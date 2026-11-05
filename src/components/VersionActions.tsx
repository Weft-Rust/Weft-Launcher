import { useInstall, InstalledVersion, InstallProgress } from "../hooks/useInstall";
import { useGameState } from "../hooks/useGameState";
import { useModProfiles } from "../hooks/useMods";
import { useLaunch } from "../hooks/useLaunch";
import { useConfirmPress } from "../hooks/useConfirmPress";
import { useI18n } from "../i18n/useI18n";
import { StableLabel } from "./StableLabel";
import { ErrorText } from "./ErrorText";
import { LaunchRefusal } from "./LaunchRefusal";
import { useAnnounce } from "./LiveRegion";
import { BlockerPanel, useReviewDialog } from "./mods/ModFixes";
import { ModFailureNotice } from "./mods/ModFailureNotice";
import { unreachable } from "../utils/never";

interface VersionActionsProps {
  release: {
    tag: string;
    asset: {
      name: string;
      url: string;
      size: number;
      sha256: string | null;
    };
  };
  installedVersion: InstalledVersion | null;
  /** Opens the Mods tab on this version, where what blocks it can be fixed. */
  onFixMods?: (tag: string) => void;
}

export function VersionActions({ release, installedVersion, onFixMods }: VersionActionsProps) {
  const announce = useAnnounce();
  const { t, tn } = useI18n();
  const { progress, busy: busyTags, errors, install, remove } = useInstall();
  const { profile } = useModProfiles();
  const report = installedVersion ? profile(release.tag) : undefined;
  const modCount = report?.mods.length ?? 0;
  const blocked = (report?.blocking.length ?? 0) > 0;
  const { anyRunning, isRunning, runningTags, lastCrash } = useGameState();
  const launch = useLaunch();
  const review = useReviewDialog(installedVersion ? release.tag : null);

  const busy = !!busyTags[release.tag];
  const currentProgress = busy ? progress[release.tag] : undefined;
  const error = errors[release.tag];
  const thisVersionRunning = isRunning(release.tag);
  const starting = launch.launching === release.tag;
  // Play was refused here because of mods: the blockers show here, with their fixes, until fixed.
  const refusedForMods = launch.refusalFor(release.tag).refusedForMods;
  const crash = installedVersion && lastCrash?.tag === release.tag ? lastCrash : null;

  // Deleting a version deletes its mod set too: the same deliberate confirmation as a mod's Remove.
  const deletion = useConfirmPress({
    onAsk: () =>
      announce(`delete-ask:${release.tag}:${Date.now()}`, t(modCount > 0 ? "deleteConfirmHint" : "deleteConfirmHintBare", release.tag)),
    onCancel: (said) => said && announce(`delete-cancelled:${release.tag}:${Date.now()}`, t("deleteCancelled", release.tag)),
    onDoubleClick: () => announce(`delete-double:${release.tag}:${Date.now()}`, t("deleteDoubleClick", release.tag)),
    onConfirm: () => remove(release.tag),
  });
  const confirmDelete = deletion.confirming;

  const handleInstall = () =>
    install(release.tag, release.asset.url, release.asset.name, release.asset.sha256);

  const getProgressLabel = (current: InstallProgress): string => {
    switch (current.stage) {
      case "downloading":
        return t(
          "progressDownloading",
          String(current.percent ?? 0),
          (current.speedMbps ?? 0).toFixed(1)
        );
      case "verifying":
        return t("progressVerifying");
      case "extracting":
        return t("progressExtracting");
      case "finalizing":
        return t("progressFinalizing");
      default:
        return unreachable(current.stage);
    }
  };

  const otherRunningTag = anyRunning ? Array.from(runningTags).find((t) => t !== release.tag) : null;
  const playTooltip = anyRunning && otherRunningTag ? t("playDisabledTooltip", otherRunningTag) : undefined;

  const deleteDisabled = anyRunning || busy;
  const playDisabled = anyRunning || thisVersionRunning || busy || blocked || !!launch.launching;
  const blockedId = `blocked-${release.tag}`;
  const playText = thisVersionRunning ? t("playing") : starting ? t("starting") : t("playButton");
  const confirmText = modCount > 0 ? tn("deleteWithMods", modCount) : t("deleteForReal");

  if (installedVersion) {
    return (
      <div className="version-actions installed">
        <button
          className="play-btn"
          onClick={() => launch.start(release.tag)}
          disabled={playDisabled}
          title={playTooltip}
          aria-label={playText}
          aria-describedby={blocked ? (refusedForMods ? `${blockedId}-why` : blockedId) : undefined}
          aria-busy={starting || undefined}
        >
          <StableLabel text={playText} widest={[t("playing"), t("starting"), t("playButton")]} />
        </button>
        <button
          className={`delete-btn${confirmDelete ? " confirming" : ""}`}
          disabled={deleteDisabled}
          title={anyRunning ? t("deleteDisabledTooltip") : undefined}
          aria-label={confirmDelete ? confirmText : t("deleteButton")}
          {...deletion.handlers}
        >
          <StableLabel text={confirmDelete ? confirmText : t("deleteButton")} widest={[confirmText, t("deleteButton")]} />
        </button>
        {blocked && !thisVersionRunning && !refusedForMods && (
          <span className="version-note bad">
            <span id={blockedId}>{t("versionModsBlocked")}</span>
            {onFixMods && (
              <button className="btn-secondary btn-small" onClick={() => onFixMods(release.tag)}>
                {t("mods.homeFixInMods")}
              </button>
            )}
          </span>
        )}
        {/* Play was refused here: why, and the fixes, here too, as on Home. */}
        {refusedForMods && blocked && (
          <div className="version-blockers">
            <BlockerPanel id={blockedId} tag={release.tag} locked={anyRunning} review={review} />
          </div>
        )}
        <LaunchRefusal tag={release.tag} launch={launch} />
        {error && <ErrorText error={error} className="install-error" />}
        {crash && (
          <div className="version-crash">
            <ModFailureNotice crash={crash} review={review} onGoToMods={onFixMods ? () => onFixMods(release.tag) : undefined} />
          </div>
        )}
        {review.dialog}
      </div>
    );
  }

  return (
    <div className="version-actions">
      {error && <ErrorText error={error} className="install-error" />}

      {/* In the button's place and no taller than it, so the list doesn't jump during an install. */}
      {currentProgress ? (
        <div className="progress-container">
          <div
            className="progress-bar"
            role="progressbar"
            aria-valuenow={currentProgress.percent ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={getProgressLabel(currentProgress)}
          >
            <div
              className="progress-fill"
              style={{ width: `round(down, ${currentProgress.percent ?? 0}%, 4px)` }}
            />
          </div>
          <span className="progress-label">{getProgressLabel(currentProgress)}</span>
        </div>
      ) : (
        <button
          className="install-btn"
          onClick={handleInstall}
          disabled={busy}
          aria-label={t("installButton")}
        >
          {t("installButton")}
        </button>
      )}
    </div>
  );
}
