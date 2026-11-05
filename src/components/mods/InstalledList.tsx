import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { useMods } from "../../hooks/useMods";
import type { InstalledMod, ProfileReport } from "../../mods/types";
import { keepOrder, sortInstalled } from "../../mods/select";
import { depStates, modMeta, shadowOf } from "../../mods/status";
import { activeStep } from "../../mods/checks";
import type { Shown } from "../../i18n/errors";
import { announce } from "../LiveRegion";
import { StableLabel } from "../StableLabel";
import { Truncate } from "../Truncate";
import { ModIcon } from "./ModIcon";
import { PixelIcon } from "../PixelIcon";
import { ARROW_UP } from "./glyphs";
import { ModProgressBar } from "./ModProgressBar";
import { ChannelBadge, RevokedBadge, TrustBadge } from "./TrustBadge";

interface RowProps {
  tag: string;
  mod: InstalledMod;
  report: ProfileReport;
  onError: (error: Shown | null) => void;
  onUpdate: (mod: InstalledMod, sha256: string) => void;
  canUpdate: boolean;
  /** Why the update can't be opened, when it can't. */
  updateWhy: string | null;
  locked: boolean;
  /** Called before a removal and once the mod is gone, so focus can go to a row that is still there. */
  onRemoving: (id: string) => void;
  onRemoved: () => void;
}

function ModRow({ tag, mod, report, onError, onUpdate, canUpdate, updateWhy, locked, onRemoving, onRemoved }: RowProps) {
  const { t, tm } = useI18n();
  const { setEnabled, remove, isBusy, progressOf, nameIn, catalog } = useMods();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const meta = modMeta(mod, tag, nameIn(tag), mod.status === "missingDeps" ? depStates(mod, report, catalog) : undefined, shadowOf(report, mod.id));
  const metaText = meta.parts.map(tm).join(" ");
  const working = isBusy(tag, mod.id);
  const events = progressOf({ kind: "mod", tag, id: mod.id });
  const updating = mod.update && events.length ? activeStep(events) : undefined;
  const disabled = working || locked;

  // The confirmation lapses: after 4 seconds, on Escape, or when focus leaves the button.
  const cancelRemove = (say: boolean) => {
    setConfirmRemove(false);
    if (say) announce(`remove-cancelled:${mod.id}:${Date.now()}`, t("mods.removeCancelled", mod.name));
  };
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
    onError(r.status === "failed" ? r.shown : null);
    if (r.status === "done") onRemoved();
  };

  const onToggle = async () => {
    const r = await setEnabled(tag, mod.id, !mod.enabled);
    onError(r.status === "failed" ? r.shown : null);
  };

  const revoked = mod.status === "revoked";
  const rowClass = ["mod-row framed", mod.enabled ? "" : "is-off", meta.bad ? "has-problem" : ""].join(" ");

  return (
    <li className={rowClass} data-mod={mod.id} data-shadowed={meta.shadowed || undefined}>
      <ModIcon id={mod.id} url={mod.icon} />
      <div className="mod-main">
        {/* The name has the line to itself; tier and version lead the line under it. */}
        <div className="mod-title">
          <Truncate className="mod-name" text={mod.name} />
          <ChannelBadge channel={mod.channel} />
        </div>
        <Truncate
          className={`mod-meta${meta.bad ? " bad" : ""}`}
          text={[mod.version, metaText].filter(Boolean).join(" · ")}
          // Two lines for a problem only this row states; a blocker's is said in full in the banner above.
          lines={(meta.bad || meta.shadowed) && !report.blocking.includes(mod.id) ? 2 : 1}
        >
          {revoked ? <RevokedBadge reason={mod.revokedReason} /> : <TrustBadge trust={mod.trust} />}{" "}
          {mod.version && <span className="mod-version">{mod.version}</span>} <span className="mod-meta-text">{metaText}</span>
        </Truncate>
        {!updating && mod.update && !canUpdate && updateWhy && <span className="mod-update-why">{updateWhy}</span>}
      </div>
      <div className="mod-actions">
        {updating ? (
          <ModProgressBar progress={updating} name={updating.modId === mod.id ? mod.name : nameIn(tag)(updating.modId)} compact />
        ) : (
          mod.update && (
            // Short, so the name keeps its room: the arrow and the version; the label says the rest.
            <button
              className="btn-primary btn-small update-btn-row"
              disabled={disabled || !canUpdate}
              onClick={() => onUpdate(mod, mod.update!.sha256)}
              aria-label={t("mods.updateLabelTo", mod.name, mod.update.version)}
              title={updateWhy ?? t("mods.updateLabelTo", mod.name, mod.update.version)}
            >
              <PixelIcon rows={ARROW_UP} />
              {mod.update.version}
            </button>
          )
        )}
        <button
          className={`toggle${mod.enabled ? " on" : ""}`}
          role="switch"
          aria-checked={mod.enabled}
          aria-label={mod.name}
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
          onKeyDown={(e) => {
            if (e.key === "Escape" && confirmRemove) {
              e.stopPropagation();
              cancelRemove(true);
            }
          }}
          onBlur={() => confirmRemove && cancelRemove(false)}
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
  onError: (error: Shown | null) => void;
  onUpdate: (mod: InstalledMod, sha256: string) => void;
  canUpdate: (mod: InstalledMod) => boolean;
  /** Why updates can't be opened right now (the mod list couldn't be loaded), if they can't. */
  updatesUnavailable: string | null;
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
export function InstalledList({ report, onError, onUpdate, canUpdate, updatesUnavailable, locked, focusMod, onFocused, onEmptied }: InstalledListProps) {
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
          canUpdate={canUpdate(m) && !updatesUnavailable}
          updateWhy={updatesUnavailable ?? (canUpdate(m) ? null : t("mods.catalogMissing"))}
          locked={locked}
          onRemoving={onRemoving}
          onRemoved={onRemoved}
        />
      ))}
    </ul>
  );
}
