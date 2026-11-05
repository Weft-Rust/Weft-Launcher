import { describe, expect, it } from "vitest";
import { contentKey } from "./usePlan";

describe("contentKey", () => {
  it("is the same for the same content read twice", () => {
    expect(contentKey({ tag: "v1", mods: [{ id: "a" }] })).toBe(contentKey({ tag: "v1", mods: [{ id: "a" }] }));
  });
  it("differs when the content does", () => {
    expect(contentKey({ tag: "v1", mods: [{ id: "a" }] })).not.toBe(contentKey({ tag: "v1", mods: [{ id: "b" }] }));
  });
  it("tells a missing input from an empty one", () => {
    expect(contentKey(undefined)).not.toBe(contentKey(null));
    expect(contentKey(null)).not.toBe(contentKey({}));
  });
});
