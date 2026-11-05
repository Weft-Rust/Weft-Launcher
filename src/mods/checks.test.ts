import { describe, expect, it } from "vitest";
import {
  activeStep,
  buildChecks,
  consentChanges,
  copyConsentView,
  fileReplaceNotes,
  planConsent,
  fileChecks,
  fileVerdict,
  installChecks,
  installOutcome,
  pinCheck,
  replaceNotes,
  weakerDeps,
  type CheckRow,
} from "./checks";
import { ABI, OLD_ABI, build } from "./fixtures";
import type { FileInspection, InstallPlan } from "./types";

const row = (rows: CheckRow[], id: string) => rows.find((r) => r.id === id);

function plan(extra: Partial<InstallPlan> = {}): InstallPlan {
  return {
    target: { id: "hearth", name: "Hearth", version: "0.4.0", sha256: "h".repeat(64), trust: "reviewed", channel: "release", size: 1 },
    replaces: null,
    install: [],
    enable: [],
    missing: [],
    problem: null,
    turnsOn: true,
    fitsVersion: true,
    planToken: "plan-x",
    ...extra,
  };
}

const ctx = {
  tag: "v26.11.1",
  name: (id: string) => id.toUpperCase(),
  enabled: new Set<string>(),
  trustOf: (id: string) => (id === "lamps" ? ("unverified" as const) : undefined),
  versionAbi: ABI as string | null,
};

describe("provenance", () => {
  it("is a green check only when the signed index vouches for it", () => {
    expect(row(buildChecks(build("1.0.0")), "provenance")?.state).toBe("yes");
  });

  it("is unknown, never green, when only the repo claims it", () => {
    const claimed = build("1.0.0", { trust: "unreviewed", reviewed: null, provenanceVerified: false });
    const r = row(buildChecks(claimed), "provenance")!;
    expect(r.state).toBe("unknown");
    expect(r.title.key).toBe("mods.ckBuiltClaimed");
  });

  it("says 'no build record' as unknown", () => {
    const r = row(buildChecks(build("1.0.0", { provenance: null })), "provenance")!;
    expect(r).toMatchObject({ state: "unknown", title: { key: "mods.ckNoBuild" } });
  });
});

describe("review and pin", () => {
  it("says a Reviewed build is in the index, an Unreviewed one isn't", () => {
    expect(row(buildChecks(build("1.0.0")), "review")?.state).toBe("yes");
    expect(row(buildChecks(build("1.0.0", { trust: "unreviewed", reviewed: null })), "review")?.state).toBe("no");
  });

  it("only counts the index's pin as a check; GitHub's digest is unknown", () => {
    expect(pinCheck(build("1.0.0")).state).toBe("yes");
    const github = pinCheck(build("1.0.0", { trust: "unreviewed", reviewed: null }));
    expect(github).toMatchObject({ state: "unknown", title: { key: "mods.ckPinnedGithub" } });
  });
});

describe("installChecks", () => {
  it("names each dependency and what happens to it", () => {
    const v = build("0.4.0", { deps: ["base", "cogwork", "signals", "lamps", "glue"] });
    const rows = installChecks(
      plan({
        install: [{ id: "cogwork", name: "Cogwork", version: "0.2.0", sha256: "c".repeat(64), trust: "unreviewed", channel: "release", size: 1 }],
        enable: ["lamps"],
        missing: ["signals"],
      }),
      v,
      { ...ctx, enabled: new Set(["glue"]) }
    );
    expect(row(rows, "dep:cogwork")).toMatchObject({ state: "yes", title: { key: "mods.ckDepInstall", args: ["Cogwork", "0.2.0"] }, trust: "unreviewed" });
    expect(row(rows, "dep:lamps")).toMatchObject({ state: "yes", title: { key: "mods.ckDepEnable", args: ["LAMPS"] }, trust: "unverified" });
    expect(row(rows, "dep:signals")).toMatchObject({ state: "no", title: { key: "mods.ckDepMissing", args: ["SIGNALS", "v26.11.1"] } });
    expect(row(rows, "dep:glue")).toMatchObject({ state: "yes", title: { key: "mods.ckDepHave" } });
    expect(rows.some((r) => r.id === "dep:base")).toBe(false);
  });

  it("doesn't call a dependency fine when the plan says nothing about it and it's off", () => {
    const rows = installChecks(plan(), build("0.4.0", { deps: ["base", "glue"] }), ctx);
    expect(row(rows, "dep:glue")?.state).toBe("unknown");
  });

  it("leads with the problem when the install would fail", () => {
    const rows = installChecks(plan({ problem: { code: "ModIncompatible", detail: "Hearth" }, fitsVersion: false }), build("0.4.0"), ctx);
    expect(rows[0]).toMatchObject({ id: "problem", state: "no" });
    expect(row(rows, "abi")?.state).toBe("no");
  });
});

