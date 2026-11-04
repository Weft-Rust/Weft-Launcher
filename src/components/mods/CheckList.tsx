import { ReactNode } from "react";
import { PixelIcon } from "../PixelIcon";
import { CHECK, CROSS, QUESTION } from "./glyphs";

export type CheckState = "yes" | "no" | "unknown";

export interface Check {
  state: CheckState;
  title: ReactNode;
  detail?: ReactNode;
}

const GLYPH: Record<CheckState, string[]> = { yes: CHECK, no: CROSS, unknown: QUESTION };

/** What was checked, one line each. A list, so a screen reader reads it as one. */
export function CheckList({ checks, label }: { checks: Check[]; label: string }) {
  return (
    <ul className="checks" aria-label={label}>
      {checks.map((c, i) => (
        <li key={i} className={`check check-${c.state}`}>
          <span className="check-mark">
            <PixelIcon rows={GLYPH[c.state]} />
          </span>
          <span>
            {c.title}
            {c.detail && <small>{c.detail}</small>}
          </span>
        </li>
      ))}
    </ul>
  );
}
