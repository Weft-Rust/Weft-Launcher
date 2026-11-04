import { describe, expect, it } from "vitest";
import { copyConsent } from "./copyPlan";
import type { CopyPreview, ProfileReport } from "./types";

const preview: CopyPreview = {
  from: "v26.10.4",
  to: "v26.11.1",
  items: [
    { id: "cogwork", name: "Cogwork", outcome: "install", version: "0.2.0", trust: "reviewed", sha256: "a".repeat(64) },
    { id: "lanterns", name: "Lanterns", outcome: "install", version: "1.1.0", trust: "unreviewed", sha256: "b".repeat(64) },
    { id: "mytweak", name: "My Tweak", outcome: "localFile", version: null, trust: null, sha256: null },
  ],
  deps: [{ id: "glowmoss", name: "Glowmoss", version: "0.3.0", sha256: "c".repeat(64), trust: "unreviewed", channel: "release", size: 1 }],
  enable: ["structures"],
  installedOff: ["lanterns"],
  missing: ["signals"],
};

const target = {
  tag: "v26.11.1",
  mods: [{ id: "structures", name: "Structures", trust: "reviewed" }],
} as unknown as ProfileReport;

describe("copyConsent", () => {
  const c = copyConsent(preview, target);

  it("lists only what will be installed", () => {
    expect(c.items.map((i) => i.id)).toEqual(["cogwork", "lanterns"]);
  });

  it("takes dependencies, turn-ons, missing and turned-off mods from the preview", () => {
    expect(c.deps.map((d) => d.id)).toEqual(["glowmoss"]);
    expect(c.enable).toEqual([{ id: "structures", name: "Structures", trust: "reviewed" }]);
    expect(c.missing).toEqual(["signals"]);
    expect(c.installedOff).toEqual(["lanterns"]);
  });

  it("names everything unreviewed it brings, dependencies included", () => {
    expect(c.unreviewed).toEqual(["Lanterns", "Glowmoss"]);
  });

  it("tracks progress for every download, copied mods first", () => {
    expect(c.shas).toEqual(["a".repeat(64), "b".repeat(64), "c".repeat(64)]);
  });
});
