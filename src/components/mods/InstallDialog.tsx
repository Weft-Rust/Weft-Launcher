import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../i18n/useI18n";
import { InstalledMod, Progress, modError } from "../../mods/api";

/** What the dialog shows. Without `run` it opens straight into the error. */
export interface DialogSpec {
  title: string;
  errorTitle: string;
  /** From file: the Unverified badge, a red warning and a red button. */
  unverified?: boolean;
  subtitle?: string;
  warning?: string;
  lines?: string[];
  source?: string;
  confirm?: string;
  run?: () => Promise<InstalledMod[]>;
  error?: string;
}

interface Props {
  spec: DialogSpec;
  tag: string;
  onDone: (list: InstalledMod[]) => void;
  onClose: () => void;
}

// One dialog for installs, updates and From file: review, then progress in the footer, then
// either closed (success) or one error line.
export function InstallDialog({ spec, tag, onDone, onClose }: Props) {
  const { t } = useI18n();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(spec.error ?? null);
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<Progress>("mods-progress", (e) => {
      if (e.payload.tag === tag) setProgress(e.payload);
    }).then((fn) => (cancelled ? fn() : (unlisten = fn)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [tag]);

  // Nothing dismisses it while it runs.
  const close = () => !running && onClose();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const install = async () => {
    setRunning(true);
    try {
      onDone(await spec.run!());
    } catch (err) {
      setError(modError(err, tag));
      setRunning(false);
    }
  };

  const percent = progress?.percent ?? (progress ? 100 : 0);
  const label = !progress
    ? ""
    : progress.percent === null
      ? t("mods.checking")
      : t("mods.progress", String(progress.file), String(progress.files), progress.name, String(progress.percent));

  return (
    <div className="dialog-backdrop" onClick={close}>
      <div className="dialog framed" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onClick={(e) => e.stopPropagation()}>
        {error !== null ? (
          <>
            <h2 id="dialog-title">{spec.errorTitle}</h2>
            <p className="dialog-error" role="alert">
              {error}
            </p>
            <p className="dialog-line">{t("mods.nothingInstalled")}</p>
            <footer className="dialog-footer">
              <button className="btn-secondary" onClick={onClose} autoFocus>
                {t("mods.close")}
              </button>
            </footer>
          </>
        ) : (
          <>
            <h2 id="dialog-title">{spec.title}</h2>
            {(spec.unverified || spec.subtitle) && (
              <p className="dialog-sub">
                {spec.unverified && <span className="badge unverified">! {t("mods.unverified")}</span>}
                {spec.subtitle}
              </p>
            )}
            {spec.warning && <p className={`dialog-warning${spec.unverified ? " danger" : ""}`}>{spec.warning}</p>}
            {spec.lines?.map((line) => (
              <p key={line} className="dialog-line">
                {line}
              </p>
            ))}
            <footer className="dialog-footer">
              {running ? (
                <div className="progress-container">
                  <div className="progress-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
                    <div className="progress-fill" style={{ width: `round(down, ${percent}%, 4px)` }} />
                  </div>
                  <span className="progress-label">{label}</span>
                </div>
              ) : (
                <>
                  {/* An unverified file isn't installed by pressing Enter. */}
                  <button className={spec.unverified ? "btn-danger" : "btn-primary"} onClick={install} autoFocus={!spec.unverified}>
                    {spec.confirm}
                  </button>
                  <button className="btn-secondary" onClick={onClose} autoFocus={spec.unverified}>
                    {t("mods.cancel")}
                  </button>
                </>
              )}
              {spec.source && (
                <button className="link-btn" onClick={() => openUrl(spec.source!)}>
                  {t("mods.viewSource")}
                </button>
              )}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
