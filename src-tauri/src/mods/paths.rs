//! Where the mod manager keeps its files, all under the launcher's own data folder:
//!
//! ```text
//! mods/store/<sha256>.zip         every mod file, verified once, named by its hash
//! mods/sources.json               GitHub repos the player added as sources
//! profiles/<tag>/mods/<id>.zip    the turned-on mods of one game version, handed to `--mods`
//! profiles/<tag>/mods.lock.json   everything installed for that version
//! cache/mod-index.json(.minisig)  the last index whose signature verified
//! ```

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use super::error::ModsError;
use crate::install::validate_name;

fn app_data(app: &AppHandle) -> Result<PathBuf, ModsError> {
    app.path()
        .app_data_dir()
        .map_err(|e| ModsError::Io(std::io::Error::other(e)))
}

pub fn store_dir(app: &AppHandle) -> Result<PathBuf, ModsError> {
    Ok(app_data(app)?.join("mods").join("store"))
}

pub fn sources_file(app: &AppHandle) -> Result<PathBuf, ModsError> {
    Ok(app_data(app)?.join("mods").join("sources.json"))
}

pub fn profiles_dir(app: &AppHandle) -> Result<PathBuf, ModsError> {
    Ok(app_data(app)?.join("profiles"))
}

pub fn profile_dir(app: &AppHandle, tag: &str) -> Result<PathBuf, ModsError> {
    validate_name(tag).map_err(|_| ModsError::InvalidName(tag.to_string()))?;
    Ok(profiles_dir(app)?.join(tag))
}

pub fn cache_dir(app: &AppHandle) -> Result<PathBuf, ModsError> {
    Ok(app_data(app)?.join("cache"))
}

pub fn downloads_dir(app: &AppHandle) -> Result<PathBuf, ModsError> {
    Ok(app_data(app)?.join("downloads"))
}

pub fn versions_dir(app: &AppHandle) -> Result<PathBuf, ModsError> {
    Ok(app_data(app)?.join("versions"))
}

/// Writes through a temporary file, so a crash never leaves half a file behind.
pub fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<(), ModsError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}
