//! The steps the commands are made of that need the running app: its state, its events and the
//! network. Each one is small; the rules they apply live in `plan.rs` and `profile.rs`.

use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex, OwnedMutexGuard};

use super::abi::{abi_for_tag, cached_abi};
use super::archive::current_platform;
use super::catalog::{
    self, Catalog, CatalogMod, CatalogState, CatalogVersion, IndexStatus, SourceResult,
};
use super::error::ModsError;
use super::index::{self, IndexCache, is_sha256};
use super::install::{self, ModProgress, ProgressStage};
use super::paths::{Paths, write_atomic};
use super::plan::{self, ChangeResult};
use super::profile::{self, Fit, Lock, ProfileReport};
use super::sources;
use super::store::{self, Reservation, Reservations};
use crate::error::AppError;

/// Held while a profile changes, and by a launch from its last check until the game counts as
/// running.
#[derive(Default)]
pub struct ModsLock(Arc<Mutex<()>>);

impl ModsLock {
    pub async fn acquire(&self) -> OwnedMutexGuard<()> {
        self.0.clone().lock_owned().await
    }
}

pub async fn lock_mods(app: &AppHandle) -> OwnedMutexGuard<()> {
    app.state::<ModsLock>().acquire().await
}

pub fn http() -> Result<reqwest::Client, ModsError> {
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

pub fn ensure_installed(paths: &Paths, tag: &str) -> Result<(), ModsError> {
    crate::install::validate_name(tag).map_err(|_| ModsError::InvalidName(tag.to_string()))?;
    if paths
        .versions_dir()
        .join(tag)
        .join(executable_name())
        .exists()
    {
        Ok(())
    } else {
        Err(ModsError::VersionNotInstalled(tag.to_string()))
    }
}

/// The page names builds by hash; anything else is refused before it reaches a path or a lookup.
pub fn check_sha(sha256: &str) -> Result<String, ModsError> {
    let sha = sha256.to_ascii_lowercase();
    if is_sha256(&sha) {
        Ok(sha)
    } else {
        Err(ModsError::InvalidName(sha256.to_string()))
    }
}

/// The running game read its mods at start; changing them under it would only confuse.
pub fn ensure_not_running(app: &AppHandle, tag: &str) -> Result<(), ModsError> {
    match crate::launch::running_game(app) {
        Some(running) if running == tag => Err(ModsError::GameRunning(running)),
        _ => Ok(()),
    }
}

pub fn is_running(app: &AppHandle, tag: &str) -> bool {
    crate::launch::running_game(app).is_some_and(|r| r == tag)
}

pub fn reservations(app: &AppHandle) -> Reservations {
    app.state::<Reservations>().inner().clone()
}

pub fn collect_garbage(app: &AppHandle, paths: &Paths) {
    if let Err(e) = store::collect_garbage(paths, &reservations(app)) {
        eprintln!("mods: garbage collection skipped: {e}");
    }
}

// ---------------------------------------------------------------------------------------------
// Catalogue

pub async fn load_catalog(app: &AppHandle, refresh: bool) -> Result<Catalog, ModsError> {
    let paths = Paths::of(app)?;
    let client = http().unwrap_or_else(|_| reqwest::Client::new());
    let cache = IndexCache::new(&paths.cache_dir(), index::public_key());
    let url = index::index_url();
    let state = index::load(&cache, refresh, async {
        let bytes = index::fetch_bytes(&client, &url).await?;
        let sig = index::fetch_bytes(&client, &format!("{url}.minisig")).await?;
        let sig = String::from_utf8(sig)
            .map_err(|_| ModsError::IndexSignatureInvalid("not text".into()))?;
        Ok((bytes, sig))
    })
    .await;
    let status = IndexStatus {
        freshness: state.freshness,
        generated: state.index.as_ref().map(|i| i.generated.clone()),
        error: state.error.map(AppError::from),
    };
    let mut fetched = Vec::new();
    for repo in sources::list(&paths) {
        let f = sources::fetch(&paths, &client, &repo, refresh).await;
        fetched.push(SourceResult {
            repo,
            mods: f.mods,
            freshness: f.freshness,
            checked: f.checked,
            error: f.error.map(AppError::from),
        });
    }
    let catalog = catalog::build(state.index.as_ref(), status, fetched);
    *app.state::<CatalogState>().0.lock().unwrap() = Some(catalog.clone());
    Ok(catalog)
}

/// The list the page last saw, or the cached one: never waits on the network.
pub async fn current_catalog(app: &AppHandle) -> Result<Catalog, ModsError> {
    let held = app.state::<CatalogState>().0.lock().unwrap().clone();
    match held {
        Some(c) => Ok(c),
        None => load_catalog(app, false).await,
    }
}

/// A catalogue icon as PNG bytes, from the cache or the network.
pub async fn icon_png(app: &AppHandle, url: &str) -> Result<Vec<u8>, ModsError> {
    let known = app
        .state::<CatalogState>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|c| c.mods.iter().any(|m| m.icon.as_deref() == Some(url)));
    if !known || !url.starts_with("https://") {
        return Err(ModsError::NotInCatalog(url.to_string()));
    }
    let cache = Paths::of(app)?.cache_dir().join("mod-icons").join(format!(
        "{}.png",
        &crate::download::sha256_hex(url.as_bytes())[..32]
    ));
    if let Ok(bytes) = std::fs::read(&cache) {
        return Ok(bytes);
    }
    let response = http()?
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(ModsError::Http {
            status: response.status().as_u16(),
            url: url.to_string(),
        });
    }
    let bytes = response.bytes().await?.to_vec();
    if bytes.len() > 512 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(ModsError::TooLarge("icon is not a PNG under 512 KB".into()));
    }
    let _ = write_atomic(&cache, &bytes);
    Ok(bytes)
}