describe("fit with the version", () => {
  it("is yes only when both mod interfaces are known and equal", () => {
    expect(row(installChecks(plan(), build("0.4.0"), ctx), "abi")?.state).toBe("yes");
    expect(row(installChecks(plan({ fitsVersion: false }), build("0.4.0", { abi: OLD_ABI }), ctx), "abi")?.state).toBe("no");
  });

  it("is unknown, never a green check, when the version's interface couldn't be found out", () => {
    const rows = installChecks(plan({ problem: { code: "AbiUnavailable", detail: "v" }, fitsVersion: null }), build("0.4.0"), { ...ctx, versionAbi: null });
    expect(row(rows, "abi")).toMatchObject({ state: "unknown", title: { key: "mods.ckFitUnchecked" } });
  });
});

describe("installOutcome", () => {
  it("installs turned off when a dependency has no build, and says so", () => {
    const o = installOutcome(plan({ missing: ["signals"], turnsOn: false }), false, "Railways", ctx);
    expect(o.button).toBe("mods.installTurnedOff");
    expect(o.explain).toEqual({ key: "mods.installsOff", count: 1, args: ["SIGNALS", "v26.11.1", "Railways"] });
  });

  it("is a plain install or update otherwise, also for an off mod that stays off", () => {
    expect(installOutcome(plan(), false, "Hearth", ctx)).toEqual({ button: "mods.install", explain: null });
    const off = plan({ turnsOn: false, replaces: { version: "1", sha256: "o".repeat(64), trust: "reviewed", enabled: false } });
    expect(installOutcome(off, true, "Hearth", ctx)).toEqual({ button: "mods.updateButton", explain: null });
  });
});

describe("weakerDeps", () => {
  it("names what an install brings that nobody reviewed, downloaded or turned on", () => {
    const p = plan({
      install: [
        { id: "glow", name: "Glowmoss", version: "1", sha256: "g".repeat(64), trust: "unreviewed", channel: "release", size: 1 },
        { id: "fine", name: "Fine", version: "1", sha256: "f".repeat(64), trust: "reviewed", channel: "release", size: 1 },
      ],
      enable: ["lamps"],
    });
    expect(weakerDeps(p, ctx)).toEqual([
      { name: "Glowmoss", trust: "unreviewed" },
      { name: "LAMPS", trust: "unverified" },
    ]);
  });
});

describe("activeStep", () => {
  const ev = (sha: string, modId: string, stage: "downloading" | "verifying" | "installing", percent: number, index: number) => ({
    operationId: "op",
    sha256: sha.repeat(64),
    modId,
    stage,
    percent,
    index,
    count: 3,
  });

  it("follows the newest event: a file that finished checking never hides the next download", () => {
    // The sequence from review sol-r3 §4: A checked at 100%, then B downloading at 25%.
    const entries = [ev("a", "cogwork", "verifying", 100, 1), ev("b", "glowmoss", "downloading", 25, 2)];
    expect(activeStep(entries)).toMatchObject({ modId: "glowmoss", percent: 25, index: 2, count: 3 });
  });

  it("shows the install step at the end, and nothing before the first event", () => {
    expect(activeStep([ev("a", "cogwork", "installing", 100, 3)])).toMatchObject({ stage: "installing", index: 3 });
    expect(activeStep([])).toBeUndefined();
  });
});

