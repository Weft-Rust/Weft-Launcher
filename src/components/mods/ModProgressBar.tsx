import { useI18n } from "../../i18n/useI18n";
import type { ModProgress, ProgressStage } from "../../mods/types";

function stageKey(stage: ProgressStage) {
  switch (stage) {
    case "downloading":
      return "mods.stageDownloading" as const;
    case "verifying":
      return "mods.stageVerifying" as const;
    case "installing":
      return "mods.stageInstalling" as const;
    default: {
      const never: never = stage;
      return never;
    }
  }
}

/**
 * Download, check, install: the bar and the step it's on. Only the step is announced, once per
 * change; the percentage stays on screen.
 */
export function ModProgressBar({ progress, name }: { progress: ModProgress | undefined; name?: string }) {
  const { t } = useI18n();
  const stage = progress?.stage ?? "downloading";
  const percent = stage === "downloading" ? (progress?.percent ?? 0) : 100;
  const step = t(stageKey(stage));
  const label = stage === "downloading" ? t("mods.progressDownloading", String(percent)) : step;
  const spoken = name ? t("mods.progressSpoken", name, step) : step;
  return (
    <div className="progress-container">
      <div
        className="progress-bar"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={spoken}
      >
        <div className="progress-fill" style={{ width: `round(down, ${percent}%, 4px)` }} />
      </div>
      <span className="progress-label" aria-hidden="true">
        {label}
      </span>
      <span className="sr-only" aria-live="polite">
        {spoken}
      </span>
    </div>
  );
}
