import { describe, expect, it } from "vitest";
import {
  blockers,
  crashFixes,
  crashResolved,
  describeChange,
  describeCopy,
  describeRemove,
  describeToggle,
  failureTitle,
  heroState,
  modMeta,
  snapshotFor,
} from "./status";
import { build, catalog, catalogMod, installed, report } from "./fixtures";
import type { ChangeResult } from "./types";
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

  it("tells a dependency that is off from one that isn't installed", () => {
    const meta = modMeta(installed("a", { status: "missingDeps", missingDeps: ["b", "c", "d"], depsNotInstalled: ["d"] }), "v", name);
    expect(meta.parts).toEqual([
      { key: "mods.statusDepsOff", count: 2, args: ["B and C"] },
      { key: "mods.statusDepsNotInstalled", count: 1, args: ["D"] },
    ]);
  });

  it("says a dependency has no build when the catalogue has none for this version", () => {
    const railways = installed("railways", { status: "missingDeps", missingDeps: ["signals"], depsNotInstalled: ["signals"] });
    const r = report([railways]);
    const [b] = blockers(r, name, catalog([catalogMod("signals", [build("0.1.0", { abi: "other" })])]));
    expect(b.reasons).toEqual([{ key: "mods.statusDepsNoBuild", count: 1, args: ["SIGNALS", "v26.11.1"] }]);
    expect(b.fixes.map((f) => f.kind)).toEqual(["turnOff"]);
  });

  it("keeps the index's reason apart from its own sentence", () => {
    const meta = modMeta(installed("a", { status: "revoked", revokedReason: "Corrupts worlds. " }), "v", name);
    expect(meta.parts[0]).toEqual({ key: "mods.statusRevoked", args: ["Corrupts worlds."] });
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
    expect(b.reasons).toEqual([{ key: "mods.blockWrongVersionTag", args: ["v26.10.4"] }]);
  });

  it("offers turning on an installed dependency that is off, and installing one that has a build", () => {
    const r = report([
      installed("hearth", { status: "missingDeps", missingDeps: ["cogwork", "signals"], depsNotInstalled: ["signals"] }),
      installed("cogwork", { enabled: false, status: "off" }),
    ]);
    const signals = catalogMod("signals", [build("0.1.0")]);
    const [b] = blockers(r, name, catalog([signals]));
    expect(b.fixes).toEqual([
      { kind: "turnOn", id: "cogwork", name: "Cogwork" },
      { kind: "install", id: "signals", name: "Signals", mod: signals, sha256: signals.versions[0].sha256 },
      { kind: "turnOff", id: "hearth", name: "Hearth" },
    ]);
    expect(b.reasons.map((m) => m.key)).toEqual(["mods.statusDepsOff", "mods.statusDepsNotInstalled"]);
  });

  it("never offers turning on a revoked dependency", () => {
    const r = report([
      installed("hearth", { status: "missingDeps", missingDeps: ["cogwork"] }),
      installed("cogwork", { enabled: false, status: "revoked", revokedReason: "bad" }),
    ]);
    const [b] = blockers(r, name);
    expect(b.fixes.map((f) => f.kind)).toEqual(["turnOff"]);
    expect(b.reasons[0].key).toBe("mods.statusDepsRevoked");
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

  it("stay while a copy in the player's own folder can still load in its place", () => {
    const shadowed = { unmanaged: ["structures-old.zip"], shadowed: [{ id: "structures", file: "structures-old.zip", managed: "on" as const }] };
    const at = report([installed("structures")], shadowed);
    const snap = snapshotFor(failure, at);
    expect(snap?.shadowFile).toBe("structures-old.zip");
    // Off or removed: the player's copy loads now. Still there, so the warning stays.
    const off = report([installed("structures", { enabled: false, status: "off" })], { unmanaged: ["structures-old.zip"], shadowed: [{ id: "structures", file: "structures-old.zip", managed: "off" }] });
    expect(crashResolved(snap, off)).toBe(false);
    expect(crashResolved(snap, report([], { unmanaged: ["structures-old.zip"] }))).toBe(false);
    // Replaced by a build that is on: that one loads instead of the player's copy.
    expect(crashResolved(snap, report([installed("structures", { sha256: "n".repeat(64) })], shadowed))).toBe(true);
    // The file is gone: as for any crash.
    expect(crashResolved(snap, report([installed("structures", { enabled: false, status: "off" })]))).toBe(true);
    expect(crashResolved(snap, report([installed("structures")]))).toBe(false);
  });

  it("go with the player's copy that crashed while the launcher's was off", () => {
    const off = { unmanaged: ["structures-old.zip"], shadowed: [{ id: "structures", file: "structures-old.zip", managed: "off" as const }] };
    const snap = snapshotFor(failure, report([installed("structures", { enabled: false, status: "off" })], off));
    expect(crashResolved(snap, report([installed("structures", { enabled: false, status: "off" })], off))).toBe(false);
    expect(crashResolved(snap, report([installed("structures", { enabled: false, status: "off" })]))).toBe(true);
  });

  it("never go on their own when no managed mod is blamed", () => {
    expect(snapshotFor({ ...failure, modId: "oldtweak" }, before)).toBeNull();
    expect(crashResolved(null, report([]))).toBe(false);
  });

  it("have a title for every failure kind", () => {
    const kinds: FailureKind[] = ["wrongVersion", "loadFailed", "notAMod", "wrongName", "missingDep", "initPanicked"];
    for (const kind of kinds) expect(failureTitle({ ...failure, kind }, "Structures", name).key).toMatch(/^mods\.failure/);
    expect(failureTitle({ ...failure, kind: "initPanicked", modId: null }, "", name)).toEqual({ key: "mods.failureInit" });
  });

  it("name the missing dependency by its display name", () => {
    expect(failureTitle({ ...failure, kind: "missingDep", other: "cogwork" }, "Structures", name)).toEqual({
      key: "mods.failureMissingDep",
      args: ["Structures", "COGWORK"],
    });
  });

  it("offer turning on a missing dependency that is off, and no update for it", () => {
    const r = report([
      installed("structures", { update: { version: "0.1.3", sha256: "u".repeat(64), channel: "release", trust: "reviewed" } }),
      installed("cogwork", { enabled: false, status: "off" }),
    ]);
    const fixes = crashFixes({ ...failure, kind: "missingDep", other: "cogwork" }, r, null);
    expect(fixes.map((f) => f.kind)).toEqual(["turnOn", "turnOff"]);
    expect(crashFixes(failure, r, null).map((f) => f.kind)).toEqual(["update", "turnOff"]);
  });

  it("offer installing a missing dependency the catalogue has", () => {
    const cogwork = catalogMod("cogwork", [build("0.2.0")]);
    const fixes = crashFixes({ ...failure, kind: "missingDep", other: "cogwork" }, report([installed("structures")]), catalog([cogwork]));
    expect(fixes[0]).toMatchObject({ kind: "install", id: "cogwork", sha256: cogwork.versions[0].sha256 });
  });
});

