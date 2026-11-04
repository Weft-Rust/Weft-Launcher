import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { useMods } from "../../hooks/useMods";
import type { InstalledMod, ProfileReport } from "../../mods/types";
import { keepOrder, sortInstalled } from "../../mods/select";
import { depStates, modMeta } from "../../mods/status";
import { StableLabel } from "../StableLabel";
import { Truncate } from "../Truncate";
import { ModIcon } from "./ModIcon";
import { ModProgressBar } from "./ModProgressBar";
import { ChannelBadge, RevokedBadge, TrustBadge } from "./TrustBadge";

interface RowProps {
  tag: string;
  mod: InstalledMod;
  report: ProfileReport;
  onError: (message: string | null) => void;
  onUpdate: (mod: InstalledMod, sha256: string) => void;
  canUpdate: boolean;
  locked: boolean;
  /** Called before a removal and once the mod is gone, so focus can go to a row that is still there. */
  onRemoving: (id: string) => void;
  onRemoved: () => void;
}

function ModRow({ tag, mod, report, onError, onUpdate, canUpdate, locked, onRemoving, onRemoved }: RowProps) {
  const { t, tm } = useI18n();
  const { setEnabled, remove, isBusy, progressFor, nameIn, catalog } = useMods();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const meta = modMeta(mod, tag, nameIn(tag), mod.status === "missingDeps" ? depStates(mod, report, catalog) : undefined);
  const metaText = meta.parts.map(tm).join(" ");
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
    onRemoving(mod.id);
    const r = await remove(tag, mod.id);
    onError(r.status === "failed" ? r.message : null);
    if (r.status === "done") onRemoved();
  };

  const onToggle = async () => {
    const r = await setEnabled(tag, mod.id, !mod.enabled);
    onError(r.status === "failed" ? r.message : null);
  };

  const revoked = mod.status === "revoked";
  const rowClass = ["mod-row framed", mod.enabled ? "" : "is-off", meta.bad ? "has-problem" : ""].join(" ");

  return (
    <li className={rowClass} data-mod={mod.id}>
      <ModIcon id={mod.id} url={mod.icon} />
      <div className="mod-main">
        <div className="mod-title">
          <Truncate className="mod-name" text={mod.name} />
          {mod.version && <span className="mod-version">{mod.version}</span>}
          {revoked ? <RevokedBadge reason={mod.revokedReason} /> : <TrustBadge trust={mod.trust} />}
          <ChannelBadge channel={mod.channel} />
        </div>
        <Truncate className={`mod-meta${meta.bad ? " bad" : ""}`} text={metaText} lines={revoked ? 3 : 2} />
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
                  {t("mods.update", mod.update.version)}
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
          disabled={disabled || revoked}
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
        <span className="sr-only" aria-live="polite">
          {confirmRemove ? t("mods.removeConfirmHint", mod.name) : ""}
        </span>
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
  /** A mod whose row should take focus once it is shown, e.g. after Undo; then cleared. */
  focusMod: string | null;
  onFocused: () => void;
  /** Where focus goes when the list is empty after a removal. */
  onEmptied: () => void;
}

/**
 * The installed mods. Sorted when the list opens or the version changes, then kept in place: a
 * toggle never moves a row away from the pointer or from focus. When a row goes, focus goes to
 * the row that took its place, or the one before.
 */
export function InstalledList({ report, onError, onUpdate, canUpdate, locked, focusMod, onFocused, onEmptied }: InstalledListProps) {
  const { t } = useI18n();
  const list = useRef<HTMLUListElement>(null);
  const order = useRef<{ tag: string; ids: string[] } | null>(null);
  const [focusAfter, setFocusAfter] = useState<{ index: number } | null>(null);
  if (!order.current || order.current.tag !== report.tag) {
    order.current = { tag: report.tag, ids: sortInstalled(report.mods) };
  } else {
    order.current = { tag: report.tag, ids: keepOrder(order.current.ids, report.mods) };
  }
  const byId = new Map(report.mods.map((m) => [m.id, m]));
  const mods = order.current.ids.map((id) => byId.get(id)!).filter(Boolean);

  const focusRow = (id: string) => {
    const row = list.current?.querySelector<HTMLElement>(`[data-mod="${CSS.escape(id)}"]`);
    const target = row?.querySelector<HTMLElement>(".toggle:not(:disabled), .delete-btn:not(:disabled)");
    target?.focus();
    return !!target;
  };

  useLayoutEffect(() => {
    if (!focusAfter) return;
    setFocusAfter(null);
    const next = mods[Math.min(focusAfter.index, mods.length - 1)];
    if (!next || !focusRow(next.id)) onEmptied();
  });

  useLayoutEffect(() => {
    if (focusMod && byId.has(focusMod) && focusRow(focusMod)) onFocused();
  });

  // The removed row's place, taken before it goes: the row that moves into it gets focus.
  const removedAt = useRef(0);
  const onRemoving = (id: string) => {
    removedAt.current = Math.max(0, order.current!.ids.indexOf(id));
  };
  const onRemoved = () => setFocusAfter({ index: removedAt.current });

  return (
    <ul className="mod-list" aria-label={t("mods.installedListLabel", report.tag)} ref={list}>
      {mods.map((m) => (
        <ModRow
          key={m.id}
          tag={report.tag}
          mod={m}
          report={report}
          onError={onError}
          onUpdate={onUpdate}
          canUpdate={canUpdate(m)}
          locked={locked}
          onRemoving={onRemoving}
          onRemoved={onRemoved}
        />
      ))}
    </ul>
  );
}
