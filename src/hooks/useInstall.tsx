import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from "react";
import { translateError } from "../i18n/errors";
import { launcherApi, listenTo } from "../mods/api";
import { EVENTS } from "../mods/ipc";
import type { InstalledVersion, InstallProgress } from "../mods/types";

export type { InstalledVersion, InstallProgress };

interface InstallContextValue {
  installedVersions: InstalledVersion[];
  /** False until the first answer, so "nothing installed" isn't shown before it is known. */
  loaded: boolean;
  progress: Record<string, InstallProgress>;
  busy: Record<string, boolean>;
  errors: Record<string, string>;
  install: (tag: string, assetUrl: string, assetName: string, expectedSha256: string | null) => Promise<void>;
  remove: (tag: string) => Promise<void>;
}

const InstallContext = createContext<InstallContextValue | null>(null);

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _, ...rest } = record;
  return rest;
}

// One provider above the tabs: an install has to outlive the page it was started from.
export function InstallProvider({ children }: { children: ReactNode }) {
  const [installedVersions, setInstalledVersions] = useState<InstalledVersion[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState<Record<string, InstallProgress>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const refreshInstalled = useCallback(async () => {
    try {
      setInstalledVersions(await launcherApi.installedVersions());
    } catch (err) {
      console.error("Failed to load installed versions:", err);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refreshInstalled();
  }, [refreshInstalled]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listenTo(EVENTS.installProgress, (event) => {
      setProgress((prev) => ({ ...prev, [event.payload.tag]: event.payload }));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const run = useCallback(
    async (tag: string, work: () => Promise<unknown>) => {
      setBusy((prev) => ({ ...prev, [tag]: true }));
      setErrors((prev) => without(prev, tag));
      try {
        await work();
        await refreshInstalled();
      } catch (err) {
        setErrors((prev) => ({ ...prev, [tag]: translateError(err) }));
      } finally {
        setBusy((prev) => without(prev, tag));
        setProgress((prev) => without(prev, tag));
      }
    },
    [refreshInstalled]
  );

  const install = useCallback(
    (tag: string, assetUrl: string, assetName: string, expectedSha256: string | null) => {
      setProgress((prev) => ({ ...prev, [tag]: { tag, stage: "downloading", percent: 0, downloaded: 0, total: 0, speedMbps: 0 } }));
      return run(tag, () => launcherApi.installVersion(tag, assetUrl, assetName, expectedSha256));
    },
    [run]
  );

  const remove = useCallback((tag: string) => run(tag, () => launcherApi.removeVersion(tag)), [run]);

  const value: InstallContextValue = { installedVersions, loaded, progress, busy, errors, install, remove };

  return <InstallContext.Provider value={value}>{children}</InstallContext.Provider>;
}

export function useInstall(): InstallContextValue {
  const context = useContext(InstallContext);
  if (!context) {
    throw new Error("useInstall must be used within an InstallProvider");
  }
  return context;
}
