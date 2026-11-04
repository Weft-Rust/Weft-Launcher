// One typed function per mod command, so a renamed command or argument fails in one place.

import { invoke } from "@tauri-apps/api/core";
import type {
  Catalog,
  ChangeResult,
  CopyResult,
  FileInspection,
  ProfileReport,
} from "./types";

export const modsApi = {
  catalog: (forceRefresh: boolean) => invoke<Catalog>("list_mod_catalog", { forceRefresh }),
  profile: (tag: string) => invoke<ProfileReport>("get_mod_profile", { tag }),
  install: (tag: string, sha256: string) => invoke<ChangeResult>("install_mod", { tag, sha256 }),
  inspectFile: (tag: string, path: string) =>
    invoke<FileInspection>("inspect_mod_file", { tag, path }),
  installFile: (tag: string, path: string, sha256: string) =>
    invoke<ChangeResult>("install_mod_file", { tag, path, sha256 }),
  setEnabled: (tag: string, id: string, enabled: boolean) =>
    invoke<ChangeResult>("set_mod_enabled", { tag, id, enabled }),
  remove: (tag: string, id: string) => invoke<ChangeResult>("remove_mod", { tag, id }),
  copyProfile: (from: string, to: string) => invoke<CopyResult>("copy_mod_profile", { from, to }),
  sources: () => invoke<string[]>("get_mod_sources"),
  addSource: (repo: string) => invoke<string[]>("add_mod_source", { repo }),
  removeSource: (repo: string) => invoke<string[]>("remove_mod_source", { repo }),
  icon: (url: string) => invoke<string>("get_mod_icon", { url }),
  openPlayerModsFolder: () => invoke<void>("open_player_mods_folder"),
};
