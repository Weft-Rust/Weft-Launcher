// TEMPORARY. The round-3 contract (CONTRACT-R3.md) in TypeScript, until the backend generates
// these into ./bindings. Names and shapes are the contract's. types.ts re-exports these over the
// generated ones; after the merge, delete this file and those re-exports.

import type * as B from "./bindings";

/** Contract 5: the plan went stale while the download ran. */
export type PendingErrorCode = "ModChangedMeanwhile";
export type ErrorCode = B.ErrorCode | PendingErrorCode;
export type AppErrorPayload = { code: ErrorCode; detail: string | null };

/** Contract 3: `stale` is a verified index whose signature is over 30 days old. */
export type Freshness = "fresh" | "stale" | "cached" | "unavailable";
export type IndexStatus = { freshness: Freshness; generated: string | null; error: AppErrorPayload | null; signedAt: string | null };
export type SourceStatus = Omit<B.SourceStatus, "freshness" | "error"> & { freshness: Freshness; error: AppErrorPayload | null };
export type Catalog = Omit<B.Catalog, "index" | "sources"> & { index: IndexStatus; sources: SourceStatus[] };

/** Contract 2: written into the lock when a revocation is applied, and kept. */
export type LockRevocation = { reason: string; at: string };

/** Contract 1 and 2. `missingDeps` minus `depsNotInstalled` are installed but off. */
export type InstalledMod = B.InstalledMod & { depsNotInstalled: string[]; revoked: LockRevocation | null };
export type ProfileReport = Omit<B.ProfileReport, "mods" | "abiError"> & { mods: InstalledMod[]; abiError: AppErrorPayload | null };

/** Contract 1: whether the target is on after this install. */
export type InstallPlan = Omit<B.InstallPlan, "problem"> & { problem: AppErrorPayload | null; turnsOn: boolean };

/** Contract 1 and 6. */
export type ChangeResult = Omit<B.ChangeResult, "report"> & {
  report: ProfileReport;
  /** Ids installed turned off because a dependency is missing. */
  installedOff: string[];
  /** The removed mod's id, when `restore_mod` can put it back. */
  undo: string | null;
};
export type CopyResult = ChangeResult & { leftBehind: B.CopyItem[] };
export type FileInspection = Omit<B.FileInspection, "problem"> & { problem: AppErrorPayload | null };
