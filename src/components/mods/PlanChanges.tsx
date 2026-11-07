import { useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import type { RichMsg } from "../../mods/checks";
import { useAnnounce } from "../LiveRegion";
import { RichText } from "./RichText";

/** What is different in the new plan, after the backend refused the one the player agreed to. */
export function PlanChanges({ changes }: { changes: RichMsg[] }) {
  const { t } = useI18n();
  return (
    <div className="plan-changes" data-testid="plan-changes">
      <p className="plan-changes-title">{t("mods.changedTitle")}</p>
      <ul>
        {changes.map((c, i) => (
          <li key={i}>
            <RichText msg={c} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A calm line in a dialog when the player cancelled: nothing changed, and that isn't an error. */
export function useOutcomeNote() {
  const announce = useAnnounce();
  const { t } = useI18n();
  const [cancelledAt, setCancelledAt] = useState<number | null>(null);
  return {
    cancelled: () => {
      const at = Date.now();
      setCancelledAt(at);
      announce(`cancelled:${at}`, t("errors.modCancelled"));
    },
    clear: () => setCancelledAt(null),
    node: cancelledAt ? (
      <p className="dialog-note calm-note" data-testid="cancelled-note">
        {t("errors.modCancelled")}
      </p>
    ) : null,
  };
}
