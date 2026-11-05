import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from "react";
import { asAppError, listenTo, modsApi, newOperationId } from "../mods/api";
import { EVENTS } from "../mods/ipc";
import { modName } from "../mods/select";
import {
  crashResolved,
  describeChange,
  describeCopy,
  describeRemove,
  describeRestore,
  describeToggle,
  snapshotFor,
  type CrashSnapshot,
  type NameOf,
  type NoticeText,
} from "../mods/status";
import type {
  Catalog,
  ChangeResult,
  CopyPreview,
  CopyResult,
  FileInspection,
  InstallPlan,
  ProfileReport,
  UiError,
  UiProgress,
} from "../mods/types";
import { showError, type Shown } from "../i18n/errors";
import { tm } from "../i18n";
import { announce } from "../components/LiveRegion";
import { useInstall } from "./useInstall";
import { useGameState } from "./useGameState";
import { failed, type ActionResult } from "./result";

export interface Notice extends NoticeText {
  id: number;
  tag: string;
  /** A removal that `restore` can still put back: until the next change to that version. */
  undo?: { id: string; name: string };
}

/** What a running change is about, so the busy state has one owner. */
export type Operation = { kind: "mod"; tag: string; id: string } | { kind: "copy"; tag: string };

export const keyOf = (op: Operation) => (op.kind === "mod" ? `mod:${op.tag}:${op.id}` : `copy:${op.tag}`);

interface ModsContextValue {
  catalog: Catalog | null;
  catalogLoading: boolean;
  /** Why the last catalogue load failed; kept until one succeeds, also while an older catalogue shows. */
  catalogError: UiError | null;
  refreshCatalog: () => Promise<void>;

  profile: (tag: string | null | undefined) => ProfileReport | undefined;
  profileError: (tag: string) => Shown | null;
  loadProfile: (tag: string) => Promise<ProfileReport | undefined>;
  /** A mod's display name in a version's set, falling back to the catalogue and then the id. */
  nameIn: (tag: string) => NameOf;

  /** Whether this mod is being changed, or the whole set is (a copy into it). */
  isBusy: (tag: string, modId: string) => boolean;
  isCopying: (tag: string) => boolean;
  /** The progress events of a running operation, in the order they came (contract R4 §3). */
  progressOf: (op: Operation) => UiProgress[];
  /** Asks the backend to stop a running operation; it then ends as "cancelled". */
  cancel: (op: Operation) => Promise<void>;
  isCancelling: (op: Operation) => boolean;

  notices: (tag: string) => Notice[];
  dismissNotice: (id: number) => void;

  /** The blamed mod as it was when the last crash happened, for its notice. */
  crashSnapshot: CrashSnapshot | null;

