// Small builders for the unit tests: a catalogue build, a mod, an installed mod, a report.

import type { Catalog, CatalogMod, CatalogVersion, InstalledMod, ProfileReport } from "./types";

export const ABI = "f470b1cbb1f9ad91";
export const OLD_ABI = "5f0569a6bea71b81";

export function build(version: string, extra: Partial<CatalogVersion> = {}): CatalogVersion {
  return {
    version,
    channel: "release",
    tag: `x-v${version}`,
    published: "2026-11-04T00:00:00Z",
    sourceRepo: "Zorro909/weft-mods",
    sourceCommit: "cceea7805df5902d62017d2008d1bb29ed84e152",
    weftTag: "v26.11.1",
    abi: ABI,
    deps: ["base"],
    platforms: ["linux-x64", "windows-x64"],
    sha256: `${version}`.padEnd(64, "0"),
    size: 1000,
    url: "https://github.com/Zorro909/weft-mods/releases/download/x/x.zip",
    provenance: { repo: "Zorro909/weft-mods", workflow: ".github/workflows/release.yml", gitRef: "refs/heads/main", verifiedAt: "2026-11-04T18:00:00Z" },
    buildRecord: "recorded",
    reviewed: { by: "Zorro909", at: "2026-11-04" },
    trust: "reviewed",
    ...extra,
  };
}

export function catalogMod(id: string, versions: CatalogVersion[], extra: Partial<CatalogMod> = {}): CatalogMod {
  return {
    key: `index:${id}`,
    id,
    name: id[0].toUpperCase() + id.slice(1),
    summary: "",
    authors: ["someone"],
    license: null,
    homepage: null,
    icon: null,
    origin: { kind: "index" },
    versions,
    ...extra,
  };
}

export function catalog(mods: CatalogMod[], extra: Partial<Catalog> = {}): Catalog {
  return {
    mods,
    revoked: [],
    index: { freshness: "fresh", generated: "2026-11-04T00:00:00Z", signedAt: "2026-11-04T00:00:00Z", error: null, cacheError: null },
    sources: [],
    weft: [],
    platform: "linux-x64",
    sourcesError: null,
    revision: 0,
    ...extra,
  };
}

export function installed(id: string, extra: Partial<InstalledMod> = {}): InstalledMod {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    summary: "",
    version: "1.0.0",
    channel: "release",
    sha256: `${id}`.padEnd(64, "a"),
    size: 1000,
    enabled: true,
    trust: "reviewed",
    origin: { kind: "index" },
    abi: ABI,
    weftTag: "v26.11.1",
    deps: ["base"],
    tag: null,
    sourceRepo: null,
    sourceCommit: null,
    icon: null,
    installedAt: "2026-11-04T00:00:00Z",
    status: "ready",
    missingDeps: [],
    depsNotInstalled: [],
    revoked: null,
    revokedReason: null,
    update: null,
    ...extra,
  };
}

export function report(mods: InstalledMod[], extra: Partial<ProfileReport> = {}): ProfileReport {
  return {
    tag: "v26.11.1",
    versionAbi: ABI,
    abiError: null,
    mods,
    revocationsPending: [],
    blocking: mods.filter((m) => m.status === "wrongVersion" || m.status === "missingDeps").map((m) => m.id),
    blockingReasons: Object.fromEntries(
      mods.filter((m) => m.status === "wrongVersion" || m.status === "missingDeps").map((m) => [m.id, m.status as "wrongVersion" | "missingDeps"])
    ),
    unmanaged: [],
    shadowed: [],
    ...extra,
  };
}
