// TEMPORARY: the shapes contract R4 (round3/CONTRACT-R4.md) adds, until the backend regenerates
// ./bindings. types.ts re-exports these over the generated ones of the same name; the integrator
// deletes this file (and api.pending.ts) once the bindings have them.

import type * as B from "./bindings";

/** Contract R4 §8. */
export type PendingErrorCode = "ModCancelled";
export type ErrorCode = B.ErrorCode | PendingErrorCode;

export type AppErrorPayload = { code: ErrorCode; detail: string | null };

/** Contract R4 §2 and §5. */
export type InstallPlan = Omit<B.InstallPlan, "problem"> & {
  problem: AppErrorPayload | null;
  /** Whether the target is built for the version's mod interface; null when that is unknown. */
  fitsVersion: boolean | null;
  /** Opaque digest of everything this plan asks the player to agree to. */
  planToken: string;
};

/** Contract R4 §2. */
export type CopyPreview = B.CopyPreview & { planToken: string };

/** Contract R4 §5: null when the version's mod interface is unknown. */
export type CatalogMatch = Omit<B.CatalogMatch, "fitsVersion"> & { fitsVersion: boolean | null };

/** Contract R4 §2 and §5. */
export type FileInspection = Omit<B.FileInspection, "catalogMatch" | "problem"> & {
  problem: AppErrorPayload | null;
  catalogMatch: CatalogMatch | null;
  planToken: string;
};

/** Contract R4 §3: progress belongs to one operation; `index` of `count` is this file's place in it. */
export type ModProgress = B.ModProgress & { operationId: string; index: number; count: number };

/** Contract R4 §4. */
export type ShadowedMod = { id: string; file: string; managed: "off" | "revoked" | "on" };
export type BlockingReason = "wrongVersion" | "missingDeps" | "revoked" | "shadowedRevoked";

export type ProfileReport = Omit<B.ProfileReport, "abiError" | "mods"> & {
  abiError: AppErrorPayload | null;
  mods: InstalledMod[];
  /** Files in the player's own mods folder with the id of a mod in this set. */
  shadowed: ShadowedMod[];
  /** Why each id in `blocking` blocks. */
  blockingReasons: Record<string, BlockingReason>;
};

/** Contract R4 §6: a revocation's time may be unknown. */
export type Revocation = { reason: string; at: string | null };
export type InstalledMod = Omit<B.InstalledMod, "revoked"> & { revoked: Revocation | null };

export type ChangeResult = Omit<B.ChangeResult, "report"> & { report: ProfileReport };
export type CopyResult = Omit<B.CopyResult, "report"> & { report: ProfileReport };

/** The catalogue's states carry R4's error codes too. */
export type IndexStatus = Omit<B.IndexStatus, "error"> & { error: AppErrorPayload | null };
export type SourceStatus = Omit<B.SourceStatus, "error"> & { error: AppErrorPayload | null };
export type Catalog = Omit<B.Catalog, "index" | "sources"> & { index: IndexStatus; sources: SourceStatus[] };
