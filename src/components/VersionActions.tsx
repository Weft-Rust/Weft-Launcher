import { useState, useEffect } from "react";
import { useInstall, InstalledVersion, InstallProgress } from "../hooks/useInstall";
import { useGameState } from "../hooks/useGameState";
import { useI18n } from "../i18n/useI18n";
import { StableLabel } from "./StableLabel";

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
}

export function VersionActions({ release, installedVersion }: VersionActionsProps) {
  const { t } = useI18n();
  const { progress, busy: busyTags, errors, install, remove } = useInstall();
  const { anyRunning, isRunning, launch, runningTags } = useGameState();

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const busy = !!busyTags[release.tag];
  const currentProgress = busy ? progress[release.tag] : undefined;
  const error = errors[release.tag];
  const thisVersionRunning = isRunning(release.tag);

  useEffect(() => {
    if (confirmDelete) {
      const timer = setTimeout(() => {
        setConfirmDelete(false);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [confirmDelete]);

  const handleInstall = () =>
    install(release.tag, release.asset.url, release.asset.name, release.asset.sha256);

  const handleRemove = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }

    // Second click - proceed with deletion
    setConfirmDelete(false);
    await remove(release.tag);
  };

  const handleLaunch = async () => {
    setLaunchError(null);
    setLaunchError(await launch(release.tag));
  };

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
    }
  };

  const otherRunningTag = anyRunning ? Array.from(runningTags).find((t) => t !== release.tag) : null;
  const playTooltip = anyRunning && otherRunningTag ? t("playDisabledTooltip", otherRunningTag) : undefined;

  const deleteDisabled = anyRunning || busy;
  const playDisabled = anyRunning || thisVersionRunning || busy;

  if (installedVersion) {
    return (
      <div className="version-actions installed">
        <button
          className="play-btn"
          onClick={handleLaunch}
          disabled={playDisabled}
          title={playTooltip}
          aria-label={thisVersionRunning ? t("playing") : t("playButton")}
        >
          <StableLabel
            text={thisVersionRunning ? t("playing") : t("playButton")}
            widest={[t("playing"), t("playButton")]}
          />
        </button>
        <button
          className={`delete-btn${confirmDelete ? " confirming" : ""}`}
          onClick={handleRemove}
          disabled={deleteDisabled}
          title={anyRunning ? t("deleteDisabledTooltip") : undefined}
          aria-label={confirmDelete ? t("deleteForReal") : t("deleteButton")}
        >
          <StableLabel
            text={confirmDelete ? t("deleteForReal") : t("deleteButton")}
            widest={[t("deleteForReal"), t("deleteButton")]}
          />
        </button>
        {(launchError || error) && (
          <div className="install-error" role="alert">
            {launchError || error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="version-actions">
      {error && (
        <div className="install-error" role="alert">
          {error}
        </div>
      )}

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
