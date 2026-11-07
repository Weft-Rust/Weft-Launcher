import { ReactNode, createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The one tooltip on screen, and the element it belongs to. Showing one hides any other, so a tip
 * the mouse left behind can't sit beside the focused element's tip, or be taken for it.
 */
let openTip: { owner: HTMLElement; hide: () => void } | null = null;

/** Whether `el` has its tooltip showing: then Escape on it closes that tip, and nothing else. */
export function tipOpenOn(el: EventTarget | null): boolean {
  return !!openTip && openTip.owner === el;
}

/**
 * A tooltip drawn in <body>, so a framed card's clip-path or a scrolling dialog can't cut it off.
 * It shows on hover and on keyboard focus. Escape on the focused element hides it; the next
 * Escape goes on to whatever is around it (a dialog closes).
 */
export function useTip(text: string, enabled: boolean) {
  const [at, setAt] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const owner = useRef<HTMLElement | null>(null);
  const hide = useCallback(() => {
    if (openTip && openTip.owner === owner.current) openTip = null;
    owner.current = null;
    setAt(null);
  }, []);
  const show = useCallback(
    (el: HTMLElement) => {
      if (!enabled) return;
      if (openTip && openTip.owner !== el) openTip.hide();
      owner.current = el;
      openTip = { owner: el, hide };
      const r = el.getBoundingClientRect();
      const below = r.top < 64;
      setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - 328)), top: below ? r.bottom + 4 : r.top - 4, below });
    },
    [enabled, hide]
  );
  // Gone with its element.
  useEffect(() => hide, [hide]);
  const handlers = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => show(e.currentTarget),
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      // A focused element keeps its tip when the mouse moves off it.
      if (document.activeElement !== e.currentTarget) hide();
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => show(e.currentTarget),
    onBlur: hide,
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === "Escape" && tipOpenOn(e.currentTarget)) {
        e.stopPropagation();
        hide();
      }
    },
  };
  const tip =
    at &&
    createPortal(
      <div
        className={`tip${at.below ? " below" : ""}`}
        style={{ left: Math.round(at.left), top: Math.round(at.top) }}
        aria-hidden="true"
      >
        {text}
      </div>,
      document.body
    );
  return { handlers, tip };
}

interface TruncateProps {
  text: string;
  className?: string;
  /** Lines before the ellipsis. */
  lines?: 1 | 2 | 3;
  children?: ReactNode;
  /**
   * A tab stop of its own when cut, so the keyboard reaches the full text: only for text that
   * appears once on a page. In a list's rows and cards it isn't one; the row shows the text whole
   * while focus is in it (style.css, `[data-focus-scope]:focus-within`), so a row stays a few Tabs.
   */
  focusable?: boolean;
  id?: string;
}

/**
 * Text that may be cut off with an ellipsis. When it is, the full text shows on hover, and on
 * focus where it is `focusable`. Screen readers get the full text anyway: the ellipsis is only drawn.
 */
export function Truncate({ text, className = "", lines = 1, children, focusable = false, id }: TruncateProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setCut(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, lines]);

  const { handlers, tip } = useTip(text, cut);
  return (
    <>
      <span ref={ref} id={id} className={`truncate lines-${lines} ${className}${cut ? " is-cut" : ""}`} tabIndex={cut && focusable ? 0 : undefined} {...handlers}>
        {children ?? text}
      </span>
      {tip}
    </>
  );
}

/**
 * Whether shortened values show whole: a check list's one "details" control turns it on, so the
 * keyboard reaches every full hash and commit with one press instead of a Tab per value.
 */
export const FullValues = createContext(false);

/**
 * A shortened hash, commit or interface id. The full value is a hover away, whole where
 * FullValues is on, and always what a screen reader hears. Never a tab stop of its own.
 */
export function Code({ full, short }: { full: string; short: string }) {
  const whole = useContext(FullValues);
  const { handlers, tip } = useTip(full, short !== full && !whole);
  if (short === full || whole) return <code className={short === full ? undefined : "code-full"}>{full}</code>;
  return (
    <>
      <code className="code-short" {...handlers}>
        <span aria-hidden="true">{short}</span>
        <span className="sr-only">{full}</span>
      </code>
      {tip}
    </>
  );
}
