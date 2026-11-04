import { ReactNode, useId, useState } from "react";
import { useI18n } from "../../i18n/useI18n";

export type Tone = "info" | "ok" | "warn" | "bad";

export interface BannerItem {
  id: string;
  tone: Tone;
  text: ReactNode;
  /** Plain text of `text`, for the collapsed row. */
  summary?: string;
  actions?: ReactNode;
}

const ORDER: Record<Tone, number> = { bad: 0, warn: 1, info: 2, ok: 3 };

function Banner({ item }: { item: BannerItem }) {
  return (
    <div className={`banner ${item.tone}`} role={item.tone === "bad" ? "alert" : "status"}>
      <span className="banner-text">{item.text}</span>
      {item.actions && <span className="banner-actions">{item.actions}</span>}
    </div>
  );
}

/**
 * Banners above a list. What blocks the player or answers their last action shows in full; the
 * rest folds into one row that opens on demand, so the list keeps most of the height.
 */
export function BannerStack({ full, quiet }: { full: BannerItem[]; quiet: BannerItem[] }) {
  const { t, tn } = useI18n();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const sorted = [...quiet].sort((a, b) => ORDER[a.tone] - ORDER[b.tone]);
  if (!full.length && !sorted.length) return null;
  const first = sorted[0];

  return (
    <div className="banners">
      {full.map((item) => (
        <Banner key={item.id} item={item} />
      ))}
      {first &&
        (open ? (
          <div className="banner-group" id={listId}>
            {sorted.map((item) => (
              <Banner key={item.id} item={item} />
            ))}
            <button className="link-btn banner-fold" aria-expanded="true" aria-controls={listId} onClick={() => setOpen(false)}>
              {t("mods.bannersFold")}
            </button>
          </div>
        ) : (
          <div className={`banner ${first.tone} compact`}>
            <span className="banner-text one-line">{first.summary ?? first.text}</span>
            <button
              className="btn-secondary btn-small"
              aria-expanded="false"
              onClick={() => setOpen(true)}
            >
              {sorted.length > 1 ? tn("mods.bannersMore", sorted.length) : t("mods.bannersOpen")}
            </button>
          </div>
        ))}
    </div>
  );
}
