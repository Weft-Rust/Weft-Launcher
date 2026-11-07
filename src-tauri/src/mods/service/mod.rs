//! The mod manager's operations, one per command, on a [`Ctx`]. The rules they apply live in
//! `plan.rs` and `profile.rs`; this is where the disk, the network and the locks come in.
//!
//! - Every change to a profile or the store happens under `ModsLock`, so two clicks never write
//!   `mods.lock.json` at once. Downloads happen before taking it.
//! - The consent boundary is the plan the player reviewed. `plan`, `copy_preview` and
//!   `inspect_file` hand the page a `planToken` ([`plan::Consent`]); `install`, `copy` and
//!   `install_file` take it back. The token is recomputed from the current catalogue, profile
//!   and ABI before anything is downloaded and again under the lock at commit; when it differs,
//!   the command fails with `ModChangedMeanwhile` and writes nothing (see [`commit`]).
//! - Each of those commands, and `restore`, runs as an [`Operation`] with the page's id: its
//!   progress carries that id, and `cancel_mod_operation` stops it until it starts writing.
//! - Nothing rewrites a version's `mods/` folder while its game runs. Revocations that arrive
//!   meanwhile are reported as pending and applied when it stops ([`apply_pending`]).
//! - Hashing and copying files run off the async runtime ([`blocking`]).

use std::path::PathBuf;
use std::time::Duration;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::OwnedMutexGuard;

use super::abi::{abi_for_tag, cached_abi};
use super::archive::current_platform;
use super::catalog::{
    self, Catalog, CatalogMod, CatalogParts, CatalogVersion, IndexStatus, SourceResult,
};
use super::context::{Ctx, Operation, Step, blocking, check_sha, ensure_installed};
use super::error::ModsError;
use super::index::{self, IndexCache, IndexState, RESERVED_ID};
use super::inspect::{self, FileInspection};
use super::install::{self, ProgressStage};
use super::paths::{Paths, write_atomic};
use super::plan::{
    self, ChangeResult, CopyOutcome, CopyPreview, CopyResult, InstallPlan, Resolution, plan_token,
};
use super::profile::{self, Fit, Lock, PlayerFile, ProfileReport};
use super::sources::{self, SourceFetch};
use super::store::{self, Removed, Reservation};
use crate::download::{read_capped, sha256_file};
use crate::error::AppError;

mod changes;
mod copying;
mod fetching;
mod launching;

pub use changes::*;
pub use copying::*;
pub use fetching::*;
pub use launching::*;

/// For the index, sources, icons and the ABI: redirects stay on GitHub, over https.
pub fn http() -> Result<reqwest::Client, ModsError> {
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .redirect(crate::download::redirect_policy())
        .build()?)
}

// ---------------------------------------------------------------------------------------------
// Catalogue

fn rfc3339(t: OffsetDateTime) -> String {
    t.format(&Rfc3339).unwrap_or_default()
}

pub async fn version_abi(
    paths: &Paths,
    catalog: &Catalog,
    tag: &str,
    network: bool,
) -> (Option<String>, Option<AppError>) {
    if let Some(abi) = cached_abi(paths, tag, &catalog.weft) {
        return (Some(abi), None);
    }
    if !network {
        return (
            None,
            Some(ModsError::AbiUnavailable(tag.to_string()).into()),
        );
    }
    let client = match http() {
        Ok(c) => c,
        Err(e) => return (None, Some(e.into())),
    };
    match abi_for_tag(paths, &client, tag, &catalog.weft).await {
        Ok(abi) => (Some(abi), None),
        Err(e) => (None, Some(e.into())),
    }
}

/// The version's mod interface, or why it can't be known: nothing can be installed without it.
pub async fn require_abi(paths: &Paths, catalog: &Catalog, tag: &str) -> Result<String, ModsError> {
    match version_abi(paths, catalog, tag, true).await {
        (Some(abi), _) => Ok(abi),
        (None, error) => Err(ModsError::AbiUnavailable(
            error
                .and_then(|e| e.detail)
                .unwrap_or_else(|| tag.to_string()),
        )),
    }
}

/// What the player put into their own Weft mods folder, which every version loads after the
/// launcher's. Only listed, never changed.
async fn unmanaged(paths: &Paths) -> Vec<PlayerFile> {
    let Some(folder) = crate::launch::find_game_folder_in(&paths.logs_dir()).await else {
        return Vec::new();
    };
    player_files(&folder.join("mods"))
}

pub fn player_files(dir: &std::path::Path) -> Vec<PlayerFile> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PlayerFile> = entries
        .flatten()
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            PlayerFile::new(&name, e.path().is_dir())
        })
        .filter(|f| !f.file.starts_with('.'))
        .collect();
    files.sort_by(|a, b| a.file.cmp(&b.file));
    files
}

