import { ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { Truncate } from "../Truncate";

export type Tone = "info" | "ok" | "warn" | "bad";

export interface BannerItem {
  id: string;
  tone: Tone;
  text: ReactNode;
  /**
   * For the collapsed row: the cause in a few words, never cut ("Index unreachable: no Reviewed
   * mods"), and what it is about, which may be cut (a repo, a list of names).
   */
  cause?: string;
  subject?: string;
  actions?: ReactNode;
  /** The one button the collapsed row offers for it, when that differs from `actions`. */
  foldActions?: ReactNode;
  /**
   * Folded notes are listed by this, lowest first. The first one leads the collapsed row, with
   * its own buttons, so a note ranked first is never out of sight.
   */
  rank?: number;
  /** Said to a screen reader as it appears: an error from the player's own action. */
  alert?: boolean;
}

const ORDER: Record<Tone, number> = { bad: 0, warn: 1, info: 2, ok: 3 };

function Banner({ item, className = "banner" }: { item: BannerItem; className?: string }) {
  return (
    <div className={`${className} ${item.tone}`} role={item.alert ? "alert" : undefined} data-banner={item.id}>
      <span className="banner-text">{item.text}</span>
      {item.actions && <span className="banner-actions">{item.actions}</span>}
    </div>
  );
}

/**
 * Banners above a list. What must not be missed shows in full; the rest folds into one row that
 * opens on demand. Open, the notes scroll inside a box of bounded height, so the list below
 * keeps its place on screen.
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
        <div className={`banner-fold ${open ? "open" : `banner ${first.tone} compact`}${full.length ? " docked" : ""}`} data-banner-fold={first.id}>
          {!open && (
            <>
              <span className="banner-text banner-summary">
                {first.cause ? (
                  <>
                    <span className="banner-cause" data-must-fit>
                      {first.cause}
                    </span>
                    {first.subject && <Truncate className="banner-subject" text={first.subject} />}
                  </>
                ) : (
                  first.text
                )}
              </span>
              {(first.foldActions ?? first.actions) && <span className="banner-actions">{first.foldActions ?? first.actions}</span>}
            </>
          )}
          <div className="banner-group" id={listId} hidden={!open}>
            {open && sorted.map((item) => <Banner key={item.id} item={item} />)}
          </div>
          <button className="btn-flat banner-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
            {open ? t("mods.bannersFold") : sorted.length > 1 ? tn("mods.bannersMore", sorted.length) : t("mods.bannersOpen")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Answers to what the player just did (Removed, with Undo; Installed; Copied; a failed action),
 * over the bottom of the list. They never push the list down, and the list makes room under its
 * last row for them (`onHeight`), so no row's buttons stay hidden behind one.
 */
export function Toasts({ items, onHeight }: { items: BannerItem[]; onHeight: (px: number) => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const report = useRef(onHeight);
  report.current = onHeight;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => report.current(items.length ? Math.ceil(el.getBoundingClientRect().height) : 0);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length]);
  return (
    <div className="toasts" ref={ref} role="region" aria-label={t("mods.toastsLabel")} hidden={!items.length}>
      {items.map((item) => (
        <Banner key={item.id} item={item} className="banner toast" />
      ))}
    </div>
  );
}
