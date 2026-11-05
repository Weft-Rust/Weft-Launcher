import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../i18n/useI18n";
import { showError, type Shown } from "../i18n/errors";
import { bannerPlan } from "../mods/banners";
import { ErrorDetails } from "../components/ErrorText";
import { announce } from "../components/LiveRegion";
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
import { BannerStack, Toasts, type BannerItem } from "../components/mods/BannerStack";
import { useCatalogBanners } from "../components/mods/catalogBanners";
import { BlockerPanel, useReviewDialog } from "../components/mods/ModFixes";
import { ModFailureNotice } from "../components/mods/ModFailureNotice";
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
  const [rowError, setRowError] = useState<Shown | null>(null);
  const [focusMod, setFocusMod] = useState<string | null>(null);
  const [toastRoom, setToastRoom] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const versionLabelId = useId();
  const pendingId = useId();
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
  // A toast that appears over the row with focus (the row after a removed one) moves that row
  // into the room the list keeps above it.
  useEffect(() => {
    const active = document.activeElement;
    if (toastRoom && active instanceof HTMLElement && panel.current?.contains(active)) active.scrollIntoView({ block: "nearest" });
  }, [toastRoom]);
  // A failed row action is said once, politely, like every result.
  useEffect(() => {
    if (rowError) announce(`row-error:${Date.now()}`, rowError.message);
  }, [rowError]);

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
      setRowError(showError(err));
    }
  };

  const openFolder = () =>
    modsApi.openPlayerModsFolder().catch((err) => {
      const shown = showError(err);
      setRowError({ ...shown, message: t("mods.folderFailed", shown.message) });
    });

  /** Focus that was on something that went away lands on the list. */
  const settleFocus = () => panel.current?.focus({ preventScroll: true });

  const undo = async (n: Notice) => {
    if (!n.undo) return;
    const r = await restore(tag, n.undo.id);
    if (r.status === "failed") setRowError(r.shown);
    else if (r.status === "done") {
      setView("installed");
      setFocusMod(n.undo.id);
    }
  };

  const name = nameIn(tag);
  const empty = report && report.mods.length === 0;
  const loadFailed = profileError(tag);
  const blocked = (report?.blocking.length ?? 0) > 0;
  const shadowedOff = (report?.shadowed ?? []).filter((x) => x.managed === "off");
  const catalog = mods.catalog;

  const plan = bannerPlan({
    view,
    running,
    notices: notices(tag).map((n) => n.id),
    blocked,
    rowError: !!rowError,
    index: catalog?.index.freshness ?? null,
    indexTrouble: !!catalog?.index.error || !!catalog?.index.cacheError,
    refreshFailed: !!catalog && !!mods.catalogError,
    sources: (catalog?.sources ?? []).filter((x) => x.error).map((x) => x.repo),
    sourcesDamaged: !!catalog?.sourcesError,
    abiUnknown: !!report?.abiError,
    shadowed: shadowedOff.length > 0,
    unmanaged: (report?.unmanaged.length ?? 0) > 0,
  });

  const showFolder = (
    <button className="btn-flat" onClick={openFolder}>
      {t("mods.unmanagedShow")}
    </button>
  );
  const item = (id: string): BannerItem | null => {
    if (id === "running") {
      // A revocation that arrived while the game runs is applied when it stops (the backend
      // never rewrites a running version's mods); say so rather than look like nothing happened.
      const pending = report?.revocationsPending ?? [];
      return {
        id,
        tone: pending.length ? "warn" : "info",
        text: pending.length ? (
          <>
            <span className="banner-line">{t("mods.runningBanner", tag)}</span>
            <span className="banner-line">{t("mods.revocationsPending", formatList(pending.map(name)))}</span>
          </>
        ) : (
          t("mods.runningBanner", tag)
        ),
      };
    }
    if (id.startsWith("notice:")) {
      const n = notices(tag).find((x) => `notice:${x.id}` === id);
      if (!n) return null;
      return {
        id,
        tone: n.tone,
        text: n.lines.map((l, i) => (
          <span key={i} className="banner-line">
            {tm(l)}
          </span>
        )),
        actions: (
          <>
            {n.undo && (
              <button className="btn-flat" onClick={() => undo(n)} aria-label={t("mods.undoLabel", n.undo.name)} disabled={running}>
                {t("mods.undo")}
              </button>
            )}
            <button
              className="btn-flat"
              onClick={() => {
                dismissNotice(n.id);
                settleFocus();
              }}
            >
              {t("mods.dismiss")}
            </button>
          </>
        ),
      };
    }
    if (id === "error" && rowError) {
      return {
        id,
        tone: "bad",
        text: (
          <>
            {rowError.message}
            {rowError.detail && <ErrorDetails detail={rowError.detail} label={t("errors.details")} />}
          </>
        ),
        actions: (
          <button
            className="btn-flat"
            onClick={() => {
              setRowError(null);
              settleFocus();
            }}
          >
            {t("mods.dismiss")}
          </button>
        ),
      };
    }
    if (id === "blocking" && report) {
      // Folded (on Browse): Play is off, and for which mod, never cut.
      const cause = report.blocking.length === 1 ? t("mods.playOffOne", name(report.blocking[0])) : tn("mods.playOffMany", report.blocking.length);
      return { id, tone: "bad", text: <BlockerPanel tag={tag} locked={running} review={review} inBanner />, cause };
    }
    if (id === "abi") {
      const text = t(view === "browse" ? "mods.abiUnknownBrowse" : "mods.abiUnknown", tag);
      return { id, tone: "info", text, cause: t("mods.abiUnknownShort", tag), actions: <RetryProfile tag={tag} /> };
    }
    if (id === "shadowed") {
      const list = formatList(shadowedOff.map((x) => `${name(x.id)} (${x.file})`));
      return { id, tone: "warn", text: t("mods.shadowBanner", list), cause: t("mods.shadowCause"), subject: formatList(shadowedOff.map((x) => name(x.id))), actions: showFolder };
    }
    if (id === "unmanaged" && report) {
      return {
        id,
        tone: "warn",
        text: t("mods.unmanagedBanner", formatList(report.unmanaged)),
        cause: tn("mods.unmanagedCause", report.unmanaged.length),
        actions: showFolder,
      };
    }
    return catalogBanners[id] ?? null;
  };
  const full = plan.full.map((p) => item(p.id)).filter((x): x is BannerItem => !!x);
  const quiet = plan.quiet.map((p) => item(p.id)).filter((x): x is BannerItem => !!x).map((x, i) => ({ ...x, rank: i }));
  const toasts = plan.toasts.map((p) => item(p.id)).filter((x): x is BannerItem => !!x);

  const count = report?.mods.length ?? 0;
  const copying = mods.isCopying(tag);
  const pending = mods.pendingSources;
  const pendingText = pending.length === 0 ? null : pending.length === 1 ? t("mods.sourcePending", pending[0]) : tn("mods.sourcesPending", pending.length);

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
          <button className="btn-flat" onClick={() => setShowSources(true)}>
            {t("mods.sources")}
          </button>
          <button
            className={`btn-flat icon-btn mods-refresh${pendingText ? " pending" : ""}`}
            onClick={refreshCatalog}
            disabled={catalogLoading}
            title={pendingText ?? t("mods.refresh")}
            aria-label={t("mods.refresh")}
            aria-describedby={pendingText ? pendingId : undefined}
          >
            <PixelIcon rows={REFRESH_ICON} scale={3} />
          </button>
          {/* The index is in and shows; a slow source is still being asked. Said, and named on
              the refresh button (and in Sources), without taking room from the list. */}
          <span className="sr-only" role="status" id={pendingId}>
            {pendingText}
          </span>
        </div>
      </header>

      <div className="mods-toolbar">
        <div className="switch" role="tablist" aria-label={t("mods.viewsLabel", tag)}>
          {VIEWS.map((v) => (
            <button
              key={v}
              {...tabs.tab(v)}
              className={view === v ? "on" : ""}
              // The count alone says nothing heard out of context: which version, and of what.
              aria-label={v === "installed" && count > 0 ? tn("mods.tabInstalledLabel", count, tag) : undefined}
            >
              {t(v === "installed" ? "mods.tabInstalled" : "mods.tabBrowse")}
              {v === "installed" && count > 0 && <span className="count">{count}</span>}
            </button>
          ))}
        </div>
        <div className="toolbar-actions">
          <button className="btn-flat" onClick={pickFile} disabled={running || copying}>
            {t("mods.fromFile")}
          </button>
          {donors.length > 0 && (
            <button className="btn-flat" onClick={() => setShowCopy(true)} disabled={running || copying}>
              {copying ? t("mods.copying") : t("mods.copyHeader")}
            </button>
          )}
        </div>
      </div>

      {lastCrash && lastCrash.tag === tag && <ModFailureNotice crash={lastCrash} review={review} />}
      <BannerStack full={full} quiet={quiet} />

      <div className="mods-list-area">
      <section
        {...tabs.panel}
        className="mods-panel"
        data-focus-scope
        ref={panel}
        tabIndex={-1}
        style={{ "--toast-room": `${toastRoom}px` } as CSSProperties}
      >
        {!report ? (
          loadFailed ? (
            <div className="empty-state framed-empty">
              <p>{t("mods.profileFailed", tag, loadFailed.message)}</p>
              {loadFailed.detail && <ErrorDetails detail={loadFailed.detail} label={t("errors.details")} />}
              <div className="empty-actions">
                <button className="btn-primary" onClick={() => loadProfile(tag, true)}>
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
              updatesUnavailable={!catalog && mods.catalogError ? t("mods.updatesNeedCatalog") : null}
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
      <Toasts items={toasts} onHeight={setToastRoom} />
      </div>

      {filePath && <FileInstallDialog tag={tag} path={filePath} onClose={() => setFilePath(null)} />}
      {showSources && <SourcesDialog onClose={() => setShowSources(false)} />}
      {showCopy && <CopyDialog tag={tag} donors={donors} onClose={() => setShowCopy(false)} />}
      {review.dialog}
    </main>
  );
}

/** Asks for the version's set again: the mod interface may be found out this time. */
function RetryProfile({ tag }: { tag: string }) {
  const { t } = useI18n();
  const { loadProfile, refreshCatalog } = useMods();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn-flat"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await Promise.all([loadProfile(tag, true), refreshCatalog()]);
        setBusy(false);
      }}
    >
      {busy ? t("mods.retrying") : t("mods.retry")}
    </button>
  );
}
