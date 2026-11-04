//! The mod manager's Tauri commands: argument checks and locking around the steps in
//! `service.rs` and the rules in `plan.rs`. Every change to a profile goes through `ModsLock`, so
//! two clicks never write `mods.lock.json` at once; downloads happen before taking it, and
//! whether the game is running is checked again once it is held.

use std::path::PathBuf;
use tauri::AppHandle;
use tokio::sync::OwnedMutexGuard;

use super::archive::current_platform;
use super::catalog::Catalog;
use super::error::ModsError;
use super::index::RESERVED_ID;
use super::inspect::{self, FileInspection};
use super::paths::Paths;
use super::plan::{self, ChangeResult, CopyOutcome, CopyPreview, CopyResult, InstallPlan};
use super::profile::{self, Fit, ProfileReport};
use super::service::{
    self, build_report, change_result, check_sha, current_catalog, ensure_installed,
    ensure_not_running, lock_mods, require_abi, run_install, version_abi,
};
use super::sources;
use super::store;
use crate::error::AppError;

#[tauri::command]
pub async fn list_mod_catalog(app: AppHandle, force_refresh: bool) -> Result<Catalog, AppError> {
    Ok(service::load_catalog(&app, force_refresh).await?)
}

#[tauri::command]
pub async fn get_mod_sources(app: AppHandle) -> Result<Vec<String>, AppError> {
    Ok(sources::list(&Paths::of(&app)?))
}

/// Adds a repo as GitHub spells it. Adding one already there, in any case, keeps one entry.
#[tauri::command]
pub async fn add_mod_source(app: AppHandle, repo: String) -> Result<Vec<String>, AppError> {
    let paths = Paths::of(&app)?;
    let repo = sources::normalize(&repo)?;
    let canonical = sources::canonical_name(&service::http()?, &repo).await?;
    let _held = lock_mods(&app).await;
    let repos = sources::with_repo(sources::list(&paths), &canonical);
    sources::save(&paths, &repos)?;
    Ok(repos)
}

/// Mods installed from the repo stay installed; they just stop getting updates.
#[tauri::command]
pub async fn remove_mod_source(app: AppHandle, repo: String) -> Result<Vec<String>, AppError> {
    let paths = Paths::of(&app)?;
    let _held = lock_mods(&app).await;
    let repos = sources::without_repo(sources::list(&paths), &repo);
    sources::save(&paths, &repos)?;
    Ok(repos)
}

#[tauri::command]
pub async fn get_mod_profile(app: AppHandle, tag: String) -> Result<ProfileReport, AppError> {
    let paths = Paths::of(&app)?;
    ensure_installed(&paths, &tag)?;
    let catalog = current_catalog(&app).await?;
    let _held = lock_mods(&app).await;
    let mut lock = store::read_lock(&paths, &tag)?;
    if profile::apply_revocations(&mut lock, &catalog) {
        store::write_lock(&paths, &tag, &lock)?;
        store::reconcile(&paths, &tag, &lock)?;
    }
    Ok(build_report(&app, &paths, &tag, &lock, &catalog, true).await)
}

/// What `install_mod` would do with this build, without doing it.
#[tauri::command]
pub async fn plan_mod_install(
    app: AppHandle,
    tag: String,
    sha256: String,
) -> Result<InstallPlan, AppError> {
    let paths = Paths::of(&app)?;
    ensure_installed(&paths, &tag)?;
    let sha = check_sha(&sha256)?;
    let catalog = current_catalog(&app).await?;
    let lock = store::read_lock(&paths, &tag)?;
    let (abi, _) = version_abi(&paths, &catalog, &tag, true).await;
    let fit = abi.as_deref().map(Fit::here);
    let running = service::is_running(&app, &tag);
    Ok(plan::plan_install(
        &catalog, &lock, &tag, &sha, fit, running,
    )?)
}

/// Installs the catalogue build with this hash, and what it needs. Installing another build of
/// an installed mod replaces it and keeps it on or off as it was.
#[tauri::command]
pub async fn install_mod(
    app: AppHandle,
    tag: String,
    sha256: String,
) -> Result<ChangeResult, AppError> {
    let paths = Paths::of(&app)?;
    ensure_installed(&paths, &tag)?;
    let sha = check_sha(&sha256)?;
    ensure_not_running(&app, &tag)?;
    let catalog = current_catalog(&app).await?;
    let (m, v) = catalog
        .find(&sha)
        .map(|(m, v)| (m.clone(), v.clone()))
        .ok_or_else(|| ModsError::NotInCatalog(sha.clone()))?;
    let abi = require_abi(&paths, &catalog, &tag).await?;
    plan::check_installable(&catalog, &m, &v, Fit::here(&abi))?;
    Ok(run_install(&app, &paths, &tag, &catalog, &abi, vec![(m, v)], Vec::new()).await?)
}

