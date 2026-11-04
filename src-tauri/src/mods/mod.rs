//! The mod manager: a per-version mod set handed to the game with `--mods`, a signed index of
//! reviewed mods, GitHub repos as extra sources, and the checks between them and the game.
//! Design: `docs/mod-manager/PROPOSAL.md`; index contract: `docs/mod-manager/INDEX_FORMAT.md`.
//!
//! - Rules on plain data: `plan.rs` (installs, copies, on/off, removal), `profile.rs` (statuses,
//!   updates, revocations), `catalog.rs`, `index.rs` (the contract), `diagnose.rs`.
//! - Disk and network: `store.rs`, `install.rs`, `inspect.rs`, `sources.rs`, `abi.rs`, all on a
//!   [`Paths`]; `service.rs` for the steps that need the running app.
//! - `commands.rs`: the Tauri commands, which check arguments and take the locks.

pub mod abi;
pub mod archive;
pub mod catalog;
pub mod commands;
pub mod diagnose;
pub mod error;
pub mod index;
pub mod inspect;
pub mod install;
pub mod paths;
pub mod plan;
pub mod profile;
pub mod service;
pub mod sources;
pub mod store;
pub mod version;

#[cfg(test)]
mod doc_tests;

pub use commands::{LaunchMods, prepare_launch};
pub use paths::Paths;

use tauri::{AppHandle, Manager};

/// A deleted game version takes its mod set along.
pub fn forget_version(app: &AppHandle, tag: &str) {
    if let Ok(paths) = Paths::of(app) {
        store::forget_version(&paths, &app.state::<store::Reservations>(), tag);
    }
}
