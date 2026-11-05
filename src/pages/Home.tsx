import { useEffect, useId, useMemo, useState } from "react";
import type { ProfileReport, UiError } from "../mods/types";
import { useI18n } from "../i18n/useI18n";
import { showError, type Shown } from "../i18n/errors";
import { ErrorText } from "../components/ErrorText";
import { useInstall } from "../hooks/useInstall";
import { useGameState } from "../hooks/useGameState";
import { useMods } from "../hooks/useMods";
import { launcherApi } from "../mods/api";
import { enabledNames, heroState } from "../mods/status";
import { StableLabel } from "../components/StableLabel";
import { VersionSelect } from "../components/VersionSelect";
import { Truncate } from "../components/Truncate";
import { BlockerPanel, useReviewDialog } from "../components/mods/ModFixes";
import { ModFailureNotice } from "../components/mods/ModFailureNotice";
import { compareTags } from "../utils/version";
import type { MessageKey } from "../i18n";
import type { HeroState } from "../mods/status";

interface HomeProps {
  onGoToVersions: () => void;
  onGoToMods: () => void;
  latestTag: string | null;
  selectedTag: string | null;
  onSelectTag: (tag: string | null) => void;
}

const BADGE: Record<HeroState, MessageKey> = {
  ready: "heroBadge",
  playing: "heroBadgePlaying",
  blocked: "heroBadgeBlocked",
  checking: "heroBadgeChecking",
  unchecked: "heroBadgeUnchecked",
};

/**
 * A refused start. For a refusal because of mods, `seen` is the set as it was known once the
 * launcher tried to read it again: only a newer one can say the refusal no longer holds.
 */
interface LaunchError {
  tag: string;
  error: UiError;
  shown: Shown;
  seen?: ProfileReport;
  /** The read again failed: the blocker panel can't say which mods, so this notice does. */
  unread?: Shown;
}

