// Focus never falls to the page body. When the focused element goes away (a card's Install
// becomes "Installed", a dialog closes after its opener was replaced), focus moves to the nearest
// place that is still there: the first control in the closest `data-focus-scope` around where it
// was (a card, a row, a version), else the page's heading.

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

function canFocus(el: Element): el is HTMLElement {
  return el instanceof HTMLElement && el.getClientRects().length > 0 && !el.closest("[hidden], [inert], .sr-only");
}

/** The scopes around an element, nearest first, kept so they can be found once it is gone. */
export function scopesOf(el: Element | null): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let a = el?.parentElement ?? null; a; a = a.parentElement) if (a.hasAttribute("data-focus-scope")) out.push(a);
  return out;
}

/**
 * Focuses the first control of the nearest scope still on the page, else the scope itself, else
 * the page's heading. Returns whether focus went somewhere.
 */
export function focusNear(scopes: HTMLElement[]): boolean {
  for (const scope of scopes) {
    if (!scope.isConnected) continue;
    const target = [...scope.querySelectorAll(FOCUSABLE)].find(canFocus);
    if (target) {
      target.focus({ preventScroll: true });
      return true;
    }
    if (canFocus(scope)) {
      if (!scope.hasAttribute("tabindex")) scope.tabIndex = -1;
      scope.focus({ preventScroll: true });
      return true;
    }
  }
  const heading = document.querySelector<HTMLElement>("main h1");
  if (!heading) return false;
  if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  return true;
}

/**
 * Watches the whole page: remembers where focus was, and when that element leaves the page
 * while focus is on the body, moves focus near where it was. Returns a function that stops it.
 */
export function watchFocus(): () => void {
  let last: { el: Element; scopes: HTMLElement[]; inDialog: boolean } | null = null;
  const onFocusIn = (e: FocusEvent) => {
    if (e.target instanceof Element && e.target !== document.body) {
      last = { el: e.target, scopes: scopesOf(e.target), inDialog: !!e.target.closest("[role=dialog]") };
    }
  };
  const rescue = () => {
    const active = document.activeElement;
    if (!last || last.el.isConnected || (active && active !== document.body)) return;
    // A dialog keeps its own focus, and gives it back to its opener when it closes (Dialog).
    if (last.inDialog || document.querySelector("[role=dialog]")) return;
    const { scopes } = last;
    last = null;
    focusNear(scopes);
  };
  const observer = new MutationObserver(rescue);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("focusin", onFocusIn);
  return () => {
    observer.disconnect();
    document.removeEventListener("focusin", onFocusIn);
  };
}
