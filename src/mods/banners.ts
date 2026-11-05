// Which notes above the Mods list show in full and which fold into the one-line row, and in what
// order. Data only, so the policy is tested without React; Mods.tsx renders the result.

import type { Catalog } from "./types";

export type View = "installed" | "browse";

export interface BannerFacts {
  view: View;
  /** The version is running: its mods can't change. */
  running: boolean;
  /** Notices answering the player's last change, by id. */
  notices: number[];
  /** Something in the set stops the game. */
  blocked: boolean;
  /** The player's last action on a row failed. */
  rowError: boolean;
  /** The index's state, and whether it had trouble. */
  index: Catalog["index"]["freshness"] | null;
  indexTrouble: boolean;
  /** The last catalogue refresh failed, while an older catalogue still shows. */
  refreshFailed: boolean;
  /** Sources whose last refresh failed, by repo. */
  sources: string[];
  /** The version's mod interface couldn't be found out. */
  abiUnknown: boolean;
  /** Copies in the player's own folder load instead of managed mods that are off. */
  shadowed: boolean;
  /** The player's own folder has files. */
  unmanaged: boolean;
}

export interface Placed {
  id: string;
  /** Folded notes are listed by rank, lowest first; the first leads the folded row. */
  rank: number;
}

/**
 * - What answers the player's last action, or must not be missed, shows in full: a running game,
 *   notices, a failed action, and on Installed what stops the game (its fixes sit right above
 *   the rows; the panel is bounded in height).
 * - Everything else folds into one row. The catalogue's state leads it on Browse, also while
 *   something blocks: a player browsing offline or from an old index sees that first. On
 *   Installed what blocks is in full, so the row leads with the catalogue too.
 * - Then sources, the version's interface, copies in the player's folder, the folder itself.
 */
export function bannerPlan(f: BannerFacts): { full: Placed[]; quiet: Placed[] } {
  const full: Placed[] = [];
  const quiet: Placed[] = [];
  if (f.running) full.push({ id: "running", rank: 0 });
  for (const n of f.notices) full.push({ id: `notice:${n}`, rank: 0 });
  if (f.rowError) full.push({ id: "error", rank: 0 });
  if (f.blocked) {
    if (f.view === "installed") full.push({ id: "blocking", rank: 0 });
    else quiet.push({ id: "blocking", rank: 1 });
  }
  if (f.refreshFailed) quiet.push({ id: "refresh", rank: 0 });
  if (f.indexTrouble || (f.index !== null && f.index !== "fresh")) quiet.push({ id: "index", rank: 0.5 });
  for (const repo of f.sources) quiet.push({ id: `source:${repo}`, rank: 2 });
  if (f.abiUnknown) quiet.push({ id: "abi", rank: 3 });
  if (f.shadowed) quiet.push({ id: "shadowed", rank: 3.5 });
  if (f.unmanaged) quiet.push({ id: "unmanaged", rank: 4 });
  quiet.sort((a, b) => a.rank - b.rank);
  return { full, quiet };
}
