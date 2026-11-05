//! What the mod manager needs from the running app, in one value: its folders, its locks, the
//! catalogue the page last saw, which game runs, the operations under way, and where progress
//! goes. [`Ctx::of`] takes them from Tauri; tests build one on a temporary folder, so the whole
//! service runs without the app.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, OwnedMutexGuard, watch};

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

const RUNNING: u8 = 0;
const COMMITTING: u8 = 1;
const CANCELLED: u8 = 2;

struct OpState {
    phase: AtomicU8,
    cancel: watch::Sender<bool>,
}

/// The operations under way (installs, copies, file installs, restores), by the id the page
/// gave each. [`Operations::cancel`] stops one until it starts writing.
#[derive(Default, Clone)]
pub struct Operations(Arc<std::sync::Mutex<HashMap<String, Arc<OpState>>>>);

impl Operations {
    /// Registers an operation. Its id must be new, and short and plain, like a UUID.
    pub fn begin(&self, id: &str) -> Result<Operation, ModsError> {
        let plain = !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'));
        if !plain {
            return Err(ModsError::InvalidName(format!("operation id {id:?}")));
        }
        let mut map = self.0.lock().unwrap();
        if map.contains_key(id) {
            return Err(ModsError::InvalidName(format!(
                "operation {id} is already under way"
            )));
        }
        let state = Arc::new(OpState {
            phase: AtomicU8::new(RUNNING),
            cancel: watch::Sender::new(false),
        });
        map.insert(id.to_string(), state.clone());
        Ok(Operation {
            id: id.to_string(),
            state,
            owner: self.clone(),
        })
    }

    /// Cancels the operation, unless it has ended or has started writing. Whether it did.
    pub fn cancel(&self, id: &str) -> bool {
        let Some(state) = self.0.lock().unwrap().get(id).cloned() else {
            return false;
        };
        let cancelled = state
            .phase
            .compare_exchange(RUNNING, CANCELLED, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
        if cancelled {
            state.cancel.send_replace(true);
        }
        cancelled
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.0.lock().unwrap().is_empty()
    }
}

/// One operation under way. Dropping it forgets it.
pub struct Operation {
    id: String,
    state: Arc<OpState>,
    owner: Operations,
}

impl Operation {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// `ModCancelled` once the operation was cancelled.
    pub fn check(&self) -> Result<(), ModsError> {
        if self.state.phase.load(Ordering::SeqCst) == CANCELLED {
            Err(ModsError::Cancelled)
        } else {
            Ok(())
        }
    }

    /// Resolves when the operation is cancelled; never otherwise.
    pub async fn cancelled(&self) {
        let mut rx = self.state.cancel.subscribe();
        if rx.wait_for(|c| *c).await.is_err() {
            std::future::pending::<()>().await;
        }
    }

    /// From here on the operation writes, and can't be cancelled; `ModCancelled` if it already
    /// was. The caller holds `ModsLock`.
    pub fn start_writing(&self) -> Result<(), ModsError> {
        self.state
            .phase
            .compare_exchange(RUNNING, COMMITTING, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| ())
            .map_err(|_| ModsError::Cancelled)
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        self.owner.0.lock().unwrap().remove(&self.id);
    }
}

/// One file of an operation, for its progress: "file `index` of `count`".
#[derive(Clone, Copy)]
pub struct Step<'a> {
    pub op: &'a Operation,
    pub index: usize,
    pub count: usize,
    pub sha256: &'a str,
    pub mod_id: &'a str,
}

#[derive(Clone)]
pub struct Ctx {
    pub paths: Paths,
    pub lock: ModsLock,
    pub reservations: Reservations,
    pub catalog: CatalogState,
    pub games: RunningGames,
    pub operations: Operations,
    progress: Progress,
    /// Whether a download's URL must be its build's GitHub release asset. Only tests, whose
    /// downloads come from a local server, turn this off.
    check_urls: bool,
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
            operations: app.state::<Operations>().inner().clone(),
            progress: Arc::new(move |p| crate::ipc::emit_mod_progress(&emitter, &p)),
            check_urls: true,
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
            operations: Operations::default(),
            progress: Arc::new(|_| {}),
            check_urls: true,
        }
    }

    pub fn with_progress(mut self, progress: impl Fn(ModProgress) + Send + Sync + 'static) -> Ctx {
        self.progress = Arc::new(progress);
        self
    }

    /// For tests that download from a local server.
    #[cfg(test)]
    pub fn trusting_any_url(mut self) -> Ctx {
        self.check_urls = false;
        self
    }

    pub fn checks_urls(&self) -> bool {
        self.check_urls
    }

    pub fn emit(&self, step: Step<'_>, stage: ProgressStage, percent: u32) {
        (self.progress)(ModProgress {
            operation_id: step.op.id().to_string(),
            sha256: step.sha256.to_string(),
            mod_id: step.mod_id.to_string(),
            stage,
            percent,
            index: step.index as u32,
            count: step.count as u32,
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

    /// A data folder with game version `tag` installed, downloading from a local server.
    pub fn with_version(root: &std::path::Path, tag: &str) -> Ctx {
        let paths = Paths::new(root);
        let dir = paths.versions_dir().join(tag);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(executable_name()), b"").unwrap();
        Ctx::new(paths).trusting_any_url()
    }

    #[test]
    fn operations_cancel_until_they_write() {
        let ops = Operations::default();
        let a = ops.begin("op-1").unwrap();
        assert!(matches!(ops.begin("op-1"), Err(ModsError::InvalidName(_))));
        for bad in ["", "../x", "a b", &"x".repeat(129)] {
            assert!(ops.begin(bad).is_err(), "{bad:?}");
        }
        assert!(a.check().is_ok());
        assert!(ops.cancel("op-1"));
        assert!(!ops.cancel("op-1"), "once");
        assert!(matches!(a.check(), Err(ModsError::Cancelled)));
        assert!(matches!(a.start_writing(), Err(ModsError::Cancelled)));
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(a.cancelled());

        let b = ops.begin("op-2").unwrap();
        b.start_writing().unwrap();
        assert!(!ops.cancel("op-2"), "too late once it writes");
        assert!(b.check().is_ok());
        drop((a, b));
        assert!(ops.is_empty());
        assert!(!ops.cancel("op-2"), "unknown once it ended");
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
