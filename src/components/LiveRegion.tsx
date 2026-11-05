import { useEffect, useState } from "react";

/**
 * The one place results are said to a screen reader: a polite live region that exists from the
 * start, so a message put into it is read even when the control that caused it has gone (a
 * removed row, a closed dialog). Each message is said once per key.
 */
type Listener = (text: string) => void;
const listeners = new Set<Listener>();
const said = new Set<string>();

/** Says `text` politely, once per `key`. */
export function announce(key: string, text: string) {
  if (!text || said.has(key)) return;
  said.add(key);
  // Bounded: keys are per notice, per error and per blocker set, so a long session can't grow it.
  if (said.size > 500) said.delete(said.values().next().value!);
  listeners.forEach((l) => l(text));
}

/** Forgets a key, so the same thing coming back later is said again. */
export function forget(key: string) {
  said.delete(key);
}

export function LiveRegion() {
  const [text, setText] = useState("");
  useEffect(() => {
    let clear: ReturnType<typeof setTimeout> | undefined;
    const l: Listener = (t) => {
      // A message the same as the last one would not change the region; clear it first.
      setText("");
      requestAnimationFrame(() => setText(t));
      clearTimeout(clear);
      clear = setTimeout(() => setText(""), 8000);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
      clearTimeout(clear);
    };
  }, []);
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="live-region">
      {text}
    </div>
  );
}
