import { useEffect, useId, useMemo, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../i18n/useI18n";
import { translateError } from "../i18n/errors";
import { useInstall } from "../hooks/useInstall";
import { useGameState } from "../hooks/useGameState";
import { useMods, type Notice } from "../hooks/useMods";
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
import { BlockerPanel, ModFailureNotice, useReviewDialog } from "../components/mods/ModFixes";
import { REFRESH_ICON } from "../components/icons";

const VIEWS = ["installed", "browse"] as const;
type View = (typeof VIEWS)[number];

interface ModsPageProps {
  selectedTag: string | null;
  onSelectTag: (tag: string) => void;
  onGoToVersions: () => void;
}

export function ModsPage({ selectedTag, onSelectTag, onGoToVersions }: ModsPageProps) {
  const { t, tn, tm, formatList } = useI18n();
  const { installedVersions, loaded } = useInstall();
  const { isRunning, lastCrash } = useGameState();
  const mods = useMods();
  const { profile, profileError, loadProfile, notices, dismissNotice, catalogLoading, refreshCatalog, nameIn, restore } = mods;
  const [view, setView] = useState<View>("installed");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [showCopy, setShowCopy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [focusMod, setFocusMod] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const versionLabelId = useId();
  const tabs = useRovingTabs("mods", VIEWS, view, setView);

  const versions = useMemo(() => [...installedVersions].sort((a, b) => compareTags(b.tag, a.tag)), [installedVersions]);
  const tag = versions.find((v) => v.tag === selectedTag)?.tag ?? versions[0]?.tag ?? null;
  const report = profile(tag);
  const running = tag ? isRunning(tag) : false;
  const review = useReviewDialog(tag);
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

  const openFolder = () =>
    modsApi.openPlayerModsFolder().catch((err) => setRowError(t("mods.folderFailed", translateError(err))));

  /** Focus that was on something that went away lands on the list. */
  const settleFocus = () => panel.current?.focus({ preventScroll: true });

  const undo = async (n: Notice) => {
    if (!n.undo) return;
    const r = await restore(tag, n.undo.id);
    if (r.status === "failed") setRowError(r.message);
    else if (r.status === "done") {
      setView("installed");
      setFocusMod(n.undo.id);
    }
  };

  const name = nameIn(tag);
  const empty = report && report.mods.length === 0;
  const loadFailed = profileError(tag);
  const blocked = (report?.blocking.length ?? 0) > 0;

  // What answers the player's last action, or must not be missed, shows in full. The rest folds
  // away, the catalogue's problems before the player's own folder.
  const full: BannerItem[] = [];
  const quiet: BannerItem[] = [];
  if (running) full.push({ id: "running", tone: "info", text: t("mods.runningBanner", tag) });
  for (const n of notices(tag)) {
    full.push({
      id: `notice:${n.id}`,
      tone: n.tone,
      reveal: true,
      text: n.lines.map((l, i) => (
        <span key={i} className="banner-line">
          {tm(l)}
        </span>
      )),
      actions: (
        <>
          {n.undo && (
            <button className="btn-secondary btn-small" onClick={() => undo(n)} aria-label={t("mods.undoLabel", n.undo.name)} disabled={running}>
              {t("mods.undo")}
            </button>
          )}
          <button
            className="btn-secondary btn-small"
            onClick={() => {
              dismissNotice(n.id);
              settleFocus();
            }}
          >
            {t("mods.dismiss")}
          </button>
        </>
      ),
    });
  }
  if (blocked) {
    const panelItem = <BlockerPanel tag={tag} locked={running} review={review} inBanner />;
    const summary = tn("mods.blockersShort", report!.blocking.length, tag, formatList(report!.blocking.map(name)));
    // On Installed the fixes sit right above the rows; on Browse they fold into one line.
    if (view === "installed") full.push({ id: "blocking", tone: "bad", text: panelItem });
    else quiet.push({ id: "blocking", tone: "bad", text: panelItem, summary, rank: 0 });
  }
  if (rowError) full.push({ id: "error", tone: "bad", text: rowError, alert: true });
  // "Reviewed mods are unavailable" ranks first, so it leads the one row on Browse and is never
  // behind "More". The row stays one line, so two rows of cards fit under it at 960×565.
  quiet.push(...catalogBanners.full.map((b) => ({ ...b, rank: view === "browse" ? -1 : b.rank })));
  quiet.push(...catalogBanners.quiet);
  if (report?.abiError) {
    const text = t(view === "browse" ? "mods.abiUnknownBrowse" : "mods.abiUnknown", tag);
    quiet.push({ id: "abi", tone: "info", text, summary: text, rank: 3 });
  }
  if (report && report.unmanaged.length > 0) {
    quiet.push({
      id: "unmanaged",
      tone: "warn",
      text: t("mods.unmanagedBanner", formatList(report.unmanaged)),
      summary: t("mods.unmanagedSummary"),
      rank: 4,
      actions: (
        <button className="btn-secondary btn-small" onClick={openFolder}>
          {t("mods.unmanagedShow")}
        </button>
      ),
    });
  }

  const count = report?.mods.length ?? 0;
  const copying = mods.isCopying(tag);

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
          <button className="btn-secondary btn-small" onClick={() => setShowSources(true)}>
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
          <button className="btn-secondary btn-small" onClick={pickFile} disabled={running || copying}>
            {t("mods.fromFile")}
          </button>
          {donors.length > 0 && (
            <button className="btn-secondary btn-small" onClick={() => setShowCopy(true)} disabled={running || copying}>
              {copying ? t("mods.copying") : t("mods.copyHeader")}
            </button>
          )}
        </div>
      </div>

      {lastCrash && lastCrash.tag === tag && <ModFailureNotice crash={lastCrash} review={review} />}
      <BannerStack full={full} quiet={quiet} />

      <section {...tabs.panel} className="mods-panel" ref={panel} tabIndex={-1}>
        {!report ? (
          loadFailed ? (
            <div className="empty-state framed-empty" role="alert">
              <p>{t("mods.profileFailed", tag, loadFailed)}</p>
              <div className="empty-actions">
                <button className="btn-primary" onClick={() => loadProfile(tag)}>
                  {t("mods.profileRetry")}
                </button>
              </div>
            </div>
          ) : (
            <div className="empty-state" role="status">
              {t("loading")}
            </div>
          )
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
              onUpdate={review.openUpdate}
              canUpdate={review.canUpdate}
              locked={running}
              focusMod={focusMod}
              onFocused={() => setFocusMod(null)}
              onEmptied={settleFocus}
            />
          )
        ) : (
          <BrowseList report={report} locked={running} />
        )}
      </section>

      {filePath && <FileInstallDialog tag={tag} path={filePath} onClose={() => setFilePath(null)} />}
      {showSources && <SourcesDialog onClose={() => setShowSources(false)} />}
      {showCopy && <CopyDialog tag={tag} donors={donors} onClose={() => setShowCopy(false)} />}
      {review.dialog}
    </main>
  );
}