pub async fn build_report(
    ctx: &Ctx,
    tag: &str,
    lock: &Lock,
    catalog: &Catalog,
    network: bool,
) -> ProfileReport {
    let (abi, abi_error) = version_abi(&ctx.paths, catalog, tag, network).await;
    profile::report(
        tag,
        lock,
        abi,
        abi_error,
        catalog,
        current_platform(),
        unmanaged(&ctx.paths).await,
    )
}

/// The profile after a change, with nothing else to report yet.
async fn change_result(ctx: &Ctx, tag: &str, lock: &Lock, catalog: &Catalog) -> ChangeResult {
    ChangeResult::of(build_report(ctx, tag, lock, catalog, false).await)
}

/// Makes the version's `mods/` folder hold exactly its turned-on mods.
async fn reconcile(ctx: &Ctx, tag: &str, lock: &Lock) -> Result<(), ModsError> {
    let (paths, tag, lock) = (ctx.paths.clone(), tag.to_string(), lock.clone());
    blocking(move || store::reconcile(&paths, &tag, &lock)).await
}

/// Writes a changed mod set under `ModsLock`. Three files change, each atomically, in an order
/// where stopping after any step (an error, or the launcher being closed) leaves a state that
/// is still true:
///
/// 1. The undo record of an earlier removal goes first, since this is the version's next
///    change. If that fails, nothing changed.
/// 2. `mods.lock.json`, the one record of the set. If that fails, nothing changed but the
///    lost Undo. Once it is written, the change is made.
/// 3. For a removal, its undo record. If that fails, the removal stands without an Undo:
///    `false` says so, and nothing else is wrong.
/// 4. The version's `mods/` folder, made to match the lock. If that fails, the error is
///    returned with the change made: the folder is made to match again by the next change and
///    before every Play ([`prepare_launch`]), so the game never starts with the old one.
///
/// `held` reservations are let go once the lock file names their builds, and unused store
/// files go. Returns whether an undo record for `undo` was kept.
async fn save(
    ctx: &Ctx,
    tag: &str,
    lock: &Lock,
    undo: Option<&Removed>,
    held: Vec<Reservation>,
) -> Result<bool, ModsError> {
    if undo.is_none() {
        store::clear_removed(&ctx.paths, tag)?;
    }
    store::write_lock(&ctx.paths, tag, lock)?;
    let kept = match undo {
        Some(removed) => match store::write_removed(&ctx.paths, tag, removed) {
            Ok(()) => true,
            Err(e) => {
                eprintln!("mods: the removal from {tag} can't be undone: {e}");
                false
            }
        },
        None => false,
    };
    drop(held);
    reconcile(ctx, tag, lock).await?;
    ctx.collect_garbage().await;
    Ok(kept)
}

/// Records and applies the catalogue's revocations to the version's mod set, unless its game
/// is running: then the lock and the folder stay as the game started with them, and the report
/// lists the revoked mods as pending. The caller holds `ModsLock`.
async fn apply_revocations(ctx: &Ctx, tag: &str, catalog: &Catalog) -> Result<Lock, ModsError> {
    let lock = store::read_lock(&ctx.paths, tag)?;
    let mut applied = lock.clone();
    if !profile::apply_revocations(&mut applied, catalog) {
        return Ok(lock);
    }
    if ctx.is_running(tag) {
        return Ok(lock);
    }
    store::write_lock(&ctx.paths, tag, &applied)?;
    reconcile(ctx, tag, &applied).await?;
    Ok(applied)
}

/// The version's mod set, with revocations applied (or pending, while its game runs).
pub async fn profile(ctx: &Ctx, tag: &str) -> Result<ProfileReport, ModsError> {
    ensure_installed(&ctx.paths, tag)?;
    let catalog = current_catalog(ctx).await?;
    let lock = {
        let _held = ctx.lock_mods().await;
        apply_revocations(ctx, tag, &catalog).await?
    };
    Ok(build_report(ctx, tag, &lock, &catalog, true).await)
}

/// After the version's game stopped: the revocations that waited for it.
pub async fn apply_pending(ctx: &Ctx, tag: &str) -> Result<(), ModsError> {
    if ensure_installed(&ctx.paths, tag).is_err() {
        return Ok(());
    }
    let catalog = current_catalog(ctx).await?;
    let _held = ctx.lock_mods().await;
    apply_revocations(ctx, tag, &catalog).await.map(|_| ())
}

/// A deleted game version takes its mod set along.
pub async fn forget_version(ctx: &Ctx, tag: &str) {
    let _guard = ctx.lock_mods().await;
    let (paths, reservations, tag) = (ctx.paths.clone(), ctx.reservations.clone(), tag.to_string());
    let _ = blocking(move || {
        store::forget_version(&paths, &reservations, &tag);
        Ok(())
    })
    .await;
}

// ---------------------------------------------------------------------------------------------
// Before Play