describe("fit (contract R4 §5)", () => {
  it("is unknown with Retry when the backend can't tell, never 'no'", () => {
    const rows = installChecks(plan({ fitsVersion: null, problem: { code: "AbiUnavailable", detail: "v26.11.1" } }), build("1.0.0"), { ...ctx, versionAbi: null });
    expect(row(rows, "abi")).toMatchObject({ state: "unknown", retry: true, title: { key: "mods.ckFitUnchecked" } });
  });

  it("says no only when it is no", () => {
    expect(row(installChecks(plan({ fitsVersion: false }), build("1.0.0", { abi: OLD_ABI }), ctx), "abi")?.state).toBe("no");
    expect(row(installChecks(plan({ fitsVersion: true }), build("1.0.0"), ctx), "abi")?.state).toBe("yes");
  });

  it("dates a review from an index that isn't fresh", () => {
    const rows = installChecks(plan(), build("1.0.0"), { ...ctx, indexFrom: "Sep 21, 2026" });
    expect(row(rows, "review")?.detail).toMatchObject({ key: "mods.ckIndexDetailDated" });
  });
});

describe("consentChanges", () => {
  const glow = (version: string, trust: "reviewed" | "unreviewed" = "unreviewed") => ({
    id: "glowmoss",
    name: "Glowmoss",
    version,
    sha256: version.repeat(8).slice(0, 64),
    trust,
    channel: "release" as const,
    size: 1,
  });

  it("names a dependency that got a newer build, and one that turns on now", () => {
    const before = planConsent(plan({ install: [glow("0.3.0")] }));
    const after = planConsent(plan({ install: [glow("0.3.1")], enable: ["cogwork"] }));
    expect(consentChanges(before, after, ctx.name)).toEqual([
      { key: "mods.changedVersion", args: ["Glowmoss", "0.3.1", "0.3.0"] },
      { key: "mods.changedEnables", args: ["COGWORK"] },
    ]);
  });

  it("names a tier change, an added and a dropped build, and a mod now installed off", () => {
    const before = planConsent(plan({ install: [glow("0.3.0")] }));
    const after = planConsent(
      plan({ install: [glow("0.3.0", "reviewed"), { ...glow("1.0.0"), id: "moss", name: "Moss" }], turnsOn: false, missing: ["x"] })
    );
    const keys = consentChanges(before, after, ctx.name).map((c) => c.key);
    expect(keys).toEqual(["mods.changedTrust", "mods.changedAdded", "mods.changedOff"]);
    expect(consentChanges(after, before, ctx.name).map((c) => c.key)).toEqual(["mods.changedTrust", "mods.changedDropped", "mods.changedOn"]);
  });

  it("says the plan changed when nothing visible did", () => {
    const same = planConsent(plan());
    expect(consentChanges(same, same, ctx.name)).toEqual([{ key: "mods.changedOther" }]);
  });

  it("reads a copy preview the same way", () => {
    const v = copyConsentView({
      from: "a",
      to: "b",
      items: [{ id: "c", name: "C", outcome: "install", version: "1", trust: "reviewed", sha256: "c".repeat(64) }],
      deps: [],
      enable: ["e"],
      installedOff: [],
      missing: [],
      planToken: "t",
    });
    expect(v).toEqual({ builds: [{ id: "c", name: "C", version: "1", trust: "reviewed" }], enable: ["e"], off: [] });
  });
});

describe("replaceNotes", () => {
  it("says when an update changes the tier and that an off mod stays off", () => {
    const notes = replaceNotes(
      plan({
        target: { ...plan().target, trust: "unreviewed" },
        replaces: { version: "0.1.2", sha256: "o".repeat(64), trust: "reviewed", enabled: false },
      })
    );
    expect(notes[0]).toEqual({ key: "mods.ckReplacesTrust", args: ["0.1.2", { trust: "reviewed" }, { trust: "unreviewed" }] });
    expect(notes[1]).toEqual({ key: "mods.ckReplacesOff" });
  });

  it("is a plain note when the tier stays", () => {
    const notes = replaceNotes(plan({ replaces: { version: "0.3.0", sha256: "o".repeat(64), trust: "reviewed", enabled: true } }));
    expect(notes).toEqual([{ key: "mods.ckReplaces", args: ["0.3.0"] }]);
  });
});

