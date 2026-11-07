import { describe, expect, it } from "vitest";
import { sentences } from "./Announce";

describe("announced sentences", () => {
  it("joins whole sentences with a space, never a comma after a full stop", () => {
    const said = sentences([
      "Weft v26.11.1 won't start with these mods on:",
      "Hearth stops Play: it needs Cogwork, which is off.",
      "Lanterns stops Play: it needs Glowmoss, which isn't installed.",
    ]);
    expect(said).toBe(
      "Weft v26.11.1 won't start with these mods on: Hearth stops Play: it needs Cogwork, which is off. Lanterns stops Play: it needs Glowmoss, which isn't installed."
    );
    expect(said).not.toMatch(/[.!?:],/);
  });

  it("leaves out empty parts", () => {
    expect(sentences(["", " One. ", "", "Two."])).toBe("One. Two.");
  });
});
