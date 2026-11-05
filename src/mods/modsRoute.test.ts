import { describe, expect, it } from "vitest";
import { MODS_START, modsRoute } from "./modsRoute";

describe("the Mods tab's route", () => {
  it("opens one dialog at a time, and closes it", () => {
    let s = modsRoute(MODS_START, { type: "open", dialog: { kind: "sources" } });
    expect(s.dialog).toEqual({ kind: "sources" });
    s = modsRoute(s, { type: "open", dialog: { kind: "file", path: "/a.zip" } });
    expect(s.dialog).toEqual({ kind: "file", path: "/a.zip" });
    s = modsRoute(s, { type: "close" });
    expect(s.dialog).toBeNull();
    expect(modsRoute(s, { type: "close" })).toBe(s);
  });

  it("brings an undone removal to the Installed list, with focus on its row once", () => {
    let s = modsRoute(MODS_START, { type: "view", view: "browse" });
    s = modsRoute(s, { type: "restored", id: "cogwork" });
    expect(s).toMatchObject({ view: "installed", focusMod: "cogwork" });
    s = modsRoute(s, { type: "focused" });
    expect(s.focusMod).toBeNull();
    expect(modsRoute(s, { type: "focused" })).toBe(s);
  });

  it("keeps the same state for the view it is already on", () => {
    expect(modsRoute(MODS_START, { type: "view", view: "installed" })).toBe(MODS_START);
  });
});
