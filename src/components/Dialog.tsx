import { ReactNode, useCallback, useEffect, useId, useRef } from "react";
import { tipOpenOn } from "./Truncate";
import { focusNear, scopesOf } from "./focusRescue";

interface DialogProps {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  /** While true, Escape and the backdrop don't close it: work is in flight. */
  locked?: boolean;
  /** The body. It scrolls; the title and the footer stay put. */
  children: ReactNode;
  /** The action row, always visible at the bottom. */
  footer: ReactNode;
}

// Native `<summary>` is a tab stop too (the error Details disclosure), as are selects and text areas.
const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], summary, [tabindex]:not([tabindex="-1"]):not(:disabled)';

function usable(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement) || (el as HTMLButtonElement).disabled || el.tabIndex < 0) return false;
  if (el.getClientRects().length === 0 || el.closest("[hidden], [inert]")) return false;
  // Only a details element's own first summary can be focused.
  if (el.tagName === "SUMMARY") {
    const details = el.parentElement;
    if (!(details instanceof HTMLDetailsElement) || details.querySelector(":scope > summary") !== el) return false;
  }
  return true;
}

/**
 * A modal. Keeps focus inside, also when its content is replaced (an async inspection) or a
 * focused button is disabled, and gives focus back to whatever opened it. It first focuses the
 * element marked `data-autofocus` (the safe choice, e.g. Cancel), else its title. When the opener
 * is gone by then, focus goes to the nearest place around where it was (components/focusRescue).
 */
export function Dialog({ title, subtitle, onClose, locked = false, children, footer }: DialogProps) {
  const box = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  const isLocked = useRef(locked);
  isLocked.current = locked;

  /** Where focus goes when it has nowhere sensible to be. */
  const settle = useCallback(() => {
    const root = box.current;
    if (!root) return;
    const active = document.activeElement;
    if (active && root.contains(active) && (active === heading.current || usable(active))) return;
    const preferred = root.querySelector("[data-autofocus]");
    (usable(preferred) ? preferred : heading.current)?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // Where the opener was, in case it is gone when this closes: an Install that became "Installed".
    const openerScopes = scopesOf(opener);
    settle();

    // Content changes can take focus away: an element unmounts or gets disabled.
    const observer = new MutationObserver(() => settle());
    if (box.current) {
      observer.observe(box.current, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    }

    // Focus that lands outside (a click on the page behind, a stray script) comes back.
    const onFocusIn = (e: FocusEvent) => {
      if (box.current && e.target instanceof Node && !box.current.contains(e.target)) settle();
    };

    const onKey = (e: KeyboardEvent) => {
      // An open menu or list takes Escape first; a disclosure (a list shown in place) doesn't.
      const popupOpen = e.target instanceof Element && !!e.target.closest('[aria-haspopup][aria-expanded="true"], [role=listbox], [role=menu]');
      // The focused element's own tooltip goes first: that element hides it on this Escape, and
      // the next one closes the dialog. Only a tip that belongs to the focused element counts,
      // never one the mouse left elsewhere.
      const tipShown = tipOpenOn(e.target);
      if (e.key === "Escape" && !isLocked.current && !popupOpen && !tipShown) {
        e.stopPropagation();
        close.current();
      } else if (e.key === "Tab" && box.current) {
        const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(usable);
        if (items.length === 0) {
          e.preventDefault();
          heading.current?.focus();
          return;
        }
        const [head, tail] = [items[0], items[items.length - 1]];
        const active = document.activeElement as HTMLElement | null;
        const inside = !!active && items.includes(active);
        if (e.shiftKey && (!inside || active === head)) {
          e.preventDefault();
          tail.focus();
        } else if (!e.shiftKey && (!inside || active === tail)) {
          e.preventDefault();
          head.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn);
      if (opener?.isConnected && opener !== document.body) opener.focus?.({ preventScroll: true });
      else focusNear(openerScopes);
    };
  }, [settle]);

  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !isLocked.current) onClose();
      }}
    >
      <div
        className="dialog framed"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={locked || undefined}
        ref={box}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id={titleId} tabIndex={-1} ref={heading}>
            {title}
          </h2>
          {subtitle && <p className="dialog-sub">{subtitle}</p>}
        </div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">{footer}</div>
      </div>
    </div>
  );
}
