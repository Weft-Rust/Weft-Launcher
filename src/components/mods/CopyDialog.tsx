import { useId, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import type { Shown } from "../../i18n/errors";
import { useMods } from "../../hooks/useMods";
import { usePlan } from "../../hooks/usePlan";
import type { CopyItem, CopyPreview, CopyResult, ModProgress, Trust } from "../../mods/types";
import { activeStep, consentChanges, copyConsentView, type CheckState, type ConsentView } from "../../mods/checks";
import { COPY_OUTCOME, copyConsent } from "../../mods/copyPlan";
import { networkDown } from "../../mods/select";
import { Dialog } from "../Dialog";
import { ErrorText } from "../ErrorText";
import { VersionSelect } from "../VersionSelect";
import { Truncate } from "../Truncate";
import { CheckMark } from "./CheckList";
import { ModProgressBar } from "./ModProgressBar";
import { PlanChanges, useOutcomeNote } from "./PlanChanges";
import { TrustBadge } from "./TrustBadge";

interface CopyDialogProps {
  /** The version that gets the mods. */
  tag: string;
  /** Versions that have mods turned on to copy, best first. */
  donors: string[];
  onClose: () => void;
}

/**
 * Copy mods from another version: what each mod gets and everything they bring along, then
 * progress with Cancel, then what happened. The copy is the preview on screen (contract R4 §2);
 * a preview for another pair of versions, or for sets that have changed since, never enables it.
 */
export function CopyDialog({ tag, donors, onClose }: CopyDialogProps) {
  const { t, tn, formatList } = useI18n();
  const mods = useMods();
  const { copyProfile, isCopying, progressOf, profile, nameIn, catalog, catalogError, cancel, isCancelling } = mods;
  const [from, setFrom] = useState(donors[0] ?? "");
  const [result, setResult] = useState<CopyResult | null>(null);
  const [error, setError] = useState<Shown | null>(null);
  const [changedFrom, setChangedFrom] = useState<ConsentView | null>(null);
  const outcomeNote = useOutcomeNote();
  const fromLabelId = useId();
  const copying = isCopying(tag);
  const target = profile(tag);
  const donor = profile(from);
  const name = nameIn(tag);
  const op = { kind: "copy", tag } as const;

  // Keyed by both versions; asked again when either set or the catalogue changes. Not after the
  // copy: the result is what shows then.
  const request = usePlan<CopyPreview>(from && !result ? `${from}|${tag}` : null, [target, donor, catalog], () => mods.previewCopy(from, tag));
  const preview = request.value;
  const consent = preview ? copyConsent(preview, target) : null;
  const toInstall = consent?.items ?? [];
  const events = progressOf(op);
  const byId = (id: string): ModProgress | undefined => events.find((p) => p.modId === id && p.sha256 !== "");
  const step = activeStep(events);
  const changes = changedFrom && preview && request.ready ? consentChanges(changedFrom, copyConsentView(preview), name) : null;
  const offline = networkDown(catalog, catalogError);
  const blocked = !request.ready || !toInstall.length;

  const confirm = async () => {
    if (copying || blocked || !preview) return;
    setError(null);
    outcomeNote.clear();
    const r = await copyProfile(preview);
    if (r.status === "done") setResult(r.result);
    else if (r.status === "cancelled") outcomeNote.cancelled();
    else if (r.status === "failed") {
      if (r.error.code === "ModChangedMeanwhile") {
        setChangedFrom(copyConsentView(preview));
        request.reload();
      }
      setError(r.shown);
    }
  };

  const title = result ? t("mods.copyDoneTitle", tag) : t("mods.copyTitle", from, tag);
  const label = toInstall.length ? tn("mods.copyConfirm", toInstall.length, tag) : t("mods.copyNothing");

  const footer = result ? (
    <button className="btn-primary" onClick={onClose} data-autofocus>
      {t("mods.close")}
    </button>
  ) : copying ? (
    <ModProgressBar progress={step} name={step ? name(step.modId) : ""} onCancel={() => cancel(op)} cancelling={isCancelling(op)} />
  ) : (
    <>
      <button className="btn-primary" onClick={confirm} disabled={blocked}>
        {offline && toInstall.length ? t("mods.needsNetworkButton", label) : label}
      </button>
      <button className="btn-secondary" onClick={onClose} data-autofocus>
        {t("mods.cancel")}
      </button>
    </>
  );

  const installedIds = new Set(result?.installed ?? []);

  return (
    <Dialog onClose={onClose} locked={copying} title={title} footer={footer}>
      {!result && (
        <div className="dialog-field">
          <span className="dialog-field-label" id={fromLabelId}>
            {t("mods.copyFrom")}
          </span>
          {donors.length > 1 ? (
            <VersionSelect
              value={from}
              options={donors.map((d) => ({ value: d, label: d }))}
              onChange={(f) => {
                setFrom(f);
                setChangedFrom(null);
                setError(null);
              }}
              disabled={copying}
              labelledBy={fromLabelId}
              compact
            />
          ) : (
            <strong className="dialog-field-value">{from}</strong>
          )}
        </div>
      )}
      {result ? (
        <>
          <p className="dialog-summary">{tn("mods.noticeCopied", result.installed.length, from)}</p>
          {result.installedOff.length > 0 && (
            <p className="dialog-note trust-change">
              {tn("mods.copyInstallsOff", result.installedOff.length, formatList(result.installedOff.map(name)), tag)}
            </p>
          )}
          {result.leftBehind.length > 0 && (
            <>
              <p className="dialog-note">{tn("mods.copyLeftBehindTitle", result.leftBehind.length)}</p>
              <CopyList items={result.leftBehind} tag={tag} />
            </>
          )}
          {result.missing.length > 0 && (
            <p className="dialog-note">{tn("mods.noticeMissing", result.missing.length, formatList(result.missing.map(name)), tag)}</p>
          )}
          {installedIds.size > 0 && <CopyList items={(preview?.items ?? []).filter((i) => installedIds.has(i.id))} tag={tag} done />}
        </>
      ) : request.error ? (
        <ErrorText error={request.error} />
      ) : !preview || !consent ? (
        <p className="dialog-note" role="status">
          {t("mods.planning")}
        </p>
      ) : (
        <>
          {toInstall.length > 0 && (
            <p className={`dialog-warning ${consent.unreviewed.length ? "red" : "amber"}`}>
              {consent.unreviewed.length ? t("mods.copyWarnUnreviewed", formatList(consent.unreviewed)) : t("mods.copyWarn")}
            </p>
          )}
          {changes && <PlanChanges changes={changes} />}
          {offline && toInstall.length > 0 && <p className="dialog-note trust-change">{t("mods.needsNetworkNote")}</p>}
          {consent.installedOff.length > 0 && (
            <p className="dialog-note trust-change">
              {tn("mods.copyInstallsOff", consent.installedOff.length, formatList(consent.installedOff.map(name)), tag)}
            </p>
          )}
          <p className="dialog-summary">{t("mods.copyIntro", tag)}</p>
          <CopyList items={preview.items} tag={tag} progressFor={copying ? byId : undefined} />
          {consent.deps.length > 0 && (
            <>
              <p className="dialog-note">{t("mods.copyAlsoInstalls")}</p>
              <ExtraList
                rows={consent.deps.map((d) => ({ id: d.id, state: "yes", text: t("mods.copyDepInstall", d.name, d.version), trust: d.trust }))}
                progressFor={copying ? byId : undefined}
              />
            </>
          )}
          {consent.enable.length > 0 && (
            <>
              <p className="dialog-note">{t("mods.copyAlsoEnables")}</p>
              <ExtraList rows={consent.enable.map((e) => ({ id: e.id, state: "yes", text: t("mods.copyDepEnable", e.name), trust: e.trust }))} />
            </>
          )}
          {consent.missing.length > 0 && (
            <ExtraList rows={consent.missing.map((id) => ({ id, state: "no", text: t("mods.copyDepMissing", name(id), tag) }))} />
          )}
        </>
      )}
      {outcomeNote.node}
      {error && !changes && <ErrorText error={error} />}
    </Dialog>
  );
}

/** Dependencies a copy brings along, each with its tier. */
function ExtraList({
  rows,
  progressFor,
}: {
  rows: { id: string; state: CheckState; text: string; trust?: Trust }[];
  progressFor?: (id: string) => ModProgress | undefined;
}) {
  return (
    <ul className="checks copy-list">
      {rows.map((r) => {
        const p = progressFor?.(r.id);
        return (
          <li key={r.id} className={`check check-${r.state}`}>
            <CheckMark state={r.state} />
            <span className="copy-item">
              <span className="copy-item-head">
                <span>{r.text}</span>
                {r.trust && <TrustBadge trust={r.trust} />}
              </span>
              {p && <ModProgressBar progress={p} name={r.text} compact />}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function CopyList({
  items,
  tag,
  done = false,
  progressFor,
}: {
  items: CopyItem[];
  tag: string;
  done?: boolean;
  progressFor?: (id: string) => ModProgress | undefined;
}) {
  const { t } = useI18n();
  return (
    <ul className="checks copy-list">
      {items.map((item) => {
        const o = COPY_OUTCOME[item.outcome];
        const p = progressFor && item.outcome === "install" ? progressFor(item.id) : undefined;
        return (
          <li key={item.id} className={`check check-${o.state}`}>
            <CheckMark state={o.state} />
            <span className="copy-item">
              <span className="copy-item-head">
                <Truncate className="copy-name" text={item.name} />
                {item.version && <span className="mod-version">{item.version}</span>}
                {item.trust && <TrustBadge trust={item.trust} />}
              </span>
              {p ? (
                <ModProgressBar progress={p} name={item.name} compact />
              ) : (
                <small>{done ? t("mods.copyInstalled", tag) : t(o.key, tag)}</small>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
