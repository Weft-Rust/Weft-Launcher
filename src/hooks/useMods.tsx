import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { modsApi, asAppError } from "../mods/api";
import { EVENTS } from "../mods/ipc";
import { modName } from "../mods/select";
import { crashResolved, describeChange, describeCopy, snapshotFor, type CrashSnapshot, type NameOf, type NoticeText } from "../mods/status";
import type { AppErrorPayload, Catalog, ChangeResult, CopyResult, InstallPlan, CopyPreview, ModProgress, ProfileReport } from "../mods/types";
import { translateError } from "../i18n/errors";
import { useInstall } from "./useInstall";
import { useGameState } from "./useGameState";
import { failed, type ActionResult } from "./result";

export interface Notice extends NoticeText {
  id: number;
  tag: string;
}

interface ModsContextValue {
  catalog: Catalog | null;
  catalogLoading: boolean;
  /** Why the last catalogue load failed; kept until one succeeds. */
  catalogError: AppErrorPayload | null;
  refreshCatalog: () => Promise<void>;

  profile: (tag: string | null | undefined) => ProfileReport | undefined;
  profileError: (tag: string) => string | null;
  loadProfile: (tag: string) => Promise<void>;
  /** A mod's display name in a version's set, falling back to the catalogue and then the id. */
  nameIn: (tag: string) => NameOf;

  isBusy: (tag: string, modId: string) => boolean;
  isCopying: (tag: string) => boolean;
  progressFor: (sha256: string) => ModProgress | undefined;
  progressForMod: (modId: string) => ModProgress | undefined;

  notices: (tag: string) => Notice[];
  dismissNotice: (id: number) => void;

  plan: (tag: string, sha256: string) => Promise<InstallPlan>;
  previewCopy: (from: string, to: string) => Promise<CopyPreview>;
  install: (tag: string, sha256: string, modId: string) => Promise<ActionResult<ChangeResult>>;
  installFile: (tag: string, path: string, sha256: string, modId: string) => Promise<ActionResult<ChangeResult>>;
  setEnabled: (tag: string, id: string, enabled: boolean) => Promise<ActionResult<ChangeResult>>;
  remove: (tag: string, id: string) => Promise<ActionResult<ChangeResult>>;
  copyProfile: (from: string, to: string) => Promise<ActionResult<CopyResult>>;
}

const ModsContext = createContext<ModsContextValue | null>(null);

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _, ...rest } = record;
  return rest;
}

const opKey = (tag: string, id: string) => `mod:${tag}:${id}`;
const copyKey = (tag: string) => `copy:${tag}`;

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

