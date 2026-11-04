// One typed function per mod command, so a renamed command or argument fails in one place.
// A rejected promise carries an AppErrorPayload; `asAppError` turns anything else into one.

import { invoke } from "@tauri-apps/api/core";
import { COMMANDS } from "./ipc";
import type {
  AppErrorPayload,
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
  previewCopy: (from: string, to: string) => invoke<CopyPreview>(COMMANDS.previewCopyModProfile, { from, to }),
  copyProfile: (from: string, to: string) => invoke<CopyResult>(COMMANDS.copyModProfile, { from, to }),
  sources: () => invoke<string[]>(COMMANDS.getModSources),
  addSource: (repo: string) => invoke<string[]>(COMMANDS.addModSource, { repo }),
  removeSource: (repo: string) => invoke<string[]>(COMMANDS.removeModSource, { repo }),
  icon: (url: string) => invoke<string>(COMMANDS.getModIcon, { url }),
  openPlayerModsFolder: () => invoke<void>(COMMANDS.openPlayerModsFolder),
};

/** Whatever a command rejected with, as the payload the backend sends. */
export function asAppError(err: unknown): AppErrorPayload {
  if (err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string") {
    const { code, detail } = err as { code: string; detail?: unknown };
    return { code: code as AppErrorPayload["code"], detail: typeof detail === "string" ? detail : null };
  }
  const detail = err instanceof Error ? err.message : err == null ? null : String(err);
  return { code: "Io", detail };
}