describe("fileChecks", () => {
  const inspection = (extra: Partial<FileInspection> = {}): FileInspection => ({
    fileName: "x.zip",
    size: 1,
    sha256: "f".repeat(64),
    archive: { id: "x", libraries: ["libx.so"], platforms: ["linux-x64"], hasAssets: false, entries: 2 },
    problem: null,
    name: "X",
    summary: null,
    fitsSystem: true,
    catalogMatch: null,
    revokedReason: null,
    replaces: null,
    planToken: "plan-f",
    ...extra,
  });

  it("shows a catalogued file's review and provenance like the catalogue does", () => {
    const rows = fileChecks(
      inspection({ catalogMatch: { key: "index:x", name: "X", fitsVersion: true, build: build("1.0.0") } }),
      "v26.11.1"
    );
    expect(row(rows, "known")?.state).toBe("yes");
    expect(row(rows, "review")?.state).toBe("yes");
    expect(row(rows, "provenance")?.state).toBe("yes");
    expect(fileVerdict(inspection({ catalogMatch: { key: "k", name: "X", fitsVersion: true, build: build("1.0.0") } }))).toEqual({
      usable: true,
      needsTyping: false,
    });
  });

  it("uses one 'no build record' state for unknown files: unknown", () => {
    const r = row(fileChecks(inspection(), "v26.11.1"), "provenance")!;
    expect(r).toMatchObject({ state: "unknown", title: { key: "mods.ckNoBuild" } });
    expect(fileVerdict(inspection())).toEqual({ usable: true, needsTyping: true });
  });

  it("refuses files that aren't mods, are for another system or were revoked", () => {
    expect(fileVerdict(inspection({ archive: null })).usable).toBe(false);
    expect(fileVerdict(inspection({ fitsSystem: false })).usable).toBe(false);
    expect(fileVerdict(inspection({ revokedReason: "bad" })).usable).toBe(false);
    expect(row(fileChecks(inspection({ revokedReason: "bad" }), "v"), "revoked")?.state).toBe("no");
  });
});

describe("file fit and replacing (contract R4 §5)", () => {
  const inspection = (extra: Partial<FileInspection> = {}): FileInspection => ({
    fileName: "x.zip",
    size: 1,
    sha256: "f".repeat(64),
    archive: { id: "x", libraries: ["libx.so"], platforms: ["linux-x64"], hasAssets: false, entries: 2 },
    problem: null,
    name: "X",
    summary: null,
    fitsSystem: true,
    catalogMatch: null,
    revokedReason: null,
    replaces: null,
    planToken: "plan-f",
    ...extra,
  });

  it("an unknown fit of a known file is unknown with Retry, and doesn't make it unusable", () => {
    const i = inspection({ catalogMatch: { key: "k", name: "X", fitsVersion: null, build: build("1.0.0") } });
    expect(row(fileChecks(i, "v26.11.1"), "abi")).toMatchObject({ state: "unknown", retry: true });
    expect(fileVerdict(i).usable).toBe(true);
    expect(fileVerdict(inspection({ catalogMatch: { key: "k", name: "X", fitsVersion: false, build: build("1.0.0") } })).usable).toBe(false);
  });

  it("states a change of tier when a file replaces an installed mod", () => {
    expect(fileReplaceNotes(inspection({ replaces: "X" }), "reviewed")).toEqual([
      { key: "mods.fileReplacesTrust", args: ["X", { trust: "reviewed" }, { trust: "unverified" }] },
    ]);
    expect(fileReplaceNotes(inspection({ replaces: "X" }), "unverified")).toEqual([{ key: "mods.fileReplaces", args: ["X"] }]);
    expect(fileReplaceNotes(inspection(), "reviewed")).toEqual([]);
  });
});
