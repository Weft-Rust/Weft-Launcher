// The IPC types, generated from the Rust structs into ./bindings (`cargo test export_bindings
// -- --ignored` in src-tauri regenerates them; a test fails while they're out of date).
export type * from "./bindings";

// TEMPORARY: the round-3 contract's types until the backend generates them. Named exports win
// over the `export *` above. Delete these lines with types.pending.ts after the merge.
export type {
  AppErrorPayload,
  Catalog,
  ChangeResult,
  CopyResult,
  ErrorCode,
  FileInspection,
  Freshness,
  IndexStatus,
  InstallPlan,
  InstalledMod,
  LockRevocation,
  PendingErrorCode,
  ProfileReport,
  SourceStatus,
} from "./types.pending";

// After the merge: from "./bindings".
import type { ErrorCode as Code } from "./types.pending";

/**
 * Frontend only: what an action failed with. "Unknown" is anything that isn't an AppError this
 * build knows: a thrown Error, or a code from a newer backend. Its detail says what there is.
 */
export type UiError = { code: Code | "Unknown"; detail: string | null };
