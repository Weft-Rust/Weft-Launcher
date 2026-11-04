// Pure choices over catalogue data, shared by the pages and kept out of components.

import type { Catalog, CatalogMod, CatalogVersion, Channel, InstalledMod } from "./types";

const RANK: Record<Channel, number> = { release: 0, prerelease: 1, experimental: 2 };

function parts(v: string): [number[], string | null] {
  const clean = v.replace(/^v/, "").split("+")[0];
  const dash = clean.indexOf("-");
  const core = dash < 0 ? clean : clean.slice(0, dash);
  const pre = dash < 0 ? null : clean.slice(dash + 1);
  return [core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre];
}

/** Semver precedence, like the backend's `mods::version::compare`. */
export function compareVersions(a: string, b: string): number {
  const [an, ap] = parts(a);
  const [bn, bp] = parts(b);
  for (let i = 0; i < Math.max(an.length, bn.length); i++) {
    const d = (an[i] ?? 0) - (bn[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (ap === bp) return 0;
  if (ap === null) return 1;
  if (bp === null) return -1;
  const as = ap.split(".");
  const bs = bp.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    if (as[i] === undefined) return -1;
    if (bs[i] === undefined) return 1;
    const x = Number(as[i]);
    const y = Number(bs[i]);
    const d = !Number.isNaN(x) && !Number.isNaN(y) ? x - y : as[i].localeCompare(bs[i]);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export function isRevoked(catalog: Catalog | null, sha256: string): boolean {
  return !!catalog?.revoked.some((r) => r.sha256 === sha256);
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
    .filter((v) => catalog === null || v.platforms.includes(catalog.platform))
    .filter((v) => allowPrerelease || v.channel === "release")
    .filter((v) => !isRevoked(catalog, v.sha256))
    .sort((a, b) => compareVersions(b.version, a.version) || RANK[a.channel] - RANK[b.channel]);
}

export function installedFor(mod: CatalogMod, installed: InstalledMod[]): InstalledMod | undefined {
  return installed.find((m) => {
    if (m.id !== mod.id) return false;
    if (mod.origin.kind === "index") return m.origin.kind === "index";
    if (mod.origin.kind === "source") return m.origin.kind === "source" && m.origin.repo === mod.origin.repo;
    return false;
  });
}

export function matchesSearch(mod: CatalogMod, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [mod.name, mod.id, mod.summary, ...mod.authors].some((s) => s.toLowerCase().includes(q));
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
