import { useEffect, useMemo, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../i18n/useI18n";
import { translateError } from "../i18n/errors";
import { useInstall } from "../hooks/useInstall";
import { useGameState } from "../hooks/useGameState";
import { useMods } from "../hooks/useMods";
import { modsApi } from "../mods/api";
import { compareTags } from "../utils/version";
import { PixelIcon } from "../components/PixelIcon";
import { VersionSelect } from "../components/VersionSelect";
import { InstalledList } from "../components/mods/InstalledList";
import { BrowseList } from "../components/mods/BrowseList";
import { FileInstallDialog } from "../components/mods/FileInstallDialog";
import { SourcesDialog } from "../components/mods/SourcesDialog";
import { REFRESH_ICON } from "../components/icons";

type View = "installed" | "browse";

interface ModsPageProps {
  selectedTag: string | null;
  onSelectTag: (tag: string) => void;
  onGoToVersions: () => void;
}

export function ModsPage({ selectedTag, onSelectTag, onGoToVersions }: ModsPageProps) {
  const { t } = useI18n();
  const { installedVersions, loaded } = useInstall();
  const { isRunning } = useGameState();
  const mods = useMods();
  const { profiles, profileErrors, loadProfile, notice, clearNotice, catalogLoading, refreshCatalog } = mods;
  const [view, setView] = useState<View>("installed");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const versions = useMemo(
    () => [...installedVersions].sort((a, b) => compareTags(b.tag, a.tag)),
    [installedVersions]
  );
  const tag = versions.find((v) => v.tag === selectedTag)?.tag ?? versions[0]?.tag ?? null;
  const report = tag ? profiles[tag] : undefined;
  const running = tag ? isRunning(tag) : false;

  // Every version's set is read, so another version's mods can be offered here.
  useEffect(() => {
    versions.forEach((v) => loadProfile(v.tag));
  }, [versions, loadProfile]);

  useEffect(() => setRowError(null), [tag, view]);

  if (!loaded) return <main className="page mods-page" />;

  if (!tag) {
    return (
      <main className="page mods-page">
        <header className="page-header clear">
          <h1>{t("mods.title")}</h1>
        </header>
        <div className="empty-state framed-empty">
          <p>{t("mods.noVersions")}</p>
          <button className="btn-primary" onClick={onGoToVersions}>
            {t("goToVersionsTab")}
          </button>
        </div>
      </main>
    );
  }

  const pickFile = async () => {
    try {
      const path = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: t("mods.fileFilter"), extensions: ["zip"] }],
      });
      if (typeof path === "string") setFilePath(path);
    } catch (err) {
      setRowError(translateError(err));
    }
  };

  const nameOf = (id: string) => report?.mods.find((m) => m.id === id)?.name ?? id;
  const donor = versions
    .filter((v) => v.tag !== tag)
    .map((v) => profiles[v.tag])
    .find((p) => p && p.mods.some((m) => m.enabled));
  const empty = report && report.mods.length === 0;

  return (
    <main className="page mods-page">
      <header className="page-header clear">
        <h1>{t("mods.title")}</h1>
        <div className="header-actions">
          <span className="header-for">{t("mods.forVersion")}</span>
          <VersionSelect
            value={tag}
            options={versions.map((v) => ({ value: v.tag, label: v.tag }))}
            onChange={onSelectTag}
            disabled={false}
            label={t("mods.versionLabel")}
            compact
          />
          <button className="btn-secondary" onClick={pickFile} disabled={running}>
            {t("mods.fromFile")}
          </button>
          <button className="btn-secondary" onClick={() => setShowSources(true)}>
            {t("mods.sources")}
          </button>
          <button
            className="btn-refresh"
            onClick={refreshCatalog}
            disabled={catalogLoading}
            title={t("mods.refresh")}
            aria-label={t("mods.refresh")}
          >
            <PixelIcon rows={REFRESH_ICON} scale={4} />
          </button>
        </div>
      </header>

      <div className="switch" role="tablist" aria-label={t("mods.title")}>
        {(["installed", "browse"] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            className={view === v ? "on" : ""}
            onClick={() => setView(v)}
          >
            {t(v === "installed" ? "mods.tabInstalled" : "mods.tabBrowse")}
            {v === "installed" && report && report.mods.length > 0 && (
              <span className="count">{report.mods.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="banners" aria-live="polite">
        {running && (
          <div className="banner info" role="status">
            <span>{t("mods.runningBanner", tag)}</span>
          </div>
        )}
        {notice && notice.tag === tag && (
          <div className={`banner ${notice.tone}`} role="status">
            <span>
              {notice.lines.map((l, i) => (
                <span key={i} className="banner-line">
                  {l}
                </span>
              ))}
            </span>
            <button className="btn-secondary btn-small" onClick={clearNotice}>
              {t("mods.dismiss")}
            </button>
          </div>
        )}
        {report && report.blocking.length > 0 && (
          <div className="banner bad" role="alert">
            <span>{t("mods.blockingBanner", tag, report.blocking.map(nameOf).join(", "))}</span>
          </div>
        )}
        {report && report.unmanaged.length > 0 && (
          <div className="banner warn">
            <span>{t("mods.unmanagedBanner", report.unmanaged.join(", "))}</span>
            <button className="btn-secondary btn-small" onClick={() => modsApi.openPlayerModsFolder().catch(() => {})}>
              {t("mods.unmanagedShow")}
            </button>
          </div>
        )}
        {report?.abiError && report.mods.length > 0 && (
          <div className="banner info" role="status">
            <span>{t("mods.abiUnknown", tag)}</span>
          </div>
        )}
        {(rowError || (tag && profileErrors[tag])) && (
          <div className="banner bad" role="alert">
            <span>{rowError ?? profileErrors[tag]}</span>
          </div>
        )}
      </div>

      {!report ? (
        <div className="empty-state">{t("loading")}</div>
      ) : view === "installed" ? (
        empty ? (
          <div className="empty-state framed-empty">
            <p>{t("mods.emptyInstalled", tag)}</p>
            <p className="hint">{t("mods.emptyInstalledHint")}</p>
            <div className="empty-actions">
              <button className="btn-primary" onClick={() => setView("browse")}>
                {t("mods.browseMods")}
              </button>
              {donor && (
                <button
                  className="btn-secondary"
                  disabled={running || !!mods.busy[`${tag}:copy`]}
                  onClick={async () => setRowError(await mods.copyProfile(donor.tag, tag))}
                >
                  {t("mods.copyButton", donor.tag)}
                </button>
              )}
            </div>
          </div>
        ) : (
          <InstalledList report={report} onError={setRowError} locked={running} />
        )
      ) : (
        <BrowseList report={report} locked={running} />
      )}

      {filePath && <FileInstallDialog tag={tag} path={filePath} onClose={() => setFilePath(null)} />}
      {showSources && <SourcesDialog onClose={() => setShowSources(false)} />}
    </main>
  );
}
