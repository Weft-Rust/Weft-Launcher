import { useI18n } from "../../i18n/useI18n";
import type { ModProgress, ProgressStage } from "../../mods/types";
import type { MessageKey } from "../../i18n";

const STEP: Record<ProgressStage, MessageKey> = {
  downloading: "mods.stepDownloading",
  verifying: "mods.stepVerifying",
  installing: "mods.stepInstalling",
};

interface ModProgressBarProps {
  progress: ModProgress | undefined;
  /** The name of the mod `progress` is about. */
  name: string;
  /** Offered while the operation can still stop: until its files are being installed. */
  onCancel?: () => void;
  cancelling?: boolean;
  /** Where there is no room for the words, e.g. a Browse card: the bar and the step only. */
  compact?: boolean;
}

/**
 * Which file of the operation is being worked on, what is happening to it, and a way to stop:
 * "File 2 of 3: Glowmoss, downloading 40%". The step is said once per change, not each percent.
 */
export function ModProgressBar({ progress, name, onCancel, cancelling = false, compact = false }: ModProgressBarProps) {
  const { t } = useI18n();
  const stage = progress?.stage ?? "downloading";
  const percent = stage === "downloading" ? (progress?.percent ?? 0) : 100;
  const count = progress?.count ?? 1;
  const index = progress?.index ?? 1;
  const step = t(STEP[stage], String(percent));
  const label = count > 1 ? t("mods.progressOf", String(index), String(count), name, step) : t("mods.progressOne", name, step);
  // Said on each new file and step, not on each percent.
  const spoken = count > 1 ? t("mods.progressOf", String(index), String(count), name, t(STEP[stage], "")) : t("mods.progressOne", name, t(STEP[stage], ""));
  const canCancel = !!onCancel && stage !== "installing";
  return (
    <div className={`progress-container${compact ? " compact" : ""}`} data-stage={stage}>
      <div className="progress-row">
        <div className="progress-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
          <div className="progress-fill" style={{ width: `round(down, ${percent}%, 4px)` }} />
        </div>
        {onCancel && (
          <button className="btn-secondary btn-small progress-cancel" onClick={onCancel} disabled={!canCancel || cancelling}>
            {cancelling ? t("mods.cancelling") : t("mods.cancelOperation")}
          </button>
        )}
      </div>
      <span className="progress-label" aria-hidden="true">
        {compact ? step : label}
      </span>
      <span className="sr-only" aria-live="polite">
        {spoken.replace(/[\s,:]+$/, "")}
      </span>
    </div>
  );
}