// ---------------------------------------------------------------------------------------------
// Profiles

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

pub async fn build_report(
    app: &AppHandle,
    paths: &Paths,
    tag: &str,
    lock: &Lock,
    catalog: &Catalog,
    network: bool,
) -> ProfileReport {
    let (abi, abi_error) = version_abi(paths, catalog, tag, network).await;
    profile::report(
        tag,
        lock,
        abi,
        abi_error,
        catalog,
        current_platform(),
        unmanaged(app).await,
    )
}

/// The profile after a change that installed nothing.
pub async fn change_result(
    app: &AppHandle,
    paths: &Paths,
    tag: &str,
    lock: &Lock,
    catalog: &Catalog,
) -> ChangeResult {
    ChangeResult {
        report: build_report(app, paths, tag, lock, catalog, false).await,
        installed: Vec::new(),
        also_enabled: Vec::new(),
        also_disabled: Vec::new(),
        missing: Vec::new(),
    }
}

fn emit_progress(app: &AppHandle, sha256: &str, mod_id: &str, stage: ProgressStage, percent: u32) {
    let _ = app.emit(
        crate::ipc::MOD_PROGRESS,
        ModProgress {
            sha256: sha256.to_string(),
            mod_id: mod_id.to_string(),
            stage,
            percent,
        },
    );
}

/// Downloads what `wanted` needs, then writes it into the profile. `held` are reservations the
/// caller already took (a local file admitted into the store).
pub async fn run_install(
    app: &AppHandle,
    paths: &Paths,
    tag: &str,
    catalog: &Catalog,
    abi: &str,
    wanted: Vec<(CatalogMod, CatalogVersion)>,
    mut held: Vec<Reservation>,
) -> Result<ChangeResult, ModsError> {
    let fit = Fit::here(abi);
    let snapshot = store::read_lock(paths, tag)?;
    let res = plan::resolve(catalog, &snapshot, wanted, fit);
    let reservations = reservations(app);
    held.extend(
        res.picks
            .iter()
            .map(|(_, v)| reservations.reserve(&v.sha256)),
    );
    for (m, v) in &res.picks {
        install::fetch_to_store(paths, m, v, fit.platform, |stage, percent| {
            emit_progress(app, &v.sha256, &m.id, stage, percent)
        })
        .await?;
    }
    for (m, v) in &res.picks {
        emit_progress(app, &v.sha256, &m.id, ProgressStage::Installing, 100);
    }

    let _guard = lock_mods(app).await;
    ensure_not_running(app, tag)?;
    let mut lock = store::read_lock(paths, tag)?;
    let done = plan::commit(&mut lock, &res);
    store::write_lock(paths, tag, &lock)?;
    drop(held);
    store::reconcile(paths, tag, &lock)?;
    collect_garbage(app, paths);
    Ok(ChangeResult {
        installed: done.installed,
        also_enabled: done.also_enabled,
        missing: res.missing,
        ..change_result(app, paths, tag, &lock, catalog).await
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_arguments_are_checked() {
        let sha = "AB".repeat(32);
        assert_eq!(check_sha(&sha).unwrap(), "ab".repeat(32));
        for bad in [
            "",
            "abc",
            "../../etc/passwd",
            &"g".repeat(64),
            &"a".repeat(65),
        ] {
            assert!(
                matches!(check_sha(bad), Err(ModsError::InvalidName(_))),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn the_mods_lock_is_held_until_released() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let lock = ModsLock::default();
            let held = lock.acquire().await;
            assert!(lock.0.clone().try_lock_owned().is_err());
            drop(held);
            assert!(lock.0.clone().try_lock_owned().is_ok());
        });
    }
}
