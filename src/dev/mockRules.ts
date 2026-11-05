// The mod-set rules of src-tauri/src/mods (plan.rs and profile.rs), on plain data, for the mock
// backend. Each function names the Rust function it follows; mockRules.test.ts runs the Rust table
// tests' cases against them (src/dev/fixtures/rules.json), so a rule that drifts fails a test.
//
// Nothing here touches mock state: the backend in mockBackend.ts holds the locks and calls these.

import { compareVersions } from "../mods/select";
import type {
  AppErrorPayload,
  Catalog,
  CatalogMod,
  CatalogVersion,
  Channel,
  CopyItem,
  CopyPreview,
  InstallPlan,
  InstalledMod,
  ModStatus,
  Origin,
  PlanItem,
  ProfileReport,
  BlockingReason,
  ShadowedMod,
  UpdateView,
} from "../mods/types";

/** One lock entry: what `profiles/<tag>/mods.lock.json` holds per mod. */
export type Entry = Omit<InstalledMod, "status" | "missingDeps" | "depsNotInstalled" | "revokedReason" | "update">;

/** `profile::BUILTIN`: what every game has, never a dependency to install. */
export const BUILTIN = ["base"];

export interface Fit {
  abi: string;
  platform: string;
}

const RANK: Record<Channel, number> = { release: 0, prerelease: 1, experimental: 2 };

const err = (code: AppErrorPayload["code"], detail: string | null = null): AppErrorPayload => ({ code, detail });

/** `Origin::key`. A file from the player's computer has no catalogue key. */
export function originKey(origin: Origin, id: string): string | null {
  if (origin.kind === "index") return `index:${id}`;
  if (origin.kind === "source") return `source:${origin.repo}:${id}`;
  return null;
}

/** `Catalog::by_key`: keys hold a repo name, and repos compare without case. */
export function byKey(catalog: Catalog, key: string): CatalogMod | undefined {
  const k = key.toLowerCase();
  return catalog.mods.find((m) => m.key.toLowerCase() === k);
}

export function findBuild(catalog: Catalog, sha256: string): { mod: CatalogMod; v: CatalogVersion } | undefined {
  for (const mod of catalog.mods) {
    const v = mod.versions.find((x) => x.sha256 === sha256);
    if (v) return { mod, v };
  }
  return undefined;
}

/**
 * The catalogue's revocation of a hash, compared without case (contract R4 §6). Revoked is the
 * record, never whether it gave a reason: `reason` may be null.
 */
export function revocation(catalog: Catalog, sha256: string): { sha256: string; reason: string | null } | null {
  const s = sha256.toLowerCase();
  return catalog.revoked.find((r) => r.sha256.toLowerCase() === s) ?? null;
}

/** For an error's detail, the backend's own words. */
const detailOf = (reason: string | null) => reason ?? "no reason given";

/** One `revoked[]` entry as the index sends it: `at` and `reason` may be missing or null. */
export interface RawRevocation {
  sha256: unknown;
  reason?: string | null;
  at?: string | null;
}

/**
 * `index::format` revocations, failing closed (contract R4 §6): hashes are lowercased, a missing
 * or empty reason is none (the page says "No reason given" in the player's language), a missing
 * time unknown, and an entry is dropped only when its hash can't be a SHA-256 at all; `dropped`
 * lists those, for the log.
 */
export function readRevocations(entries: RawRevocation[]): { kept: { sha256: string; reason: string | null; at: string | null }[]; dropped: unknown[] } {
  const kept: { sha256: string; reason: string | null; at: string | null }[] = [];
  const dropped: unknown[] = [];
  for (const e of entries) {
    const sha = typeof e.sha256 === "string" ? e.sha256.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(sha)) {
      dropped.push(e.sha256);
      continue;
    }
    const reason = typeof e.reason === "string" && e.reason.trim() ? e.reason.trim() : null;
    kept.push({ sha256: sha, reason, at: typeof e.at === "string" ? e.at : null });
  }
  return { kept, dropped };
}

/** Revoked in the catalogue, or remembered in the lock (contract R3 §2), and why if it said. */
export function entryRevocation(catalog: Catalog, e: Entry): { reason: string | null } | null {
  if (e.revoked) return { reason: e.revoked.reason };
  const r = revocation(catalog, e.sha256);
  return r ? { reason: r.reason } : null;
}

