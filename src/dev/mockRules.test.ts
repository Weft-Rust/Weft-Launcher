// The mock's rules against the cases of the Rust table tests (fixtures/rules.json). A rule that
// drifts from src-tauri/src/mods fails here, not in a UI test that trusts the mock.
import { describe, expect, it } from "vitest";
import rules from "./fixtures/rules.json";
import * as R from "./mockRules";
import type { Catalog, CatalogMod, Channel, Origin, Trust } from "../mods/types";

type AbiName = keyof typeof rules.abi;
const abi = (name: string | null | undefined): string | null => (name ? rules.abi[name as AbiName] : null);
const FIT = { abi: rules.abi.ABI, platform: "linux-x64" };

interface EntrySpec {
  id: string;
  deps?: string[];
  abi?: string | null;
  enabled?: boolean;
  version?: string;
  channel?: string;
  trust?: string;
  origin?: { kind: string; name?: string; repo?: string };
  revoked?: { reason: string; at: string };
}

/** The Rust test helper `entry(id, deps, abi)`, with the fields given changed. */
function entry(s: EntrySpec): R.Entry {
  const version = s.version ?? "0.1.0";
  return {
    id: s.id,
    name: `${s.id} name`,
    summary: "",
    version,
    channel: (s.channel ?? "release") as Channel,
    sha256: `${s.id}@${version}`,
    size: 1,
    enabled: s.enabled ?? true,
    trust: (s.trust ?? "reviewed") as Trust,
    origin: (s.origin ?? { kind: "index" }) as Origin,
    abi: s.abi === undefined ? rules.abi.ABI : abi(s.abi),
    weftTag: null,
    deps: s.deps ?? [],
    tag: null,
    sourceRepo: null,
    sourceCommit: null,
    icon: null,
    installedAt: "",
    revoked: s.revoked ?? null,
  };
}

function catalog(name: keyof typeof rules.catalogs): Catalog {
  const c = rules.catalogs[name];
  const mods: CatalogMod[] = c.mods.map((m) => {
    const origin: Origin = m.origin === "index" ? { kind: "index" } : { kind: "source", repo: m.origin };
    return {
      key: R.originKey(origin, m.id)!,
      id: m.id,
      name: `${m.id} name`,
      summary: "",
      authors: [],
      license: null,
      homepage: null,
      icon: null,
      origin,
      versions: m.builds.map(([version, a, channel, deps]) => ({
        version: version as string,
        channel: channel as Channel,
        tag: `${m.id}-v${version}`,
        published: "",
        sourceRepo: "Zorro909/weft-mods",
        sourceCommit: "c".repeat(40),
        weftTag: null,
        abi: abi(a as string)!,
        deps: deps as string[],
        platforms: ["linux-x64"],
        sha256: `${m.id}@${version}`,
        size: 10,
        url: "",
        provenance: null,
        provenanceVerified: false,
        reviewed: null,
        trust: "reviewed",
      })),
    };
  });
  return {
    mods,
    revoked: c.revoked.map((sha256) => ({ sha256, reason: "broken" })),
    index: { freshness: "fresh", generated: null, error: null, signedAt: null },
    sources: [],
    weft: [],
    platform: "linux-x64",
  };
}

const build = (c: Catalog, sha: string) => {
  const b = R.findBuild(c, sha);
  if (!b) throw new Error(`no build ${sha}`);
  return b;
};
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { code: string }).code;
  }
};

