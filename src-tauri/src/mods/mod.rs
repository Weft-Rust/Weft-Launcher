//! The mod manager: a per-version mod set handed to the game with `--mods`, a signed index of
//! reviewed mods, GitHub repos as extra sources, and the checks between them and the game.
//! Design: `docs/mod-manager/PROPOSAL.md`; index contract: `docs/mod-manager/INDEX_FORMAT.md`.
//!
//! - Rules on plain data: `plan.rs` (installs, copies, on/off, removal), `profile.rs` (statuses,
//!   updates, revocations), `catalog.rs`, `index/` (the contract), `diagnose.rs`.
//! - Disk and network: `store.rs`, `install.rs`, `inspect.rs`, `sources.rs`, `abi.rs`, all on a
//!   [`Paths`].
//! - `service.rs`: the operations, on a [`Ctx`] (`context.rs`) that holds what they need from the
//!   app, so they run without it in tests.
//! - `commands.rs`: the Tauri commands, one call into `service.rs` each.

pub mod abi;
pub mod archive;
pub mod catalog;
pub mod commands;
pub mod context;
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
#[cfg(test)]
mod service_tests;

pub use context::{Ctx, ModsLock};
pub use paths::Paths;
pub use service::LaunchMods;

use tauri::AppHandle;

/// Before Play: see [`service::prepare_launch`].
pub async fn prepare_launch(
    app: &AppHandle,
    tag: &str,
) -> Result<LaunchMods, crate::error::AppError> {
    Ok(service::prepare_launch(&Ctx::of(app)?, tag).await?)
}

/// A deleted game version takes its mod set along, under the mods lock.
pub async fn forget_version(app: &AppHandle, tag: &str) {
    if let Ok(ctx) = Ctx::of(app) {
        service::forget_version(&ctx, tag).await;
    }
}
