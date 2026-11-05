import { useEffect, useState } from "react";

const said = new Map<string, Set<string>>();

/**
 * Whole sentences said one after another: a space between them, never a comma, so a screen
 * reader doesn't hear "…which is off., Lanterns…". Empty parts are left out.
 */
export function sentences(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Says the items of a channel that weren't on it before, assertively: blockers that newly appear.
 * A panel that re-renders, or comes back on another tab with the same problems, stays quiet; one
 * fixed problem doesn't make the others be said again. An item that goes away is forgotten, so
 * it is said again if it comes back.
 */
export function Announce({ channel, items, prefix = "" }: { channel: string; items: { id: string; text: string }[]; prefix?: string }) {
  const [now, setNow] = useState("");
  const ids = items.map((i) => i.id).join("\u0000");
  useEffect(() => {
    const before = said.get(channel) ?? new Set<string>();
    const fresh = items.filter((i) => !before.has(i.id));
    said.set(channel, new Set(items.map((i) => i.id)));
    if (fresh.length) setNow(sentences([prefix, ...fresh.map((i) => i.text)]));
    else if (!items.length) setNow("");
    // `items` is read through its ids: the same problems with new objects say nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, ids, prefix]);
  return (
    <span className="sr-only" role="alert">
      {now}
    </span>
  );
}