describe("mock rules follow the backend's", () => {
  it.each(rules.plans.cases)("plan: $what", (c) => {
    const cat = catalog(rules.plans.catalog as "world");
    const fit = "abi" in c && c.abi === null ? null : FIT;
    const plan = R.planInstall(cat, (c.lock as EntrySpec[]).map(entry), "v1", c.target, fit, "running" in c && !!c.running);
    expect(plan.install.map((i) => i.id)).toEqual(c.install);
    expect(plan.enable).toEqual(c.enable);
    expect(plan.missing).toEqual(c.missing);
    expect(plan.problem?.code ?? null).toBe(c.problem);
    expect(plan.turnsOn).toBe(c.turnsOn);
    if ("replaces" in c) expect(plan.replaces).toMatchObject(c.replaces!);
  });

  it.each(rules.commits.cases)("commit: $what", (c) => {
    const cat = catalog(rules.commits.catalog as "world");
    const lock = (c.lock as EntrySpec[]).map(entry);
    const res = R.resolve(cat, lock, c.wanted.map((s) => build(cat, s)), FIT);
    const done = R.commit(lock, res, "");
    expect(done.installed).toEqual(c.installed);
    expect(done.alsoEnabled).toEqual(c.alsoEnabled);
    expect(done.installedOff).toEqual(c.installedOff);
    for (const [id, on] of Object.entries(c.after)) expect(lock.find((e) => e.id === id)?.enabled, id).toBe(on);
  });

  it.each(rules.toggles.cases)("toggle: $what", (c) => {
    const cat = catalog(rules.toggles.catalog as "empty");
    const lock = (c.lock as EntrySpec[]).map(entry);
    const [action, id] = c.action;
    let out: { alsoEnabled: string[]; alsoDisabled: string[] } | undefined;
    const code = codeOf(() => {
      out = action === "remove" ? { alsoEnabled: [], ...R.remove(lock, id) } : R.setEnabled(lock, cat, id, action === "on");
    });
    if ("error" in c) {
      expect(code).toBe(c.error);
      if (c.error === "ModRevoked") expect(lock.every((e) => !e.enabled), "nothing changes").toBe(true);
      return;
    }
    expect(code).toBeNull();
    expect([...out!.alsoEnabled].sort()).toEqual(c.alsoEnabled);
    expect([...out!.alsoDisabled].sort()).toEqual(c.alsoDisabled);
    for (const [k, on] of Object.entries(("after" in c && c.after) || {})) expect(lock.find((e) => e.id === k)?.enabled).toBe(on);
  });

  it("copy preview", () => {
    const c = rules.copies;
    const cat = catalog(c.catalog as "world");
    const { preview, picks } = R.copyPreview(cat, ["v1", (c.from as EntrySpec[]).map(entry)], ["v2", c.to.map(entry)], FIT);
    for (const [id, want] of Object.entries(c.outcomes)) {
      const item = preview.items.find((i) => i.id === id);
      expect(item ? [item.outcome, item.version] : null, id).toEqual(want);
    }
    expect(picks.map((p) => p.mod.id)).toEqual(c.picks);
    expect(preview.items[0].trust).toBe("reviewed");
  });

  it("statuses, blocking and missing dependencies", () => {
    const s = rules.statuses;
    const cat = catalog(s.catalog as "statuses");
    const lock = (s.lock as EntrySpec[]).map(entry);
    for (const [a, id, want] of s.cases) {
      const r = R.report("v1", lock, abi(a), null, cat, []);
      expect(r.mods.find((m) => m.id === id)?.status, `${id} with ${a}`).toBe(want);
    }
    const r = R.report("v1", lock, rules.abi.ABI, null, cat, []);
    expect(r.blocking).toEqual(s.blocking);
    for (const [id, want] of Object.entries(s.missingDeps)) expect(r.mods.find((m) => m.id === id)?.missingDeps).toEqual(want);
    for (const [id, want] of Object.entries(s.depsNotInstalled)) expect(r.mods.find((m) => m.id === id)?.depsNotInstalled).toEqual(want);
    for (const [id, want] of Object.entries(s.revokedReason)) expect(r.mods.find((m) => m.id === id)?.revokedReason).toBe(want);
  });

  it.each(rules.updates.cases)("update: $what", (c) => {
    const cat = catalog(rules.updates.catalog as "updates");
    expect(R.updateFor(entry(c.entry as EntrySpec), FIT, cat)?.version ?? null).toBe(c.want);
    expect(R.updateFor(entry(c.entry as EntrySpec), null, cat)).toBeNull();
  });

  it("remembers a revocation in the lock and keeps it", () => {
    const cat = catalog("statuses");
    const lock = [entry({ id: "pulled" }), entry({ id: "fine" })];
    expect(R.applyRevocations(lock, cat, "2026-11-04T00:00:00Z")).toBe(true);
    expect(lock[0]).toMatchObject({ enabled: false, revoked: { reason: "broken" } });
    expect(lock[1].enabled).toBe(true);
    expect(R.applyRevocations(lock, cat, "later")).toBe(false);
    // The index is gone: the lock still says so.
    const r = R.report("v1", lock, rules.abi.ABI, null, { ...cat, revoked: [] }, []);
    expect(r.mods[0]).toMatchObject({ status: "revoked", revokedReason: "broken" });
  });

  it("shadowing: a player-folder copy of a managed mod, and a revoked one blocks", () => {
    const s = rules.shadowing;
    const cat = catalog(s.catalog as "statuses");
    const r = R.report("v1", (s.lock as EntrySpec[]).map(entry), rules.abi.ABI, null, cat, s.playerFolder);
    expect(r.unmanaged).toEqual(s.unmanaged);
    expect(r.shadowed).toEqual(s.shadowed);
    expect(r.blocking).toEqual(s.blocking);
    expect(r.blockingReasons).toEqual(s.blockingReasons);
  });

  it("revocations fail closed", () => {
    const v = rules.revocations;
    const { kept, dropped } = R.readRevocations(v.entries as R.RawRevocation[]);
    expect(kept).toEqual(v.kept);
    expect(dropped).toHaveLength(v.dropped);
    const cat = { ...catalog("empty"), revoked: kept.map(({ sha256, reason }) => ({ sha256, reason })) };
    for (const [sha, revoked] of v.matches) expect(R.revocation(cat, sha as string) !== null, String(sha)).toBe(revoked);
  });

  it("every blocking id has a reason", () => {
    const s = rules.statuses;
    const r = R.report("v1", (s.lock as EntrySpec[]).map(entry), rules.abi.ABI, null, catalog(s.catalog as "statuses"), []);
    expect(Object.keys(r.blockingReasons).sort()).toEqual([...r.blocking].sort());
    expect(r.blockingReasons).toEqual({ cogwork: "missingDeps", old: "wrongVersion" });
  });
});