const accepts = (fit: Fit, v: CatalogVersion) => v.abi === fit.abi && (v.platforms as string[]).includes(fit.platform);

/** `profile::fitting`: builds of `key` that fit, no less stable than `atMost`, revoked ones included. */
export function fitting(catalog: Catalog, key: string, fit: Fit, atMost: Channel): { mod: CatalogMod; versions: CatalogVersion[] } | null {
  const mod = byKey(catalog, key);
  if (!mod) return null;
  return { mod, versions: mod.versions.filter((v) => accepts(fit, v) && RANK[v.channel] <= RANK[atMost]) };
}

/** `profile::best_version`: the newest fitting build that isn't revoked. */
export function bestVersion(catalog: Catalog, key: string, fit: Fit, atMost: Channel): { mod: CatalogMod; v: CatalogVersion } | null {
  const f = fitting(catalog, key, fit, atMost);
  if (!f) return null;
  const best = f.versions
    .filter((v) => revocation(catalog, v.sha256) === null)
    .reduce<CatalogVersion | null>((a, b) => {
      if (!a) return b;
      const d = compareVersions(b.version, a.version) || RANK[a.channel] - RANK[b.channel];
      return d > 0 ? b : a;
    }, null);
  return best ? { mod: f.mod, v: best } : null;
}

/** `profile::update_for`. */
export function updateFor(e: Entry, fit: Fit | null, catalog: Catalog): UpdateView | null {
  if (!fit) return null;
  const key = originKey(e.origin, e.id);
  if (!key) return null;
  const best = bestVersion(catalog, key, fit, e.channel ?? "release");
  if (!best) return null;
  const fitsNow = e.abi === fit.abi;
  const newer = e.version === null || compareVersions(best.v.version, e.version) > 0;
  if (best.v.sha256 === e.sha256 || (fitsNow && !newer)) return null;
  return { version: best.v.version, sha256: best.v.sha256, channel: best.v.channel, trust: best.v.trust };
}

/** A file in the player's own mods folder, and the mod id it says it is, when it says. */
export interface PlayerFile {
  file: string;
  id: string | null;
}

/**
 * `profile::report`. The engine loads the first copy of an id it finds, the launcher's folder
 * first: a file in the player's folder with a managed id wins whenever the managed copy is off or
 * revoked (contract R4 §4). A revoked one that is shadowed blocks Play.
 */
export function report(
  tag: string,
  lock: Entry[],
  versionAbi: string | null,
  abiError: AppErrorPayload | null,
  catalog: Catalog,
  playerFolder: PlayerFile[]
): ProfileReport {
  const enabled = new Set(lock.filter((m) => m.enabled).map((m) => m.id));
  const installed = new Set(lock.map((m) => m.id));
  const fit = versionAbi === null ? null : { abi: versionAbi, platform: catalog.platform };
  const blocking: string[] = [];
  const blockingReasons: Record<string, BlockingReason> = {};
  const shadowed: ShadowedMod[] = [];
  const mods: InstalledMod[] = lock.map((e) => {
    const revoked = entryRevocation(catalog, e);
    const revokedReason = revoked?.reason ?? null;
    const missingDeps = e.deps.filter((d) => !BUILTIN.includes(d) && !enabled.has(d));
    const status: ModStatus =
      revoked !== null
        ? "revoked"
        : !e.enabled
          ? "off"
          : e.abi !== null && versionAbi !== null && e.abi !== versionAbi
            ? "wrongVersion"
            : missingDeps.length
              ? "missingDeps"
              : e.abi === null || versionAbi === null
                ? "unchecked"
                : "ready";
    const shadow = playerFolder.find((f) => f.id === e.id);
    if (shadow) shadowed.push({ id: e.id, file: shadow.file, managed: status === "revoked" ? "revoked" : e.enabled ? "on" : "off" });
    if (status === "wrongVersion" || status === "missingDeps") {
      blocking.push(e.id);
      blockingReasons[e.id] = status;
    } else if (status === "revoked" && shadow) {
      blocking.push(e.id);
      blockingReasons[e.id] = "shadowedRevoked";
    }
    return {
      ...e,
      status,
      missingDeps,
      depsNotInstalled: missingDeps.filter((d) => !installed.has(d)),
      revokedReason,
      update: updateFor(e, fit, catalog),
    };
  });
  return { tag, versionAbi, abiError, mods, blocking, blockingReasons, unmanaged: playerFolder.map((f) => f.file), shadowed, revocationsPending: [] };
}

