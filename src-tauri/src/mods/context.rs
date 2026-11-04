//! What the mod manager needs from the running app, in one value: its folders, its locks, the
//! catalogue the page last saw, which game runs, and where progress goes. [`Ctx::of`] takes them
//! from Tauri; tests build one on a temporary folder, so the whole service runs without the app.

use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex, OwnedMutexGuard};

use super::catalog::{Catalog, CatalogState};
use super::error::ModsError;
use super::index::is_sha256;
use super::install::{ModProgress, ProgressStage};
use super::paths::Paths;
use super::store::{self, Reservations};
use crate::launch::RunningGames;

/// Held while a profile or the store changes, and by a launch from its last check until the
/// game counts as running.
#[derive(Default, Clone)]
pub struct ModsLock(Arc<Mutex<()>>);

impl ModsLock {
    pub async fn acquire(&self) -> OwnedMutexGuard<()> {
        self.0.clone().lock_owned().await
    }

    #[cfg(test)]
    pub fn is_held(&self) -> bool {
        self.0.clone().try_lock_owned().is_err()
    }
}

type Progress = Arc<dyn Fn(ModProgress) + Send + Sync>;

#[derive(Clone)]
pub struct Ctx {
    pub paths: Paths,
    pub lock: ModsLock,
    pub reservations: Reservations,
    pub catalog: CatalogState,
    pub games: RunningGames,
    progress: Progress,
}

impl Ctx {
    pub fn of(app: &AppHandle) -> Result<Ctx, ModsError> {
        let emitter = app.clone();
        Ok(Ctx {
            paths: Paths::of(app)?,
            lock: app.state::<ModsLock>().inner().clone(),
            reservations: app.state::<Reservations>().inner().clone(),
            catalog: app.state::<CatalogState>().inner().clone(),
            games: app.state::<RunningGames>().inner().clone(),
            progress: Arc::new(move |p| {
                let _ = emitter.emit(crate::ipc::MOD_PROGRESS, p);
            }),
        })
    }

    /// A context of its own on `paths`: nothing running, nothing held, progress dropped.
    pub fn new(paths: Paths) -> Ctx {
        Ctx {
            paths,
            lock: ModsLock::default(),
            reservations: Reservations::default(),
            catalog: CatalogState::default(),
            games: RunningGames::default(),
            progress: Arc::new(|_| {}),
        }
    }

    pub fn with_progress(mut self, progress: impl Fn(ModProgress) + Send + Sync + 'static) -> Ctx {
        self.progress = Arc::new(progress);
        self
    }

    pub fn emit(&self, sha256: &str, mod_id: &str, stage: ProgressStage, percent: u32) {
        (self.progress)(ModProgress {
            sha256: sha256.to_string(),
            mod_id: mod_id.to_string(),
            stage,
            percent,
        });
    }

    pub async fn lock_mods(&self) -> OwnedMutexGuard<()> {
        self.lock.acquire().await
    }

    pub fn is_running(&self, tag: &str) -> bool {
        self.games.current().is_some_and(|r| r == tag)
    }

    /// The running game read its mods at start; changing them under it would only confuse.
    pub fn ensure_not_running(&self, tag: &str) -> Result<(), ModsError> {
        match self.games.current() {
            Some(running) if running == tag => Err(ModsError::GameRunning(running)),
            _ => Ok(()),
        }
    }

    /// The catalogue the page last loaded, if it loaded one.
    pub fn held_catalog(&self) -> Option<Catalog> {
        self.catalog.0.lock().unwrap().clone()
    }

    pub fn hold_catalog(&self, catalog: Catalog) {
        *self.catalog.0.lock().unwrap() = Some(catalog);
    }

    /// Deletes store files nothing uses. The caller holds `ModsLock`.
    pub async fn collect_garbage(&self) {
        let (paths, reservations) = (self.paths.clone(), self.reservations.clone());
        let result = blocking(move || store::collect_garbage(&paths, &reservations)).await;
        if let Err(e) = result {
            eprintln!("mods: garbage collection skipped: {e}");
        }
    }
}

/// Runs disk work that may take long (hashing and copying files of up to 512 MB) off the async
/// runtime.
pub async fn blocking<T, F>(f: F) -> Result<T, ModsError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ModsError> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ModsError::Io(std::io::Error::other(e)))?
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A data folder with game version `tag` installed.
    pub fn with_version(root: &std::path::Path, tag: &str) -> Ctx {
        let paths = Paths::new(root);
        let dir = paths.versions_dir().join(tag);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(executable_name()), b"").unwrap();
        Ctx::new(paths)
    }

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
            assert!(lock.is_held());
            drop(held);
            assert!(!lock.is_held());
        });
    }

    #[test]
    fn versions_and_running_games() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = with_version(tmp.path(), "v1");
        assert!(ensure_installed(&ctx.paths, "v1").is_ok());
        assert!(matches!(
            ensure_installed(&ctx.paths, "v2"),
            Err(ModsError::VersionNotInstalled(_))
        ));
        assert!(ensure_installed(&ctx.paths, "../v1").is_err());
        ctx.games.insert("v1");
        assert!(ctx.is_running("v1") && !ctx.is_running("v2"));
        assert!(matches!(
            ctx.ensure_not_running("v1"),
            Err(ModsError::GameRunning(_))
        ));
    }
}
