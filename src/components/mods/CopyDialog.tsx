import { useEffect, useId, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { translateError } from "../../i18n/errors";
import { useMods } from "../../hooks/useMods";
import type { CopyItem, CopyPreview, CopyResult, InstallPlan, ModProgress, Trust } from "../../mods/types";
import type { CheckState } from "../../mods/checks";
import { COPY_OUTCOME, copyConsent, copyItemSha } from "../../mods/copyPlan";
import { Dialog } from "../Dialog";
import { PixelIcon } from "../PixelIcon";
import { VersionSelect } from "../VersionSelect";
import { Truncate } from "../Truncate";
import { ModProgressBar } from "./ModProgressBar";
import { TrustBadge } from "./TrustBadge";
import { CHECK, CROSS, QUESTION } from "./glyphs";
import type { MessageKey } from "../../i18n";

const GLYPH: Record<CheckState, string[]> = { yes: CHECK, no: CROSS, unknown: QUESTION };
const SPOKEN: Record<CheckState, MessageKey> = { yes: "mods.ckPassed", no: "mods.ckFailed", unknown: "mods.ckUnknown" };

interface CopyDialogProps {
  /** The version that gets the mods. */
  tag: string;
  /** Versions that have mods turned on to copy, best first. */
  donors: string[];
  onClose: () => void;
}

type Loaded = { from: string; preview: CopyPreview | null; plans: Map<string, InstallPlan>; error: string | null };

/**
 * Copy a mod set from another version: what each mod gets and everything they bring along,
 * then progress, then what happened.
 */
export function CopyDialog({ tag, donors, onClose }: CopyDialogProps) {
  const { t, tn, formatList } = useI18n();
  const { previewCopy, plan, copyProfile, isCopying, progressOf, profile, nameIn, catalog } = useMods();
  const [from, setFrom] = useState(donors[0] ?? "");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [result, setResult] = useState<CopyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fromLabelId = useId();
  const copying = isCopying(tag);
  const target = profile(tag);
  const donor = profile(from);
  const name = nameIn(tag);

  useEffect(() => {
    if (!from || result) return;
    let live = true;
    (async () => {
      const preview = await previewCopy(from, tag);
      // The backend's plan for each mod says what it brings: dependencies, and what turns on.
      const plans = new Map<string, InstallPlan>();
      for (const item of preview.items) {
        const sha = copyItemSha(item, donor, catalog, target?.versionAbi ?? null);
        if (sha) plans.set(item.id, await plan(tag, sha));
      }
      return { preview, plans };
    })()
      .then(({ preview, plans }) => live && setLoaded({ from, preview, plans, error: null }))
      .catch((err) => live && setLoaded({ from, preview: null, plans: new Map(), error: translateError(err) }));
    return () => {
      live = false;
    };
    // Previewed again when either set changes, so "already there" stays true.
  }, [from, tag, previewCopy, plan, result, target, donor, catalog]);

  const preview = loaded?.from === from ? loaded.preview : null;
  const consent = preview ? copyConsent(preview, loaded!.plans, target) : null;
  const toInstall = consent?.items ?? [];
  const running = progressOf({ kind: "copy", tag });
  const progressById = (id: string): ModProgress | undefined => running.find((p) => p.modId === id);
  // The one being worked on: how many copied mods have started.
  const started = toInstall.filter((i) => progressById(i.id)).length;

  const confirm = async () => {
    if (copying || !toInstall.length) return;
    setError(null);
    const r = await copyProfile(from, tag, consent?.shas);
    if (r.status === "done") setResult(r.result);
    else if (r.status === "failed") setError(r.message);
  };

  const title = result ? t("mods.copyDoneTitle", tag) : t("mods.copyTitle", from, tag);

  const footer = result ? (
    <button className="btn-primary" onClick={onClose} data-autofocus>
      {t("mods.close")}
    </button>
  ) : copying ? (
    <span className="dialog-note" role="status">
      {t("mods.copyProgress", String(Math.max(1, started)), String(toInstall.length))}
    </span>
  ) : (
    <>
      <button className="btn-primary" onClick={confirm} disabled={!toInstall.length}>
        {toInstall.length ? tn("mods.copyConfirm", toInstall.length) : t("mods.copyNothing")}
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
              onChange={setFrom}
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
          <p className="dialog-summary" role="status">
            {tn("mods.noticeCopied", result.installed.length, from)}
          </p>
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
      ) : loaded?.from === from && loaded.error ? (
        <div className="inline-error" role="alert">
          {loaded.error}
        </div>
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
          {consent.installedOff.length > 0 && (
            <p className="dialog-note trust-change">
              {tn("mods.copyInstallsOff", consent.installedOff.length, formatList(consent.installedOff.map(name)), tag)}
            </p>
          )}
          <p className="dialog-summary">{t("mods.copyIntro", tag)}</p>
          <CopyList items={preview.items} tag={tag} progressFor={copying ? progressById : undefined} />
          {consent.deps.length > 0 && (
            <>
              <p className="dialog-note">{t("mods.copyAlsoInstalls")}</p>
              <ExtraList
                rows={consent.deps.map((d) => ({ id: d.id, state: "yes", text: t("mods.copyDepInstall", d.name, d.version), trust: d.trust }))}
                progressFor={copying ? progressById : undefined}
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
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  );
}

function Mark({ state }: { state: CheckState }) {
  const { t } = useI18n();
  return (
    <>
      <span className="check-mark" aria-hidden="true">
        <PixelIcon rows={GLYPH[state]} />
      </span>
      <span className="sr-only">{t(SPOKEN[state])}: </span>
    </>
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
            <Mark state={r.state} />
            <span className="copy-item">
              <span className="copy-item-head">
                <span>{r.text}</span>
                {r.trust && <TrustBadge trust={r.trust} />}
              </span>
              {p && <ModProgressBar progress={p} name={r.text} />}
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
            <Mark state={o.state} />
            <span className="copy-item">
              <span className="copy-item-head">
                <Truncate className="copy-name" text={item.name} />
                {item.version && <span className="mod-version">{item.version}</span>}
                {item.trust && <TrustBadge trust={item.trust} />}
              </span>
              {p ? (
                <ModProgressBar progress={p} name={item.name} />
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
