import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { modsApi, asAppError } from "../mods/api";
import { EVENTS } from "../mods/ipc";
import { modName } from "../mods/select";
import {
  crashResolved,
  describeChange,
  describeCopy,
  describeRemove,
  describeRestore,
  snapshotFor,
  type CrashSnapshot,
  type NameOf,
  type NoticeText,
} from "../mods/status";
import type { Catalog, ChangeResult, CopyResult, InstallPlan, CopyPreview, ModProgress, ProfileReport, UiError } from "../mods/types";
import { translateError } from "../i18n/errors";
import { useInstall } from "./useInstall";
import { useGameState } from "./useGameState";
import { failed, type ActionResult } from "./result";

export interface Notice extends NoticeText {
  id: number;
  tag: string;
  /** A removal that `restore` can still put back: until the next change to that version. */
  undo?: { id: string; name: string };
}

/** What a running change is, so the busy state and its progress have one owner each. */
export type Operation = { kind: "mod"; tag: string; id: string } | { kind: "copy"; tag: string };

const keyOf = (op: Operation) => (op.kind === "mod" ? `mod:${op.tag}:${op.id}` : `copy:${op.tag}`);

interface ModsContextValue {
  catalog: Catalog | null;
  catalogLoading: boolean;
  /** Why the last catalogue load failed; kept until one succeeds. */
  catalogError: UiError | null;
  refreshCatalog: () => Promise<void>;

  profile: (tag: string | null | undefined) => ProfileReport | undefined;
  profileError: (tag: string) => string | null;
  loadProfile: (tag: string) => Promise<ProfileReport | undefined>;
  /** A mod's display name in a version's set, falling back to the catalogue and then the id. */
  nameIn: (tag: string) => NameOf;

  /** Whether this mod is being changed, or the whole set is (a copy into it). */
  isBusy: (tag: string, modId: string) => boolean;
  isCopying: (tag: string) => boolean;
  progressFor: (sha256: string) => ModProgress | undefined;
  /** The progress events of one running operation, oldest first. */
  progressOf: (op: Operation) => ModProgress[];

  notices: (tag: string) => Notice[];
  dismissNotice: (id: number) => void;

  plan: (tag: string, sha256: string) => Promise<InstallPlan>;
  previewCopy: (from: string, to: string) => Promise<CopyPreview>;
  install: (tag: string, sha256: string, modId: string, expected?: string[]) => Promise<ActionResult<ChangeResult>>;
  installFile: (tag: string, path: string, sha256: string, modId: string, expected?: string[]) => Promise<ActionResult<ChangeResult>>;
  setEnabled: (tag: string, id: string, enabled: boolean) => Promise<ActionResult<ChangeResult>>;
  remove: (tag: string, id: string) => Promise<ActionResult<ChangeResult>>;
  restore: (tag: string, id: string) => Promise<ActionResult<ChangeResult>>;
  copyProfile: (from: string, to: string, expected?: string[]) => Promise<ActionResult<CopyResult>>;
}

const ModsContext = createContext<ModsContextValue | null>(null);

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _, ...rest } = record;
  return rest;
}

/**
 * Profile answers per version, in order. Every read and every finished change takes a ticket;
 * an answer older than one already shown is dropped, so a slow read can't undo a change.
 */
function useProfileCoordinator(setProfiles: (fn: (p: Record<string, ProfileReport>) => Record<string, ProfileReport>) => void) {
  const issued = useRef<Record<string, number>>({});
  const shown = useRef<Record<string, number>>({});
  const reads = useRef<Record<string, Promise<ProfileReport>>>({});

  const ticket = useCallback((tag: string) => (issued.current[tag] = (issued.current[tag] ?? 0) + 1), []);

  const offer = useCallback(
    (tag: string, at: number, report: ProfileReport) => {
      if (at <= (shown.current[tag] ?? 0)) return;
      shown.current[tag] = at;
      setProfiles((p) => ({ ...p, [tag]: report }));
    },
    [setProfiles]
  );

  /** One read per version at a time; a caller during a read shares it. */
  const read = useCallback(
    (tag: string): Promise<ProfileReport> => {
      const running = reads.current[tag];
      if (running) return running;
      const at = ticket(tag);
      const p = modsApi
        .profile(tag)
        .then((report) => {
          offer(tag, at, report);
          return report;
        })
        .finally(() => {
          delete reads.current[tag];
        });
      reads.current[tag] = p;
      return p;
    },
    [offer, ticket]
  );

  /** A change's report is the newest state when it arrives: its ticket is taken then. */
  const changed = useCallback((tag: string, report: ProfileReport) => offer(tag, ticket(tag), report), [offer, ticket]);

  return { read, changed };
}

interface Owned extends ModProgress {
  /** The operation the event belongs to. */
  owner: string;
}

/**
 * Progress, owned by operations. An operation names the hashes it expects; an event for another
 * hash goes to the newest running operation (a dependency the plan didn't list). When the
 * operation ends, however it ends, every hash it owns is cleared.
 */
