// Every backend command goes through `call`, typed by the generated `CommandSignatures`: a renamed
// command or argument, or a changed result, fails to compile here instead of failing at runtime.
// A rejected promise carries an AppErrorPayload; `asAppError` says "Unknown" for anything else.

import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import type { CommandSignatures, EventPayloads } from "./bindings/commands";
import { COMMANDS } from "./ipc";
import { isErrorCode } from "../i18n/errors";
import type { UiError } from "./types";

export type CommandArgs<K extends keyof CommandSignatures> = CommandSignatures[K]["args"];
export type CommandResult<K extends keyof CommandSignatures> = CommandSignatures[K]["result"];

/** Calls a backend command with the arguments and result its Rust declaration has. */
export function call<K extends keyof CommandSignatures>(
  cmd: K,
  args: CommandSignatures[K]["args"],
): Promise<CommandSignatures[K]["result"]> {
  return invoke<CommandSignatures[K]["result"]>(cmd, args as InvokeArgs);
}

/** Listens to a backend event with its generated payload type. */
export function listenTo<E extends keyof EventPayloads>(
  event: E,
  handler: EventCallback<EventPayloads[E]>,
): Promise<UnlistenFn> {
  return listen<EventPayloads[E]>(event, handler);
}

/** A fresh id for one operation, chosen by the client: its progress and `cancel` refer to it. */
export function newOperationId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export const modsApi = {
  catalog: (forceRefresh: boolean) => call(COMMANDS.listModCatalog, { forceRefresh }),
  profile: (tag: string) => call(COMMANDS.getModProfile, { tag }),
  plan: (tag: string, sha256: string) => call(COMMANDS.planModInstall, { tag, sha256 }),
  /** `planToken` is the reviewed plan's; `ModChangedMeanwhile` when what it would do changed. */
  install: (tag: string, sha256: string, planToken: string, operationId: string) =>
    call(COMMANDS.installMod, { tag, sha256, planToken, operationId }),
  inspectFile: (tag: string, path: string) => call(COMMANDS.inspectModFile, { tag, path }),
  installFile: (tag: string, path: string, sha256: string, planToken: string, operationId: string) =>
    call(COMMANDS.installModFile, { tag, path, sha256, planToken, operationId }),
  setEnabled: (tag: string, id: string, enabled: boolean) =>
    call(COMMANDS.setModEnabled, { tag, id, enabled }),
  remove: (tag: string, id: string) => call(COMMANDS.removeMod, { tag, id }),
  /** Undoes the most recent `remove` for this version; `ModNotInstalled` once it can't. */
  restore: (tag: string, id: string, operationId: string) =>
    call(COMMANDS.restoreMod, { tag, id, operationId }),
  previewCopy: (from: string, to: string) => call(COMMANDS.previewCopyModProfile, { from, to }),
  copyProfile: (from: string, to: string, planToken: string, operationId: string) =>
    call(COMMANDS.copyModProfile, { from, to, planToken, operationId }),
  /** Aborts that operation's downloads; it then fails with `ModCancelled`. False when it had already ended or started writing. */
  cancel: (operationId: string) => call(COMMANDS.cancelModOperation, { operationId }),
  sources: () => call(COMMANDS.getModSources, {}),
  addSource: (repo: string) => call(COMMANDS.addModSource, { repo }),
  removeSource: (repo: string) => call(COMMANDS.removeModSource, { repo }),
  icon: (url: string) => call(COMMANDS.getModIcon, { url }),
  openPlayerModsFolder: () => call(COMMANDS.openPlayerModsFolder, {}),
  openLog: (tag: string) => call(COMMANDS.openLog, { tag }),
};

/** The game version and launch commands. */
export const launcherApi = {
  versions: (forceRefresh: boolean) => call(COMMANDS.listVersions, { forceRefresh }),
  installVersion: (tag: string, assetUrl: string, assetName: string, expectedSha256: string | null) =>
    call(COMMANDS.installVersion, { tag, assetUrl, assetName, expectedSha256 }),
  installedVersions: () => call(COMMANDS.getInstalledVersions, {}),
  removeVersion: (tag: string) => call(COMMANDS.removeVersion, { tag }),
  launch: (tag: string) => call(COMMANDS.launchVersion, { tag }),
  runningVersions: () => call(COMMANDS.getRunningVersions, {}),
  openGameFolder: (tag: string) => call(COMMANDS.openGameFolder, { tag }),
  openLog: (tag: string) => call(COMMANDS.openLog, { tag }),
};

/**
 * Whatever a command rejected with. A payload with a code this build knows stays as it is;
 * anything else (a code from a newer backend, a thrown Error, a plain string) is "Unknown" with
 * what there is to say, never passed off as a known failure.
 */
export function asAppError(err: unknown): UiError {
  if (err && typeof err === "object" && "code" in err) {
    const { code, detail } = err as { code: unknown; detail?: unknown };
    const text = typeof detail === "string" ? detail : null;
    if (isErrorCode(code)) return { code, detail: text };
    return { code: "Unknown", detail: typeof code === "string" ? (text ? `${code}: ${text}` : code) : text };
  }
  const detail = err instanceof Error ? err.message : err == null ? null : String(err);
  return { code: "Unknown", detail };
}
