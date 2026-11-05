import { useI18n } from "../../i18n/useI18n";
import type { MessageKey } from "../../i18n";
import type { Channel, Trust } from "../../mods/types";
import { PixelIcon } from "../PixelIcon";
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

/** The tier, as a word and a glyph, never colour alone. The hint is a hover; the word says enough. */
export function TrustBadge({ trust }: { trust: Trust }) {
  const { t } = useI18n();
  return (
    <span className={`badge trust-${trust}`} title={t(HINT[trust])}>
      <PixelIcon rows={GLYPH[trust]} />
      <span className="badge-text">{t(TRUST_LABEL[trust])}</span>
    </span>
  );
}

/**
 * In place of the tier on a mod pulled from the index: whatever it was, it isn't usable now. The
 * reason is a hover; the row's own line says it in full.
 */
export function RevokedBadge({ reason }: { reason: string | null }) {
  const { t } = useI18n();
  return (
    <span className="badge revoked" title={t("mods.badgeRevokedHint", (reason ?? "").trim() || t("mods.noReason"))}>
      <PixelIcon rows={CROSS} />
      <span className="badge-text">{t("mods.badgeRevoked")}</span>
    </span>
  );
}

export function ChannelBadge({ channel }: { channel: Channel | null }) {
  const { t } = useI18n();
  if (!channel || channel === "release") return null;
  return (
    <span className="badge channel">
      <span className="badge-text">{t(channel === "experimental" ? "mods.badgeExperimental" : "mods.badgePrerelease")}</span>
    </span>
  );
}
