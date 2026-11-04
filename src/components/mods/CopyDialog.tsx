import { useEffect, useId, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { translateError } from "../../i18n/errors";
import type { MessageKey } from "../../i18n";
import { useMods } from "../../hooks/useMods";
import type { CopyItem, CopyPreview, CopyResult, ModProgress } from "../../mods/types";
import type { CheckState } from "../../mods/checks";
import { Dialog } from "../Dialog";
import { PixelIcon } from "../PixelIcon";
import { VersionSelect } from "../VersionSelect";
import { Truncate } from "../Truncate";
import { ModProgressBar } from "./ModProgressBar";
import { TrustBadge } from "./TrustBadge";
import { CHECK, CROSS, QUESTION } from "./glyphs";

type Outcome = CopyItem["outcome"];

const OUTCOME: Record<Outcome, { state: CheckState; key: MessageKey }> = {
  install: { state: "yes", key: "mods.copyWillInstall" },
  alreadyThere: { state: "unknown", key: "mods.copyAlreadyThere" },
  noBuild: { state: "no", key: "mods.copyNoBuild" },
  localFile: { state: "no", key: "mods.copyLocalFile" },
  revoked: { state: "no", key: "mods.copyRevoked" },
};
const GLYPH: Record<CheckState, string[]> = { yes: CHECK, no: CROSS, unknown: QUESTION };
const SPOKEN: Record<CheckState, MessageKey> = { yes: "mods.ckPassed", no: "mods.ckFailed", unknown: "mods.ckUnknown" };

interface CopyDialogProps {
  /** The version that gets the mods. */
  tag: string;
  /** Versions that have mods to copy, best first. */
  donors: string[];
  onClose: () => void;
}

type Loaded = { from: string; preview: CopyPreview | null; error: string | null };

/** Copy a mod set from another version: which mods have a build here, then progress, then what happened. */
export function CopyDialog({ tag, donors, onClose }: CopyDialogProps) {
  const { t, tn } = useI18n();
  const { previewCopy, copyProfile, isCopying, progressForMod, profile, nameIn } = useMods();
  const [from, setFrom] = useState(donors[0] ?? "");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [result, setResult] = useState<CopyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fromLabelId = useId();
  const copying = isCopying(tag);
  const target = profile(tag);

  useEffect(() => {
    if (!from || result) return;
    let live = true;
    previewCopy(from, tag)
      .then((preview) => live && setLoaded({ from, preview, error: null }))
      .catch((err) => live && setLoaded({ from, preview: null, error: translateError(err) }));
    return () => {
      live = false;
    };
    // Previewed again when the target set changes, so "already there" stays true.
  }, [from, tag, previewCopy, result, target]);

  const preview = loaded?.from === from ? loaded.preview : null;
  const items = preview?.items ?? [];
  const toInstall = items.filter((i) => i.outcome === "install");
  const unreviewed = toInstall.filter((i) => i.trust !== "reviewed");
  // The one being worked on: how many have started.
  const started = toInstall.filter((i) => progressForMod(i.id)).length;

  const confirm = async () => {
    if (copying || !toInstall.length) return;
    setError(null);
    const r = await copyProfile(from, tag);
    if (r.status === "done") setResult(r.result);
    else if (r.status === "failed") setError(r.message);
  };

  const title = result
    ? t("mods.copyDoneTitle", tag)
    : t("mods.copyTitle", from, tag);

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
          {result.leftBehind.length > 0 && (
            <>
              <p className="dialog-note">{tn("mods.copyLeftBehindTitle", result.leftBehind.length)}</p>
              <CopyList items={result.leftBehind} tag={tag} />
            </>
          )}
          {result.missing.length > 0 && (
            <p className="dialog-note">{tn("mods.noticeMissing", result.missing.length, result.missing.map(nameIn(tag)).join(", "))}</p>
          )}
          {installedIds.size > 0 && <CopyList items={items.filter((i) => installedIds.has(i.id))} tag={tag} done />}
        </>
      ) : loaded?.from === from && loaded.error ? (
        <div className="inline-error" role="alert">
          {loaded.error}
        </div>
      ) : !preview ? (
        <p className="dialog-note" role="status">
          {t("mods.planning")}
        </p>
      ) : (
        <>
          {toInstall.length > 0 && (
            <p className={`dialog-warning ${unreviewed.length ? "red" : "amber"}`}>
              {unreviewed.length
                ? t("mods.copyWarnUnreviewed", unreviewed.map((i) => i.name).join(", "))
                : t("mods.copyWarn")}
            </p>
          )}
          <p className="dialog-summary">{t("mods.copyIntro", tag)}</p>
          <CopyList items={items} tag={tag} progressFor={copying ? progressForMod : undefined} />
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
        const o = OUTCOME[item.outcome];
        const p = progressFor && item.outcome === "install" ? progressFor(item.id) : undefined;
        return (
          <li key={item.id} className={`check check-${o.state}`}>
            <span className="check-mark" aria-hidden="true">
              <PixelIcon rows={GLYPH[o.state]} />
            </span>
            <span className="copy-item">
              <span className="copy-item-head">
                <span className="sr-only">{t(SPOKEN[o.state])}: </span>
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
