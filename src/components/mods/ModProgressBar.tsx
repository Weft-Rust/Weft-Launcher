import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import type { UiProgress, UiStage } from "../../mods/types";
import type { MessageKey } from "../../i18n";
import { announce } from "../LiveRegion";

/** What is shown: "downloading 40%" has the percent in it, the others don't. */
const STEP: Record<UiStage, MessageKey> = {
  preparing: "mods.stepPreparing",
  downloading: "mods.stepDownloading",
  verifying: "mods.stepVerifying",
  installing: "mods.stepInstalling",
};
/** What is said, once per step: never a number, so nothing like a lone "%" is left behind. */
const SPOKEN: Record<UiStage, MessageKey> = { ...STEP, downloading: "mods.stepDownloadingSpoken" };

/** The check of a file stays on screen at least this long, so the player sees it happen. */
export const VERIFY_DWELL_MS = 400;

/**
 * The stage to show: the newest, except that a check is held for VERIFY_DWELL_MS once it starts,
 * however quickly the backend moves on. Only what is drawn waits; the operation doesn't.
 */
function useDwell(stage: UiStage): UiStage {
  const [shown, setShown] = useState(stage);
  const since = useRef(0);
  useEffect(() => {
    if (stage === shown) return;
    if (stage === "verifying") since.current = Date.now();
    const wait = shown === "verifying" ? VERIFY_DWELL_MS - (Date.now() - since.current) : 0;
    if (wait <= 0) {
      setShown(stage);
      return;
    }
    const timer = setTimeout(() => setShown(stage), wait);
    return () => clearTimeout(timer);
  }, [stage, shown]);
  return shown;
}

interface ModProgressBarProps {
  progress: UiProgress | undefined;
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
  const stage = useDwell(progress?.stage ?? "preparing");
  const percent = stage === "downloading" ? (progress?.percent ?? 0) : stage === "preparing" ? 0 : 100;
  const count = progress?.count ?? 1;
  const index = progress?.index ?? 1;
  const whole = (step: string) => (count > 1 ? t("mods.progressOf", String(index), String(count), name, step) : t("mods.progressOne", name, step));
  const step = t(STEP[stage], String(percent));
  const label = whole(step);
  // Said on each new file and step, not on each percent.
  const spoken = whole(t(SPOKEN[stage]));
  const canCancel = !!onCancel && stage !== "installing";
  // Said through the one live region, once per file and step of this bar. A compact bar sits
  // beside a full one that says the same, so only the full one speaks.
  const bar = useId();
  useEffect(() => {
    if (!compact) announce(`progress:${bar}:${spoken}`, spoken);
  }, [bar, compact, spoken]);
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
    </div>
  );
}
