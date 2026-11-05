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
 * A badge whose word is always shown whole, with what it means a hover or a Tab away: the
 * tooltip shows on focus too, and a screen reader hears the word and then the explanation.
 */
function ExplainedBadge({ className, glyph, word, hint }: { className: string; glyph?: string[]; word: string; hint: string }) {
  const { handlers, tip } = useTip(hint, true);
  const hintId = useId();
  return (
    <>
      <span className={`badge ${className}`} tabIndex={0} aria-describedby={hintId} data-must-fit {...handlers}>
        {glyph && <PixelIcon rows={glyph} />}
        <span className="badge-text">{word}</span>
      </span>
      {/* Hidden, yet it still describes the badge: a screen reader says the word, then this. */}
      <span hidden id={hintId}>
        {hint}
      </span>
      {tip}
    </>
  );
}

/** The tier, as a word and a glyph, never colour alone. */
export function TrustBadge({ trust }: { trust: Trust }) {
  const { t } = useI18n();
  return <ExplainedBadge className={`trust-${trust}`} glyph={GLYPH[trust]} word={t(TRUST_LABEL[trust])} hint={t(HINT[trust])} />;
}

/**
 * In place of the tier on a mod pulled from the index: whatever it was, it isn't usable now. The
 * index's reason is quoted, in the words (and language) the index gave it; the row says it too.
 */
export function RevokedBadge({ reason }: { reason: string | null }) {
  const { t } = useI18n();
  const why = (reason ?? "").trim();
  return <ExplainedBadge className="revoked" glyph={CROSS} word={t("mods.badgeRevoked")} hint={why ? t("mods.badgeRevokedHint", why) : t("mods.badgeRevokedHintNoReason")} />;
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