function useOperations() {
  const [progress, setProgress] = useState<Record<string, Owned>>({});
  const [running, setRunning] = useState<Record<string, Operation>>({});
  const live = useRef<Map<string, { op: Operation; expected: Set<string> }>>(new Map());

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<ModProgress>(EVENTS.modProgress, (e) => {
      const ops = [...live.current.entries()];
      const owner = ops.find(([, o]) => o.expected.has(e.payload.sha256))?.[0] ?? ops[ops.length - 1]?.[0];
      // Nothing running: a late event of an operation that has ended.
      if (!owner) return;
      setProgress((p) => ({ ...p, [e.payload.sha256]: { ...e.payload, owner } }));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const clearOwner = useCallback((key: string) => {
    setProgress((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v.owner !== key)));
  }, []);

  /** Starts an operation, or says it is already running. */
  const begin = useCallback(
    (op: Operation, expected: string[]): boolean => {
      const key = keyOf(op);
      if (live.current.has(key)) return false;
      live.current.set(key, { op, expected: new Set(expected) });
      clearOwner(key);
      setRunning((r) => ({ ...r, [key]: op }));
      // The first file shows as waiting at once, before its first event.
      if (expected[0]) {
        setProgress((p) => ({ ...p, [expected[0]]: { sha256: expected[0], modId: op.kind === "mod" ? op.id : "", stage: "downloading", percent: 0, owner: key } }));
      }
      return true;
    },
    [clearOwner]
  );

  const end = useCallback(
    (op: Operation) => {
      const key = keyOf(op);
      live.current.delete(key);
      clearOwner(key);
      setRunning((r) => without(r, key));
    },
    [clearOwner]
  );

  return { progress, running, begin, end };
}

export function ModsProvider({ children }: { children: ReactNode }) {
  const { installedVersions } = useInstall();
  const { lastCrash, clearCrash } = useGameState();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<UiError | null>(null);
  const [profiles, setProfiles] = useState<Record<string, ProfileReport>>({});
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeId = useRef(0);
  const { read, changed } = useProfileCoordinator(setProfiles);
  const { progress, running, begin, end } = useOperations();

  const loadProfile = useCallback(
    async (tag: string) => {
      try {
        const report = await read(tag);
        setProfileErrors((e) => without(e, tag));
        return report;
      } catch (err) {
        setProfileErrors((e) => ({ ...e, [tag]: translateError(err) }));
        return undefined;
      }
    },
    [read]
  );

  const tags = useMemo(() => installedVersions.map((v) => v.tag), [installedVersions]);
  const tagsRef = useRef(tags);
  tagsRef.current = tags;

  // Every version's set: Home, Versions (mod counts) and Mods (copy donors) all use them.
  useEffect(() => {
    tags.forEach((tag) => loadProfile(tag));
  }, [tags, loadProfile]);

  const refreshCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      setCatalog(await modsApi.catalog(true));
      setCatalogError(null);
    } catch (err) {
      setCatalogError(asAppError(err));
    } finally {
      setCatalogLoading(false);
    }
    // Revocations and updates come with the catalogue.
    await Promise.all(tagsRef.current.map((tag) => loadProfile(tag)));
  }, [loadProfile]);

  // The cache shows something at once, then the network says what is new.
  useEffect(() => {
    modsApi
      .catalog(false)
      .then(setCatalog)
      .catch(() => {})
      .finally(() => refreshCatalog());
  }, [refreshCatalog]);

  // A crash notice stays until its problem is fixed: the blamed mod is off, gone or replaced.
  const crashSnapshot = useRef<{ crash: unknown; snapshot: CrashSnapshot | null } | null>(null);
  useEffect(() => {
    if (!lastCrash) {
      crashSnapshot.current = null;
      return;
    }
    if (crashSnapshot.current?.crash !== lastCrash) {
      crashSnapshot.current = { crash: lastCrash, snapshot: snapshotFor(lastCrash.modFailure, profiles[lastCrash.tag]) };
      return;
    }
    if (crashResolved(crashSnapshot.current.snapshot, profiles[lastCrash.tag])) clearCrash();
  }, [lastCrash, profiles, clearCrash]);

  const nameIn = useCallback((tag: string): NameOf => (id) => modName(id, profiles[tag], catalog), [profiles, catalog]);

  /**
   * The answer to a version's last change. One per version: a newer change replaces it, and with
   * it any Undo, which the backend forgets at the next change anyway.
   */
  const pushNotice = useCallback((tag: string, text: NoticeText | null, undo?: Notice["undo"]) => {
    setNotices((all) => {
      const others = all.filter((n) => n.tag !== tag);
      if (!text) return others;
      return [...others, { ...text, id: ++noticeId.current, tag, undo }];
    });
  }, []);

  const dismissNotice = useCallback((id: number) => setNotices((all) => all.filter((n) => n.id !== id)), []);

  /** Runs one change. The same change while it runs is refused, not sent twice. */
  const run = useCallback(
    async <R extends ChangeResult>(op: Operation, expected: string[], work: () => Promise<R>, after: (r: R) => void): Promise<ActionResult<R>> => {
      if (!begin(op, expected)) return { status: "skipped" };
      try {
        const result = await work();
        changed(op.tag, result.report);
        after(result);
        return { status: "done", result };
      } catch (err) {
        // The set may have changed before the failure: read what it is now.
        loadProfile(op.tag);
        return failed(err);
      } finally {
        end(op);
      }
    },
    [begin, end, changed, loadProfile]
  );

  const namer = useCallback((r: ChangeResult, before?: ProfileReport): NameOf => (id) =>
    modName(id, r.report.mods.some((m) => m.id === id) ? r.report : before, catalog), [catalog]);

  const install = useCallback(
    (tag: string, sha256: string, modId: string, expected: string[] = []) =>
      run({ kind: "mod", tag, id: modId }, [sha256, ...expected], () => modsApi.install(tag, sha256), (r) =>
        pushNotice(tag, describeChange(r, modId, tag, namer(r)))
      ),
    [run, pushNotice, namer]
  );

  const installFile = useCallback(
    (tag: string, path: string, sha256: string, modId: string, expected: string[] = []) =>
      run({ kind: "mod", tag, id: modId }, [sha256, ...expected], () => modsApi.installFile(tag, path, sha256), (r) =>
        pushNotice(tag, describeChange(r, modId, tag, namer(r)))
      ),
    [run, pushNotice, namer]
  );

  const setEnabled = useCallback(
    (tag: string, id: string, enabled: boolean) =>
      run({ kind: "mod", tag, id }, [], () => modsApi.setEnabled(tag, id, enabled), (r) =>
        pushNotice(tag, describeChange(r, null, tag, namer(r)))
      ),
    [run, pushNotice, namer]
  );

  const remove = useCallback(
    (tag: string, id: string) => {
      const before = profiles[tag];
      return run({ kind: "mod", tag, id }, [], () => modsApi.remove(tag, id), (r) => {
        // The removed mod is no longer in the new report; name it from the old one.
        const name = namer(r, before);
        pushNotice(tag, describeRemove(r, id, tag, name), r.undo ? { id: r.undo, name: name(r.undo) } : undefined);
      });
    },
    [run, pushNotice, namer, profiles]
  );

  const restore = useCallback(
    (tag: string, id: string) =>
      run({ kind: "mod", tag, id }, [], () => modsApi.restore(tag, id), (r) => pushNotice(tag, describeRestore(r, id, tag, namer(r)))),
    [run, pushNotice, namer]
  );

  const copyProfile = useCallback(
    (from: string, to: string, expected: string[] = []) =>
      run({ kind: "copy", tag: to }, expected, () => modsApi.copyProfile(from, to), (r) =>
        pushNotice(to, describeCopy(r, from, to, namer(r)))
      ),
    [run, pushNotice, namer]
  );

  const isCopying = useCallback((tag: string) => !!running[keyOf({ kind: "copy", tag })], [running]);
  const isBusy = useCallback(
    (tag: string, id: string) => !!running[keyOf({ kind: "mod", tag, id })] || isCopying(tag),
    [running, isCopying]
  );
  const progressFor = useCallback((sha: string) => progress[sha], [progress]);
  const progressOf = useCallback(
    (op: Operation) => {
      const key = keyOf(op);
      return Object.values(progress).filter((p) => p.owner === key);
    },
    [progress]
  );
  const noticesFor = useCallback((tag: string) => notices.filter((n) => n.tag === tag), [notices]);
  const profile = useCallback((tag: string | null | undefined) => (tag ? profiles[tag] : undefined), [profiles]);
  const profileError = useCallback((tag: string) => profileErrors[tag] ?? null, [profileErrors]);

  const value = useMemo<ModsContextValue>(
    () => ({
      catalog,
      catalogLoading,
      catalogError,
      refreshCatalog,
      profile,
      profileError,
      loadProfile,
      nameIn,
      isBusy,
      isCopying,
      progressFor,
      progressOf,
      notices: noticesFor,
      dismissNotice,
      plan: modsApi.plan,
      previewCopy: modsApi.previewCopy,
      install,
      installFile,
      setEnabled,
      remove,
      restore,
      copyProfile,
    }),
    [
      catalog,
      catalogLoading,
      catalogError,
      refreshCatalog,
      profile,
      profileError,
      loadProfile,
      nameIn,
      isBusy,
      isCopying,
      progressFor,
      progressOf,
      noticesFor,
      dismissNotice,
      install,
      installFile,
      setEnabled,
      remove,
      restore,
      copyProfile,
    ]
  );

  return <ModsContext.Provider value={value}>{children}</ModsContext.Provider>;
}

export function useMods(): ModsContextValue {
  const context = useContext(ModsContext);
  if (!context) throw new Error("useMods must be used within a ModsProvider");
  return context;
}
