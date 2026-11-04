import type { UiError } from "../mods/types";
import { asAppError } from "../mods/api";
import { translateError } from "../i18n/errors";

/** How an action ended. "skipped": the same action was already running, so nothing was sent. */
export type ActionResult<R = void> =
  | { status: "done"; result: R }
  | { status: "failed"; error: UiError; message: string }
  | { status: "skipped" };

export function failed(err: unknown): { status: "failed"; error: UiError; message: string } {
  return { status: "failed", error: asAppError(err), message: translateError(err) };
}

/** The message to show for a result, or null when there is nothing to say. */
export function errorOf(result: ActionResult<unknown>): string | null {
  return result.status === "failed" ? result.message : null;
}
