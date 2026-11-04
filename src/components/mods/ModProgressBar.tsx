import { useI18n } from "../../i18n/useI18n";
import type { ModProgress } from "../../mods/types";

export function ModProgressBar({ progress }: { progress: ModProgress | undefined }) {
  const { t } = useI18n();
  const percent = progress?.percent ?? 0;
  const label =
    progress?.stage === "verifying"
      ? t("mods.progressVerifying")
      : progress?.stage === "installing"
        ? t("mods.progressInstalling")
        : t("mods.progressDownloading", String(percent));
  return (
    <div className="progress-container">
      <div
        className="progress-bar"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className="progress-fill" style={{ width: `round(down, ${percent}%, 4px)` }} />
      </div>
      <span className="progress-label" aria-live="polite">
        {label}
      </span>
    </div>
  );
}
