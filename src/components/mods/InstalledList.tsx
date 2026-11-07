import { useId, useLayoutEffect, useRef, useState } from "react";
import { useConfirmPress } from "../../hooks/useConfirmPress";
import { useI18n } from "../../i18n/useI18n";
import { useMods } from "../../hooks/useMods";
import type { InstalledMod, ProfileReport } from "../../mods/types";
import { keepOrder, sortInstalled } from "../../mods/select";
import { depStates, modMeta, shadowOf, turnOnWarnings } from "../../mods/status";
import type { Msg } from "../../i18n";
import { activeStep } from "../../mods/checks";
import type { Shown } from "../../i18n/errors";
import { useAnnounce } from "../LiveRegion";
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

/** Characters of a name that fit beside a row's switch and Remove in the smallest window. */
const LONG_NAME = 28;

function ModRow({ tag, mod, report, onError, onUpdate, canUpdate, updateWhy, locked, onRemoving, onRemoved }: RowProps) {
  const announce = useAnnounce();
  const { t, tm } = useI18n();
  const { setEnabled, remove, isBusy, progressOf, nameIn, catalog } = useMods();
  const hintId = useId();
  // The tier's meaning and the row's details, heard from the switch: the badge isn't a tab stop.
  const tierId = useId();
  const metaId = useId();
  const meta = modMeta(mod, tag, nameIn(tag), mod.status === "missingDeps" ? depStates(mod, report, catalog) : undefined, shadowOf(report, mod.id));
  const metaText = meta.parts.map(tm).join(" ");
  const working = isBusy(tag, mod.id);
  const events = progressOf({ kind: "mod", tag, id: mod.id });
  const updating = mod.update && events.length ? activeStep(events) : undefined;
  const disabled = working || locked;
  // A reason is read whole: it gets the row's width under the buttons, as many lines as it needs.
  const wide = meta.bad || meta.shadowed;
  // A name longer than fits beside the switch and Remove takes the row's width, and they move to
  // the line under it, so it wraps once rather than into a narrow column.
  const longName = mod.name.length > LONG_NAME;

  const removal = useConfirmPress({
    onAsk: () => announce(`remove-ask:${mod.id}:${Date.now()}`, t("mods.removeConfirmHint", mod.name)),
    onCancel: (said) => said && announce(`remove-cancelled:${mod.id}:${Date.now()}`, t("mods.removeCancelled", mod.name)),
    onDoubleClick: () => announce(`remove-double:${mod.id}:${Date.now()}`, t("mods.removeDoubleClick", mod.name)),
    onConfirm: async () => {
      onRemoving(mod.id);
      const r = await remove(tag, mod.id);
      onError(r.status === "failed" ? r.shown : null);
      if (r.status === "done") onRemoved();
    },
  });
  const confirmRemove = removal.confirming;

  // Turning on a mod that would stop Play asks first, with the reason in front of the player.
  const [askOn, setAskOn] = useState<Msg[] | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const askRef = useRef<HTMLButtonElement>(null);
  const toggle = async (enabled: boolean) => {
    const r = await setEnabled(tag, mod.id, enabled);
    onError(r.status === "failed" ? r.shown : null);
  };
  const onToggle = () => {
    if (!mod.enabled) {
      const warnings = turnOnWarnings(report, mod.id, nameIn(tag), catalog);
      if (warnings.length) {
        setAskOn(warnings);
        announce(`turn-on-ask:${mod.id}:${Date.now()}`, [t("mods.turnOnAsk", mod.name), ...warnings.map(tm)].join(" "));
        return;
      }
    }
    void toggle(!mod.enabled);
  };
  const closeAsk = (focusToggle: boolean) => {
    setAskOn(null);
    if (focusToggle) requestAnimationFrame(() => toggleRef.current?.focus());
  };
  useLayoutEffect(() => {
    if (askOn) askRef.current?.focus();
  }, [askOn]);

  const revoked = mod.status === "revoked";
  const rowClass = ["mod-row framed", mod.enabled ? "" : "is-off", meta.bad ? "has-problem" : "", wide ? "wide" : "", longName ? "long-name" : "", askOn ? "asking" : ""].join(" ");

  return (
    <li className={rowClass} data-mod={mod.id} data-shadowed={meta.shadowed || undefined} data-focus-scope>
      <ModIcon id={mod.id} url={mod.icon} />
      {/* The name whole, and its tier beside it; the tier goes under the name when both don't
          fit, never shortened. */}
      <div className="mod-title">
        <span className="mod-name" data-must-fit>
          {mod.name}
        </span>
        <span className="mod-badges">
          <ChannelBadge channel={mod.channel} />
          {revoked ? <RevokedBadge reason={mod.revokedReason} hintId={tierId} /> : <TrustBadge trust={mod.trust} hintId={tierId} />}
        </span>
      </div>
      {/* The version, then what the launcher knows: a reason is never cut, other details (a
          repo, what it needs) may be, with the full text a hover or a Tab away. */}
      <div className={`mod-meta${meta.bad ? " bad" : ""}`} data-must-fit={wide || undefined}>
        {mod.version && (
          <span className="mod-version" data-must-fit>
            {mod.version}
          </span>
        )}
        {/* An update sits by the version it replaces: the arrow and the new version; the label
            says the rest. */}
        {!updating && mod.update && (
          <button
            className="btn-flat primary chip update-btn-row"
            disabled={disabled || !canUpdate}
            onClick={() => onUpdate(mod, mod.update!.sha256)}
            aria-label={t("mods.updateLabelTo", mod.name, mod.update.version, tag)}
            title={updateWhy ?? t("mods.updateLabelTo", mod.name, mod.update.version, tag)}
          >
            <PixelIcon rows={ARROW_UP} />
            <span data-must-fit>{mod.update.version}</span>
          </button>
        )}
        {wide ? (
          <span className="mod-reason" id={metaId}>
            {metaText}
          </span>
        ) : (
          <Truncate className="mod-meta-text" text={metaText} id={metaId} />
        )}
        {!updating && mod.update && !canUpdate && updateWhy && (
          <span className="mod-update-why" data-must-fit>
            {updateWhy}
          </span>
        )}
      </div>
      <div className="mod-actions">
        {updating && <ModProgressBar progress={updating} nameOf={(p) => (p.modId === mod.id ? mod.name : nameIn(tag)(p.modId))} compact />}
        <button
          className={`toggle${mod.enabled ? " on" : ""}`}
          role="switch"
          aria-checked={mod.enabled}
          aria-label={mod.name}
          aria-describedby={`${tierId} ${metaId}`}
          disabled={disabled || revoked}
          onClick={onToggle}
          aria-expanded={askOn ? true : undefined}
          ref={toggleRef}
        >
          <span className="toggle-knob" aria-hidden="true" />
          <StableLabel text={mod.enabled ? t("mods.on") : t("mods.off")} widest={[t("mods.on"), t("mods.off")]} />
        </button>
        <button
          className={`delete-btn btn-small${confirmRemove ? " confirming" : ""}`}
          disabled={disabled}
          {...removal.handlers}
          aria-label={confirmRemove ? t("mods.removeConfirmLabel", mod.name) : t("mods.removeLabel", mod.name)}
          aria-describedby={confirmRemove ? hintId : undefined}
        >
          <StableLabel
            text={confirmRemove ? t("mods.removeConfirm") : t("mods.remove")}
            widest={[t("mods.removeConfirm"), t("mods.remove")]}
          />
        </button>
        <span className="sr-only" id={hintId}>
          {confirmRemove ? t("mods.removeConfirmHint", mod.name) : ""}
        </span>
      </div>
      {askOn && (
        <div
          className="mod-ask"
          role="group"
          aria-label={t("mods.turnOnAsk", mod.name)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              closeAsk(true);
            }
          }}
        >
          <span className="mod-ask-text" data-must-fit>
            <span className="mod-ask-lead">{t("mods.turnOnAsk", mod.name)}</span>
            {askOn.map((m, i) => (
              <span key={i} className="mod-ask-line">
                {tm(m)}
              </span>
            ))}
          </span>
          <span className="mod-ask-actions">
            <button className="btn-secondary btn-small" ref={askRef} onClick={() => closeAsk(true)}>
              {t("mods.keepOff")}
            </button>
            <button
              className="btn-secondary btn-small"
              onClick={() => {
                closeAsk(true);
                void toggle(true);
              }}
            >
              {t("mods.turnOnAnyway")}
            </button>
          </span>
        </div>
      )}
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
