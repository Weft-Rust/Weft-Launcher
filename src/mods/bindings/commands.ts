// Generated from the Rust types by src-tauri/src/bindings.rs. Do not edit.

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
