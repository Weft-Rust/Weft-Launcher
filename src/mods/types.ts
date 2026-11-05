// The IPC types, generated from the Rust structs into ./bindings (`cargo test export_bindings
// -- --ignored` in src-tauri regenerates them; a test fails while they're out of date).
export type * from "./bindings";

import type { ErrorCode } from "./bindings";

/**
 * Frontend only: what an action failed with. "Unknown" is anything that isn't an AppError this
 * build knows: a thrown Error, or a code from a newer backend. Its detail says what there is.
 */
export type UiError = { code: ErrorCode | "Unknown"; detail: string | null };
