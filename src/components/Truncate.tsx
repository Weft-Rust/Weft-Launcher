import { ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A tooltip drawn in <body>, so a framed card's clip-path or a scrolling dialog can't cut it off.
 * It shows on hover and on keyboard focus.
 */
function useTip(text: string, enabled: boolean) {
  const [at, setAt] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const show = useCallback(
    (el: HTMLElement) => {
      if (!enabled) return;
      const r = el.getBoundingClientRect();
      const below = r.top < 64;
      setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - 328)), top: below ? r.bottom + 4 : r.top - 4, below });
    },
    [enabled]
  );
  const hide = useCallback(() => setAt(null), []);
  const handlers = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => show(e.currentTarget),
    onMouseLeave: hide,
    onFocus: (e: React.FocusEvent<HTMLElement>) => show(e.currentTarget),
    onBlur: hide,
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === "Escape" && at) {
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
}

/**
 * Text that may be cut off with an ellipsis. When it is, the full text shows on hover and on
 * focus, and it becomes a tab stop so the keyboard can reach it. Screen readers get the full text
 * anyway: the ellipsis is only drawn.
 */
export function Truncate({ text, className = "", lines = 1, children }: TruncateProps) {
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
      <span ref={ref} className={`truncate lines-${lines} ${className}`} tabIndex={cut ? 0 : undefined} {...handlers}>
        {children ?? text}
      </span>
      {tip}
    </>
  );
}

/** A shortened hash, commit or interface id. The full value is a hover or a Tab away. */
export function Code({ full, short }: { full: string; short: string }) {
  const { handlers, tip } = useTip(full, short !== full);
  if (short === full) return <code>{full}</code>;
  return (
    <>
      <code className="code-short" tabIndex={0} {...handlers}>
        <span aria-hidden="true">{short}</span>
        <span className="sr-only">{full}</span>
      </code>
      {tip}
    </>
  );
}
