// Generated from the Rust types by src-tauri/src/bindings.rs. Do not edit.

import type { Catalog } from "./Catalog";
import type { ChangeResult } from "./ChangeResult";
import type { CopyPreview } from "./CopyPreview";
import type { CopyResult } from "./CopyResult";
import type { FileInspection } from "./FileInspection";
import type { GameStateEvent } from "./GameStateEvent";
import type { InstallPlan } from "./InstallPlan";
import type { InstallProgress } from "./InstallProgress";
import type { InstalledVersion } from "./InstalledVersion";
import type { ModProgress } from "./ModProgress";
import type { ProfileReport } from "./ProfileReport";
import type { Release } from "./Release";

/** Every Tauri command, by the name `invoke` takes. */
export const COMMANDS = {
  listVersions: "list_versions",
  installVersion: "install_version",
  getInstalledVersions: "get_installed_versions",
  removeVersion: "remove_version",
  launchVersion: "launch_version",
  getRunningVersions: "get_running_versions",
  openGameFolder: "open_game_folder",
  openLog: "open_log",
  listModCatalog: "list_mod_catalog",
  getModSources: "get_mod_sources",
  addModSource: "add_mod_source",
  removeModSource: "remove_mod_source",
  getModProfile: "get_mod_profile",
  planModInstall: "plan_mod_install",
  installMod: "install_mod",
  inspectModFile: "inspect_mod_file",
  installModFile: "install_mod_file",
  setModEnabled: "set_mod_enabled",
  removeMod: "remove_mod",
  restoreMod: "restore_mod",
  previewCopyModProfile: "preview_copy_mod_profile",
  copyModProfile: "copy_mod_profile",
  getModIcon: "get_mod_icon",
  openPlayerModsFolder: "open_player_mods_folder",
} as const;

export type CommandName = (typeof COMMANDS)[keyof typeof COMMANDS];

/** Every event the backend emits. */
export const EVENTS = {
  modProgress: "mod-progress",
  gameState: "game-state",
  installProgress: "install-progress",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/** Every command's arguments and result, read from its declaration in Rust. */
export interface CommandSignatures {
  list_versions: { args: { forceRefresh: boolean }; result: Array<Release> };
  install_version: { args: { tag: string; assetUrl: string; assetName: string; expectedSha256: string | null }; result: InstalledVersion };
  get_installed_versions: { args: Record<string, never>; result: Array<InstalledVersion> };
  remove_version: { args: { tag: string }; result: void };
  launch_version: { args: { tag: string }; result: void };
  get_running_versions: { args: Record<string, never>; result: Array<string> };
  open_game_folder: { args: { tag: string }; result: void };
  open_log: { args: { tag: string }; result: void };
  list_mod_catalog: { args: { forceRefresh: boolean }; result: Catalog };
  get_mod_sources: { args: Record<string, never>; result: Array<string> };
  add_mod_source: { args: { repo: string }; result: Array<string> };
  remove_mod_source: { args: { repo: string }; result: Array<string> };
  get_mod_profile: { args: { tag: string }; result: ProfileReport };
  plan_mod_install: { args: { tag: string; sha256: string }; result: InstallPlan };
  install_mod: { args: { tag: string; sha256: string }; result: ChangeResult };
  inspect_mod_file: { args: { tag: string; path: string }; result: FileInspection };
  install_mod_file: { args: { tag: string; path: string; sha256: string }; result: ChangeResult };
  set_mod_enabled: { args: { tag: string; id: string; enabled: boolean }; result: ChangeResult };
  remove_mod: { args: { tag: string; id: string }; result: ChangeResult };
  restore_mod: { args: { tag: string; id: string }; result: ChangeResult };
  preview_copy_mod_profile: { args: { from: string; to: string }; result: CopyPreview };
  copy_mod_profile: { args: { from: string; to: string }; result: CopyResult };
  get_mod_icon: { args: { url: string }; result: string };
  open_player_mods_folder: { args: Record<string, never>; result: void };
}

/** Every event's payload. */
export interface EventPayloads {
  "mod-progress": ModProgress;
  "game-state": GameStateEvent;
  "install-progress": InstallProgress;
}
