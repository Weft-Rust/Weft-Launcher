// TEMPORARY: the commands contract R4 changes or adds, until the backend regenerates
// ./bindings/commands.ts and updates api.ts. Everything else is api.ts's own `modsApi`. The
// integrator deletes this file and points its importers back at ./api.

import { invoke } from "@tauri-apps/api/core";
import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { modsApi as generated } from "./api";
import { COMMANDS, EVENTS } from "./ipc";
import type { Catalog, ChangeResult, CopyPreview, CopyResult, FileInspection, InstallPlan, ModProgress, ProfileReport } from "./types";

/** Contract R4 §3. */
export const CANCEL_MOD_OPERATION = "cancel_mod_operation";

/** A fresh id for one operation, chosen by the client (contract R4 §3). */
export function newOperationId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export const modsApi = {
  ...generated,
  catalog: (forceRefresh: boolean) => invoke<Catalog>(COMMANDS.listModCatalog, { forceRefresh }),
  profile: (tag: string) => invoke<ProfileReport>(COMMANDS.getModProfile, { tag }),
  plan: (tag: string, sha256: string) => invoke<InstallPlan>(COMMANDS.planModInstall, { tag, sha256 }),
  inspectFile: (tag: string, path: string) => invoke<FileInspection>(COMMANDS.inspectModFile, { tag, path }),
  previewCopy: (from: string, to: string) => invoke<CopyPreview>(COMMANDS.previewCopyModProfile, { from, to }),
  install: (tag: string, sha256: string, planToken: string, operationId: string) =>
    invoke<ChangeResult>(COMMANDS.installMod, { tag, sha256, planToken, operationId }),
  installFile: (tag: string, path: string, sha256: string, planToken: string, operationId: string) =>
    invoke<ChangeResult>(COMMANDS.installModFile, { tag, path, sha256, planToken, operationId }),
  copyProfile: (from: string, to: string, planToken: string, operationId: string) =>
    invoke<CopyResult>(COMMANDS.copyModProfile, { from, to, planToken, operationId }),
  setEnabled: (tag: string, id: string, enabled: boolean) => invoke<ChangeResult>(COMMANDS.setModEnabled, { tag, id, enabled }),
  remove: (tag: string, id: string) => invoke<ChangeResult>(COMMANDS.removeMod, { tag, id }),
  restore: (tag: string, id: string, operationId: string) => invoke<ChangeResult>(COMMANDS.restoreMod, { tag, id, operationId }),
  /** Aborts that operation's downloads; it then fails with `ModCancelled`. False when it had already ended. */
  cancel: (operationId: string) => invoke<boolean>(CANCEL_MOD_OPERATION, { operationId }),
};

/** The `mod-progress` event with its R4 payload. */
export function listenToModProgress(handler: EventCallback<ModProgress>): Promise<UnlistenFn> {
  return listen<ModProgress>(EVENTS.modProgress, handler);
}
