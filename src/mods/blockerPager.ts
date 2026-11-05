// Which blocking mod the Mods tab's banner shows, as the list changes around it. No React:
// components/mods/ModFixes `useBlockerPager` holds the page.

export interface PagerAt {
  /** The mod on screen, by id; null before the player paged. */
  id: string | null;
  /** Where it was in the list: the place a fixed mod gives to the next. */
  index: number;
}

/**
 * The index to show in `ids` (the blocking mods, in order): the mod on screen stays on screen
 * while others come and go; a fixed one gives its place to the next, or the last.
 */
export function pagerIndex(ids: string[], at: PagerAt): number {
  if (!ids.length) return 0;
  const found = at.id === null ? -1 : ids.indexOf(at.id);
  return found >= 0 ? found : Math.min(at.index, ids.length - 1);
}

/** One step back or on from `index`, round the ends. */
export function pagerStep(length: number, index: number, step: number): number {
  return (index + step + length) % length;
}
