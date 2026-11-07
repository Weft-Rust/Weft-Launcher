import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../i18n/useI18n";
import { getLocale } from "../i18n";
import { useInstall } from "../hooks/useInstall";
import { useGameState } from "../hooks/useGameState";
import { PixelIcon, REFRESH_ICON } from "../components/PixelIcon";
import { VersionSelect } from "../components/VersionSelect";
import { InstalledList } from "../components/mods/InstalledList";
import { BrowseList } from "../components/mods/BrowseList";
import { DialogSpec, InstallDialog } from "../components/mods/InstallDialog";
import { Build, Index, IndexMod, InstalledMod, Planned, mods, modError, owner } from "../mods/api";

interface ModsPageProps {
  selectedTag: string | null;
  onGoToVersions: () => void;
}

export function ModsPage({ selectedTag, onGoToVersions }: ModsPageProps) {
  const { t } = useI18n();
  const { installedVersions } = useInstall();
  const { runningTags } = useGameState();
  const tags = installedVersions.map((v) => v.tag);
  const [picked, setPicked] = useState(selectedTag);
  const tag = picked && tags.includes(picked) ? picked : (tags[0] ?? null);

  const [view, setView] = useState<"installed" | "browse">("installed");
  const [index, setIndex] = useState<Index | null>(null);
  const [indexFailed, setIndexFailed] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  // With the version it belongs to, so another version's list never shows.
  const [loaded, setLoaded] = useState<{ tag: string; mods: InstalledMod[] } | null>(null);
  // The version's mod ABI, worked out from its source: null if it's older than mods.
  const [abiFor, setAbiFor] = useState<{ tag: string; abi: string | null; failed: boolean } | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogSpec | null>(null);

  const list = loaded && loaded.tag === tag ? loaded.mods : null;
  const running = tag !== null && runningTags.has(tag);
  const readOnly = running || busy;
  const abiOf = abiFor && abiFor.tag === tag ? abiFor : null;
  const abi = abiOf?.abi ?? null;

  // Fetched when the tab opens; a cached copy is used silently. A failed Refresh says so.
  const loadIndex = async (refresh: boolean) => {
    setRefreshFailed(false);
    try {
      setIndex(await mods.catalog(refresh));
      setIndexFailed(false);
    } catch {
      if (index) setRefreshFailed(true);
      else setIndexFailed(true);
    }
  };
  useEffect(() => {
    loadIndex(false);
  }, []);

  useEffect(() => {
    if (!tag) return;
    let stale = false;
    mods.abi(tag).then(
      (abi) => !stale && setAbiFor({ tag, abi, failed: false }),
      () => !stale && setAbiFor({ tag, abi: null, failed: true })
    );
    return () => {
      stale = true;
    };
  }, [tag, reload]);

  // Again when the game stops (the set may have been repaired at launch), after a dialog, and
  // once the ABI is known.
  useEffect(() => {
    if (!tag) return;
    let stale = false;
    setError(null);
    mods.list(tag).then(
      (next) => !stale && setLoaded({ tag, mods: next }),
      (err) => !stale && setError({ id: "", text: modError(err, tag) })
    );
    return () => {
      stale = true;
    };
  }, [tag, index, running, reload, abi]);

  if (!tag) {
    return (
      <main className="page mods-page">
        <h1>{t("mods.tab")}</h1>
        <div className="mods-panel">
          <p>{t("mods.noGame")}</p>
          <button className="btn-primary" onClick={onGoToVersions}>
            {t("mods.goToVersions")}
          </button>
        </div>
      </main>
    );
  }

  /** Runs one change; the page's buttons are off until it's done. */
  const change = async (id: string, action: () => Promise<InstalledMod[]>) => {
    setBusy(true);
    setError(null);
    try {
      setLoaded({ tag, mods: await action() });
    } catch (err) {
      setError({ id, text: modError(err, tag) });
    } finally {
      setBusy(false);
    }
  };

  const depsLine = (plan: Planned[], rootId: string, rootName: string) => {
    const deps = plan.filter((p) => p.id !== rootId).map((p) => `${p.name} ${p.version}`);
    const joined = new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(deps);
    return deps.length ? [t("mods.alsoInstalls", joined, rootName)] : [];
  };

  const openInstall = async (mod: IndexMod, build: Build) => {
    const have = list?.find((m) => m.id === mod.id);
    const errorTitle = t("mods.failedTitle", `${mod.name} ${build.version}`);
    try {
      const plan = await mods.plan(tag, mod.id, build.version);
      setDialog({
        title: have
          ? t("mods.updateTitle", mod.name, build.version, tag)
          : t("mods.installTitle", mod.name, build.version, tag),
        errorTitle,
        subtitle: t("mods.by", owner(mod.repo)),
        warning: t("mods.warning", mod.name, mod.repo),
        lines: [...depsLine(plan, mod.id, mod.name), ...(have?.version ? [t("mods.replaces", have.version)] : []), mod.summary],
        source: `https://github.com/${mod.repo}/tree/${build.tag}`,
        confirm: have ? t("mods.update") : t("mods.install"),
        run: () => mods.install(tag, mod.id, build.version),
      });
    } catch (err) {
      setDialog({ title: "", errorTitle, error: modError(err, tag) });
    }
  };

  const openUpdate = (installed: InstalledMod) => {
    const mod = index?.mods.find((m) => m.id === installed.id);
    const build = mod?.builds.find((b) => b.version === installed.update && b.abi === abi);
    if (mod && build) openInstall(mod, build);
  };

  const fromFile = async () => {
    const path = await open({ multiple: false, directory: false, filters: [{ name: t("mods.fileFilter"), extensions: ["zip"] }] });
    if (typeof path !== "string") return;
    const fileName = path.split(/[\\/]/).pop() ?? path;
    const errorTitle = t("mods.failedTitle", fileName);
    try {
      const info = await mods.inspectFile(tag, path);
      setDialog({
        title: info.replaces
          ? t("mods.fileReplaceTitle", info.name, fileName)
          : t("mods.fileTitle", info.name, info.version, fileName),
        errorTitle,
        unverified: true,
        warning: t("mods.fileWarning"),
        lines: depsLine(info.plan, info.id, info.name),
        confirm: t("mods.installAnyway"),
        run: () => mods.installFile(tag, path),
      });
    } catch (err) {
      setDialog({ title: "", errorTitle, error: modError(err, tag) });
    }
  };

  // A From file needs the version's ABI, which comes from the index.
  const fromFileButton = (
    <button className="btn-secondary" disabled={readOnly || !abi} onClick={fromFile}>
      {t("mods.fromFile")}
    </button>
  );

  const installedView = (items: InstalledMod[]) =>
    items.length === 0 ? (
      <div className="mods-panel">
        <p>{t("mods.empty", tag)}</p>
        <div className="mods-panel-actions">
          <button className="btn-primary" onClick={() => setView("browse")}>
            {t("mods.browseMods")}
          </button>
          {fromFileButton}
        </div>
      </div>
    ) : (
      <InstalledList
        mods={items}
        readOnly={readOnly}
        rowError={error}
        onToggle={(m) => change(m.id, () => mods.setEnabled(tag, m.id, !m.on))}
        onRemove={(m) => change(m.id, () => mods.remove(tag, m.id))}
        onUpdate={openUpdate}
      />
    );

  const browseView = (items: InstalledMod[]) =>
    index && abi ? (
      <BrowseList index={index} abi={abi} tag={tag} installed={items} readOnly={readOnly} onInstall={openInstall} />
    ) : indexFailed || abiOf?.failed ? (
      <div className="mods-panel">
        <p>{t("mods.catalogFailed")}</p>
        <button
          className="btn-secondary"
          onClick={() => {
            loadIndex(false);
            setReload((n) => n + 1);
          }}
        >
          {t("mods.retry")}
        </button>
      </div>
    ) : (
      <p className="empty-state">{t("loading")}</p>
    );

  return (
    <main className="page mods-page">
      <header className="page-header">
        <h1>{t("mods.tab")}</h1>
        <div className="header-actions">
          {refreshFailed && <span className="inline-error">{t("mods.refreshFailed")}</span>}
          <span className="mods-label">{t("mods.version")}</span>
          <VersionSelect
            value={tag}
            options={tags.map((v) => ({ value: v, label: v }))}
            onChange={setPicked}
            disabled={busy}
            label={t("mods.version")}
          />
          <button className="btn-refresh" onClick={() => loadIndex(true)} disabled={busy} title={t("mods.refresh")} aria-label={t("mods.refresh")}>
            <PixelIcon rows={REFRESH_ICON} scale={4} />
          </button>
        </div>
      </header>

      {error && !list?.some((m) => m.id === error.id) && (
        <div className="error-banner" role="alert">
          {error.text}
        </div>
      )}
      {abiOf && !abiOf.failed && !abiOf.abi ? (
        <div className="mods-panel">{t("mods.unavailable", tag)}</div>
      ) : (
        list && (
          <>
            <div className="mods-toolbar">
              <div className="switch">
                <button aria-pressed={view === "installed"} className={view === "installed" ? "on" : ""} onClick={() => setView("installed")}>
                  {t("mods.installed")}
                  <span className="count">{list.length}</span>
                </button>
                <button aria-pressed={view === "browse"} className={view === "browse" ? "on" : ""} onClick={() => setView("browse")}>
                  {t("mods.browse")}
                </button>
              </div>
              {fromFileButton}
            </div>
            {running && (
              <p className="mods-running" role="status">
                {t("mods.running", tag)}
              </p>
            )}
            {view === "installed" ? installedView(list) : browseView(list)}
          </>
        )
      )}

      {dialog && (
        <InstallDialog
          spec={dialog}
          tag={tag}
          onClose={() => {
            setDialog(null);
            // Whatever is on disk now, also after a failure.
            setReload((n) => n + 1);
          }}
          onDone={(next) => {
            setLoaded({ tag, mods: next });
            setDialog(null);
          }}
        />
      )}
    </main>
  );
}
