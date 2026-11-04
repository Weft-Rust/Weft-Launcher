//! Where the mod manager keeps its files, all under the launcher's own data folder:
//!
//! ```text
//! mods/store/<sha256>.zip              every mod file, verified once, named by its hash
//! mods/sources.json                    GitHub repos the player added as sources
//! profiles/<tag>/mods/<id>.zip         the turned-on mods of one game version, handed to `--mods`
//! profiles/<tag>/mods.lock.json        everything installed for that version
//! cache/mod-index/<n>/index.json(.minisig)   verified index generations; `current` names one
//! cache/mod-sources/<owner__repo>.json  the last good answer of each source
//! cache/abi.json                       the mod interface hash of each Weft tag
//! downloads/mod-<sha256>-<unique>.part a download in progress
//! ```
//!
//! Everything takes a [`Paths`], so tests can point it at a temporary folder.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};

use super::error::ModsError;
use crate::install::validate_name;

#[derive(Debug, Clone)]
pub struct Paths {
    root: PathBuf,
}

impl Paths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Paths { root: root.into() }
    }

    /// The launcher's data folder.
    pub fn of(app: &AppHandle) -> Result<Self, ModsError> {
        app.path()
            .app_data_dir()
            .map(Paths::new)
            .map_err(|e| ModsError::Io(std::io::Error::other(e)))
    }

    pub fn store_dir(&self) -> PathBuf {
        self.root.join("mods").join("store")
    }

    pub fn store_object(&self, sha256: &str) -> PathBuf {
        self.store_dir().join(format!("{sha256}.zip"))
    }

    pub fn sources_file(&self) -> PathBuf {
        self.root.join("mods").join("sources.json")
    }

    pub fn profiles_dir(&self) -> PathBuf {
        self.root.join("profiles")
    }

    pub fn profile_dir(&self, tag: &str) -> Result<PathBuf, ModsError> {
        validate_name(tag).map_err(|_| ModsError::InvalidName(tag.to_string()))?;
        Ok(self.profiles_dir().join(tag))
    }

    pub fn lock_file(&self, tag: &str) -> Result<PathBuf, ModsError> {
        Ok(self.profile_dir(tag)?.join(LOCK_FILE))
    }

    pub fn mods_dir(&self, tag: &str) -> Result<PathBuf, ModsError> {
        Ok(self.profile_dir(tag)?.join("mods"))
    }

    pub fn cache_dir(&self) -> PathBuf {
        self.root.join("cache")
    }

    pub fn downloads_dir(&self) -> PathBuf {
        self.root.join("downloads")
    }

    pub fn versions_dir(&self) -> PathBuf {
        self.root.join("versions")
    }
}

pub const LOCK_FILE: &str = "mods.lock.json";

/// A name no other download or write in this process uses, so two of them never share a file.
pub fn unique_suffix() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{}-{n}-{nanos:08x}", std::process::id())
}

/// Writes through a temporary file, so a crash never leaves half a file behind.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), ModsError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", unique_suffix()));
    let result = (|| {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(result?)
}
