import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { useMods } from "../../hooks/useMods";
import type { InstalledMod, ProfileReport } from "../../mods/types";
import { keepOrder, sortInstalled } from "../../mods/select";
import { modMeta } from "../../mods/status";
import { StableLabel } from "../StableLabel";
import { Truncate } from "../Truncate";
import { ModIcon } from "./ModIcon";
import { ModProgressBar } from "./ModProgressBar";
import { ChannelBadge, TrustBadge } from "./TrustBadge";

interface RowProps {
  tag: string;
  mod: InstalledMod;
  onError: (message: string | null) => void;
  onUpdate: (mod: InstalledMod, sha256: string) => void;
  canUpdate: boolean;
  locked: boolean;
}

function ModRow({ tag, mod, onError, onUpdate, canUpdate, locked }: RowProps) {
  const { t, tm } = useI18n();
  const { setEnabled, remove, isBusy, progressFor, nameIn } = useMods();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const meta = modMeta(mod, tag, nameIn(tag));
  const metaText = meta.parts.map(tm).join(" · ");
  const working = isBusy(tag, mod.id);
  const updating = mod.update ? progressFor(mod.update.sha256) : undefined;
  const disabled = working || locked;

  useEffect(() => {
    if (!confirmRemove) return;
    const timer = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmRemove]);

  const onRemove = async () => {
    if (!confirmRemove) return setConfirmRemove(true);
    setConfirmRemove(false);
    const r = await remove(tag, mod.id);
    onError(r.status === "failed" ? r.message : null);
  };

  const onToggle = async () => {
    const r = await setEnabled(tag, mod.id, !mod.enabled);
    onError(r.status === "failed" ? r.message : null);
  };

  const fix = mod.status === "wrongVersion";
  const rowClass = ["mod-row framed", mod.enabled ? "" : "is-off", meta.bad ? "has-problem" : ""].join(" ");

  return (
    <li className={rowClass}>
      <ModIcon id={mod.id} url={mod.icon} />
      <div className="mod-main">
        <div className="mod-title">
          <Truncate className="mod-name" text={mod.name} />
          {mod.version && <span className="mod-version">{mod.version}</span>}
          <TrustBadge trust={mod.trust} />
          <ChannelBadge channel={mod.channel} />
        </div>
        <Truncate className={`mod-meta${meta.bad ? " bad" : ""}`} text={metaText} lines={2} />
        {(updating || mod.update) && (
          <div className="mod-update">
            {updating ? (
              <ModProgressBar progress={updating} name={mod.name} />
            ) : (
              mod.update && (
                <button
                  className="btn-primary btn-small"
                  disabled={disabled || !canUpdate}
                  onClick={() => onUpdate(mod, mod.update!.sha256)}
                  title={canUpdate ? undefined : t("mods.catalogMissing")}
                >
                  {fix ? t("mods.installFitting", mod.update.version) : t("mods.update", mod.update.version)}
                </button>
              )
            )}
          </div>
        )}
      </div>
      <div className="mod-actions">
        <button
          className={`toggle${mod.enabled ? " on" : ""}`}
          role="switch"
          aria-checked={mod.enabled}
          aria-label={t("mods.toggleLabel", mod.name)}
          disabled={disabled || mod.status === "revoked"}
          onClick={onToggle}
        >
          <span className="toggle-knob" aria-hidden="true" />
          <StableLabel text={mod.enabled ? t("mods.on") : t("mods.off")} widest={[t("mods.on"), t("mods.off")]} />
        </button>
        <button
          className={`delete-btn btn-small${confirmRemove ? " confirming" : ""}`}
          disabled={disabled}
          onClick={onRemove}
          aria-label={confirmRemove ? t("mods.removeConfirmLabel", mod.name) : t("mods.removeLabel", mod.name)}
        >
          <StableLabel
            text={confirmRemove ? t("mods.removeConfirm") : t("mods.remove")}
            widest={[t("mods.removeConfirm"), t("mods.remove")]}
          />
        </button>
      </div>
    </li>
  );
}

interface InstalledListProps {
  report: ProfileReport;
  onError: (message: string | null) => void;
  onUpdate: (mod: InstalledMod, sha256: string) => void;
  canUpdate: (mod: InstalledMod) => boolean;
  locked: boolean;
}

/**
 * The installed mods. Sorted when the list opens or the version changes, then kept in place: a
 * toggle never moves a row away from the pointer or from focus.
 */
export function InstalledList({ report, onError, onUpdate, canUpdate, locked }: InstalledListProps) {
  const { t } = useI18n();
  const order = useRef<{ tag: string; ids: string[] } | null>(null);
  if (!order.current || order.current.tag !== report.tag) {
    order.current = { tag: report.tag, ids: sortInstalled(report.mods) };
  } else {
    order.current = { tag: report.tag, ids: keepOrder(order.current.ids, report.mods) };
  }
  const byId = new Map(report.mods.map((m) => [m.id, m]));
  const mods = order.current.ids.map((id) => byId.get(id)!).filter(Boolean);
  return (
    <ul className="mod-list" aria-label={t("mods.installedListLabel", report.tag)}>
      {mods.map((m) => (
        <ModRow
          key={m.id}
          tag={report.tag}
          mod={m}
          onError={onError}
          onUpdate={onUpdate}
          canUpdate={canUpdate(m)}
          locked={locked}
        />
      ))}
    </ul>
  );
}