/** `profile::apply_revocations`, remembering each in the lock. Returns whether anything changed. */
export function applyRevocations(lock: Entry[], catalog: Catalog, at: string): boolean {
  let changed = false;
  for (const e of lock) {
    const r = revocation(catalog, e.sha256);
    if (r === null) continue;
    if (e.enabled || !e.revoked) changed = true;
    e.enabled = false;
    e.revoked ??= { reason: r.reason, at };
  }
  return changed;
}

/** `Lock::deps_of`: installed mods `id` needs, directly or through others. */
export function depsOf(lock: Entry[], id: string): string[] {
  const out: string[] = [];
  const todo = [id];
  while (todo.length) {
    const next = todo.pop();
    const e = lock.find((m) => m.id === next);
    if (!e) continue;
    for (const d of e.deps) {
      if (!out.includes(d) && d !== id && lock.some((m) => m.id === d)) {
        out.push(d);
        todo.push(d);
      }
    }
  }
  return out;
}

/** `Lock::dependents_of`: turned-on mods that need `id`, directly or through others. */
export function dependentsOf(lock: Entry[], id: string): string[] {
  const out: string[] = [];
  const todo = [id];
  while (todo.length) {
    const next = todo.pop()!;
    for (const m of lock.filter((x) => x.enabled)) {
      if (m.deps.includes(next) && !out.includes(m.id) && m.id !== id) {
        out.push(m.id);
        todo.push(m.id);
      }
    }
  }
  return out;
}

/** `LockEntry::from_catalog`. */
export function entryFrom(mod: CatalogMod, v: CatalogVersion, enabled: boolean, installedAt: string): Entry {
  return {
    id: mod.id,
    name: mod.name,
    summary: mod.summary,
    version: v.version,
    channel: v.channel,
    sha256: v.sha256,
    size: v.size,
    enabled,
    trust: v.trust,
    origin: mod.origin,
    abi: v.abi,
    weftTag: v.weftTag,
    deps: v.deps,
    tag: v.tag,
    sourceRepo: v.sourceRepo,
    sourceCommit: v.sourceCommit,
    icon: mod.icon,
    installedAt,
    revoked: null,
  };
}