describe("plan tokens and fit (contract R4 §2, §5)", () => {
  const cat = catalog("world");
  it("the same plan gives the same token; a changed consent another", () => {
    const lock = [entry({ id: "mid", deps: ["leaf"], enabled: false }), entry({ id: "leaf", enabled: false })];
    const a = R.planInstall(cat, lock, "v1", "top@1.0.0", FIT, false);
    const b = R.planInstall(cat, lock.map((e) => ({ ...e })), "v1", "top@1.0.0", FIT, false);
    expect(a.planToken).toBe(b.planToken);
    // Leaf is on now: one fewer mod turns on, so the player agreed to something else.
    const c = R.planInstall(cat, [lock[0], { ...lock[1], enabled: true }], "v1", "top@1.0.0", FIT, false);
    expect(c.planToken).not.toBe(a.planToken);
    // A dependency's tier changes.
    const swapped = { ...cat, mods: cat.mods.map((m) => (m.id === "leaf" ? { ...m, versions: m.versions.map((v) => ({ ...v, trust: "unreviewed" as Trust })) } : m)) };
    const d = R.planInstall(swapped, [lock[0]], "v1", "top@1.0.0", FIT, false);
    const e = R.planInstall(cat, [lock[0]], "v1", "top@1.0.0", FIT, false);
    expect(d.planToken).not.toBe(e.planToken);
  });

  it("fitsVersion is unknown, never false, without the version's interface", () => {
    expect(R.planInstall(cat, [], "v1", "cogwork@0.2.0", null, false).fitsVersion).toBeNull();
    expect(R.planInstall(cat, [], "v1", "cogwork@0.2.0", FIT, false).fitsVersion).toBe(true);
    expect(R.planInstall(cat, [], "v1", "cogwork@0.1.0", FIT, false).fitsVersion).toBe(false);
  });

  it("a copy preview carries a token", () => {
    const { preview } = R.copyPreview(cat, ["v1", [entry({ id: "cogwork", deps: ["showcase"], abi: "OLD" })]], ["v2", []], FIT);
    expect(preview.planToken).toMatch(/^plan-/);
  });
});
