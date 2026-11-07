import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { InstalledMod } from "../../mods/api";
import { StableLabel } from "../StableLabel";

interface Props {
  mods: InstalledMod[];
  readOnly: boolean;
  /** An error under one row, until the next change. */
  rowError: { id: string; text: string } | null;
  onToggle: (mod: InstalledMod) => void;
  onRemove: (mod: InstalledMod) => void;
  onUpdate: (mod: InstalledMod) => void;
}

export function InstalledList({ mods, readOnly, rowError, onToggle, onRemove, onUpdate }: Props) {
  const { t } = useI18n();
  // Remove needs a second press, like Delete on Versions.
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(null), 4000);
    return () => clearTimeout(timer);
  }, [confirming]);

  const remove = (mod: InstalledMod) => {
    if (confirming !== mod.id) return setConfirming(mod.id);
    setConfirming(null);
    onRemove(mod);
  };

  return (
    <ul className="mod-list">
      {mods.map((mod) => (
        <li key={mod.id} className={`mod-row framed${mod.on ? "" : " is-off"}`}>
          <div className="mod-info">
            <div className="mod-title">
              <span className="mod-name" id={`mod-${mod.id}`}>
                {mod.name}
              </span>
              {mod.unverified && <span className="badge unverified">! {t("mods.unverified")}</span>}
              {mod.revoked && <span className="badge revoked">{t("mods.revoked")}</span>}
            </div>
            <div className="mod-meta">
              {mod.version && <span>{mod.version}</span>}
              {mod.update && (
                <button className="chip" disabled={readOnly} title={t("mods.updateTo", mod.update)} onClick={() => onUpdate(mod)}>
                  ↑ {mod.update}
                </button>
              )}
              {mod.revoked && <span className="mod-reason">{mod.reason ?? t("mods.noReason")}</span>}
            </div>
          </div>
          <div className="mod-actions">
            <button
              className={`toggle${mod.on ? " on" : ""}`}
              aria-pressed={mod.on}
              aria-describedby={`mod-${mod.id}`}
              disabled={readOnly || mod.revoked}
              onClick={() => onToggle(mod)}
            >
              <span className="toggle-knob" />
              <StableLabel text={mod.on ? t("mods.on") : t("mods.off")} widest={[t("mods.on"), t("mods.off")]} />
            </button>
            <button
              className={`delete-btn${confirming === mod.id ? " confirming" : ""}`}
              aria-describedby={`mod-${mod.id}`}
              disabled={readOnly}
              onClick={() => remove(mod)}
            >
              <StableLabel
                text={confirming === mod.id ? t("mods.confirmRemove") : t("mods.remove")}
                widest={[t("mods.confirmRemove"), t("mods.remove")]}
              />
            </button>
          </div>
          {rowError?.id === mod.id && (
            <div className="install-error" role="alert">
              {rowError.text}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