/** `Lock::put`: adds the entry, or replaces the mod with the same id; kept in id order. */
export function put(lock: Entry[], entry: Entry) {
  const at = lock.findIndex((e) => e.id === entry.id);
  if (at >= 0) lock[at] = entry;
  else {
    lock.push(entry);
    lock.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

export interface Resolution {
  wanted: string[];
  picks: { mod: CatalogMod; v: CatalogVersion }[];
  /** Installed, usable mods the wanted ones need, directly or through others, with what each needs. */
  installed: Record<string, string[]>;
  /** The part of `installed` that is off now. */
  enable: string[];
  missing: string[];
}

type Node = { kind: "pick"; mod: CatalogMod; v: CatalogVersion } | { kind: "have"; entry: Entry };

/**
 * `plan::resolve` (contract R4 §1): the wanted builds and everything they need, walking the whole
 * graph: through picked builds and through installed mods alike. An installed dependency counts
 * when it fits and isn't revoked; otherwise a catalogue build replaces it, or it is missing.
 */
export function resolve(catalog: Catalog, lock: Entry[], wanted: { mod: CatalogMod; v: CatalogVersion }[], fit: Fit): Resolution {
  const res: Resolution = { wanted: wanted.map((w) => w.mod.id), picks: [], installed: {}, enable: [], missing: [] };
  const todo: Node[] = wanted.map((w) => ({ kind: "pick", ...w }));
  const seen = (id: string) =>
    res.picks.some((p) => p.mod.id === id) ||
    id in res.installed ||
    res.missing.includes(id) ||
    todo.some((n) => (n.kind === "pick" ? n.mod.id : n.entry.id) === id);
  while (todo.length) {
    const node = todo.shift()!;
    const deps = node.kind === "pick" ? node.v.deps : node.entry.deps;
    const origin = node.kind === "pick" ? node.mod.origin : node.entry.origin;
    const channel = (node.kind === "pick" ? node.v.channel : node.entry.channel) ?? "release";
    if (node.kind === "pick") {
      if (res.picks.some((p) => p.mod.id === node.mod.id)) continue;
      res.picks.push({ mod: node.mod, v: node.v });
    } else {
      res.installed[node.entry.id] = node.entry.deps.filter((d) => !BUILTIN.includes(d));
      if (!node.entry.enabled) res.enable.push(node.entry.id);
    }
    for (const dep of deps) {
      if (BUILTIN.includes(dep) || seen(dep)) continue;
      const have = lock.find((e) => e.id === dep);
      if (have && (have.abi === null || have.abi === fit.abi) && entryRevocation(catalog, have) === null) {
        todo.push({ kind: "have", entry: have });
        continue;
      }
      const keys = [`index:${dep}`];
      if (origin.kind === "source") keys.push(`source:${origin.repo}:${dep}`);
      const found = keys.map((k) => bestVersion(catalog, k, fit, channel)).find((x) => x !== null);
      if (found) todo.push({ kind: "pick", ...found });
      else res.missing.push(dep);
    }
  }
  return res;
}

/** What `id` needs within this resolution: a picked build's dependencies, or an installed mod's. */
function depsIn(res: Resolution, id: string): string[] {
  const pick = res.picks.find((p) => p.mod.id === id);
  if (pick) return pick.v.deps;
  return res.installed[id] ?? [];
}

/** `Resolution::needs_missing`: whether `id`, through picked and installed mods, needs something missing. */
export function needsMissing(res: Resolution, id: string): boolean {
  const seen = new Set<string>();
  const todo = [id];
  while (todo.length) {
    const next = todo.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const dep of depsIn(res, next)) {
      if (res.missing.includes(dep)) return true;
      todo.push(dep);
    }
  }
  return false;
}

export interface Outcome {
  /** Wanted mods that end up on, and the picked or installed mods they need. */
  on: Set<string>;
  /** Installed, off mods that will be turned on. */
  enable: string[];
  /** Wanted mods installed turned off because something they need is missing. */
  installedOff: string[];
}

/**
 * `plan::outcome` (contracts R3 §1, R4 §1): a wanted mod is on afterwards when it was on (or is
 * new) and nothing it needs, at any depth, is missing; everything it needs is on with it.
 */
export function outcome(lock: Entry[], res: Resolution): Outcome {
  const installedOff: string[] = [];
  const todo: string[] = [];
  for (const id of res.wanted) {
    if (needsMissing(res, id)) installedOff.push(id);
    else if (lock.find((e) => e.id === id)?.enabled ?? true) todo.push(id);
  }
  const on = new Set<string>();
  while (todo.length) {
    const id = todo.pop()!;
    if (on.has(id)) continue;
    on.add(id);
    for (const dep of depsIn(res, id)) {
      if (res.picks.some((p) => p.mod.id === dep) || dep in res.installed) todo.push(dep);
    }
  }
  return { on, enable: res.enable.filter((id) => on.has(id)), installedOff };
}

/** `InstallPlan.turnsOn` for a wanted mod. */
export function turnsOn(lock: Entry[], res: Resolution, id: string): boolean {
  return outcome(lock, res).on.has(id);
}

export interface Committed {
  installed: string[];
  alsoEnabled: string[];
  installedOff: string[];
}

/** `plan::commit`: writes a resolution into the lock, following `outcome`. */
export function commit(lock: Entry[], res: Resolution, at: string): Committed {
  const out = outcome(lock, res);
  const installed: string[] = [];
  for (const { mod, v } of res.picks) {
    const wasOn = lock.find((e) => e.id === mod.id)?.enabled ?? false;
    const enabled = out.on.has(mod.id) || (!res.wanted.includes(mod.id) && wasOn);
    put(lock, entryFrom(mod, v, enabled, at));
    installed.push(mod.id);
  }
  const alsoEnabled: string[] = [];
  for (const id of out.enable) {
    const e = lock.find((x) => x.id === id);
    if (e && !e.enabled) {
      e.enabled = true;
      alsoEnabled.push(id);
    }
  }
  return { installed, alsoEnabled, installedOff: out.installedOff };
}

const planItem = (mod: CatalogMod, v: CatalogVersion): PlanItem => ({
  id: mod.id,
  name: mod.name,
  version: v.version,
  sha256: v.sha256,
  trust: v.trust,
  channel: v.channel,
  size: v.size,
});

/** FNV-1a over a string, as hex: stable, and enough to tell two plans apart in the mock. */
export function fnv(text: string, rounds = 2): string {
  let out = "";
  for (let round = 0; round < rounds; round++) {
    let h = 2166136261 ^ round;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out;
}

/** What the player consents to (contract R4 §2). */
export interface Consent {
  builds: { sha256: string; trust: string }[];
  on: string[];
  turnsOn: boolean;
  installedOff: string[];
  abi: string | null;
}

/**
 * `plan::plan_token`: an opaque digest of a consent. The same consent gives the same token,
 * whatever order its lists come in; any change to it gives another.
 */
export function planToken(c: Consent): string {
  const canonical = JSON.stringify({
    builds: c.builds.map((b) => `${b.sha256.toLowerCase()}:${b.trust}`).sort(),
    on: [...c.on].sort(),
    turnsOn: c.turnsOn,
    installedOff: [...c.installedOff].sort(),
    abi: c.abi,
  });
  return `plan-${fnv(canonical)}`;
}

/** The consent of a resolution: what it installs, and every mod it turns on (installed or new). */
export function consentOf(lock: Entry[], res: Resolution, abi: string | null, turnsOn: boolean): Consent {
  const out = outcome(lock, res);
  return {
    builds: res.picks.map((p) => ({ sha256: p.v.sha256, trust: p.v.trust })),
    on: [...out.enable, ...res.picks.map((p) => p.mod.id).filter((id) => out.on.has(id))],
    turnsOn,
    installedOff: out.installedOff,
    abi,
  };
}

/** `plan::check_installable`. */
export function checkInstallable(catalog: Catalog, mod: CatalogMod, v: CatalogVersion, fit: Fit): AppErrorPayload | null {
  if (BUILTIN.includes(mod.id)) return err("ModIdReserved", mod.id);
  const r = revocation(catalog, v.sha256);
  if (r !== null) return err("ModRevoked", `${mod.name}: ${detailOf(r.reason)}`);
  if (!(v.platforms as string[]).includes(fit.platform)) return err("ModNotForPlatform", mod.name);
  if (v.abi !== fit.abi) return err("ModIncompatible", mod.name);
  return null;
}

/** `plan::plan_install`. Throws `ModNotInCatalog` for a hash the catalogue doesn't have. */
export function planInstall(catalog: Catalog, lock: Entry[], tag: string, sha256: string, fit: Fit | null, running: boolean): InstallPlan {
  const found = findBuild(catalog, sha256);
  if (!found) throw err("ModNotInCatalog", sha256);
  const { mod, v } = found;
  const existing = lock.find((e) => e.id === mod.id);
  const plan: InstallPlan = {
    target: planItem(mod, v),
    replaces: existing ? { version: existing.version, sha256: existing.sha256, trust: existing.trust, enabled: existing.enabled } : null,
    install: [],
    enable: [],
    missing: [],
    problem: null,
    turnsOn: false,
    fitsVersion: null,
    planToken: "",
  };
  if (!fit) {
    // Contract R4 §5: unknown, not "no".
    plan.problem = err("AbiUnavailable", tag);
    plan.planToken = planToken({ builds: [{ sha256: v.sha256, trust: v.trust }], on: [], turnsOn: false, installedOff: [], abi: null });
    return plan;
  }
  const res = resolve(catalog, lock, [{ mod, v }], fit);
  const out = outcome(lock, res);
  plan.turnsOn = out.on.has(mod.id);
  plan.install = res.picks.filter((p) => p.mod.id !== mod.id).map((p) => planItem(p.mod, p.v));
  plan.enable = out.enable;
  plan.missing = res.missing;
  plan.fitsVersion = v.abi === fit.abi;
  plan.problem = checkInstallable(catalog, mod, v, fit) ?? (running ? err("GameRunning", tag) : null);
  plan.planToken = planToken(consentOf(lock, res, fit.abi, plan.turnsOn));
  return plan;
}

/** `plan::set_enabled`. Returns what else changed; throws `ModRevoked` or `ModNotInstalled`. */
export function setEnabled(lock: Entry[], catalog: Catalog, id: string, enabled: boolean): { alsoEnabled: string[]; alsoDisabled: string[] } {
  const entry = lock.find((e) => e.id === id);
  if (!entry) throw err("ModNotInstalled", id);
  const revoked = (e: Entry) => {
    const r = entryRevocation(catalog, e);
    return r === null ? null : err("ModRevoked", `${e.name}: ${detailOf(r.reason)}`);
  };
  const alsoEnabled: string[] = [];
  const alsoDisabled: string[] = [];
  if (enabled) {
    const own = revoked(entry);
    if (own) throw own;
    const deps = depsOf(lock, id);
    for (const d of deps) {
      const e = lock.find((x) => x.id === d);
      const r = e && revoked(e);
      if (r) throw r;
    }
    for (const d of deps) {
      const e = lock.find((x) => x.id === d)!;
      if (!e.enabled) {
        e.enabled = true;
        alsoEnabled.push(d);
      }
    }
  } else {
    for (const d of dependentsOf(lock, id)) {
      lock.find((x) => x.id === d)!.enabled = false;
      alsoDisabled.push(d);
    }
  }
  entry.enabled = enabled;
  return { alsoEnabled, alsoDisabled };
}

/** `plan::remove`: removes a mod and turns off what needed it. Returns those and the removed entry. */
export function remove(lock: Entry[], id: string): { alsoDisabled: string[]; removed: Entry } {
  const at = lock.findIndex((e) => e.id === id);
  if (at < 0) throw err("ModNotInstalled", id);
  const alsoDisabled = dependentsOf(lock, id);
  for (const d of alsoDisabled) lock.find((x) => x.id === d)!.enabled = false;
  const [removed] = lock.splice(at, 1);
  return { alsoDisabled, removed };
}

/** `plan::copy_preview`: what copying the turned-on mods of `from` into `to` brings, and the builds. */
export function copyPreview(
  catalog: Catalog,
  from: [string, Entry[]],
  to: [string, Entry[]],
  fit: Fit
): { preview: CopyPreview; picks: { mod: CatalogMod; v: CatalogVersion }[]; res: Resolution } {
  const items: CopyItem[] = [];
  const picks: { mod: CatalogMod; v: CatalogVersion }[] = [];
  for (const e of from[1].filter((m) => m.enabled)) {
    const item = (outcome: CopyItem["outcome"], v: CatalogVersion | null = null): CopyItem => ({
      id: e.id,
      name: e.name,
      outcome,
      version: v?.version ?? null,
      trust: v?.trust ?? null,
      sha256: v?.sha256 ?? null,
    });
    if (to[1].some((x) => x.id === e.id)) {
      items.push(item("alreadyThere"));
      continue;
    }
    const key = originKey(e.origin, e.id);
    if (!key) {
      items.push(item("localFile"));
      continue;
    }
    const channel = e.channel ?? "release";
    const best = bestVersion(catalog, key, fit, channel);
    if (best) {
      items.push(item("install", best.v));
      picks.push(best);
    } else if ((fitting(catalog, key, fit, channel)?.versions.length ?? 0) > 0) {
      items.push(item("revoked"));
    } else {
      items.push(item("noBuild"));
    }
  }
  const res = resolve(catalog, to[1], picks, fit);
  const out = outcome(to[1], res);
  const deps = res.picks.filter((p) => !res.wanted.includes(p.mod.id)).map((p) => planItem(p.mod, p.v));
  return {
    preview: {
      from: from[0],
      to: to[0],
      items,
      deps,
      enable: out.enable,
      installedOff: out.installedOff,
      missing: res.missing,
      planToken: planToken(consentOf(to[1], res, fit.abi, out.installedOff.length === 0)),
    },
    picks,
    res,
  };
}
