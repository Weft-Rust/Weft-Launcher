// Where the Mods tab is: Installed or Browse, the one dialog open over it, and the row focus
// goes to next. A reducer without React, so the rules are tested apart from the page.

export const MODS_VIEWS = ["installed", "browse"] as const;
export type ModsView = (typeof MODS_VIEWS)[number];

export type ModsDialog = { kind: "file"; path: string } | { kind: "sources" } | { kind: "copy" };

export interface ModsRoute {
  view: ModsView;
  /** One dialog at a time: what the player opened last is what shows. */
  dialog: ModsDialog | null;
  /** A row to focus once it is there (a mod put back by Undo). */
  focusMod: string | null;
}

export type ModsRouteAction =
  | { type: "view"; view: ModsView }
  | { type: "open"; dialog: ModsDialog }
  | { type: "close" }
  /** Undo put a mod back: it is on the Installed list, and focus goes to its row. */
  | { type: "restored"; id: string }
  | { type: "focused" };

export const MODS_START: ModsRoute = { view: "installed", dialog: null, focusMod: null };

export function modsRoute(state: ModsRoute, action: ModsRouteAction): ModsRoute {
  switch (action.type) {
    case "view":
      return state.view === action.view ? state : { ...state, view: action.view };
    case "open":
      return { ...state, dialog: action.dialog };
    case "close":
      return state.dialog ? { ...state, dialog: null } : state;
    case "restored":
      return { ...state, view: "installed", focusMod: action.id };
    case "focused":
      return state.focusMod ? { ...state, focusMod: null } : state;
  }
}
