import type { UiError } from "../mods/types";
import { asAppError } from "../mods/api";
import { showError, type Shown } from "../i18n/errors";

/**
 * How an action ended. "skipped": the same action was already running, so nothing was sent.
 * "cancelled": the player stopped it (contract R4 §3); nothing changed, and that isn't a failure.
 */
export type ActionResult<R = void> =
  | { status: "done"; result: R }
  | { status: "failed"; error: UiError; shown: Shown }
  | { status: "cancelled" }
  | { status: "skipped" };

export function failed(err: unknown): ActionResult<never> {
  const error = asAppError(err);
  if (error.code === "ModCancelled") return { status: "cancelled" };
  return { status: "failed", error, shown: showError(err) };
}

/** What to show for a result, or null when there is nothing to say. */
export function errorOf(result: ActionResult<unknown>): Shown | null {
  return result.status === "failed" ? result.shown : null;
}