  plan: (tag: string, sha256: string) => Promise<InstallPlan>;
  previewCopy: (from: string, to: string) => Promise<CopyPreview>;
  inspectFile: (tag: string, path: string) => Promise<FileInspection>;
  /** Installs what the player reviewed: the plan's token goes with it (contract R4 §2). */
  install: (tag: string, plan: InstallPlan) => Promise<ActionResult<ChangeResult>>;
  installFile: (tag: string, path: string, inspection: FileInspection, plan: InstallPlan | null) => Promise<ActionResult<ChangeResult>>;
  setEnabled: (tag: string, id: string, enabled: boolean) => Promise<ActionResult<ChangeResult>>;
  remove: (tag: string, id: string) => Promise<ActionResult<ChangeResult>>;
  restore: (tag: string, id: string) => Promise<ActionResult<ChangeResult>>;
  copyProfile: (preview: CopyPreview) => Promise<ActionResult<CopyResult>>;
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

/** The first file an operation will work on, so its progress shows at once, before any event. */
export interface FirstFile {
  sha256: string;
  modId: string;
  count: number;
  /** A file already on the player's computer: its first step is checking it, not a download. */
  local?: boolean;
}

/**
 * Running operations and their progress. The client names each operation (contract R4 §3) and
 * every event carries that id, so progress always belongs to the operation that caused it; an
 * event for an operation that isn't running is dropped. When one ends, however it ends, its
 * progress goes with it.
 */
function useOperations() {
  const [progress, setProgress] = useState<Record<string, UiProgress[]>>({});
  const [running, setRunning] = useState<Record<string, { op: Operation; operationId: string; cancelling: boolean }>>({});
  const live = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listenTo(EVENTS.modProgress, (e) => {
      const id = e.payload.operationId;
      if (![...live.current.values()].includes(id)) return;
      setProgress((p) => {
        const list = (p[id] ?? []).filter((x) => x.sha256 !== e.payload.sha256 && x.sha256 !== "");
        return { ...p, [id]: [...list, e.payload] };
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  /** Starts an operation and says its id, or null when the same one is already running. */
  const begin = useCallback((op: Operation, first: FirstFile | null): string | null => {
    const key = keyOf(op);
    if (live.current.has(key)) return null;
    const operationId = newOperationId();
    live.current.set(key, operationId);
    setRunning((r) => ({ ...r, [key]: { op, operationId, cancelling: false } }));
    // The first file shows at once, before its first event: getting ready, or being checked when
    // it is a file the player picked. Never "downloading" before anything is.
    const waiting: UiProgress = {
      operationId,
      sha256: first?.sha256 ?? "",
      modId: first?.modId ?? (op.kind === "mod" ? op.id : ""),
      stage: first?.local ? "verifying" : "preparing",
      percent: 0,
      index: 1,
      count: Math.max(1, first?.count ?? 1),
    };
    setProgress((p) => ({ ...p, [operationId]: [waiting] }));
    return operationId;
  }, []);

  const end = useCallback((op: Operation) => {
    const key = keyOf(op);
    const operationId = live.current.get(key);
    live.current.delete(key);
    setRunning((r) => without(r, key));
    if (operationId) setProgress((p) => without(p, operationId));
  }, []);

  const markCancelling = useCallback((op: Operation) => {
    const key = keyOf(op);
    setRunning((r) => (r[key] ? { ...r, [key]: { ...r[key], cancelling: true } } : r));
    return live.current.get(key) ?? null;
  }, []);

  return { progress, running, begin, end, markCancelling };
}

export function ModsProvider({ children }: { children: ReactNode }) {
  const { installedVersions } = useInstall();
  const { lastCrash, clearCrash } = useGameState();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<UiError | null>(null);
  const [profiles, setProfiles] = useState<Record<string, ProfileReport>>({});
  const [profileErrors, setProfileErrors] = useState<Record<string, Shown>>({});
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeId = useRef(0);
  const { read, changed } = useProfileCoordinator(setProfiles);
  const { progress, running, begin, end, markCancelling } = useOperations();

  const loadProfile = useCallback(
    async (tag: string) => {
      try {
        const report = await read(tag);
        setProfileErrors((e) => without(e, tag));
        return report;
      } catch (err) {
        setProfileErrors((e) => ({ ...e, [tag]: showError(err) }));
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
      // The catalogue shown so far stays; the banner says it couldn't be refreshed, and why.
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

  // A crash notice stays until its problem is fixed: the blamed mod is off, gone or replaced, or
  // the dependency it lacked is on and usable.
  // A copy in the player's own folder counts too: it loads whenever the launcher's doesn't, so the
  // notice stays until that file is gone or a launcher build that is on stands in for it.
  const [crashSnap, setCrashSnap] = useState<{ crash: unknown; snapshot: CrashSnapshot | null } | null>(null);
  useEffect(() => {
    if (!lastCrash) {
      setCrashSnap(null);
      return;
    }
    if (crashSnap?.crash !== lastCrash) {
      setCrashSnap({ crash: lastCrash, snapshot: snapshotFor(lastCrash.modFailure, profiles[lastCrash.tag]) });
      return;
    }
    if (crashResolved(crashSnap.snapshot, profiles[lastCrash.tag])) clearCrash();
  }, [lastCrash, profiles, clearCrash, crashSnap]);
  const crashSnapshot = crashSnap && crashSnap.crash === lastCrash ? crashSnap.snapshot : null;

  const nameIn = useCallback((tag: string): NameOf => (id) => modName(id, profiles[tag], catalog), [profiles, catalog]);

  /**
   * The answer to a version's last change. One per version: a newer change replaces it, and with
   * it any Undo, which the backend forgets at the next change anyway. Said once, politely.
   */
  const pushNotice = useCallback((tag: string, text: NoticeText | null, undo?: Notice["undo"]) => {
    const id = ++noticeId.current;
    if (text) announce(`notice:${id}`, text.lines.map(tm).join(" "));
    setNotices((all) => {
      const others = all.filter((n) => n.tag !== tag);
      if (!text) return others;
      return [...others, { ...text, id, tag, undo }];
    });
  }, []);

  const dismissNotice = useCallback((id: number) => setNotices((all) => all.filter((n) => n.id !== id)), []);

  /** Runs one change. The same change while it runs is refused, not sent twice. */
  const run = useCallback(
    async <R extends ChangeResult>(
      op: Operation,
      first: FirstFile | null,
      work: (operationId: string) => Promise<R>,
      after: (r: R) => void
    ): Promise<ActionResult<R>> => {
      const operationId = begin(op, first);
      if (!operationId) return { status: "skipped" };
      try {
        const result = await work(operationId);
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
    (tag: string, plan: InstallPlan) => {
      const modId = plan.target.id;
      // As the backend works (`plan::resolve`): the build asked for first, then what it needs.
      return run(
        { kind: "mod", tag, id: modId },
        { sha256: plan.target.sha256, modId, count: plan.install.length + 1 },
        (operationId) => modsApi.install(tag, plan.target.sha256, plan.planToken, operationId),
        (r) => pushNotice(tag, describeChange(r, modId, tag, namer(r)))
      );
    },
    [run, pushNotice, namer]
  );

  const installFile = useCallback(
    (tag: string, path: string, inspection: FileInspection, plan: InstallPlan | null) => {
      const modId = inspection.archive?.id ?? "";
      return run(
        { kind: "mod", tag, id: modId },
        // The file itself is checked first, then what it needs is fetched.
        { sha256: inspection.sha256, modId, count: (plan?.install.length ?? 0) + 1, local: true },
        (operationId) => modsApi.installFile(tag, path, inspection.sha256, inspection.planToken, operationId),
        (r) => pushNotice(tag, describeChange(r, modId, tag, namer(r)))
      );
    },
    [run, pushNotice, namer]
  );

  const setEnabled = useCallback(
    (tag: string, id: string, enabled: boolean) =>
      run({ kind: "mod", tag, id }, null, () => modsApi.setEnabled(tag, id, enabled), (r) =>
        pushNotice(tag, describeToggle(r, id, enabled, tag, namer(r)))
      ),
    [run, pushNotice, namer]
  );

  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;

  const remove = useCallback(
    (tag: string, id: string) => {
      const before = profilesRef.current[tag];
      return run({ kind: "mod", tag, id }, null, () => modsApi.remove(tag, id), (r) => {
        // The removed mod is no longer in the new report; name it from the old one.
        const name = namer(r, before);
        pushNotice(tag, describeRemove(r, id, tag, name), r.undo ? { id: r.undo, name: name(r.undo) } : undefined);
      });
    },
    [run, pushNotice, namer]
  );

  const restore = useCallback(
    (tag: string, id: string) =>
      run({ kind: "mod", tag, id }, null, (operationId) => modsApi.restore(tag, id, operationId), (r) =>
        pushNotice(tag, describeRestore(r, id, tag, namer(r)))
      ),
    [run, pushNotice, namer]
  );

  const copyProfile = useCallback(
    (preview: CopyPreview) => {
      const { from, to } = preview;
      const items = preview.items.filter((i) => i.outcome === "install");
      // The copied mods first, in the source set's order, then what they need.
      const first = items[0] ?? preview.deps[0];
      return run(
        { kind: "copy", tag: to },
        first ? { sha256: first.sha256 ?? "", modId: first.id, count: items.length + preview.deps.length } : null,
        (operationId) => modsApi.copyProfile(from, to, preview.planToken, operationId),
        (r) => pushNotice(to, describeCopy(r, from, to, namer(r)))
      );
    },
    [run, pushNotice, namer]
  );

  const isCopying = useCallback((tag: string) => !!running[keyOf({ kind: "copy", tag })], [running]);
  const isBusy = useCallback(
    (tag: string, id: string) => !!running[keyOf({ kind: "mod", tag, id })] || isCopying(tag),
    [running, isCopying]
  );
  const progressOf = useCallback(
    (op: Operation) => {
      const r = running[keyOf(op)];
      return r ? (progress[r.operationId] ?? []) : [];
    },
    [running, progress]
  );
  const cancel = useCallback(
    async (op: Operation) => {
      const operationId = markCancelling(op);
      if (!operationId) return;
      // False: it had already ended, or got past the point where it can stop. Either way its
      // own answer says what happened.
      await modsApi.cancel(operationId).catch(() => false);
    },
    [markCancelling]
  );
  const isCancelling = useCallback((op: Operation) => !!running[keyOf(op)]?.cancelling, [running]);
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
      progressOf,
      cancel,
      isCancelling,
      notices: noticesFor,
      dismissNotice,
      crashSnapshot,
      plan: modsApi.plan,
      previewCopy: modsApi.previewCopy,
      inspectFile: modsApi.inspectFile,
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
      progressOf,
      cancel,
      isCancelling,
      noticesFor,
      dismissNotice,
      crashSnapshot,
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
