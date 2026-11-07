// What has been said to a screen reader, without React: one per app tree, held by the
// SpeechProvider in ./LiveRegion. Pure, so its memory is tested apart from any page.

type Listener = (text: string) => void;

/** Keys kept before the oldest is let go: keys are per notice, per error and per blocker set. */
const MEMORY = 500;

export class Speech {
  private said = new Set<string>();
  private channels = new Map<string, Set<string>>();
  private listeners = new Set<Listener>();

  /** Says `text` politely, once per `key`. */
  say(key: string, text: string) {
    if (!text || this.said.has(key)) return;
    this.said.add(key);
    if (this.said.size > MEMORY) this.said.delete(this.said.values().next().value!);
    this.listeners.forEach((l) => l(text));
  }

  /** Forgets a key, so the same thing coming back later is said again. */
  forget(key: string) {
    this.said.delete(key);
  }

  /** The polite region hears what is said from here on; the returned function stops that. */
  listen(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /**
   * The items of `channel` that weren't on it the last time, which it now remembers: blockers
   * that newly appear. An item that went away is forgotten, so it is new again if it comes back.
   */
  fresh<T extends { id: string }>(channel: string, items: T[]): T[] {
    const before = this.channels.get(channel) ?? new Set<string>();
    this.channels.set(channel, new Set(items.map((i) => i.id)));
    return items.filter((i) => !before.has(i.id));
  }
}
