//! The IPC commands of the Mods tab. Every change runs under one lock, refuses a version whose
//! game is running, and ends with `settle`.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use super::fetch::{self, Staging};
use super::index::{self, Index};
use super::plan::{Planned, plan};
use super::profile::{Installed, Profile};
use super::{Dirs, ModError, abi, archive, verify};
use crate::error::AppError;
use crate::install::validate_name;
use crate::launch::running_game;

pub struct Mods {
    dirs: Dirs,
    lock: Mutex<()>,
}

impl Mods {
    pub fn new(dirs: Dirs) -> Self {
        Self {
            dirs,
            lock: Mutex::new(()),
        }
    }

    /// Runs one change to a version's mods, under the lock and never while its game runs.
    /// Returns the list afterwards.
    async fn change(
        &self,
        app: &AppHandle,
        tag: &str,
        f: impl FnOnce(&Profile, &Index) -> Result<(), ModError>,
    ) -> Result<Vec<ListedMod>, ModError> {
        let _guard = self.lock.lock().await;
        if is_running(app, tag) {
            return Err(ModError::GameRunning);
        }
        f(&Profile::new(&self.dirs, tag), &index_or_empty(&self.dirs))?;
        list(app, self, tag)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedMod {
    id: String,
    name: String,
    version: String,
    on: bool,
    /// An index is loaded and the file's SHA-256 isn't in it.
    unverified: bool,
    revoked: bool,
    reason: Option<String>,
    /// A newer build for this version, from the index.
    update: Option<String>,
}

#[derive(Serialize)]
pub struct FileInfo {
    id: String,
    name: String,
    version: String,
    replaces: bool,
    plan: Vec<Planned>,
}

fn is_running(app: &AppHandle, tag: &str) -> bool {
    running_game(app).as_deref() == Some(tag)
}

fn index_or_empty(dirs: &Dirs) -> Index {
    index::cached(dirs).unwrap_or_default()
}

/// A version's mods, repaired first unless its game is running.
fn list(app: &AppHandle, mods: &Mods, tag: &str) -> Result<Vec<ListedMod>, ModError> {
    let cached = index::cached(&mods.dirs);
    let index = cached.clone().unwrap_or_default();
    let profile = Profile::new(&mods.dirs, tag);
    let installed = if is_running(app, tag) {
        profile.read()?
    } else {
        profile.settle(&index)?
    };
    let abi = profile.abi.as_deref();
    let mut list: Vec<ListedMod> = installed
        .into_values()
        .map(|m| {
            let revoked = index.revoked(&m.sha256);
            let unverified =
                cached.is_some() && revoked.is_none() && index.by_hash(&m.sha256).is_none();
            let newer = abi.and_then(|abi| index.newest(&m.manifest.id, abi));
            let update = newer
                .map(|(_, b)| b.version.clone())
                .filter(|v| !unverified && index::version(v) > index::version(&m.manifest.version));
            ListedMod {
                id: m.manifest.id,
                name: m.manifest.name,
                version: m.manifest.version,
                on: m.on,
                unverified,
                revoked: revoked.is_some(),
                reason: revoked.and_then(|r| r.reason.clone()),
                update,
            }
        })
        .collect();
    list.sort_by_key(|m| m.name.to_lowercase());
    Ok(list)
}

/// The version's mod ABI. `None` if the version is older than mods.
#[tauri::command]
pub async fn mods_abi(mods: State<'_, Mods>, tag: String) -> Result<Option<String>, AppError> {
    validate_name(&tag)?;
    Ok(abi::get(&mods.dirs, &tag).await?)
}

/// The index, fetched now. Without `refresh`, a failed fetch falls back to the cached copy.
#[tauri::command]
pub async fn mods_catalog(mods: State<'_, Mods>, refresh: bool) -> Result<Index, AppError> {
    match index::fetch(&mods.dirs).await {
        Err(e) if !refresh => Ok(index::cached(&mods.dirs).ok_or(e)?),
        result => Ok(result?),
    }
}

#[tauri::command]
pub async fn mods_list(
    app: AppHandle,
    mods: State<'_, Mods>,
    tag: String,
) -> Result<Vec<ListedMod>, AppError> {
    validate_name(&tag)?;
    let _guard = mods.lock.lock().await;
    Ok(list(&app, &mods, &tag)?)
}

fn plan_install(dirs: &Dirs, tag: &str, id: &str, version: &str) -> Result<Vec<Planned>, ModError> {
    let index = index_or_empty(dirs);
    let profile = Profile::new(dirs, tag);
    let abi = profile.abi.as_deref().ok_or(ModError::WrongVersion)?;
    let todo = vec![(id.to_string(), Some(version.to_string()))];
    plan(&index, &profile, &profile.read()?, abi, todo)
}

#[tauri::command]
pub async fn mods_plan(
    mods: State<'_, Mods>,
    tag: String,
    id: String,
    version: String,
) -> Result<Vec<Planned>, AppError> {
    validate_name(&tag)?;
    Ok(plan_install(&mods.dirs, &tag, &id, &version)?)
}

/// Downloads and checks the plan into `staging`, which may already hold the player's own file
/// as `<root>.zip`. Then moves every file in place and turns `root` on with what it needs,
/// unless it was installed and off. The plan covers everything `root` needs, so nothing is
/// installed if any step fails.
async fn install(
    app: &AppHandle,
    mods: &Mods,
    tag: &str,
    staging: Staging,
    plan: &[Planned],
    root: &str,
) -> Result<Vec<ListedMod>, ModError> {
    fetch::fetch(app, &staging, tag, plan).await?;
    mods.change(app, tag, |profile, index| {
        for p in plan {
            profile.place(&p.id, &staging.zip(&p.id))?;
        }
        if staging.zip(root).exists() {
            profile.place(root, &staging.zip(root))?;
        }
        if profile.on.join(format!("{root}.zip")).exists() {
            profile.enable(root, index)?;
        }
        Ok(())
    })
    .await
}

/// Installs or updates `id` at `version` from the index, with what it needs.
#[tauri::command]
pub async fn mods_install(
    app: AppHandle,
    mods: State<'_, Mods>,
    tag: String,
    id: String,
    version: String,
) -> Result<Vec<ListedMod>, AppError> {
    validate_name(&tag)?;
    let plan = plan_install(&mods.dirs, &tag, &id, &version)?;
    let staging = Staging::new(&mods.dirs).map_err(ModError::from)?;
    Ok(install(&app, &mods, &tag, staging, &plan, &id).await?)
}

/// What a mod file would install, or why it can't.
fn inspect_file(dirs: &Dirs, tag: &str, path: &Path) -> Result<FileInfo, ModError> {
    let manifest = archive::inspect(path)?;
    let sha256 = verify::sha256(&std::fs::read(path)?);
    let index = index_or_empty(dirs);
    if let Some(r) = index.revoked(&sha256) {
        return Err(ModError::Revoked(r.reason.clone()));
    }
    let profile = Profile::new(dirs, tag);
    if profile.abi.as_ref() != Some(&manifest.abi) {
        return Err(ModError::WrongVersion);
    }
    let mut installed = profile.read()?;
    let replaces = installed.contains_key(&manifest.id);
    let deps = manifest.deps.iter().map(|d| (d.clone(), None)).collect();
    // The file counts as installed, so no dependency brings another copy of it.
    let file = Installed {
        manifest: manifest.clone(),
        sha256,
        on: true,
        bare: false,
    };
    installed.insert(manifest.id.clone(), file);
    Ok(FileInfo {
        plan: plan(&index, &profile, &installed, &manifest.abi, deps)?,
        replaces,
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
    })
}

#[tauri::command]
pub async fn mods_inspect_file(
    mods: State<'_, Mods>,
    tag: String,
    path: String,
) -> Result<FileInfo, AppError> {
    validate_name(&tag)?;
    Ok(inspect_file(&mods.dirs, &tag, Path::new(&path))?)
}

/// Installs a file the player picked, with what it needs from the index. The file is copied
/// first, and that copy is what's checked and installed.
#[tauri::command]
pub async fn mods_install_file(
    app: AppHandle,
    mods: State<'_, Mods>,
    tag: String,
    path: String,
) -> Result<Vec<ListedMod>, AppError> {
    validate_name(&tag)?;
    let staging = Staging::new(&mods.dirs).map_err(ModError::from)?;
    let copy = staging.0.join(".picked");
    std::fs::copy(&path, &copy).map_err(ModError::from)?;
    let info = inspect_file(&mods.dirs, &tag, &copy)?;
    std::fs::rename(&copy, staging.zip(&info.id)).map_err(ModError::from)?;
    Ok(install(&app, &mods, &tag, staging, &info.plan, &info.id).await?)
}

/// Turns a mod on (with what it needs) or off (with what needs it).
#[tauri::command]
pub async fn mods_set_enabled(
    app: AppHandle,
    mods: State<'_, Mods>,
    tag: String,
    id: String,
    on: bool,
) -> Result<Vec<ListedMod>, AppError> {
    validate_name(&tag)?;
    validate_name(&id)?;
    let list = mods.change(&app, &tag, |profile, index| match on {
        true => profile.enable(&id, index),
        false => Ok(profile.set(&id, false)?),
    });
    Ok(list.await?)
}

#[tauri::command]
pub async fn mods_remove(
    app: AppHandle,
    mods: State<'_, Mods>,
    tag: String,
    id: String,
) -> Result<Vec<ListedMod>, AppError> {
    validate_name(&tag)?;
    validate_name(&id)?;
    let list = mods.change(&app, &tag, |profile, _| Ok(profile.remove(&id)?));
    Ok(list.await?)
}

/// Settles a version's mods right before its game starts, and returns the folder to pass to it.
pub async fn prepare_launch(app: &AppHandle, tag: &str) -> Result<PathBuf, ModError> {
    let mods = app.state::<Mods>();
    let _guard = mods.lock.lock().await;
    let profile = Profile::new(&mods.dirs, tag);
    profile.settle(&index_or_empty(&mods.dirs))?;
    Ok(profile.on)
}

/// Deletes a version's mods along with the version.
pub async fn remove_profile(app: &AppHandle, tag: &str) {
    let mods = app.state::<Mods>();
    let _guard = mods.lock.lock().await;
    let _ = std::fs::remove_dir_all(mods.dirs.profile(tag));
}