/// What the launcher can tell about a zip from the player's computer, before installing it.
#[tauri::command]
pub async fn inspect_mod_file(
    app: AppHandle,
    tag: String,
    path: String,
) -> Result<FileInspection, AppError> {
    let paths = Paths::of(&app)?;
    ensure_installed(&paths, &tag)?;
    let catalog = current_catalog(&app).await?;
    let (abi, _) = version_abi(&paths, &catalog, &tag, true).await;
    let lock = store::read_lock(&paths, &tag)?;
    Ok(inspect::inspect(
        &PathBuf::from(path),
        &catalog,
        abi.as_deref(),
        current_platform(),
        &lock,
    )?)
}

/// Installs a zip from the player's computer. `sha256` is what `inspect_mod_file` showed, so a
/// file swapped in between is refused. A file that is in the catalogue installs from these same
/// bytes, with the catalogue's metadata and trust; anything else is Unverified.
#[tauri::command]
pub async fn install_mod_file(
    app: AppHandle,
    tag: String,
    path: String,
    sha256: String,
) -> Result<ChangeResult, AppError> {
    let paths = Paths::of(&app)?;
    ensure_installed(&paths, &tag)?;
    let sha = check_sha(&sha256)?;
    ensure_not_running(&app, &tag)?;
    let catalog = current_catalog(&app).await?;
    if let Some(r) = catalog.revocation(&sha) {
        return Err(ModsError::Revoked(r.reason.clone()).into());
    }
    let source = PathBuf::from(&path);
    inspect::checked_size(&source)?;
    let hold = service::reservations(&app).reserve(&sha);

    if let Some((m, v)) = catalog.find(&sha).map(|(m, v)| (m.clone(), v.clone())) {
        let abi = require_abi(&paths, &catalog, &tag).await?;
        let fit = Fit::here(&abi);
        plan::check_installable(&catalog, &m, &v, fit)?;
        store::admit_local(&paths, &source, &sha, Some(&m.id), fit.platform)?;
        let held = vec![hold];
        return Ok(run_install(&app, &paths, &tag, &catalog, &abi, vec![(m, v)], held).await?);
    }

    let info = store::admit_local(&paths, &source, &sha, None, current_platform())?;
    if info.id == RESERVED_ID {
        return Err(ModsError::IdReserved(info.id).into());
    }
    let mut entry = inspect::local_entry(&info, &paths.store_object(&sha), &source, &sha)?;

    let _guard = lock_mods(&app).await;
    ensure_not_running(&app, &tag)?;
    let mut lock = store::read_lock(&paths, &tag)?;
    entry.enabled = lock.get(&entry.id).is_none_or(|e| e.enabled);
    lock.put(entry);
    store::write_lock(&paths, &tag, &lock)?;
    drop(hold);
    store::reconcile(&paths, &tag, &lock)?;
    service::collect_garbage(&app, &paths);
    Ok(ChangeResult {
        installed: vec![info.id],
        ..change_result(&app, &paths, &tag, &lock, &catalog).await
    })
}

/// Turning a mod on turns on the installed mods it needs, and is refused when one of them is
/// revoked; turning it off turns off what needs it.
#[tauri::command]
pub async fn set_mod_enabled(
    app: AppHandle,
    tag: String,
    id: String,
    enabled: bool,
) -> Result<ChangeResult, AppError> {
    let paths = Paths::of(&app)?;
    ensure_installed(&paths, &tag)?;
    ensure_not_running(&app, &tag)?;
    let catalog = current_catalog(&app).await?;
    let _guard = lock_mods(&app).await;
    ensure_not_running(&app, &tag)?;
    let mut lock = store::read_lock(&paths, &tag)?;
    let (also_enabled, also_disabled) = plan::set_enabled(&mut lock, &catalog, &id, enabled)?;
    store::write_lock(&paths, &tag, &lock)?;
    store::reconcile(&paths, &tag, &lock)?;
    Ok(ChangeResult {
        also_enabled,
        also_disabled,
        ..change_result(&app, &paths, &tag, &lock, &catalog).await
    })
}

#[tauri::command]
pub async fn remove_mod(app: AppHandle, tag: String, id: String) -> Result<ChangeResult, AppError> {
    let paths = Paths::of(&app)?;
    ensure_installed(&paths, &tag)?;
    ensure_not_running(&app, &tag)?;
    let catalog = current_catalog(&app).await?;
    let _guard = lock_mods(&app).await;
    ensure_not_running(&app, &tag)?;
    let mut lock = store::read_lock(&paths, &tag)?;
    let also_disabled = plan::remove(&mut lock, &id)?;
    store::write_lock(&paths, &tag, &lock)?;
    store::reconcile(&paths, &tag, &lock)?;
    service::collect_garbage(&app, &paths);
    Ok(ChangeResult {
        also_disabled,
        ..change_result(&app, &paths, &tag, &lock, &catalog).await
    })
}

