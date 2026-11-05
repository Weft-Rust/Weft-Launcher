// Pure choices over catalogue and profile data, shared by the pages, the mock backend and the tests.

import type { Catalog, CatalogMod, CatalogVersion, Channel, InstalledMod, Origin, ProfileReport } from "./types";

const RANK: Record<Channel, number> = { release: 0, prerelease: 1, experimental: 2 };

function parts(v: string): [number[], string | null] {
  const clean = v.replace(/^v/, "").split("+")[0];
  const dash = clean.indexOf("-");
  const core = dash < 0 ? clean : clean.slice(0, dash);
  const pre = dash < 0 ? null : clean.slice(dash + 1);
  return [core.split(".").map((n) => (/^\d+$/.test(n) ? Number(n) : 0)), pre];
}

const NUMERIC = /^\d+$/;

/** Prerelease identifiers: numbers by value and below words, words by ASCII order. */
function comparePre(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = NUMERIC.test(x);
    const yn = NUMERIC.test(y);
    let d: number;
    if (xn && yn) d = Number(x) - Number(y);
    else if (xn) d = -1;
    else if (yn) d = 1;
    else d = x < y ? -1 : x > y ? 1 : 0;
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** Semver precedence, exactly like the backend's `mods::version::compare`. */
export function compareVersions(a: string, b: string): number {
  const [an, ap] = parts(a);
  const [bn, bp] = parts(b);
  for (let i = 0; i < Math.max(an.length, bn.length); i++) {
    const d = (an[i] ?? 0) - (bn[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (ap === null && bp === null) return 0;
  if (ap === null) return 1;
  if (bp === null) return -1;
  return comparePre(ap, bp);
}

export function sameRepo(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function revocation(catalog: Catalog | null, sha256: string): string | null {
  const s = sha256.toLowerCase();
  return catalog?.revoked.find((r) => r.sha256.toLowerCase() === s)?.reason ?? null;
}

export function isRevoked(catalog: Catalog | null, sha256: string): boolean {
  return revocation(catalog, sha256) !== null;
}

/** Versions that would load into a game with `abi` on this system, best first. */
export function fittingVersions(
  catalog: Catalog | null,
  mod: CatalogMod,
  abi: string | null,
  allowPrerelease: boolean
): CatalogVersion[] {
  return mod.versions
    .filter((v) => abi !== null && v.abi === abi)
    .filter((v) => catalog === null || (v.platforms as string[]).includes(catalog.platform))
    .filter((v) => allowPrerelease || v.channel === "release")
    .filter((v) => !isRevoked(catalog, v.sha256))
    .sort((a, b) => compareVersions(b.version, a.version) || RANK[a.channel] - RANK[b.channel]);
}

function sameOrigin(a: Origin, b: Origin): boolean {
  if (a.kind === "index") return b.kind === "index";
  if (a.kind === "source") return b.kind === "source" && sameRepo(a.repo, b.repo);
  return false;
}

/** The installed mod a catalogue entry describes, if any. */
export function installedFor(mod: CatalogMod, installed: InstalledMod[]): InstalledMod | undefined {
  return installed.find((m) => m.id === mod.id && sameOrigin(mod.origin, m.origin));
}

/** The catalogue entry an installed mod came from, if the catalogue still has it. */
export function catalogModFor(catalog: Catalog | null, mod: InstalledMod): CatalogMod | undefined {
  return catalog?.mods.find((c) => c.id === mod.id && sameOrigin(c.origin, mod.origin));
}

/** A mod's display name: from the profile, then the catalogue, then its id. */
export function modName(id: string, report: ProfileReport | undefined, catalog: Catalog | null): string {
  return report?.mods.find((m) => m.id === id)?.name ?? catalog?.mods.find((m) => m.id === id)?.name ?? id;
}

export function matchesSearch(mod: CatalogMod, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [mod.name, mod.id, mod.summary, ...mod.authors].some((s) => s.toLowerCase().includes(q));
}

/** Problems first, then what's on, then what's off: what needs a look is on top. */
function installedRank(m: InstalledMod): number {
  if (m.status === "wrongVersion" || m.status === "missingDeps") return 0;
  if (m.status === "revoked") return 1;
  return m.enabled ? 2 : 3;
}

/** Ids in display order. Called on load and on a version change, not after every toggle. */
export function sortInstalled(mods: InstalledMod[]): string[] {
  return [...mods]
    .sort((a, b) => installedRank(a) - installedRank(b) || a.name.localeCompare(b.name))
    .map((m) => m.id);
}

/**
 * Keeps an earlier order stable: ids still present keep their place, new ones follow in sorted
 * order. So a row never jumps away from the pointer or from focus.
 */
export function keepOrder(previous: string[], mods: InstalledMod[]): string[] {
  const present = new Set(mods.map((m) => m.id));
  const kept = previous.filter((id) => present.has(id));
  const known = new Set(kept);
  const added = sortInstalled(mods.filter((m) => !known.has(m.id)));
  return [...kept, ...added];
}

/** Other versions with mods turned on, which is what a copy brings over; newest first as given. */
export function copyDonors(tags: string[], to: string, profiles: Record<string, ProfileReport | undefined>): string[] {
  return tags.filter((t) => t !== to && (profiles[t]?.mods.some((m) => m.enabled) ?? false));
}

export function shortSha(sha: string): string {
  return `${sha.slice(0, 8)}…${sha.slice(-4)}`;
}

export function shortCommit(commit: string | null | undefined): string {
  return (commit ?? "").slice(0, 7);
}

/** A link to the exact source a version was built from. */
export function sourceUrl(v: { sourceRepo: string | null; sourceCommit: string | null }): string | null {
  if (!v.sourceRepo) return null;
  return v.sourceCommit
    ? `https://github.com/${v.sourceRepo}/tree/${v.sourceCommit}`
    : `https://github.com/${v.sourceRepo}`;
}

/** `owner/repo` from what a player typed, or null: the backend's `sources::normalize` and `is_repo`. */
export function parseRepo(input: string): string | null {
  let s = input.trim().replace(/\/+$/, "");
  if (s.endsWith(".git")) s = s.slice(0, -4);
  for (const prefix of ["https://github.com/", "http://github.com/", "github.com/"]) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length);
      break;
    }
  }
  const halves = s.split("/");
  const part = (p: string) => p.length > 0 && p.length <= 100 && p !== "." && p !== ".." && /^[A-Za-z0-9._-]+$/.test(p);
  return halves.length === 2 && part(halves[0]) && part(halves[1]) ? s : null;
}

/**
 * Whether the network was down at the last look, so a download would fail for want of a
 * connection. True when the catalogue couldn't be refreshed for that reason, or when an origin
 * failed with `Network` and no origin got an answer at all.
 *
 * One origin failing is not the network failing: when a source just answered (or failed with a
 * reply, like a rate limit), the index being unreachable is the index host's trouble, and builds
 * still download from GitHub. Install buttons then don't claim to need internet.
 */
export function networkDown(catalog: Catalog | null, catalogError: { code: string } | null): boolean {
  if (catalogError?.code === "Network") return true;
  if (!catalog) return false;
  const origins = [catalog.index.error, ...catalog.sources.map((s) => s.error)];
  const lostConnection = origins.some((e) => e?.code === "Network");
  const answered = origins.some((e) => !e || e.code !== "Network");
  return lostConnection && !answered;
}
