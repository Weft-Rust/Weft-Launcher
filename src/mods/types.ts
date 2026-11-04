// Mirrors the Rust types in src-tauri/src/mods. Field names are the camelCase serde output.

export type Trust = "reviewed" | "unreviewed" | "unverified";
export type Channel = "release" | "prerelease" | "experimental";
export type Freshness = "fresh" | "cached" | "unavailable";

export type Origin =
  | { kind: "index" }
  | { kind: "source"; repo: string }
  | { kind: "file"; name: string };

export interface AppErrorPayload {
  code: string;
  detail: string | null;
}

export interface CatalogVersion {
  version: string;
  channel: Channel;
  tag: string;
  published: string;
  sourceRepo: string;
  sourceCommit: string;
  weftTag: string | null;
  abi: string;
  deps: string[];
  platforms: string[];
  sha256: string;
  size: number;
  url: string;
  provenance: {
    repo: string | null;
    workflow: string | null;
    gitRef: string | null;
    verifiedAt: string | null;
  } | null;
  reviewed: { by: string; at: string } | null;
  trust: Trust;
}

export interface CatalogMod {
  key: string;
  id: string;
  name: string;
  summary: string;
  authors: string[];
  license: string | null;
  homepage: string | null;
  icon: string | null;
  origin: Origin;
  versions: CatalogVersion[];
}

export interface Catalog {
  mods: CatalogMod[];
  revoked: { sha256: string; reason: string }[];
  index: { freshness: Freshness; generated: string | null; error: AppErrorPayload | null };
  sources: { repo: string; mods: number; error: AppErrorPayload | null }[];
  weft: { tag: string; commit: string; abi: string }[];
  platform: string;
}

export type ModStatus = "ready" | "off" | "wrongVersion" | "missingDeps" | "revoked" | "unchecked";

export interface InstalledMod {
  id: string;
  name: string;
  summary: string;
  version: string | null;
  channel: Channel | null;
  sha256: string;
  size: number;
  enabled: boolean;
  trust: Trust;
  origin: Origin;
  abi: string | null;
  weftTag: string | null;
  deps: string[];
  tag: string | null;
  sourceRepo: string | null;
  sourceCommit: string | null;
  icon: string | null;
  installedAt: string;
  status: ModStatus;
  missingDeps: string[];
  revokedReason: string | null;
  update: { version: string; sha256: string; channel: Channel; trust: Trust } | null;
}

export interface ProfileReport {
  tag: string;
  versionAbi: string | null;
  abiError: AppErrorPayload | null;
  mods: InstalledMod[];
  blocking: string[];
  unmanaged: string[];
}

export interface ChangeResult {
  report: ProfileReport;
  installed: string[];
  alsoEnabled: string[];
  alsoDisabled: string[];
  missing: string[];
}

export interface CopyResult extends ChangeResult {
  leftBehind: string[];
}

export interface ArchiveInfo {
  id: string;
  libraries: string[];
  platforms: string[];
  hasAssets: boolean;
  entries: number;
}

export interface FileInspection {
  fileName: string;
  size: number;
  sha256: string;
  archive: ArchiveInfo | null;
  problem: AppErrorPayload | null;
  name: string | null;
  summary: string | null;
  fitsSystem: boolean;
  catalogMatch: { key: string; name: string; version: string; trust: Trust; fitsVersion: boolean } | null;
  revokedReason: string | null;
  replaces: string | null;
}

export interface ModProgress {
  sha256: string;
  modId: string;
  stage: "downloading" | "verifying" | "installing";
  percent: number;
}

export interface ModFailure {
  kind: "wrongVersion" | "loadFailed" | "notAMod" | "wrongName" | "missingDep" | "initPanicked";
  modId: string | null;
  other: string | null;
  line: string;
}