struct CopyInputs {
    catalog: Catalog,
    abi: String,
    preview: CopyPreview,
    picks: Vec<(super::catalog::CatalogMod, super::catalog::CatalogVersion)>,
}

async fn copy_inputs(
    app: &AppHandle,
    paths: &Paths,
    from: &str,
    to: &str,
) -> Result<CopyInputs, ModsError> {
    ensure_installed(paths, to)?;
    let source = store::read_lock(paths, from)?;
    let target = store::read_lock(paths, to)?;
    let catalog = current_catalog(app).await?;
    let abi = require_abi(paths, &catalog, to).await?;
    let (preview, picks) =
        plan::copy_preview(&catalog, (from, &source), (to, &target), Fit::here(&abi));
    Ok(CopyInputs {
        catalog,
        abi,
        preview,
        picks,
    })
}

/// What `copy_mod_profile` would bring over.
#[tauri::command]
pub async fn preview_copy_mod_profile(
    app: AppHandle,
    from: String,
    to: String,
) -> Result<CopyPreview, AppError> {
    let paths = Paths::of(&app)?;
    Ok(copy_inputs(&app, &paths, &from, &to).await?.preview)
}

/// Brings the turned-on mods of one version to another, each as the build made for the new one.
/// Mods the new version already has are left as they are.
#[tauri::command]
pub async fn copy_mod_profile(
    app: AppHandle,
    from: String,
    to: String,
) -> Result<CopyResult, AppError> {
    let paths = Paths::of(&app)?;
    ensure_not_running(&app, &to)?;
    let inputs = copy_inputs(&app, &paths, &from, &to).await?;
    let left_behind = inputs
        .preview
        .items
        .into_iter()
        .filter(|i| {
            matches!(
                i.outcome,
                CopyOutcome::NoBuild | CopyOutcome::LocalFile | CopyOutcome::Revoked
            )
        })
        .collect();
    let change = if inputs.picks.is_empty() {
        let lock = store::read_lock(&paths, &to)?;
        change_result(&app, &paths, &to, &lock, &inputs.catalog).await
    } else {
        let (catalog, abi) = (&inputs.catalog, &inputs.abi);
        run_install(&app, &paths, &to, catalog, abi, inputs.picks, Vec::new()).await?
    };
    Ok(CopyResult {
        change,
        left_behind,
    })
}

/// A mod icon as a `data:` URL: the page may not load images from the network.
#[tauri::command]
pub async fn get_mod_icon(app: AppHandle, url: String) -> Result<String, AppError> {
    use base64::Engine;
    let bytes = service::icon_png(&app, &url).await?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub async fn open_player_mods_folder(app: AppHandle) -> Result<(), AppError> {
    let folder = crate::launch::find_game_folder(&app).await.ok_or_else(|| {
        crate::launch::LaunchError::GameFolderNotFound("start the game once".into())
    })?;
    let mods = folder.join("mods");
    crate::launch::open_path(&app, if mods.exists() { &mods } else { &folder })?;
    Ok(())
}

/// The outcome of the pre-Play check. Holds `ModsLock` until [`LaunchMods::release`], so no mod
/// change can land between this check and the game counting as running.
pub struct LaunchMods {
    dir: Option<PathBuf>,
    _held: OwnedMutexGuard<()>,
}

impl LaunchMods {
    /// The folder to hand to `--mods`, letting mod changes go ahead again.
    pub fn release(self) -> Option<PathBuf> {
        self.dir
    }
}

/// Before Play: the folder to hand to `--mods`, or why the game would not start. Never waits
/// long on the network; without a known ABI the game itself has the last word.
pub async fn prepare_launch(app: &AppHandle, tag: &str) -> Result<LaunchMods, AppError> {
    let paths = Paths::of(app)?;
    let catalog = current_catalog(app).await?;
    let held = lock_mods(app).await;
    let mut lock = store::read_lock(&paths, tag)?;
    if profile::apply_revocations(&mut lock, &catalog) {
        store::write_lock(&paths, tag, &lock)?;
    }
    store::reconcile(&paths, tag, &lock)?;
    if !lock.mods.iter().any(|m| m.enabled) {
        return Ok(LaunchMods {
            dir: None,
            _held: held,
        });
    }
    let report = build_report(app, &paths, tag, &lock, &catalog, true).await;
    if !report.blocking.is_empty() {
        let names: Vec<String> = report.blocking.iter().map(|id| lock.name_of(id)).collect();
        return Err(ModsError::Blocked(names.join(", ")).into());
    }
    Ok(LaunchMods {
        dir: Some(paths.mods_dir(tag)?),
        _held: held,
    })
}
