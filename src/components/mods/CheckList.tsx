import { useI18n } from "../../i18n/useI18n";
import type { MessageKey } from "../../i18n";
import type { CheckRow, CheckState } from "../../mods/checks";
import { PixelIcon } from "../PixelIcon";
import { CHECK, CROSS, QUESTION } from "./glyphs";
import { RichText } from "./RichText";
import { TrustBadge } from "./TrustBadge";

const GLYPH: Record<CheckState, string[]> = { yes: CHECK, no: CROSS, unknown: QUESTION };
const SPOKEN: Record<CheckState, MessageKey> = { yes: "mods.ckPassed", no: "mods.ckFailed", unknown: "mods.ckUnknown" };

/** What was checked, one line each. A list, so a screen reader reads it as one, each row with its result first. */
export function CheckList({ checks, label }: { checks: CheckRow[]; label: string }) {
  const { t } = useI18n();
  return (
    <ul className="checks" aria-label={label}>
      {checks.map((c) => (
        <li key={c.id} className={`check check-${c.state}`}>
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
