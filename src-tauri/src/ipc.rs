//! Names shared with the page. Command names and signatures come from `generate_handler!` in
//! `lib.rs` and the commands' own declarations; they and the events below are written to
//! `src/mods/bindings/commands.ts` by the `bindings` test.
//!
//! Every event is sent through its own `emit_*` function, so the payload type sent under a name
//! is the one `EVENTS` (and so `EventPayloads`) says.

use tauri::{AppHandle, Emitter};

use crate::install::InstallProgress;
use crate::launch::GameStateEvent;
use crate::mods::install::ModProgress;

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

pub fn emit_mod_progress(app: &AppHandle, payload: &ModProgress) {
    let _ = app.emit(MOD_PROGRESS, payload);
}

pub fn emit_game_state(app: &AppHandle, payload: &GameStateEvent) {
    let _ = app.emit(GAME_STATE, payload);
}

pub fn emit_install_progress(app: &AppHandle, payload: &InstallProgress) {
    let _ = app.emit(INSTALL_PROGRESS, payload);
}
