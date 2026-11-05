// The IPC types, generated from the Rust structs into ./bindings (`cargo test export_bindings
// -- --ignored` in src-tauri regenerates them; a test fails while they're out of date).
export type * from "./bindings";
// TEMPORARY (contract R4): the new shapes, until the bindings are regenerated. A named export
// wins over the same name from `export *`, so these replace the generated ones.
export type {
  AppErrorPayload,
  BlockingReason,
  Catalog,
  CatalogMatch,
  ChangeResult,
  CopyPreview,
  CopyResult,
  ErrorCode,
  FileInspection,
  InstallPlan,
  IndexStatus,
  InstalledMod,
  ModProgress,
  ProfileReport,
  Revocation,
  ShadowedMod,
  SourceStatus,
} from "./types.pending";

import type { ErrorCode } from "./types.pending";

/**
 * Frontend only: what an action failed with. "Unknown" is anything that isn't an AppError this
 * build knows: a thrown Error, or a code from a newer backend. Its detail says what there is.
 */
export type UiError = { code: ErrorCode | "Unknown"; detail: string | null };
