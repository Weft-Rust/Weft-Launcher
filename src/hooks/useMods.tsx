import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { modsApi } from "../mods/api";
import type { Catalog, ChangeResult, CopyResult, ModProgress, ProfileReport } from "../mods/types";
import { translateError } from "../i18n/errors";
import { useI18n } from "../i18n/useI18n";

export interface Notice {
  tag: string;
  tone: "ok" | "warn";
  lines: string[];
}

interface ModsContextValue {
  catalog: Catalog | null;
  catalogLoading: boolean;
  refreshCatalog: () => Promise<void>;
  profiles: Record<string, ProfileReport>;
  profileErrors: Record<string, string>;
  loadProfile: (tag: string) => Promise<void>;
  /** Download progress by file hash. */
  progress: Record<string, ModProgress>;
  /** Work in flight, by `<tag>:<mod id>` or `<tag>:<sha256>`. */
  busy: Record<string, boolean>;
  notice: Notice | null;
  clearNotice: () => void;
  install: (tag: string, sha256: string, modId: string) => Promise<string | null>;
  installFile: (tag: string, path: string, sha256: string, modId: string) => Promise<string | null>;
  setEnabled: (tag: string, id: string, enabled: boolean) => Promise<string | null>;
  remove: (tag: string, id: string) => Promise<string | null>;
  copyProfile: (from: string, to: string) => Promise<string | null>;
}

const ModsContext = createContext<ModsContextValue | null>(null);

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _, ...rest } = record;
  return rest;
}

export function ModsProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [profiles, setProfiles] = useState<Record<string, ProfileReport>>({});
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, ModProgress>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const loadedTags = useRef(new Set<string>());

  const loadProfile = useCallback(async (tag: string) => {
    loadedTags.current.add(tag);
    try {
      const report = await modsApi.profile(tag);
      setProfiles((p) => ({ ...p, [tag]: report }));
      setProfileErrors((e) => without(e, tag));
    } catch (err) {
      setProfileErrors((e) => ({ ...e, [tag]: translateError(err) }));
    }
  }, []);

  const refreshCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      setCatalog(await modsApi.catalog(true));
    } catch (err) {
      console.error("Mod catalogue:", err);
    } finally {
      setCatalogLoading(false);
    }
    // Revocations and updates come with the catalogue.
    await Promise.all([...loadedTags.current].map((tag) => loadProfile(tag)));
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
    listen<ModProgress>("mod-progress", (e) => {
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

  const nameOf = useCallback(
    (report: ProfileReport, id: string) => report.mods.find((m) => m.id === id)?.name ?? id,
    []
  );

  const describe = useCallback(
    (tag: string, result: ChangeResult | CopyResult, primary: string | null) => {
      const names = (ids: string[]) => ids.map((id) => nameOf(result.report, id)).join(", ");
      const lines: string[] = [];
      const deps = result.installed.filter((id) => id !== primary);
      if (primary && result.installed.includes(primary)) {
        lines.push(t("mods.noticeInstalled", nameOf(result.report, primary)));
      }
      if (deps.length && primary) lines.push(t("mods.noticeDepsInstalled", names(deps)));
      if (result.alsoEnabled.length) lines.push(t("mods.noticeAlsoEnabled", names(result.alsoEnabled)));
      if (result.alsoDisabled.length) lines.push(t("mods.noticeAlsoDisabled", names(result.alsoDisabled)));
      if (result.missing.length) lines.push(t("mods.noticeMissing", result.missing.join(", ")));
      if ("leftBehind" in result && result.leftBehind.length) {
        lines.push(t("mods.noticeLeftBehind", result.leftBehind.join(", ")));
      }
      const warn = result.missing.length > 0 || ("leftBehind" in result && result.leftBehind.length > 0);
      setNotice(lines.length ? { tag, tone: warn ? "warn" : "ok", lines } : null);
    },
    [nameOf, t]
  );

  const run = useCallback(
    async <R extends ChangeResult>(
      tag: string,
      key: string,
      work: () => Promise<R>,
      after?: (r: R) => void
    ): Promise<string | null> => {
      setBusy((b) => ({ ...b, [key]: true }));
      try {
        const result = await work();
        setProfiles((p) => ({ ...p, [tag]: result.report }));
        after?.(result);
        return null;
      } catch (err) {
        return translateError(err);
      } finally {
        setBusy((b) => without(b, key));
      }
    },
    []
  );

  const install = useCallback(
    (tag: string, sha256: string, modId: string) => {
      setProgress((p) => ({ ...p, [sha256]: { sha256, modId, stage: "downloading", percent: 0 } }));
      return run(tag, `${tag}:${modId}`, () => modsApi.install(tag, sha256), (r) => describe(tag, r, modId)).finally(
        () => setProgress((p) => without(p, sha256))
      );
    },
    [run, describe]
  );

  const installFile = useCallback(
    (tag: string, path: string, sha256: string, modId: string) =>
      run(tag, `${tag}:${modId}`, () => modsApi.installFile(tag, path, sha256), (r) => describe(tag, r, modId)),
    [run, describe]
  );

  const setEnabled = useCallback(
    (tag: string, id: string, enabled: boolean) =>
      run(tag, `${tag}:${id}`, () => modsApi.setEnabled(tag, id, enabled), (r) => describe(tag, r, null)),
    [run, describe]
  );

  const remove = useCallback(
    (tag: string, id: string) =>
      run(tag, `${tag}:${id}`, () => modsApi.remove(tag, id), (r) => describe(tag, r, null)),
    [run, describe]
  );

  const copyProfile = useCallback(
    (from: string, to: string) =>
      run(to, `${to}:copy`, () => modsApi.copyProfile(from, to), (r) => {
        const lines = [t("mods.noticeCopied", String(r.installed.length), from)];
        if (r.leftBehind.length) lines.push(t("mods.noticeLeftBehind", r.leftBehind.join(", ")));
        if (r.missing.length) lines.push(t("mods.noticeMissing", r.missing.join(", ")));
        setNotice({ tag: to, tone: r.leftBehind.length || r.missing.length ? "warn" : "ok", lines });
      }),
    [run, t]
  );

  const clearNotice = useCallback(() => setNotice(null), []);

  const value: ModsContextValue = {
    catalog,
    catalogLoading,
    refreshCatalog,
    profiles,
    profileErrors,
    loadProfile,
    progress,
    busy,
    notice,
    clearNotice,
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