export function Home({ onGoToVersions, onGoToMods, latestTag, selectedTag, onSelectTag }: HomeProps) {
  const { t, locale, formatList } = useI18n();
  const { installedVersions, loaded } = useInstall();
  const { anyRunning, isRunning, launch, lastCrash } = useGameState();
  const { profile, profileError, isCopying, loadProfile, readProfile } = useMods();
  const [launchError, setLaunchError] = useState<LaunchError | null>(null);
  const [launching, setLaunching] = useState(false);
  const [rereading, setRereading] = useState(false);
  const blockersId = useId();

  const sortedVersions = useMemo(() => [...installedVersions].sort((a, b) => compareTags(b.tag, a.tag)), [installedVersions]);

  // The selection may be a version that has been deleted since.
  const selectedVersion = useMemo(
    () => sortedVersions.find((v) => v.tag === selectedTag) ?? sortedVersions[0] ?? null,
    [sortedVersions, selectedTag]
  );

  const effectiveTag = selectedVersion?.tag ?? null;
  const report = profile(effectiveTag);
  const review = useReviewDialog(effectiveTag);
  const isSelectedRunning = effectiveTag ? isRunning(effectiveTag) : false;
  const readError = effectiveTag ? profileError(effectiveTag) : null;
  const state = heroState(report, isSelectedRunning, !!readError);
  const blocked = state === "blocked";
  const crash = lastCrash && lastCrash.tag === effectiveTag ? lastCrash : null;
  const busyWithMods = effectiveTag ? isCopying(effectiveTag) : false;
  const playDisabled = !effectiveTag || anyRunning || isSelectedRunning || blocked || launching || busyWithMods;

  const handleLaunch = async (tag: string) => {
    if (launching) return;
    setLaunching(true);
    setLaunchError(null);
    const r = await launch(tag);
    if (r.status === "failed") {
      if (r.error.code === "ModsBlocked") {
        // The backend found a blocker the shown set doesn't have (a revocation Play applied, a
        // change from elsewhere): read the set again, so the panel can say what and offer fixes.
        // If that read fails, the refusal stays on screen, with a way to read it again.
        setLaunchError(await reread(tag, { tag, error: r.error, shown: r.shown }));
      } else {
        setLaunchError({ tag, error: r.error, shown: r.shown });
      }
    }
    setLaunching(false);
  };

  /** Reads a refused version's set again; the refusal then holds until a newer set clears it. */
  const reread = async (tag: string, refusal: LaunchError): Promise<LaunchError> => {
    setRereading(true);
    const r = await readProfile(tag);
    setRereading(false);
    if ("report" in r) return { ...refusal, seen: r.report, unread: undefined };
    return { ...refusal, seen: profile(tag), unread: r.error };
  };

  const handleOpenFolder = async () => {
    if (!effectiveTag) return;
    setLaunchError(null);
    try {
      await launcherApi.openGameFolder(effectiveTag);
    } catch (err) {
      setLaunchError({ tag: effectiveTag, error: { code: "Unknown", detail: null }, shown: showError(err) });
    }
  };

  // A refusal because mods blocked is about that set: once a report of it newer than the one
  // known at the refusal has nothing blocking (the player fixed it, here or on Mods), the
  // refusal no longer holds. An older report, or none, never clears it.
  const reportBlocks = (report?.blocking.length ?? 0) > 0;
  useEffect(() => {
    if (launchError?.error.code !== "ModsBlocked" || launchError.tag !== effectiveTag) return;
    if (report && report !== launchError.seen && !reportBlocks) setLaunchError(null);
    // A read that succeeds after a failed one: the panel takes over.
    else if (report && report !== launchError.seen && launchError.unread) setLaunchError({ ...launchError, seen: report, unread: undefined });
  }, [launchError, effectiveTag, report, reportBlocks]);

  if (!loaded) {
    return <main className="page home-page" />;
  }

  if (installedVersions.length === 0) {
    return (
      <main className="page home-page">
        <section className="hero empty clear">
          <h1 className="hero-title">WEFT</h1>
          <p className="empty-message">{t("noVersionsInstalled")}</p>
          <button className="btn-primary" onClick={onGoToVersions}>
            {t("goToVersionsTab")}
          </button>
        </section>
      </main>
    );
  }

  // A refused launch says why, unless the blocker panel below already says it with its fixes:
  // a refusal because of mods hides only behind a set that was read and shows what blocks.
  const refusal = launchError && launchError.tag === effectiveTag ? launchError : null;
  const modsRefusal = refusal?.error.code === "ModsBlocked" ? refusal : null;
  const unreadRefusal = modsRefusal && (modsRefusal.unread || !reportBlocks) ? modsRefusal : null;
  const shownError = refusal && !modsRefusal ? refusal.shown : null;
  // The set couldn't be read at all (no refusal involved): say so, with Retry, also here.
  const shownReadError = !report && readError && !unreadRefusal ? readError : null;
  // With something to read under Play, the title steps back so the actions stay in view.
  const compact = blocked || !!crash || !!shownError || !!unreadRefusal || !!shownReadError;
  const names = enabledNames(report);

  return (
    <main className="page home-page">
      <section className={`hero clear${compact ? " compact" : ""}`}>
        <div className="hero-header">
          <h1 className="hero-title">WEFT</h1>
          <div className={`hero-version-badge${blocked ? " bad" : ""}`} role="status">
            {t(BADGE[state], effectiveTag || "—")}
          </div>
        </div>
        <div className="hero-play-area">
          <VersionSelect
            value={effectiveTag || ""}
            options={sortedVersions.map((v) => ({
              value: v.tag,
              label: latestTag && v.tag === latestTag ? `${v.tag} — ${t("latestBadge")}` : v.tag,
            }))}
            onChange={onSelectTag}
            disabled={anyRunning}
            label={t("selectVersionLabel")}
          />
          <button
            className="btn-play"
            onClick={() => effectiveTag && handleLaunch(effectiveTag)}
            disabled={playDisabled}
            aria-describedby={blocked ? `${blockersId}-why` : undefined}
          >
            <StableLabel
              text={isSelectedRunning ? t("playing") : t("playButton")}
              widest={[t("playing"), t("playButton")]}
            />
          </button>
        </div>
        {/* Why Play is off, and the fixes, right under it. */}
        {effectiveTag && <BlockerPanel id={blockersId} tag={effectiveTag} locked={anyRunning} review={review} />}
        {shownError && <ErrorText error={shownError} className="launch-error" />}
        {unreadRefusal && effectiveTag && (
          <ErrorText
            error={{ ...(unreadRefusal.unread ?? unreadRefusal.shown), message: t("mods.refusedUnread", (unreadRefusal.unread ?? unreadRefusal.shown).message) }}
            className="launch-error refused-unread"
          >
            <button
              className="btn-secondary btn-small"
              disabled={rereading}
              onClick={async () => setLaunchError(await reread(effectiveTag, unreadRefusal))}
            >
              {rereading ? t("mods.retrying") : t("mods.refusedRetry")}
            </button>
          </ErrorText>
        )}
        {shownReadError && effectiveTag && (
          <ErrorText error={{ ...shownReadError, message: t("mods.homeProfileFailed", effectiveTag, shownReadError.message) }} className="launch-error">
            <button className="btn-secondary btn-small" disabled={rereading} onClick={async () => {
              setRereading(true);
              await loadProfile(effectiveTag);
              setRereading(false);
            }}>
              {rereading ? t("mods.retrying") : t("mods.profileRetry")}
            </button>
          </ErrorText>
        )}
        {report && effectiveTag && (
          <p className="mods-line">
            <Truncate text={names.length ? t("mods.homeMods", effectiveTag, formatList(names)) : t("mods.homeModsNone", effectiveTag)} />
            <button className="link-btn" onClick={onGoToMods}>
              {names.length ? t("mods.homeChange") : t("mods.homeAdd")}
            </button>
          </p>
        )}
        {crash && <ModFailureNotice crash={crash} review={review} onGoToMods={onGoToMods} />}
      </section>

      <section className="card clear">
        <div className="card-header">
          <h2 className="card-title">{t("instanceCardTitle")}</h2>
        </div>
        <div className="card-body">
          {selectedVersion ? (
            <>
              <div className="detail-row">
                <span className="detail-label">{t("versionLabel")}</span>
                <span className="detail-value">{selectedVersion.tag}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">{t("installedAtLabel")}</span>
                <span className="detail-value">{new Date(selectedVersion.installed_at).toLocaleString(locale)}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">{t("gameFolderTitle")}</span>
                <button className="btn-secondary btn-open-folder" onClick={handleOpenFolder}>
                  {t("openFolderButton")}
                </button>
              </div>
            </>
          ) : (
            <p className="select-version-hint">{t("selectVersionHint")}</p>
          )}
        </div>
      </section>
      {review.dialog}
    </main>
  );
}
