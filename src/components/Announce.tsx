import { useEffect, useState } from "react";
import { useSpeech } from "./LiveRegion";

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
  const speech = useSpeech();
  const [now, setNow] = useState("");
  const ids = items.map((i) => i.id).join("\u0000");
  useEffect(() => {
    const fresh = speech.fresh(channel, items);
    if (fresh.length) setNow(sentences([prefix, ...fresh.map((i) => i.text)]));
    else if (!items.length) setNow("");
    // `items` is read through its ids: the same problems with new objects say nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speech, channel, ids, prefix]);
  return (
    <span className="sr-only" role="alert">
      {now}
    </span>
  );
}
