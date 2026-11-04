//! The mod manager's Tauri commands. Every change to a profile goes through `ModsLock`, so two
//! clicks never write `mods.lock.json` at once; downloads happen before taking it.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use super::abi::{abi_for_tag, cached_abi};
use super::archive::{self, ArchiveInfo, MAX_FILE_BYTES, current_platform};
use super::catalog::{
    self, Catalog, CatalogMod, CatalogState, CatalogVersion, IndexStatus, Origin, Trust,
};
use super::error::ModsError;
use super::index::{self, Channel};
use super::paths::{downloads_dir, versions_dir};
use super::profile::{
    self, BUILTIN, Lock, LockEntry, ProfileReport, best_version, read_lock, reconcile, store_path,
    write_lock,
};
use super::sources;
use crate::download::{self, sha256_file};
use crate::error::AppError;

#[derive(Default)]
pub struct ModsLock(pub tokio::sync::Mutex<()>);

fn http() -> Result<reqwest::Client, ModsError> {
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()?)
}

fn executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "weft.exe"
    } else {
        "weft"
    }
}

fn ensure_installed(app: &AppHandle, tag: &str) -> Result<(), ModsError> {
    crate::install::validate_name(tag).map_err(|_| ModsError::InvalidName(tag.to_string()))?;
    if versions_dir(app)?
        .join(tag)
        .join(executable_name())
        .exists()
    {
        Ok(())
    } else {
        Err(ModsError::VersionNotInstalled(tag.to_string()))
    }
}

