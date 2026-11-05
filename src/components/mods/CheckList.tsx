import { useCallback, useId, useRef, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import type { MessageKey } from "../../i18n";
import type { CheckRow, CheckState } from "../../mods/checks";
import { PixelIcon } from "../PixelIcon";
import { CHECK, CROSS, EQUALS, QUESTION } from "./glyphs";
import { RichText } from "./RichText";
import { TrustBadge } from "./TrustBadge";
import { FullValues } from "../Truncate";

const GLYPH: Record<CheckState, string[]> = { yes: CHECK, no: CROSS, unknown: QUESTION, same: EQUALS };
const SPOKEN: Record<CheckState, MessageKey> = { yes: "mods.ckPassed", no: "mods.ckFailed", unknown: "mods.ckUnknown", same: "mods.ckSame" };

/** A check's mark, and its result in words for a screen reader. */
export function CheckMark({ state, said }: { state: CheckState; said?: MessageKey | null }) {
  const { t } = useI18n();
  return (
    <>
      <span className="check-mark" aria-hidden="true">
        <PixelIcon rows={GLYPH[state]} />
      </span>
      {said !== null && <span className="sr-only">{t(said ?? SPOKEN[state])}: </span>}
    </>
  );
}

/** Whether a row carries a shortened value (a hash, a commit) whose full form can be shown. */
const hasCode = (c: CheckRow) => [c.title, c.detail].some((m) => m?.args?.some((a) => typeof a === "object" && "code" in a));

/**
 * What was checked, one line each. A list, so a screen reader reads it as one, each row with its
 * result first. A row that couldn't be found out offers Retry, when there is a way to retry.
 *
 * The checks that passed fold into one line ("5 checks passed · Show"), so what failed or is
 * unknown stays in view above the dialog's buttons in a small window; so do details that only say
 * again what is above them (`aside`). That line's one control shows them, and every shortened hash
 * and commit in the list whole: one tab stop for all of it.
 */
export function CheckList({ checks, label, onRetry, retrying = false }: { checks: CheckRow[]; label: string; onRetry?: () => void; retrying?: boolean }) {
  const { t, tn } = useI18n();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const passed = checks.filter((c) => c.state === "yes" || c.state === "same");
  const folds = passed.length >= 2;
  const codes = checks.some(hasCode);
  const asides = checks.some((c) => c.aside && c.detail && !passed.includes(c));
  return (
    <FullValues.Provider value={open}>
    <ul className="checks" aria-label={label} id={listId}>
      {checks.map((c) => (
        <li key={c.id} className={`check check-${c.state}`} data-check={c.id} hidden={folds && !open && passed.includes(c)}>
          <span className="check-mark" aria-hidden="true">
            <PixelIcon rows={GLYPH[c.state]} />
          </span>
          <span>
            <span className="sr-only">{t(c.said ?? SPOKEN[c.state])}: </span>
            <RichText msg={c.title} />
            {c.trust && (
              <>
                {" "}
                <TrustBadge trust={c.trust} />
              </>
            )}
            {c.retry && onRetry && (
              <>
                {" "}
                <button className="link-btn check-retry" onClick={onRetry} disabled={retrying}>
                  {retrying ? t("mods.retrying") : t("mods.retry")}
                </button>
              </>
            )}
            {c.detail && !(c.aside && !open) && (
              <small>
                <RichText msg={c.detail} />
              </small>
            )}
          </span>
        </li>
      ))}
      {(folds || codes || asides) && (
        <li className={`check check-fold${folds ? " check-yes" : ""}`} data-check="fold">
          <span className="check-mark" aria-hidden="true">
            {folds && <PixelIcon rows={GLYPH.yes} />}
          </span>
          <span>
            {folds && <>{tn("mods.checksPassed", passed.length)} · </>}
            <button className="link-btn check-fold-btn" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
              {open ? t("mods.checksHide") : folds ? t("mods.checksShow") : t("mods.checksShowDetails")}
            </button>
          </span>
        </li>
      )}
    </ul>
    </FullValues.Provider>
  );
}

/**
 * A Retry that says it is running: on while `run` works, so a second click can't ask twice and
 * the player sees it was taken.
 */
export function useRetry(run: () => Promise<unknown>): [() => Promise<void>, boolean] {
  const [busy, setBusy] = useState(false);
  const going = useRef(false);
  const retry = useCallback(async () => {
    if (going.current) return;
    going.current = true;
    setBusy(true);
    try {
      await run();
    } finally {
      going.current = false;
      setBusy(false);
    }
  }, [run]);
  return [retry, busy];
}
