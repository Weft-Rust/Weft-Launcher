// The IPC types, generated from the Rust structs into ./bindings (`cargo test export_bindings
// -- --ignored` in src-tauri regenerates them; a test fails while they're out of date).
export type * from "./bindings";

import type { ErrorCode } from "./bindings";

/**
 * Frontend only: what an action failed with. "Unknown" is anything that isn't an AppError this
 * build knows: a thrown Error, or a code from a newer backend. Its detail says what there is.
 */
export type UiError = { code: ErrorCode | "Unknown"; detail: string | null };

import type { ModProgress, ProgressStage } from "./bindings";

/**
 * Frontend only: a step of a running operation. `preparing` is the moment before the backend's
 * first event, when nothing is being downloaded yet; the backend's own stages follow.
 */
export type UiStage = ProgressStage | "preparing";
export type UiProgress = Omit<ModProgress, "stage"> & { stage: UiStage };
