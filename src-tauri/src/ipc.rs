//! Names shared with the page. Command names come from `generate_handler!` in `lib.rs`; both
//! lists are written to `src/mods/bindings/commands.ts` by the `bindings` test.

/// `ModProgress`, while a mod downloads, is checked and is installed.
pub const MOD_PROGRESS: &str = "mod-progress";
/// `GameStateEvent`, when a game starts or stops.
pub const GAME_STATE: &str = "game-state";
/// Progress of a game version install (an untyped object).
pub const INSTALL_PROGRESS: &str = "install-progress";

pub const EVENTS: &[(&str, &str)] = &[
    ("modProgress", MOD_PROGRESS),
    ("gameState", GAME_STATE),
    ("installProgress", INSTALL_PROGRESS),
];
