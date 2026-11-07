import { describe, expect, it } from "vitest";
import { pagerIndex, pagerStep } from "./blockerPager";

describe("blocker pager", () => {
  it("keeps the mod on screen while the list changes around it", () => {
    expect(pagerIndex(["a", "b", "c"], { id: "b", index: 1 })).toBe(1);
    // One before it is fixed: it moves up and stays shown.
    expect(pagerIndex(["b", "c"], { id: "b", index: 1 })).toBe(0);
  });

  it("gives a fixed mod's place to the next, or the last", () => {
    expect(pagerIndex(["a", "c"], { id: "b", index: 1 })).toBe(1);
    expect(pagerIndex(["a"], { id: "c", index: 2 })).toBe(0);
    expect(pagerIndex([], { id: "c", index: 2 })).toBe(0);
    expect(pagerIndex(["a", "b"], { id: null, index: 0 })).toBe(0);
  });

  it("steps round the ends", () => {
    expect(pagerStep(3, 2, 1)).toBe(0);
    expect(pagerStep(3, 0, -1)).toBe(2);
  });
});