const change = (extra: Partial<ChangeResult> = {}): ChangeResult => ({
  report: report([]),
  installed: [],
  alsoEnabled: [],
  alsoDisabled: [],
  missing: [],
  installedOff: [],
  undo: null,
  ...extra,
});

describe("result notices", () => {
  const T = "v26.11.1";

  it("name mods, never ids, and join them as the language does", () => {
    const r = report([installed("hearth"), installed("cogwork")]);
    const text = describeChange(change({ report: r, installed: ["hearth", "cogwork"], alsoDisabled: ["rails", "carts"], missing: ["signals"] }), "hearth", T, name)!;
    expect(text.tone).toBe("warn");
    expect(text.lines).toEqual([
      { key: "mods.noticeInstalled", args: ["HEARTH", T] },
      { key: "mods.noticeDepsInstalled", args: ["COGWORK"] },
      { key: "mods.noticeAlsoDisabled", args: ["RAILS and CARTS"] },
      { key: "mods.noticeMissing", count: 1, args: ["SIGNALS", T] },
    ]);
  });

  it("say a mod with a missing dependency was installed turned off, once", () => {
    const r = report([installed("railways", { enabled: false, status: "off" })]);
    const text = describeChange(change({ report: r, installed: ["railways"], missing: ["signals"], installedOff: ["railways"] }), "railways", T, name)!;
    expect(text.lines).toEqual([{ key: "mods.noticeInstalledOffMissing", count: 1, args: ["RAILWAYS", "SIGNALS", T] }]);
  });

  it("say an update of an off mod left it off", () => {
    const r = report([installed("hearth", { enabled: false, status: "off" })]);
    expect(describeChange(change({ report: r, installed: ["hearth"] }), "hearth", T, name)!.lines[0].key).toBe("mods.noticeInstalledOff");
  });

  it("say what a removal did", () => {
    const text = describeRemove(change({ alsoDisabled: ["hearth"], undo: "cogwork" }), "cogwork", T, name);
    expect(text.lines).toEqual([
      { key: "mods.noticeRemoved", args: ["COGWORK", T] },
      { key: "mods.noticeAlsoDisabled", args: ["HEARTH"] },
    ]);
  });

  it("count copied mods and list what stayed behind or stayed off", () => {
    const text = describeCopy(
      {
        ...change({ installed: ["a", "railways"], installedOff: ["railways"], missing: ["signals"] }),
        leftBehind: [{ id: "t", name: "My Tweak", outcome: "localFile", version: null, trust: null, sha256: null }],
      },
      "v26.10.4",
      T,
      name
    );
    expect(text.lines).toEqual([
      { key: "mods.noticeCopied", count: 2, args: ["v26.10.4"] },
      { key: "mods.noticeCopiedOff", count: 1, args: ["RAILWAYS", T] },
      { key: "mods.noticeLeftBehind", count: 1, args: ["My Tweak"] },
      { key: "mods.noticeMissing", count: 1, args: ["SIGNALS", T] },
    ]);
  });

  it("say nothing when nothing happened worth saying", () => {
    expect(describeChange(change(), null, T, name)).toBeNull();
  });
});

