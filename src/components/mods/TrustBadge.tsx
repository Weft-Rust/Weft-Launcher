import { useId } from "react";
import { useI18n } from "../../i18n/useI18n";
import type { MessageKey } from "../../i18n";
import type { Channel, Trust } from "../../mods/types";
import { PixelIcon } from "../PixelIcon";
import { useTip } from "../Truncate";
import { BANG, CHECK, CROSS, HAMMER } from "./glyphs";

const GLYPH: Record<Trust, string[]> = { reviewed: CHECK, unreviewed: HAMMER, unverified: BANG };
export const TRUST_LABEL: Record<Trust, MessageKey> = {
  reviewed: "mods.badgeReviewed",
  unreviewed: "mods.badgeUnreviewed",
  unverified: "mods.badgeUnverified",
};
const HINT: Record<Trust, MessageKey> = {
  reviewed: "mods.badgeReviewedHint",
  unreviewed: "mods.badgeUnreviewedHint",
  unverified: "mods.badgeUnverifiedHint",
};

/**
 * A badge whose word is always shown whole, with what it means a hover away. Not a tab stop: in
 * a list that would be one per row. The explanation is a hidden element with `hintId`, which the
 * row's own control (a switch, a card's details button) names in its `aria-describedby`, so it is
 * heard from where focus already is; the details dialog says it in full.
 */
function ExplainedBadge({ className, glyph, word, hint, hintId }: { className: string; glyph?: string[]; word: string; hint: string; hintId?: string }) {
  const { handlers, tip } = useTip(hint, true);
  const ownId = useId();
  const id = hintId ?? ownId;
  return (
    <>
      <span className={`badge ${className}`} aria-describedby={id} data-must-fit {...handlers}>
        {glyph && <PixelIcon rows={glyph} />}
        <span className="badge-text">{word}</span>
      </span>
      {/* Hidden, yet it still describes the badge: a screen reader says the word, then this. */}
      <span hidden id={id}>
        {hint}
      </span>
      {tip}
    </>
  );
}

/** The tier, as a word and a glyph, never colour alone. */
export function TrustBadge({ trust, hintId }: { trust: Trust; hintId?: string }) {
  const { t } = useI18n();
  return <ExplainedBadge className={`trust-${trust}`} glyph={GLYPH[trust]} word={t(TRUST_LABEL[trust])} hint={t(HINT[trust])} hintId={hintId} />;
}

/**
 * In place of the tier on a mod pulled from the index: whatever it was, it isn't usable now. The
 * index's reason is quoted, in the words (and language) the index gave it; the row says it too.
 */
export function RevokedBadge({ reason, hintId }: { reason: string | null; hintId?: string }) {
  const { t } = useI18n();
  const why = (reason ?? "").trim();
  return <ExplainedBadge className="revoked" glyph={CROSS} word={t("mods.badgeRevoked")} hint={why ? t("mods.badgeRevokedHint", why) : t("mods.badgeRevokedHintNoReason")} hintId={hintId} />;
}

export function ChannelBadge({ channel }: { channel: Channel | null }) {
  const { t } = useI18n();
  if (!channel || channel === "release") return null;
  return (
    <span className="badge channel" data-must-fit>
      <span className="badge-text">{t(channel === "experimental" ? "mods.badgeExperimental" : "mods.badgePrerelease")}</span>
    </span>
  );
}
