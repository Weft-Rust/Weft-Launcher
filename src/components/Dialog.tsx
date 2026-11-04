import { ReactNode, useEffect, useId, useRef } from "react";

interface DialogProps {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  /** While true, Escape and the backdrop don't close it: work is in flight. */
  locked?: boolean;
  children: ReactNode;
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

// Keeps focus inside while open and gives it back to whatever opened it.
export function Dialog({ title, subtitle, onClose, locked = false, children }: DialogProps) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  const isLocked = useRef(locked);
  isLocked.current = locked;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      box.current?.querySelector<HTMLElement>(FOCUSABLE);
    // Without scrolling: a tall dialog should open at its title, not at its buttons.
    first?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isLocked.current) {
        e.stopPropagation();
        close.current();
      } else if (e.key === "Tab" && box.current) {
        const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) return;
        const [head, tail] = [items[0], items[items.length - 1]];
        if (e.shiftKey && document.activeElement === head) {
          e.preventDefault();
          tail.focus();
        } else if (!e.shiftKey && document.activeElement === tail) {
          e.preventDefault();
          head.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      opener?.focus?.();
    };
  }, []);

  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !isLocked.current) onClose();
      }}
    >
      <div className="dialog framed" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={box}>
        <h2 className="dialog-title" id={titleId}>
          {title}
        </h2>
        {subtitle && <p className="dialog-sub">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}
