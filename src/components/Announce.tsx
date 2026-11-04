import { useEffect, useState } from "react";

const said = new Map<string, string>();

/**
 * Says `text` to a screen reader once per `id` on a channel: a panel that re-renders, or comes
 * back on another tab with the same problem, stays quiet. An empty id (nothing to say) resets
 * the channel, so the same problem coming back later is said again.
 */
export function Announce({ channel, id, text }: { channel: string; id: string; text: string }) {
  const [now, setNow] = useState("");
  useEffect(() => {
    if (!id) {
      said.delete(channel);
      setNow("");
      return;
    }
    if (said.get(channel) === id) return;
    said.set(channel, id);
    setNow(text);
  }, [channel, id, text]);
  return (
    <span className="sr-only" role="alert">
      {now}
    </span>
  );
}
