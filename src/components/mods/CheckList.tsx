import { useCallback, useRef, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import type { MessageKey } from "../../i18n";
import type { CheckRow, CheckState } from "../../mods/checks";
import { PixelIcon } from "../PixelIcon";
import { CHECK, CROSS, EQUALS, QUESTION } from "./glyphs";
import { RichText } from "./RichText";
import { TrustBadge } from "./TrustBadge";

const GLYPH: Record<CheckState, string[]> = { yes: CHECK, no: CROSS, unknown: QUESTION, same: EQUALS };
const SPOKEN: Record<CheckState, MessageKey> = { yes: "mods.ckPassed", no: "mods.ckFailed", unknown: "mods.ckUnknown", same: "mods.ckSame" };

/** A check's mark, and its result in words for a screen reader. */
export function CheckMark({ state }: { state: CheckState }) {
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

/**
 * What was checked, one line each. A list, so a screen reader reads it as one, each row with its
 * result first. A row that couldn't be found out offers Retry, when there is a way to retry.
 */
export function CheckList({ checks, label, onRetry, retrying = false }: { checks: CheckRow[]; label: string; onRetry?: () => void; retrying?: boolean }) {
  const { t } = useI18n();
  return (
    <ul className="checks" aria-label={label}>
      {checks.map((c) => (
        <li key={c.id} className={`check check-${c.state}`} data-check={c.id}>
          <span className="check-mark" aria-hidden="true">
            <PixelIcon rows={GLYPH[c.state]} />
          </span>
          <span>
            <span className="sr-only">{t(SPOKEN[c.state])}: </span>
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
            {c.detail && (
              <small>
                <RichText msg={c.detail} />
              </small>
            )}
          </span>
        </li>
      ))}
    </ul>
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
