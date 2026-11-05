import { describe, expect, it } from "vitest";
import { typeAhead } from "./typeAhead";

const tags = ["v26.11.1", "v26.10.4", "v26.9.0", "v25.12.2", "nightly-2026-11-03"];

describe("type-ahead in the version list", () => {
  it("finds a version by what it starts with, with or without its v", () => {
    expect(typeAhead(tags, "v26.9", 0)).toBe(2);
    expect(typeAhead(tags, "26.10", 0)).toBe(1);
    expect(typeAhead(tags, "25", 0)).toBe(3);
    expect(typeAhead(tags, "n", 0)).toBe(4);
  });

  it("steps through the matches when one key is typed again, round to the first", () => {
    expect(typeAhead(tags, "v", 0)).toBe(1);
    expect(typeAhead(tags, "vv", 1)).toBe(2);
    expect(typeAhead(tags, "v", 3)).toBe(0);
  });

  it("keeps the label it is on while the word still fits it", () => {
    expect(typeAhead(tags, "v26.1", 0)).toBe(0);
  });

  it("finds nothing for nothing, or for what no label starts with", () => {
    expect(typeAhead(tags, "", 0)).toBe(-1);
    expect(typeAhead(tags, "x", 0)).toBe(-1);
    expect(typeAhead([], "v", 0)).toBe(-1);
  });
});
