import { useEffect, useId, useMemo, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../i18n/useI18n";
import { translateError } from "../i18n/errors";
import { useInstall } from "../hooks/useInstall";
import { useGameState } from "../hooks/useGameState";
import { useMods } from "../hooks/useMods";
import { useRovingTabs } from "../hooks/useRovingTabs";
import { modsApi } from "../mods/api";
import { copyDonors } from "../mods/select";
import { compareTags } from "../utils/version";
import { PixelIcon } from "../components/PixelIcon";
import { VersionSelect } from "../components/VersionSelect";
import { InstalledList } from "../components/mods/InstalledList";
import { BrowseList } from "../components/mods/BrowseList";
import { FileInstallDialog } from "../components/mods/FileInstallDialog";
import { SourcesDialog } from "../components/mods/SourcesDialog";
import { CopyDialog } from "../components/mods/CopyDialog";
import { BannerStack, type BannerItem } from "../components/mods/BannerStack";
import { useCatalogBanners } from "../components/mods/catalogBanners";
import { ModFailureNotice, useUpdateDialog } from "../components/mods/ModFixes";
import { REFRESH_ICON } from "../components/icons";

const VIEWS = ["installed", "browse"] as const;
type View = (typeof VIEWS)[number];

interface ModsPageProps {
  selectedTag: string | null;
  onSelectTag: (tag: string) => void;
  onGoToVersions: () => void;
}

export function ModsPage({ selectedTag, onSelectTag, onGoToVersions }: ModsPageProps) {
  const { t, tn, tm } = useI18n();
  const { installedVersions, loaded } = useInstall();
  const { isRunning, lastCrash } = useGameState();
  const mods = useMods();
  const { profile, profileError, notices, dismissNotice, catalogLoading, refreshCatalog, nameIn } = mods;
  const [view, setView] = useState<View>("installed");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [showCopy, setShowCopy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const versionLabelId = useId();
  const tabs = useRovingTabs("mods", VIEWS, view, setView);

  const versions = useMemo(() => [...installedVersions].sort((a, b) => compareTags(b.tag, a.tag)), [installedVersions]);
  const tag = versions.find((v) => v.tag === selectedTag)?.tag ?? versions[0]?.tag ?? null;
  const report = profile(tag);
  const running = tag ? isRunning(tag) : false;
  const update = useUpdateDialog(tag);
  const catalogBanners = useCatalogBanners(() => setShowSources(true));
  const donors = tag
    ? copyDonors(
        versions.map((v) => v.tag),
        tag,
        Object.fromEntries(versions.map((v) => [v.tag, profile(v.tag)]))
      )
    : [];

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

  const name = nameIn(tag);
  const empty = report && report.mods.length === 0;
  const error = rowError ?? profileError(tag);

  // What blocks the player or answers their last action shows in full. The rest folds away.
  const full: BannerItem[] = [];
  if (running) full.push({ id: "running", tone: "info", text: t("mods.runningBanner", tag) });
  for (const n of notices(tag)) {
    full.push({
      id: `notice:${n.id}`,
      tone: n.tone,
      text: n.lines.map((l, i) => (
        <span key={i} className="banner-line">
          {tm(l)}
        </span>
      )),
      actions: (
        <button className="btn-secondary btn-small" onClick={() => dismissNotice(n.id)}>
          {t("mods.dismiss")}
        </button>
      ),
    });
  }
  if (report && report.blocking.length > 0) {
    const names = report.blocking.map(name).join(", ");
    full.push({ id: "blocking", tone: "bad", text: tn("mods.blockingBanner", report.blocking.length, tag, names) });
  }
  if (error) full.push({ id: "error", tone: "bad", text: error });

  const quiet: BannerItem[] = [];
  if (report && report.unmanaged.length > 0) {
    const text = t("mods.unmanagedBanner", report.unmanaged.join(", "));
    quiet.push({
      id: "unmanaged",
      tone: "warn",
      text,
      summary: text,
      actions: (
        <button className="btn-secondary btn-small" onClick={() => modsApi.openPlayerModsFolder().catch(() => {})}>
          {t("mods.unmanagedShow")}
        </button>
      ),
    });
  }
  if (report?.abiError) {
    const text = t(view === "browse" ? "mods.abiUnknownBrowse" : "mods.abiUnknown", tag);
    quiet.push({ id: "abi", tone: "info", text, summary: text });
  }
  if (view === "browse") quiet.push(...catalogBanners);

  const count = report?.mods.length ?? 0;

  return (
    <main className="page mods-page">
      <header className="page-header clear">
        <h1>{t("mods.title")}</h1>
        <div className="header-actions">
          <span className="header-for" id={versionLabelId}>
            {t("mods.versionPicker")}
          </span>
          <VersionSelect
            value={tag}
            options={versions.map((v) => ({ value: v.tag, label: v.tag }))}
            onChange={onSelectTag}
            disabled={false}
            labelledBy={versionLabelId}
            compact
          />
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

      <div className="mods-toolbar">
        <div className="switch" role="tablist" aria-label={t("mods.viewsLabel", tag)}>
          {VIEWS.map((v) => (
            <button key={v} {...tabs.tab(v)} className={view === v ? "on" : ""}>
              {t(v === "installed" ? "mods.tabInstalled" : "mods.tabBrowse")}
              {v === "installed" && count > 0 && <span className="count">{count}</span>}
            </button>
          ))}
        </div>
        <div className="toolbar-actions">
          <button className="btn-secondary btn-small" onClick={pickFile} disabled={running}>
            {t("mods.fromFile")}
          </button>
          {donors.length > 0 && (
            <button className="btn-secondary btn-small" onClick={() => setShowCopy(true)} disabled={running || mods.isCopying(tag)}>
              {mods.isCopying(tag) ? t("mods.copying") : t("mods.copyHeader")}
            </button>
          )}
          <button className="btn-secondary btn-small" onClick={() => setShowSources(true)}>
            {t("mods.sources")}
          </button>
        </div>
      </div>

      {lastCrash && lastCrash.tag === tag && (
        <ModFailureNotice crash={lastCrash} onUpdate={update.open} canUpdate={update.canOpen} />
      )}
      <BannerStack full={full} quiet={quiet} />

      <section {...tabs.panel} className="mods-panel">
        {!report ? (
          <div className="empty-state" role="status">
            {t("loading")}
          </div>
        ) : view === "installed" ? (
          empty ? (
            <div className="empty-state framed-empty">
              <p>{t("mods.emptyInstalled", tag)}</p>
              <p className="hint">{t("mods.emptyInstalledHint")}</p>
              <div className="empty-actions">
                <button className="btn-primary" onClick={() => setView("browse")}>
                  {t("mods.browseMods")}
                </button>
                {donors.length > 0 && (
                  <button className="btn-secondary" disabled={running} onClick={() => setShowCopy(true)}>
                    {t("mods.copyButton", donors[0])}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <InstalledList
              report={report}
              onError={setRowError}
              onUpdate={update.open}
              canUpdate={update.canOpen}
              locked={running}
            />
          )
        ) : (
          <BrowseList report={report} locked={running} />
        )}
      </section>

      {filePath && <FileInstallDialog tag={tag} path={filePath} onClose={() => setFilePath(null)} />}
      {showSources && <SourcesDialog onClose={() => setShowSources(false)} />}
      {showCopy && <CopyDialog tag={tag} donors={donors} onClose={() => setShowCopy(false)} />}
      {update.dialog}
    </main>
  );
}
