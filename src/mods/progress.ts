// What a progress bar shows while the backend moves from file to file. No React: the bar holds
// the record this says to hold (components/mods/ModProgressBar).
import type { UiProgress } from "./types";

/** The check of a file stays on screen at least this long, so the player sees it happen. */
export const VERIFY_DWELL = 400;

/** One file's one step: a new percent of the same step is the same step. */
export const stepKey = (p: UiProgress | undefined) => (p ? `${p.index}:${p.sha256}:${p.stage}` : "");

/**
 * How long to keep showing `shown` (on screen since `shownSince`) before `next` replaces it: a
 * file's check is held for VERIFY_DWELL, everything else gives way at once. The record is replaced
 * whole, so the number, the name and the step on screen always belong to one file.
 */
export function dwellDelay(shown: UiProgress | undefined, next: UiProgress | undefined, shownSince: number, now: number): number {
  if (!shown || shown.stage !== "verifying" || stepKey(shown) === stepKey(next)) return 0;
  return Math.max(0, VERIFY_DWELL - (now - shownSince));
}
