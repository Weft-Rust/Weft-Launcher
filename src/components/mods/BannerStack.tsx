import { ReactNode, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { Truncate } from "../Truncate";

export type Tone = "info" | "ok" | "warn" | "bad";

export interface BannerItem {
  id: string;
  tone: Tone;
  text: ReactNode;
  /** Plain text of `text`, for the collapsed row. */
  summary?: string;
  actions?: ReactNode;
  /**
   * Folded notes are listed by this, lowest first. The first one leads the collapsed row, with
   * its own buttons, so a note ranked first is never out of sight.
   */
  rank?: number;
  /** Said to a screen reader as it appears: an error from the player's own action. */
  alert?: boolean;
  /**
   * Scrolled into view as it appears: the result of something the player did further down the
   * list, which they would otherwise not see (and couldn't Undo).
   */
  reveal?: boolean;
}

const ORDER: Record<Tone, number> = { bad: 0, warn: 1, info: 2, ok: 3 };

function Banner({ item }: { item: BannerItem }) {
  const ref = useRef<HTMLDivElement>(null);
  const reveal = !!item.reveal;
  useEffect(() => {
    if (!reveal) return;
    // After this frame's focus moves, so the notice is what ends up in view.
    const frame = requestAnimationFrame(() => ref.current?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [reveal, item.id]);
  return (
    <div ref={ref} className={`banner ${item.tone}`} role={item.alert ? "alert" : undefined}>
      <span className="banner-text">{item.text}</span>
      {item.actions && <span className="banner-actions">{item.actions}</span>}
    </div>
  );
}

/**
 * Banners above a list. What answers the player's last action, or must not be missed, shows in
 * full; the rest folds into one row that opens on demand. Open, the notes scroll inside a box
 * of bounded height, so the list below keeps its place on screen.
 *
 * The toggle is one button in both states, so it keeps focus when it flips.
 */
export function BannerStack({ full, quiet }: { full: BannerItem[]; quiet: BannerItem[] }) {
  const { t, tn } = useI18n();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const sorted = [...quiet].sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9) || ORDER[a.tone] - ORDER[b.tone]);
  if (!full.length && !sorted.length) return null;
  const first = sorted[0];

  return (
    <div className="banners">
      {full.map((item) => (
        <Banner key={item.id} item={item} />
      ))}
      {first && (
        <div className={`banner-fold ${open ? "open" : `banner ${first.tone} compact`}`}>
          {!open && (
            <>
              <span className="banner-text one-line">{first.summary ? <Truncate text={first.summary} /> : first.text}</span>
              {first.actions && <span className="banner-actions">{first.actions}</span>}
            </>
          )}
          <div className="banner-group" id={listId} hidden={!open}>
            {open && sorted.map((item) => <Banner key={item.id} item={item} />)}
          </div>
          <button
            className={open ? "link-btn banner-toggle" : "btn-secondary btn-small banner-toggle"}
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen(!open)}
          >
            {open ? t("mods.bannersFold") : sorted.length > 1 ? tn("mods.bannersMore", sorted.length) : t("mods.bannersOpen")}
          </button>
        </div>
      )}
    </div>
  );
}
