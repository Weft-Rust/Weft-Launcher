//! Names shared with the page. Command names and signatures come from `generate_handler!` in
//! `lib.rs` and the commands' own declarations; they and the events below are written to
//! `src/mods/bindings/commands.ts` by the `bindings` test.

/// `ModProgress`, while a mod downloads, is checked and is installed.
pub const MOD_PROGRESS: &str = "mod-progress";
/// `GameStateEvent`, when a game starts or stops.
pub const GAME_STATE: &str = "game-state";
/// `InstallProgress`, while a game version downloads and installs.
pub const INSTALL_PROGRESS: &str = "install-progress";

/// Every event: its key in `EVENTS`, its name, and the type of its payload.
pub const EVENTS: &[(&str, &str, &str)] = &[
    ("modProgress", MOD_PROGRESS, "ModProgress"),
    ("gameState", GAME_STATE, "GameStateEvent"),
    ("installProgress", INSTALL_PROGRESS, "InstallProgress"),
];
