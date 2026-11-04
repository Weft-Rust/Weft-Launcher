// Command and event names, in one place for src/mods/api.ts, the hooks and the mock backend. The
// backend exports the same names to src/mods/bindings/; the integrator points this file at them.

export const COMMANDS = {
  // Game versions
  listVersions: "list_versions",
  installVersion: "install_version",
  getInstalledVersions: "get_installed_versions",
  removeVersion: "remove_version",
  launchVersion: "launch_version",
  getRunningVersions: "get_running_versions",
  openGameFolder: "open_game_folder",
  openLog: "open_log",
  // Mods
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
  previewCopyModProfile: "preview_copy_mod_profile",
  copyModProfile: "copy_mod_profile",
  getModIcon: "get_mod_icon",
  openPlayerModsFolder: "open_player_mods_folder",
} as const;

export type Command = (typeof COMMANDS)[keyof typeof COMMANDS];

export const EVENTS = {
  modProgress: "mod-progress",
  gameState: "game-state",
  installProgress: "install-progress",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];
