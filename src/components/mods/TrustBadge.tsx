import { useI18n } from "../../i18n/useI18n";
import type { Channel, Trust } from "../../mods/types";
import { PixelIcon } from "../PixelIcon";
import { BANG, CHECK, HAMMER } from "./glyphs";

const GLYPH: Record<Trust, string[]> = { reviewed: CHECK, unreviewed: HAMMER, unverified: BANG };
const LABEL: Record<Trust, string> = {
  reviewed: "mods.badgeReviewed",
  unreviewed: "mods.badgeUnreviewed",
  unverified: "mods.badgeUnverified",
};
const HINT: Record<Trust, string> = {
  reviewed: "mods.badgeReviewedHint",
  unreviewed: "mods.badgeUnreviewedHint",
  unverified: "mods.badgeUnverifiedHint",
};

export function TrustBadge({ trust }: { trust: Trust }) {
  const { t } = useI18n();
  return (
    <span className={`badge trust-${trust}`} title={t(HINT[trust])}>
      <PixelIcon rows={GLYPH[trust]} />
      {t(LABEL[trust])}
    </span>
  );
}

export function ChannelBadge({ channel }: { channel: Channel | null }) {
  const { t } = useI18n();
  if (!channel || channel === "release") return null;
  return (
    <span className="badge channel">
      {t(channel === "experimental" ? "mods.badgeExperimental" : "mods.badgePrerelease")}
    </span>
  );
}