/// The running game read its mods at start; changing them under it would only confuse.
fn ensure_not_running(app: &AppHandle, tag: &str) -> Result<(), ModsError> {
    match crate::launch::running_game(app) {
        Some(running) if running == tag => Err(ModsError::GameRunning(running)),
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------------------------
// Catalogue

async fn load_catalog(app: &AppHandle, refresh: bool) -> Catalog {
    let client = match http() {
        Ok(c) => c,
        Err(_) => reqwest::Client::new(),
    };
    let state = index::load(app, &client, refresh).await;
    let status = IndexStatus {
        freshness: state.freshness,
        generated: state.index.as_ref().map(|i| i.generated.clone()),
        error: state.error.map(AppError::from),
    };
    let mut fetched = Vec::new();
    for repo in sources::list(app) {
        let result = sources::fetch(app, &client, &repo, refresh)
            .await
            .map_err(AppError::from);
        fetched.push((repo, result));
    }
    let catalog = catalog::build(state.index.as_ref(), status, fetched);
    *app.state::<CatalogState>().0.lock().unwrap() = Some(catalog.clone());
    catalog
}

/// The list the page last saw, or the cached one: never waits on the network.
async fn current_catalog(app: &AppHandle) -> Catalog {
    let held = app.state::<CatalogState>().0.lock().unwrap().clone();
    match held {
        Some(c) => c,
        None => load_catalog(app, false).await,
    }
}

#[tauri::command]
pub async fn list_mod_catalog(app: AppHandle, force_refresh: bool) -> Result<Catalog, AppError> {
    Ok(load_catalog(&app, force_refresh).await)
}

#[tauri::command]
pub async fn get_mod_sources(app: AppHandle) -> Result<Vec<String>, AppError> {
    Ok(sources::list(&app))
}

#[tauri::command]
pub async fn add_mod_source(app: AppHandle, repo: String) -> Result<Vec<String>, AppError> {
    let repo = sources::normalize(&repo)?;
    sources::exists(&http()?, &repo).await?;
    let mut repos = sources::list(&app);
    if !repos.iter().any(|r| r.eq_ignore_ascii_case(&repo)) {
        repos.push(repo);
        sources::save(&app, &repos)?;
    }
    Ok(repos)
}

#[tauri::command]
pub async fn remove_mod_source(app: AppHandle, repo: String) -> Result<Vec<String>, AppError> {
    let mut repos = sources::list(&app);
    repos.retain(|r| !r.eq_ignore_ascii_case(&repo));
    sources::save(&app, &repos)?;
    Ok(repos)
}

// ---------------------------------------------------------------------------------------------
// Profiles

async fn version_abi(
    app: &AppHandle,
    catalog: &Catalog,
    tag: &str,
    network: bool,
) -> (Option<String>, Option<AppError>) {
    if let Some(abi) = cached_abi(app, tag, &catalog.weft) {
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
    match abi_for_tag(app, &client, tag, &catalog.weft).await {
        Ok(abi) => (Some(abi), None),
        Err(e) => (None, Some(e.into())),
    }
}

/// Mods the player put into their own Weft folder, which every version loads.
async fn unmanaged(app: &AppHandle) -> Vec<String> {
    let Some(folder) = crate::launch::find_game_folder(app).await else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(folder.join("mods")) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort();
    names
}

async fn build_report(
    app: &AppHandle,
    tag: &str,
    lock: &Lock,
    catalog: &Catalog,
    network: bool,
) -> ProfileReport {
    let (abi, abi_error) = version_abi(app, catalog, tag, network).await;
    profile::report(
        tag,
        lock,
        abi,
        abi_error,
        Some(catalog),
        unmanaged(app).await,
    )
}

#[tauri::command]
pub async fn get_mod_profile(app: AppHandle, tag: String) -> Result<ProfileReport, AppError> {
    ensure_installed(&app, &tag)?;
    let catalog = current_catalog(&app).await;
    let guard = app.state::<ModsLock>();
    let _held = guard.0.lock().await;
    let mut lock = read_lock(&app, &tag)?;
    if profile::apply_revocations(&mut lock, &catalog) {
        write_lock(&app, &tag, &lock)?;
        reconcile(&app, &tag, &lock)?;
    }
    Ok(build_report(&app, &tag, &lock, &catalog, true).await)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeResult {
    pub report: ProfileReport,
    /// Mods downloaded or replaced by this change, dependencies included.
    pub installed: Vec<String>,
    /// Installed mods turned on because something needs them.
    pub also_enabled: Vec<String>,
    /// Mods turned off because what they need went away.
    pub also_disabled: Vec<String>,
    /// Dependencies nothing in the catalogue provides for this version.
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModProgress<'a> {
    sha256: &'a str,
    mod_id: &'a str,
    stage: &'a str,
    percent: u32,
}

fn emit_progress(app: &AppHandle, sha256: &str, mod_id: &str, stage: &str, percent: u32) {
    let _ = app.emit(
        "mod-progress",
        ModProgress {
            sha256,
            mod_id,
            stage,
            percent,
        },
    );
}

fn temp_file(app: &AppHandle, sha256: &str) -> Result<PathBuf, ModsError> {
    let dir = downloads_dir(app)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("mod-{sha256}.part")))
}

/// Checks a downloaded or copied file and moves it into the store under its hash.
fn admit(
    app: &AppHandle,
    tmp: &Path,
    sha256: &str,
    id: Option<&str>,
) -> Result<ArchiveInfo, ModsError> {
    let info = archive::inspect(std::fs::File::open(tmp)?, id)?;
    if !info.platforms.iter().any(|p| p == current_platform()) {
        return Err(ModsError::NotForPlatform(info.id));
    }
    let stored = store_path(app, sha256)?;
    std::fs::create_dir_all(stored.parent().unwrap())?;
    std::fs::rename(tmp, &stored)?;
    Ok(info)
}

async fn fetch_to_store(
    app: &AppHandle,
    m: &CatalogMod,
    v: &CatalogVersion,
) -> Result<(), ModsError> {
    let stored = store_path(app, &v.sha256)?;
    if stored.exists() && sha256_file(&stored)? == v.sha256 {
        return Ok(());
    }
    let tmp = temp_file(app, &v.sha256)?;
    emit_progress(app, &v.sha256, &m.id, "downloading", 0);
    let client = download::client()?;
    let limit = v.size.saturating_add(1024).min(MAX_FILE_BYTES);
    let result = download::to_file(&client, &v.url, &tmp, Some(limit), |p| {
        emit_progress(app, &v.sha256, &m.id, "downloading", p.percent);
    })
    .await;
    let done = match result {
        Ok(d) => d,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(ModsError::Http {
                status: 0,
                url: format!("{} ({e})", v.url),
            });
        }
    };
    emit_progress(app, &v.sha256, &m.id, "verifying", 100);
    if done.sha256 != v.sha256 {
        let _ = std::fs::remove_file(&tmp);
        return Err(ModsError::Sha256Mismatch {
            expected: v.sha256.clone(),
            actual: done.sha256,
        });
    }
    admit(app, &tmp, &v.sha256, Some(&m.id)).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

struct Plan {
    picks: Vec<(CatalogMod, CatalogVersion)>,
    enable: Vec<String>,
    missing: Vec<String>,
}

/// The requested versions plus whatever they need that isn't on yet. A dependency comes from the
/// index first, then from the same source as the mod that needs it.
fn plan(
    catalog: &Catalog,
    lock: &Lock,
    wanted: Vec<(CatalogMod, CatalogVersion)>,
    abi: &str,
) -> Plan {
    let mut plan = Plan {
        picks: Vec::new(),
        enable: Vec::new(),
        missing: Vec::new(),
    };
    let mut todo = wanted;
    while let Some((m, v)) = todo.pop() {
        if plan.picks.iter().any(|(p, _)| p.id == m.id) {
            continue;
        }
        for dep in &v.deps {
            if BUILTIN.contains(&dep.as_str())
                || plan.picks.iter().any(|(p, _)| &p.id == dep)
                || todo.iter().any(|(p, _)| &p.id == dep)
            {
                continue;
            }
            if let Some(have) = lock.get(dep)
                && have.abi.as_deref().is_none_or(|a| a == abi)
                && catalog.revocation(&have.sha256).is_none()
            {
                if !have.enabled && !plan.enable.contains(dep) {
                    plan.enable.push(dep.clone());
                }
                continue;
            }
            let mut keys = vec![format!("index:{dep}")];
            if let Origin::Source { repo } = &m.origin {
                keys.push(format!("source:{repo}:{dep}"));
            }
            match keys
                .iter()
                .find_map(|k| best_version(catalog, k, abi, v.channel))
            {
                Some((dm, dv)) => todo.push((dm.clone(), dv.clone())),
                None => {
                    if !plan.missing.contains(dep) {
                        plan.missing.push(dep.clone());
                    }
                }
            }
        }
        plan.picks.push((m, v));
    }
    plan
}

fn check_installable(
    catalog: &Catalog,
    v: &CatalogVersion,
    abi: &str,
    name: &str,
) -> Result<(), ModsError> {
    if let Some(r) = catalog.revocation(&v.sha256) {
        return Err(ModsError::Revoked(format!("{name}: {}", r.reason)));
    }
    if !v.platforms.iter().any(|p| p == current_platform()) {
        return Err(ModsError::NotForPlatform(name.to_string()));
    }
    if v.abi != abi {
        return Err(ModsError::Incompatible(name.to_string()));
    }
    Ok(())
}

async fn install_picks(
    app: &AppHandle,
    tag: &str,
    catalog: &Catalog,
    wanted: Vec<(CatalogMod, CatalogVersion)>,
) -> Result<ChangeResult, ModsError> {
    let (abi, abi_error) = version_abi(app, catalog, tag, true).await;
    let Some(abi) = abi else {
        return Err(abi_error
            .map(|e| ModsError::AbiUnavailable(e.detail.unwrap_or_default()))
            .unwrap_or_else(|| ModsError::AbiUnavailable(tag.to_string())));
    };
    for (m, v) in &wanted {
        check_installable(catalog, v, &abi, &m.name)?;
    }
    let snapshot = read_lock(app, tag)?;
    let plan = plan(catalog, &snapshot, wanted, &abi);
    for (m, v) in &plan.picks {
        fetch_to_store(app, m, v).await?;
    }

    let guard = app.state::<ModsLock>();
    let _held = guard.0.lock().await;
    let mut lock = read_lock(app, tag)?;
    let mut installed = Vec::new();
    for (m, v) in &plan.picks {
        emit_progress(app, &v.sha256, &m.id, "installing", 100);
        lock.put(LockEntry::from_catalog(m, v));
        installed.push(m.id.clone());
    }
    for id in &plan.enable {
        if let Some(e) = lock.get_mut(id) {
            e.enabled = true;
        }
    }
    write_lock(app, tag, &lock)?;
    reconcile(app, tag, &lock)?;
    let _ = profile::collect_garbage(app);
    Ok(ChangeResult {
        report: build_report(app, tag, &lock, catalog, false).await,
        installed,
        also_enabled: plan.enable,
        also_disabled: Vec::new(),
        missing: plan.missing,
    })
}

/// Installs the catalogue version with this hash, and what it needs. Installing another version
/// of an installed mod replaces it.
#[tauri::command]
pub async fn install_mod(
    app: AppHandle,
    tag: String,
    sha256: String,
) -> Result<ChangeResult, AppError> {
    ensure_installed(&app, &tag)?;
    ensure_not_running(&app, &tag)?;
    let catalog = current_catalog(&app).await;
    let (m, v) = catalog
        .find(&sha256.to_ascii_lowercase())
        .map(|(m, v)| (m.clone(), v.clone()))
        .ok_or_else(|| ModsError::NotInCatalog(sha256.clone()))?;
    Ok(install_picks(&app, &tag, &catalog, vec![(m, v)]).await?)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogMatch {
    pub key: String,
    pub name: String,
    pub version: String,
    pub trust: Trust,
    pub fits_version: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInspection {
    pub file_name: String,
    pub size: u64,
    pub sha256: String,
    pub archive: Option<ArchiveInfo>,
    /// Why the file can't be a mod, if it can't.
    pub problem: Option<AppError>,
    /// What the mod's own language file calls it. Only what the file says about itself.
    pub name: Option<String>,
    pub summary: Option<String>,
    pub fits_system: bool,
    pub catalog_match: Option<CatalogMatch>,
    pub revoked_reason: Option<String>,
    /// The installed version of a mod with the same id, which this file would replace.
    pub replaces: Option<String>,
}

/// What the launcher can tell about a zip from the player's computer, before installing it.
#[tauri::command]
pub async fn inspect_mod_file(
    app: AppHandle,
    tag: String,
    path: String,
) -> Result<FileInspection, AppError> {
    ensure_installed(&app, &tag)?;
    let path = PathBuf::from(path);
    let meta = std::fs::metadata(&path)?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if meta.len() > MAX_FILE_BYTES {
        return Err(ModsError::ArchiveInvalid("larger than 512 MB".into()).into());
    }
    let sha256 = sha256_file(&path)?;
    let inspected = std::fs::File::open(&path)
        .map_err(ModsError::from)
        .and_then(|f| archive::inspect(f, None));
    let (archive, problem) = match inspected {
        Ok(info) => (Some(info), None),
        Err(e) => (None, Some(AppError::from(e))),
    };
    let (name, summary) = archive
        .as_ref()
        .map(|a| archive::read_lang(&path, &a.id))
        .unwrap_or_default();
    let catalog = current_catalog(&app).await;
    let (abi, _) = version_abi(&app, &catalog, &tag, true).await;
    let catalog_match = catalog.find(&sha256).map(|(m, v)| CatalogMatch {
        key: m.key.clone(),
        name: m.name.clone(),
        version: v.version.clone(),
        trust: v.trust,
        fits_version: abi.as_deref() == Some(v.abi.as_str()),
    });
    let lock = read_lock(&app, &tag)?;
    let replaces = archive
        .as_ref()
        .and_then(|a| lock.get(&a.id))
        .map(|e| e.version.clone().unwrap_or_else(|| e.name.clone()));
    Ok(FileInspection {
        file_name,
        size: meta.len(),
        fits_system: archive
            .as_ref()
            .is_some_and(|a| a.platforms.iter().any(|p| p == current_platform())),
        archive,
        problem,
        name,
        summary,
        revoked_reason: catalog.revocation(&sha256).map(|r| r.reason.clone()),
        catalog_match,
        replaces,
        sha256,
    })
}

/// Installs a zip from the player's computer. `sha256` is what `inspect_mod_file` showed, so a
/// file swapped in between is refused. A file that is in the catalogue keeps its trust.
#[tauri::command]
pub async fn install_mod_file(
    app: AppHandle,
    tag: String,
    path: String,
    sha256: String,
) -> Result<ChangeResult, AppError> {
    ensure_installed(&app, &tag)?;
    ensure_not_running(&app, &tag)?;
    let catalog = current_catalog(&app).await;
    if let Some(r) = catalog.revocation(&sha256) {
        return Err(ModsError::Revoked(r.reason.clone()).into());
    }
    if let Some((m, v)) = catalog.find(&sha256) {
        let wanted = vec![(m.clone(), v.clone())];
        return Ok(install_picks(&app, &tag, &catalog, wanted).await?);
    }

    let source = PathBuf::from(&path);
    let tmp = temp_file(&app, &sha256)?;
    std::fs::copy(&source, &tmp)?;
    let copied = sha256_file(&tmp)?;
    if copied != sha256 {
        let _ = std::fs::remove_file(&tmp);
        return Err(ModsError::FileChanged.into());
    }
    let info = admit(&app, &tmp, &sha256, None).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    let (name, summary) = archive::read_lang(&store_path(&app, &sha256)?, &info.id);
    let file_name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let entry = LockEntry {
        id: info.id.clone(),
        name: name.unwrap_or_else(|| info.id.clone()),
        summary: summary.unwrap_or_default(),
        version: None,
        channel: None,
        sha256: sha256.clone(),
        size: std::fs::metadata(store_path(&app, &sha256)?)?.len(),
        enabled: true,
        trust: Trust::Unverified,
        origin: Origin::File { name: file_name },
        abi: None,
        weft_tag: None,
        deps: Vec::new(),
        tag: None,
        source_repo: None,
        source_commit: None,
        icon: None,
        installed_at: profile::now(),
    };

    let guard = app.state::<ModsLock>();
    let _held = guard.0.lock().await;
    let mut lock = read_lock(&app, &tag)?;
    lock.put(entry);
    write_lock(&app, &tag, &lock)?;
    reconcile(&app, &tag, &lock)?;
    let _ = profile::collect_garbage(&app);
    Ok(ChangeResult {
        report: build_report(&app, &tag, &lock, &catalog, false).await,
        installed: vec![info.id],
        also_enabled: Vec::new(),
        also_disabled: Vec::new(),
        missing: Vec::new(),
    })
}

/// Turning a mod on turns on the installed mods it needs; turning it off turns off what needs it.
#[tauri::command]
pub async fn set_mod_enabled(
    app: AppHandle,
    tag: String,
    id: String,
    enabled: bool,
) -> Result<ChangeResult, AppError> {
    ensure_installed(&app, &tag)?;
    ensure_not_running(&app, &tag)?;
    let catalog = current_catalog(&app).await;
    let guard = app.state::<ModsLock>();
    let _held = guard.0.lock().await;
    let mut lock = read_lock(&app, &tag)?;
    let entry = lock
        .get(&id)
        .ok_or_else(|| ModsError::NotInstalled(id.clone()))?;
    if enabled && let Some(r) = catalog.revocation(&entry.sha256) {
        return Err(ModsError::Revoked(r.reason.clone()).into());
    }
    let (mut also_enabled, mut also_disabled) = (Vec::new(), Vec::new());
    if enabled {
        for dep in lock.deps_of(&id) {
            if let Some(d) = lock.get_mut(&dep)
                && !d.enabled
            {
                d.enabled = true;
                also_enabled.push(dep);
            }
        }
    } else {
        for dependent in lock.dependents_of(&id) {
            if let Some(d) = lock.get_mut(&dependent) {
                d.enabled = false;
                also_disabled.push(dependent);
            }
        }
    }
    lock.get_mut(&id).unwrap().enabled = enabled;
    write_lock(&app, &tag, &lock)?;
    reconcile(&app, &tag, &lock)?;
    Ok(ChangeResult {
        report: build_report(&app, &tag, &lock, &catalog, false).await,
        installed: Vec::new(),
        also_enabled,
        also_disabled,
        missing: Vec::new(),
    })
}

#[tauri::command]
pub async fn remove_mod(app: AppHandle, tag: String, id: String) -> Result<ChangeResult, AppError> {
    ensure_installed(&app, &tag)?;
    ensure_not_running(&app, &tag)?;
    let catalog = current_catalog(&app).await;
    let guard = app.state::<ModsLock>();
    let _held = guard.0.lock().await;
    let mut lock = read_lock(&app, &tag)?;
    if lock.get(&id).is_none() {
        return Err(ModsError::NotInstalled(id).into());
    }
    let also_disabled = lock.dependents_of(&id);
    for dependent in &also_disabled {
        if let Some(d) = lock.get_mut(dependent) {
            d.enabled = false;
        }
    }
    lock.mods.retain(|m| m.id != id);
    write_lock(&app, &tag, &lock)?;
    reconcile(&app, &tag, &lock)?;
    let _ = profile::collect_garbage(&app);
    Ok(ChangeResult {
        report: build_report(&app, &tag, &lock, &catalog, false).await,
        installed: Vec::new(),
        also_enabled: Vec::new(),
        also_disabled,
        missing: Vec::new(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    #[serde(flatten)]
    pub change: ChangeResult,
    /// Turned-on mods of the old version with no build for the new one yet.
    pub left_behind: Vec<String>,
}

/// Brings the turned-on mods of one version to another, each as the build made for the new one.
#[tauri::command]
pub async fn copy_mod_profile(
    app: AppHandle,
    from: String,
    to: String,
) -> Result<CopyResult, AppError> {
    ensure_installed(&app, &to)?;
    ensure_not_running(&app, &to)?;
    let catalog = current_catalog(&app).await;
    let (abi, _) = version_abi(&app, &catalog, &to, true).await;
    let abi = abi.ok_or_else(|| ModsError::AbiUnavailable(to.clone()))?;
    let source = read_lock(&app, &from)?;
    let mut wanted = Vec::new();
    let mut left_behind = Vec::new();
    for entry in source.mods.iter().filter(|m| m.enabled) {
        let pick = entry.catalog_key().and_then(|key| {
            best_version(
                &catalog,
                &key,
                &abi,
                entry.channel.unwrap_or(Channel::Release),
            )
        });
        match pick {
            Some((m, v)) => wanted.push((m.clone(), v.clone())),
            None => left_behind.push(entry.name.clone()),
        }
    }
    let change = if wanted.is_empty() {
        let lock = read_lock(&app, &to)?;
        ChangeResult {
            report: build_report(&app, &to, &lock, &catalog, false).await,
            installed: Vec::new(),
            also_enabled: Vec::new(),
            also_disabled: Vec::new(),
            missing: Vec::new(),
        }
    } else {
        install_picks(&app, &to, &catalog, wanted).await?
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
    let known = app
        .state::<CatalogState>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|c| {
            c.mods
                .iter()
                .any(|m| m.icon.as_deref() == Some(url.as_str()))
        });
    if !known || !url.starts_with("https://") {
        return Err(ModsError::NotInCatalog(url).into());
    }
    let cache = super::paths::cache_dir(&app)?
        .join("mod-icons")
        .join(format!(
            "{}.png",
            &crate::download::sha256_hex(url.as_bytes())[..32]
        ));
    let bytes = match std::fs::read(&cache) {
        Ok(b) => b,
        Err(_) => {
            let response = http()?
                .get(&url)
                .timeout(Duration::from_secs(15))
                .send()
                .await
                .map_err(ModsError::from)?;
            if !response.status().is_success() {
                return Err(ModsError::Http {
                    status: response.status().as_u16(),
                    url,
                }
                .into());
            }
            let b = response.bytes().await.map_err(ModsError::from)?.to_vec();
            if b.len() > 512 * 1024 || !b.starts_with(b"\x89PNG\r\n\x1a\n") {
                return Err(ModsError::ArchiveInvalid("icon is not a small PNG".into()).into());
            }
            let _ = super::paths::write_atomic(&cache, &b);
            b
        }
    };
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

/// Before Play: the folder to hand to `--mods`, or why the game would not start. Never waits
/// long on the network; without a known ABI the game itself has the last word.
pub async fn prepare_launch(app: &AppHandle, tag: &str) -> Result<Option<PathBuf>, AppError> {
    let catalog = current_catalog(app).await;
    let guard = app.state::<ModsLock>();
    let _held = guard.0.lock().await;
    let mut lock = read_lock(app, tag)?;
    if profile::apply_revocations(&mut lock, &catalog) {
        write_lock(app, tag, &lock)?;
    }
    reconcile(app, tag, &lock)?;
    if !lock.mods.iter().any(|m| m.enabled) {
        return Ok(None);
    }
    let report = build_report(app, tag, &lock, &catalog, true).await;
    if !report.blocking.is_empty() {
        return Err(ModsError::Blocked(report.blocking.join(", ")).into());
    }
    Ok(Some(profile::mods_dir(app, tag)?))
}
