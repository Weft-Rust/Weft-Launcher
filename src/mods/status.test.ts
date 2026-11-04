import { describe, expect, it } from "vitest";
import { blockers, crashResolved, describeChange, describeCopy, failureTitle, heroState, modMeta, snapshotFor } from "./status";
import { installed, report } from "./fixtures";
import type { FailureKind, ModStatus } from "./types";

const name = (id: string) => id.toUpperCase();

describe("modMeta", () => {
  it("has a line for every status", () => {
    const statuses: ModStatus[] = ["ready", "off", "wrongVersion", "missingDeps", "revoked", "unchecked"];
    for (const status of statuses) {
      const meta = modMeta(installed("a", { status, missingDeps: ["b"] }), "v26.11.1", name);
      expect(meta.parts.length).toBeGreaterThan(0);
      expect(meta.bad).toBe(status === "wrongVersion" || status === "missingDeps" || status === "revoked");
    }
  });

  it("names missing dependencies and counts them", () => {
    const meta = modMeta(installed("a", { status: "missingDeps", missingDeps: ["b", "c"] }), "v", name);
    expect(meta.parts[0]).toEqual({ key: "mods.statusMissingDeps", count: 2, args: ["B, C"] });
  });
});

describe("blockers", () => {
  it("offers the fitting update and turning the mod off", () => {
    const r = report([
      installed("lanterns", { status: "wrongVersion", weftTag: "v26.10.4", update: { version: "1.1.0", sha256: "u".repeat(64), channel: "release", trust: "unreviewed" } }),
    ]);
    const [b] = blockers(r, name);
    expect(b.fixes.map((f) => f.kind)).toEqual(["update", "turnOff"]);
    expect(b.fixes[0]).toMatchObject({ version: "1.1.0" });
    expect(b.reason).toEqual({ key: "mods.statusWrongVersionTag", args: ["v26.10.4"] });
  });

  it("offers turning on an installed dependency that is off", () => {
    const r = report([
      installed("hearth", { status: "missingDeps", missingDeps: ["cogwork", "signals"] }),
      installed("cogwork", { enabled: false, status: "off" }),
    ]);
    const [b] = blockers(r, name);
    expect(b.fixes).toEqual([
      { kind: "turnOn", id: "cogwork", name: "Cogwork" },
      { kind: "turnOff", id: "hearth", name: "Hearth" },
    ]);
  });

  it("is empty without a report or blockers", () => {
    expect(blockers(undefined, name)).toEqual([]);
    expect(blockers(report([installed("a")]), name)).toEqual([]);
  });
});

describe("heroState", () => {
  it("reads blocked only when something blocks and the game isn't running", () => {
    const blocked = report([installed("a", { status: "wrongVersion" })]);
    expect(heroState(blocked, false)).toBe("blocked");
    expect(heroState(blocked, true)).toBe("playing");
    expect(heroState(report([]), false)).toBe("ready");
    expect(heroState(undefined, false)).toBe("ready");
  });
});

describe("crash notices", () => {
  const failure = { kind: "loadFailed" as const, modId: "structures", other: null, line: "x" };
  const before = report([installed("structures")]);
  const snap = snapshotFor(failure, before);

  it("stay while the blamed mod is unchanged", () => {
    expect(crashResolved(snap, before)).toBe(false);
  });

  it("go once the mod is off, removed or replaced", () => {
    expect(crashResolved(snap, report([installed("structures", { enabled: false, status: "off" })]))).toBe(true);
    expect(crashResolved(snap, report([]))).toBe(true);
    expect(crashResolved(snap, report([installed("structures", { sha256: "n".repeat(64) })]))).toBe(true);
  });

  it("never go on their own when no managed mod is blamed", () => {
    expect(snapshotFor({ ...failure, modId: "oldtweak" }, before)).toBeNull();
    expect(crashResolved(null, report([]))).toBe(false);
  });

  it("have a title for every failure kind", () => {
    const kinds: FailureKind[] = ["wrongVersion", "loadFailed", "notAMod", "wrongName", "missingDep", "initPanicked"];
    for (const kind of kinds) expect(failureTitle({ ...failure, kind }, "Structures").key).toMatch(/^mods\.failure/);
    expect(failureTitle({ ...failure, kind: "initPanicked", modId: null }, "")).toEqual({ key: "mods.failureInit" });
  });
});

describe("result notices", () => {
  it("name mods, never ids", () => {
    const r = report([installed("hearth"), installed("cogwork")]);
    const text = describeChange(
      { report: r, installed: ["hearth", "cogwork"], alsoEnabled: [], alsoDisabled: ["rails"], missing: ["signals"] },
      "hearth",
      name
    )!;
    expect(text.tone).toBe("warn");
    expect(text.lines).toEqual([
      { key: "mods.noticeInstalled", args: ["HEARTH"] },
      { key: "mods.noticeDepsInstalled", args: ["COGWORK"] },
      { key: "mods.noticeAlsoDisabled", args: ["RAILS"] },
      { key: "mods.noticeMissing", count: 1, args: ["SIGNALS"] },
    ]);
  });

  it("say an update of an off mod left it off", () => {
    const r = report([installed("hearth", { enabled: false, status: "off" })]);
    const text = describeChange({ report: r, installed: ["hearth"], alsoEnabled: [], alsoDisabled: [], missing: [] }, "hearth", name)!;
    expect(text.lines[0].key).toBe("mods.noticeInstalledOff");
  });

  it("count copied mods and list what stayed behind", () => {
    const text = describeCopy(
      {
        report: report([]),
        installed: ["a"],
        alsoEnabled: [],
        alsoDisabled: [],
        missing: [],
        leftBehind: [{ id: "t", name: "My Tweak", outcome: "localFile", version: null, trust: null }],
      },
      "v26.10.4",
      name
    );
    expect(text.lines).toEqual([
      { key: "mods.noticeCopied", count: 1, args: ["v26.10.4"] },
      { key: "mods.noticeLeftBehind", count: 1, args: ["My Tweak"] },
    ]);
  });

  it("say nothing when nothing happened worth saying", () => {
    expect(describeChange({ report: report([]), installed: [], alsoEnabled: [], alsoDisabled: [], missing: [] }, null, name)).toBeNull();
  });
});
