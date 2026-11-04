// One typed function per mod command, so a renamed command or argument fails in one place.
// A rejected promise carries an AppErrorPayload; `asAppError` says "Unknown" for anything else.

import { invoke } from "@tauri-apps/api/core";
import { COMMANDS } from "./ipc";
import { isErrorCode } from "../i18n/errors";
import type {
  UiError,
  Catalog,
  ChangeResult,
  CopyPreview,
  CopyResult,
  FileInspection,
  InstallPlan,
  ProfileReport,
} from "./types";

export const modsApi = {
  catalog: (forceRefresh: boolean) => invoke<Catalog>(COMMANDS.listModCatalog, { forceRefresh }),
  profile: (tag: string) => invoke<ProfileReport>(COMMANDS.getModProfile, { tag }),
  plan: (tag: string, sha256: string) => invoke<InstallPlan>(COMMANDS.planModInstall, { tag, sha256 }),
  install: (tag: string, sha256: string) => invoke<ChangeResult>(COMMANDS.installMod, { tag, sha256 }),
  inspectFile: (tag: string, path: string) => invoke<FileInspection>(COMMANDS.inspectModFile, { tag, path }),
  installFile: (tag: string, path: string, sha256: string) =>
    invoke<ChangeResult>(COMMANDS.installModFile, { tag, path, sha256 }),
  setEnabled: (tag: string, id: string, enabled: boolean) =>
    invoke<ChangeResult>(COMMANDS.setModEnabled, { tag, id, enabled }),
  remove: (tag: string, id: string) => invoke<ChangeResult>(COMMANDS.removeMod, { tag, id }),
  // TEMPORARY name: COMMANDS.restoreMod once the backend generates it (contract R3 §6).
  restore: (tag: string, id: string) => invoke<ChangeResult>("restore_mod", { tag, id }),
  previewCopy: (from: string, to: string) => invoke<CopyPreview>(COMMANDS.previewCopyModProfile, { from, to }),
  copyProfile: (from: string, to: string) => invoke<CopyResult>(COMMANDS.copyModProfile, { from, to }),
  sources: () => invoke<string[]>(COMMANDS.getModSources),
  addSource: (repo: string) => invoke<string[]>(COMMANDS.addModSource, { repo }),
  removeSource: (repo: string) => invoke<string[]>(COMMANDS.removeModSource, { repo }),
  icon: (url: string) => invoke<string>(COMMANDS.getModIcon, { url }),
  openPlayerModsFolder: () => invoke<void>(COMMANDS.openPlayerModsFolder),
  openLog: (tag: string) => invoke<void>(COMMANDS.openLog, { tag }),
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
