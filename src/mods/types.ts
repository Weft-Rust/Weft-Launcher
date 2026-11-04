// Mirrors the Rust types in src-tauri/src/mods, as in the round 2 IPC contract. Field names are
// the camelCase serde output. The integrator replaces this file with re-exports of the generated
// bindings in src/mods/bindings/, so keep the names and shapes exactly as the contract has them.

export type Trust = "reviewed" | "unreviewed" | "unverified";
export type Channel = "release" | "prerelease" | "experimental";
export type Freshness = "fresh" | "cached" | "unavailable";
export type Platform = "windows-x64" | "linux-x64" | "macos-arm64";
export type ProgressStage = "downloading" | "verifying" | "installing";
export type FailureKind = "wrongVersion" | "loadFailed" | "notAMod" | "wrongName" | "missingDep" | "initPanicked";

/** Every code an `AppError` can carry, across the whole app. */
export type ErrorCode =
  // Network, files and data
  | "Network"
  | "Io"
  | "Serde"
  | "InvalidHeader"
  | "CacheCorrupted"
  | "RateLimited"
  | "Forbidden"
  | "OfflineNoCache"
  | "DiskFull"
  // Game versions
  | "AssetNotFound"
  | "MissingDigest"
  | "Zip"
  | "CreateDir"
  | "Sha256Mismatch"
  | "HashMissing"
  | "AlreadyInstalled"
  | "NotInstalled"
  | "DownloadFailed"
  | "ExtractFailed"
  | "GameRunning"
  | "VersionInUse"
  | "InvalidName"
  | "InstallInProgress"
  // Launching
  | "AlreadyRunning"
  | "AnotherGameRunning"
  | "ExecutableNotFound"
  | "ProcessSpawnFailed"
  | "LogDirCreateFailed"
  | "GameFolderNotFound"
  | "OpenerError"
  // Mods
  | "IndexSignatureInvalid"
  | "IndexRollback"
  | "IndexInvalid"
  | "AbiUnavailable"
  | "ModNotInCatalog"
  | "ModIncompatible"
  | "ModNotForPlatform"
  | "ModRevoked"
  | "ModArchiveInvalid"
  | "ModFileChanged"
  | "ModNotInstalled"
  | "ModsBlocked"
  | "ModSourceInvalid"
  | "ModSourceNotFound"
  | "ModSourceRateLimited"
  | "ModDownloadNotFound"
  | "ModTooLarge"
  | "ModIdReserved";

export type Origin =
  | { kind: "index" }
  | { kind: "source"; repo: string }
  | { kind: "file"; name: string };

export interface AppErrorPayload {
  code: ErrorCode;
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
  platforms: Platform[];
  sha256: string;
  size: number;
  url: string;
  provenance: {
    repo: string | null;
    workflow: string | null;
    gitRef: string | null;
    verifiedAt: string | null;
  } | null;
  /** True only when provenance came from the signed index; a source's own claim is false. */
  provenanceVerified: boolean;
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

export interface SourceStatus {
  /** Canonical casing, as GitHub reports it. */
  repo: string;
  mods: number;
  /** "cached": showing the last good copy because the refresh failed. */
  freshness: Freshness;
  /** RFC 3339 time of the data shown. */
  checked: string | null;
  /** Set whenever the last refresh failed, even when cached data is shown. */
  error: AppErrorPayload | null;
}

export interface Catalog {
  mods: CatalogMod[];
  revoked: { sha256: string; reason: string }[];
  index: { freshness: Freshness; generated: string | null; error: AppErrorPayload | null };
  sources: SourceStatus[];
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

/** `installed`, `alsoEnabled`, `alsoDisabled` and `missing` are all mod ids. */
export interface ChangeResult {
  report: ProfileReport;
  installed: string[];
  alsoEnabled: string[];
  alsoDisabled: string[];
  missing: string[];
}

export interface CopyResult extends ChangeResult {
  leftBehind: CopyItem[];
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
  catalogMatch: {
    key: string;
    name: string;
    fitsVersion: boolean;
    build: CatalogVersion;
  } | null;
  revokedReason: string | null;
  replaces: string | null;
}

export interface ModProgress {
  sha256: string;
  modId: string;
  stage: ProgressStage;
  percent: number;
}

export interface ModFailure {
  kind: FailureKind;
  modId: string | null;
  other: string | null;
  line: string;
}

/** What `install_mod(tag, sha256)` would do, without doing it. */
export interface InstallPlan {
  target: PlanItem;
  replaces: { version: string | null; sha256: string; trust: Trust; enabled: boolean } | null;
  /** Dependencies that will be downloaded. */
  install: PlanItem[];
  /** Ids of installed dependencies that will be turned on. */
  enable: string[];
  /** Dependency ids with no fitting, non-revoked build. */
  missing: string[];
  /** Set when the install would fail: revoked, incompatible, not for this platform, game running... */
  problem: AppErrorPayload | null;
}

export interface PlanItem {
  id: string;
  name: string;
  version: string;
  sha256: string;
  trust: Trust;
  channel: Channel;
  size: number;
}

/** What `copy_mod_profile(from, to)` would bring over. */
export interface CopyPreview {
  from: string;
  to: string;
  items: CopyItem[];
}

export interface CopyItem {
  id: string;
  name: string;
  outcome: "install" | "alreadyThere" | "noBuild" | "localFile" | "revoked";
  /** The build that will be installed (outcome "install"). */
  version: string | null;
  trust: Trust | null;
}
