import { useId, useMemo, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { showError } from "../i18n/errors";
import { ErrorText } from "../components/ErrorText";
import { useInstall } from "../hooks/useInstall";
import { useGameState } from "../hooks/useGameState";
import { useMods } from "../hooks/useMods";
import { useLaunch } from "../hooks/useLaunch";
import { LaunchRefusal } from "../components/LaunchRefusal";
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

export function Home({ onGoToVersions, onGoToMods, latestTag, selectedTag, onSelectTag }: HomeProps) {
  const { t, locale, formatList } = useI18n();
  const { installedVersions, loaded } = useInstall();
  const { anyRunning, isRunning, lastCrash } = useGameState();
  const { profile, profileError, isCopying, loadProfile } = useMods();
  const launch = useLaunch();
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
  const launching = !!launch.launching;
  const playDisabled = !effectiveTag || anyRunning || isSelectedRunning || blocked || launching || busyWithMods;

  const handleOpenFolder = async () => {
    if (!effectiveTag) return;
    launch.clear();
    try {
      await launcherApi.openGameFolder(effectiveTag);
    } catch (err) {
      launch.fail(effectiveTag, { code: "Unknown", detail: null }, showError(err));
    }
  };

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

  // A refused launch says why, unless the blocker panel below already says it with its fixes.
  const { shownError, unread: unreadRefusal } = launch.refusalFor(effectiveTag);
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
            onClick={() => effectiveTag && launch.start(effectiveTag)}
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
        {effectiveTag && <LaunchRefusal tag={effectiveTag} launch={launch} />}
        {shownReadError && effectiveTag && (
          <ErrorText error={{ ...shownReadError, message: t("mods.homeProfileFailed", effectiveTag, shownReadError.message) }} className="launch-error">
            <button className="btn-secondary btn-small" disabled={rereading} onClick={async () => {
              setRereading(true);
              await loadProfile(effectiveTag, true);
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
