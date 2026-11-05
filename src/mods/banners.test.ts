import { describe, expect, it } from "vitest";
import { bannerPlan, type BannerFacts } from "./banners";

const base: BannerFacts = {
  view: "installed",
  running: false,
  notices: [],
  blocked: false,
  rowError: false,
  index: "fresh",
  indexTrouble: false,
  refreshFailed: false,
  sources: [],
  abiUnknown: false,
  shadowed: false,
  unmanaged: false,
};
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("bannerPlan", () => {
  it("shows what blocks in full on Installed, and folds the rest", () => {
    const p = bannerPlan({ ...base, blocked: true, unmanaged: true, index: "cached", indexTrouble: true });
    expect(ids(p.full)).toEqual(["blocking"]);
    expect(ids(p.quiet)).toEqual(["index", "unmanaged"]);
  });

  it("keeps the offline index first on Browse, also while something blocks", () => {
    const p = bannerPlan({ ...base, view: "browse", blocked: true, unmanaged: true, index: "cached", indexTrouble: true, sources: ["a/b"] });
    expect(p.full).toEqual([]);
    expect(ids(p.quiet)).toEqual(["index", "blocking", "source:a/b", "unmanaged"]);
  });

  it("puts a failed refresh of a catalogue it still shows first", () => {
    const p = bannerPlan({ ...base, view: "browse", blocked: true, refreshFailed: true });
    expect(ids(p.quiet)[0]).toBe("refresh");
  });

  it("answers the player's action in full", () => {
    const p = bannerPlan({ ...base, notices: [3], rowError: true, running: true });
    expect(ids(p.full)).toEqual(["running", "notice:3", "error"]);
  });

  it("ranks copies in the player's folder before the folder itself", () => {
    const p = bannerPlan({ ...base, shadowed: true, unmanaged: true, abiUnknown: true });
    expect(ids(p.quiet)).toEqual(["abi", "shadowed", "unmanaged"]);
  });

  it("says nothing when all is well", () => {
    expect(bannerPlan(base)).toEqual({ full: [], quiet: [] });
  });
});