describe("contract R4: shadowing, reasons and recovery", () => {
  it("a revoked mod with a copy in the player's folder blocks, and the fix is that folder", () => {
    const r = report([installed("cogwork", { status: "revoked", enabled: false, revokedReason: "Corrupts worlds." })], {
      blocking: ["cogwork"],
      blockingReasons: { cogwork: "shadowedRevoked" },
      shadowed: [{ id: "cogwork", file: "cogwork-old.zip", managed: "revoked" }],
    });
    const [b] = blockers(r, name);
    expect(b.reasons).toEqual([{ key: "mods.blockShadowedRevoked", args: ["cogwork-old.zip", "Cogwork", "Corrupts worlds."] }]);
    expect(b.fixes.map((f) => f.kind)).toEqual(["showFolder"]);
    // Turning it off can't help: it is off already.
    expect(b.fixes.some((f) => f.kind === "turnOff")).toBe(false);
  });

  it("the row says a copy in the player's folder loads instead", () => {
    const m = installed("showcase", { status: "off", enabled: false });
    const meta = modMeta(m, "v26.11.1", name, undefined, { id: "showcase", file: "tweak.zip", managed: "off" });
    expect(meta.shadowed).toBe(true);
    expect(meta.parts[meta.parts.length - 1]).toEqual({ key: "mods.shadowOffRow", args: ["tweak.zip"] });
    expect(meta.bad).toBe(false);
    const on = modMeta(installed("fine"), "v26.11.1", name, undefined, { id: "fine", file: "f.zip", managed: "on" });
    expect(on.shadowed).toBe(false);
  });

  it("uses the backend's reason for the wording", () => {
    const r = report([installed("old", { status: "wrongVersion", weftTag: "v26.10.4" })], { blockingReasons: { old: "wrongVersion" } });
    expect(blockers(r, name)[0].reasons[0]).toEqual({ key: "mods.blockWrongVersionTag", args: ["v26.10.4"] });
  });

  it("a missing-dependency crash clears once that dependency is on and usable", () => {
    const failure = { kind: "missingDep" as const, modId: "hearth", other: "cogwork", line: "x" };
    const before = report([installed("hearth"), installed("cogwork", { enabled: false, status: "off" })]);
    const snap = snapshotFor(failure, before);
    expect(crashResolved(snap, before)).toBe(false);
    expect(crashResolved(snap, report([installed("hearth"), installed("cogwork", { status: "revoked", revokedReason: "x" })]))).toBe(false);
    expect(crashResolved(snap, report([installed("hearth"), installed("cogwork")]))).toBe(true);
  });

  it("a toggle with side effects names what the player did first", () => {
    const r: ChangeResult = { report: report([]), installed: [], alsoEnabled: [], alsoDisabled: ["hearth"], missing: [], installedOff: [], undo: null };
    expect(describeToggle(r, "cogwork", false, "v", name)?.lines).toEqual([
      { key: "mods.noticeTurnedOff", args: ["COGWORK"] },
      { key: "mods.noticeAlsoDisabled", args: ["HEARTH"] },
    ]);
    expect(describeToggle({ ...r, alsoDisabled: [] }, "cogwork", false, "v", name)).toBeNull();
  });

  it("turning off a mod with a copy in the player's folder says that copy loads instead", () => {
    const shadowed = { ...report([]), shadowed: [{ id: "cogwork", file: "cogwork-old.zip", managed: "off" as const }] };
    const r: ChangeResult = { report: shadowed, installed: [], alsoEnabled: [], alsoDisabled: [], missing: [], installedOff: [], undo: null };
    expect(describeToggle(r, "cogwork", false, "v", name)).toEqual({
      tone: "warn",
      lines: [
        { key: "mods.noticeTurnedOff", args: ["COGWORK"] },
        { key: "mods.noticeShadowLoads", args: ["COGWORK", "cogwork-old.zip"] },
      ],
    });
    expect(describeToggle(r, "cogwork", true, "v", name)).toBeNull();
  });
});