export function ModsProvider({ children }: { children: ReactNode }) {
  const { installedVersions } = useInstall();
  const { lastCrash, clearCrash } = useGameState();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<AppErrorPayload | null>(null);
  const [profiles, setProfiles] = useState<Record<string, ProfileReport>>({});
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, ModProgress>>({});
  const [ops, setOps] = useState<Record<string, true>>({});
  const opsNow = useRef<Record<string, true>>({});
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeId = useRef(0);
  const { read, changed } = useProfileCoordinator(setProfiles);

  const loadProfile = useCallback(
    async (tag: string) => {
      try {
        await read(tag);
        setProfileErrors((e) => without(e, tag));
      } catch (err) {
        setProfileErrors((e) => ({ ...e, [tag]: translateError(err) }));
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

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<ModProgress>(EVENTS.modProgress, (e) => {
      setProgress((p) => ({ ...p, [e.payload.sha256]: e.payload }));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

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

  const pushNotice = useCallback((tag: string, text: NoticeText | null) => {
    if (!text) return;
    const id = ++noticeId.current;
    // A queue per version, newest last; the oldest go once there are more than three.
    setNotices((all) => {
      const mine = [...all.filter((n) => n.tag === tag), { ...text, id, tag }].slice(-3);
      return [...all.filter((n) => n.tag !== tag), ...mine];
    });
  }, []);

  const dismissNotice = useCallback((id: number) => setNotices((all) => all.filter((n) => n.id !== id)), []);

  /** Runs one change. The same change while it runs is refused, not sent twice. */
  const run = useCallback(
    async <R extends ChangeResult>(tag: string, key: string, work: () => Promise<R>, after: (r: R) => void): Promise<ActionResult<R>> => {
      if (opsNow.current[key]) return { status: "skipped" };
      opsNow.current = { ...opsNow.current, [key]: true };
      setOps(opsNow.current);
      try {
        const result = await work();
        changed(tag, result.report);
        after(result);
        return { status: "done", result };
      } catch (err) {
        // The set may have changed before the failure: read what it is now.
        loadProfile(tag);
        return failed(err);
      } finally {
        opsNow.current = without(opsNow.current, key);
        setOps(opsNow.current);
      }
    },
    [changed, loadProfile]
  );

  const clearProgress = useCallback((shas: string[], ids: string[]) => {
    setProgress((p) => Object.fromEntries(Object.entries(p).filter(([sha, v]) => !shas.includes(sha) && !ids.includes(v.modId))));
  }, []);

  const install = useCallback(
    (tag: string, sha256: string, modId: string) => {
      if (!opsNow.current[opKey(tag, modId)]) {
        setProgress((p) => ({ ...p, [sha256]: { sha256, modId, stage: "downloading", percent: 0 } }));
      }
      return run(tag, opKey(tag, modId), () => modsApi.install(tag, sha256), (r) =>
        pushNotice(tag, describeChange(r, modId, (id) => modName(id, r.report, catalog)))
      ).then((r) => {
        if (r.status !== "skipped") clearProgress([sha256], r.status === "done" ? r.result.installed : []);
        return r;
      });
    },
    [run, pushNotice, catalog, clearProgress]
  );

  const installFile = useCallback(
    (tag: string, path: string, sha256: string, modId: string) =>
      run(tag, opKey(tag, modId), () => modsApi.installFile(tag, path, sha256), (r) =>
        pushNotice(tag, describeChange(r, modId, (id) => modName(id, r.report, catalog)))
      ),
    [run, pushNotice, catalog]
  );

  const setEnabled = useCallback(
    (tag: string, id: string, enabled: boolean) =>
      run(tag, opKey(tag, id), () => modsApi.setEnabled(tag, id, enabled), (r) =>
        pushNotice(tag, describeChange(r, null, (x) => modName(x, r.report, catalog)))
      ),
    [run, pushNotice, catalog]
  );

  const remove = useCallback(
    (tag: string, id: string) => {
      const before = profiles[tag];
      return run(tag, opKey(tag, id), () => modsApi.remove(tag, id), (r) =>
        // The removed mod is no longer in the new report; name it from the old one.
        pushNotice(tag, describeChange(r, null, (x) => modName(x, r.report.mods.some((m) => m.id === x) ? r.report : before, catalog)))
      );
    },
    [run, pushNotice, catalog, profiles]
  );

  const copyProfile = useCallback(
    (from: string, to: string) =>
      run(to, copyKey(to), () => modsApi.copyProfile(from, to), (r) => {
        pushNotice(to, describeCopy(r, from, (id) => modName(id, r.report, catalog)));
        clearProgress([], r.installed);
      }),
    [run, pushNotice, catalog, clearProgress]
  );

  const isBusy = useCallback((tag: string, id: string) => !!ops[opKey(tag, id)], [ops]);
  const isCopying = useCallback((tag: string) => !!ops[copyKey(tag)], [ops]);
  const progressFor = useCallback((sha: string) => progress[sha], [progress]);
  const progressForMod = useCallback(
    (modId: string) => Object.values(progress).find((p) => p.modId === modId),
    [progress]
  );
  const noticesFor = useCallback((tag: string) => notices.filter((n) => n.tag === tag), [notices]);
  const profile = useCallback((tag: string | null | undefined) => (tag ? profiles[tag] : undefined), [profiles]);
  const profileError = useCallback((tag: string) => profileErrors[tag] ?? null, [profileErrors]);

  const value: ModsContextValue = {
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
    progressForMod,
    notices: noticesFor,
    dismissNotice,
    plan: modsApi.plan,
    previewCopy: modsApi.previewCopy,
    install,
    installFile,
    setEnabled,
    remove,
    copyProfile,
  };

  return <ModsContext.Provider value={value}>{children}</ModsContext.Provider>;
}

export function useMods(): ModsContextValue {
  const context = useContext(ModsContext);
  if (!context) throw new Error("useMods must be used within a ModsProvider");
  return context;
}
