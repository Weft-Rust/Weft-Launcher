use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::File as StdFile;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use thiserror::Error;
use tokio::fs;
use zip::result::ZipError;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use crate::config::WEFT_REPO;
use crate::error::AppError;
use crate::launch::running_game;

const TEMP_EXTRACT_PREFIX: &str = ".tmp-";
const REMOVING_PREFIX: &str = ".removing-";

#[derive(Debug, Error)]
pub enum InstallError {
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("Zip error: {0}")]
    Zip(#[from] ZipError),
    #[error("Failed to create directory: {0}")]
    CreateDir(String),
    #[error("SHA256 mismatch: expected {expected}, got {actual}")]
    Sha256Mismatch { expected: String, actual: String },
    #[error("SHA256 digest missing in asset")]
    MissingDigest,
    #[error("Required SHA256 not provided")]
    HashMissing,
    #[error("Asset not found for the current platform")]
    AssetNotFound,
    #[error("Version already installed: {0}")]
    AlreadyInstalled(String),
    #[error("Version not installed: {0}")]
    NotInstalled(String),
    #[error("GitHub API rate limit exceeded")]
    RateLimited,
    #[error("GitHub API access denied (403)")]
    Forbidden,
    #[error("Offline and no cache available")]
    OfflineNoCache,
    #[error("Download failed: {0}")]
    DownloadFailed(String),
    #[error("Extraction failed: {0}")]
    ExtractFailed(String),
    #[error("A game is running: {0}")]
    GameRunning(String),
    #[error("Version in use (file locked): {0}")]
    VersionInUse(String),
    #[error("Invalid name: {0}")]
    InvalidName(String),
    #[error("Already installing: {0}")]
    InstallInProgress(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledVersion {
    pub tag: String,
    pub path: String,
    pub executable: String,
    pub installed_at: String,
}

/// Tags that are being installed: two installs of one tag would share their temporary files.
#[derive(Default, Clone)]
pub struct ActiveInstalls(Arc<Mutex<HashSet<String>>>);

struct InstallClaim {
    active: ActiveInstalls,
    tag: String,
}

impl InstallClaim {
    fn new(active: &ActiveInstalls, tag: &str) -> Result<Self, InstallError> {
        if !active.0.lock().unwrap().insert(tag.to_string()) {
            return Err(InstallError::InstallInProgress(tag.to_string()));
        }
        Ok(Self {
            active: active.clone(),
            tag: tag.to_string(),
        })
    }
}

impl Drop for InstallClaim {
    fn drop(&mut self) {
        self.active.0.lock().unwrap().remove(&self.tag);
    }
}

/// Tags and asset names become folder and file names, so they must stay one path component.
/// A leading dot is also how the launcher marks its own temporary folders.
pub fn validate_name(name: &str) -> Result<(), InstallError> {
    let bad = name.is_empty() || name.starts_with('.') || name.contains(['/', '\\', ':', '\0']);
    if bad {
        return Err(InstallError::InvalidName(name.to_string()));
    }
    Ok(())
}

fn get_versions_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, InstallError> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| InstallError::Io(std::io::Error::other(e)))?;
    Ok(app_data.join("versions"))
}

fn get_downloads_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, InstallError> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| InstallError::Io(std::io::Error::other(e)))?;
    Ok(app_data.join("downloads"))
}

fn executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "weft.exe"
    } else {
        "weft"
    }
}

fn temp_extract_dir(versions_dir: &Path, tag: &str) -> PathBuf {
    versions_dir.join(format!("{TEMP_EXTRACT_PREFIX}{tag}"))
}

async fn cleanup_temp(temp_download: &Path, temp_extract: &Path) {
    fs::remove_file(temp_download).await.ok();
    fs::remove_dir_all(temp_extract).await.ok();
}

/// Removes what an interrupted install or delete left behind. Only for startup, when nothing of
/// the kind can be running.
pub fn sweep_leftovers(app_handle: &tauri::AppHandle) {
    if let Ok(dir) = get_versions_dir(app_handle)
        && let Ok(entries) = std::fs::read_dir(dir)
    {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(TEMP_EXTRACT_PREFIX) || name.starts_with(REMOVING_PREFIX) {
                std::fs::remove_dir_all(entry.path()).ok();
            }
        }
    }
    if let Ok(dir) = get_downloads_dir(app_handle)
        && let Ok(entries) = std::fs::read_dir(dir)
    {
        for entry in entries.flatten() {
            std::fs::remove_file(entry.path()).ok();
        }
    }
}

#[tauri::command]
pub async fn install_version(
    app_handle: tauri::AppHandle,
    tag: String,
    asset_url: String,
    asset_name: String,
    expected_sha256: Option<String>,
) -> Result<InstalledVersion, AppError> {
    validate_name(&tag)?;
    validate_name(&asset_name)?;
    let expected_sha256 = expected_sha256
        .filter(|s| !s.is_empty())
        .ok_or(InstallError::HashMissing)?;
    let allowed = format!("https://github.com/{WEFT_REPO}/releases/download/");
    if !asset_url.starts_with(&allowed) {
        return Err(InstallError::DownloadFailed(format!("unexpected URL: {asset_url}")).into());
    }

    let active = app_handle.state::<ActiveInstalls>().inner().clone();
    let _claim = InstallClaim::new(&active, &tag)?;

    let versions_dir = get_versions_dir(&app_handle)?;
    let downloads_dir = get_downloads_dir(&app_handle)?;
    fs::create_dir_all(&versions_dir).await?;
    fs::create_dir_all(&downloads_dir).await?;

    let temp_download = downloads_dir.join(format!("{asset_name}.tmp"));
    let temp_extract = temp_extract_dir(&versions_dir, &tag);

    let result = download_and_install(
        &app_handle,
        &tag,
        &asset_url,
        &asset_name,
        &expected_sha256,
        &versions_dir,
        &temp_download,
    )
    .await;
    // After a success the extract folder has already become the version.
    cleanup_temp(&temp_download, &temp_extract).await;
    result
}

async fn download_and_install(
    app_handle: &tauri::AppHandle,
    tag: &str,
    asset_url: &str,
    asset_name: &str,
    expected_sha256: &str,
    versions_dir: &Path,
    temp_download: &Path,
) -> Result<InstalledVersion, AppError> {
    let version_dir = versions_dir.join(tag);
    let executable_path = version_dir.join(executable_name());
    let temp_extract = temp_extract_dir(versions_dir, tag);

    // Check if already properly installed (directory exists AND executable exists)
    if executable_path.exists() {
        return Err(InstallError::AlreadyInstalled(tag.to_string()).into());
    }

    // Directory exists but executable is missing -> remove stale directory and reinstall
    if version_dir.exists() {
        fs::remove_dir_all(&version_dir).await?;
    }

    let client = crate::download::client()?;
    let tag_owned = tag.to_string();
    let downloaded = crate::download::to_file(&client, asset_url, temp_download, None, |p| {
        let _ = app_handle.emit(
            "install-progress",
            serde_json::json!({
                "tag": tag_owned,
                "downloaded": p.downloaded,
                "total": p.total,
                "percent": p.percent,
                "stage": "downloading",
                "speedMbps": p.speed_mbps
            }),
        );
    })
    .await
    .map_err(|e| InstallError::DownloadFailed(e.to_string()))?;
    let total_size = downloaded.bytes;

    let _ = app_handle.emit(
        "install-progress",
        serde_json::json!({
            "tag": tag,
            "downloaded": downloaded.bytes,
            "total": total_size,
            "percent": 100,
            "stage": "verifying",
            "speedMbps": 0.0
        }),
    );

    // Hashed while it downloaded.
    if !downloaded.sha256.eq_ignore_ascii_case(expected_sha256) {
        return Err(InstallError::Sha256Mismatch {
            expected: expected_sha256.to_string(),
            actual: downloaded.sha256,
        }
        .into());
    }
    let downloaded = downloaded.bytes;

    // Extract to temp directory
    let _ = app_handle.emit(
        "install-progress",
        serde_json::json!({
            "tag": tag,
            "downloaded": downloaded,
            "total": total_size,
            "percent": 100,
            "stage": "extracting",
            "speedMbps": 0.0
        }),
    );

    if temp_extract.exists() {
        fs::remove_dir_all(&temp_extract).await?;
    }
    fs::create_dir_all(&temp_extract).await?;

    // Extract based on file extension
    if asset_name.ends_with(".zip") {
        extract_zip(temp_download.to_path_buf(), temp_extract.clone()).await?;
    } else if asset_name.ends_with(".tar.gz") || asset_name.ends_with(".tgz") {
        extract_tar_gz(temp_download.to_path_buf(), temp_extract.clone()).await?;
    } else {
        return Err(InstallError::ExtractFailed("unsupported archive format".to_string()).into());
    }

    // Normalize structure (handle top-level folder)
    normalize_install_structure(&temp_extract).await?;

    // Verify executable exists in temp directory before finalizing
    let temp_executable = temp_extract.join(executable_name());
    if !temp_executable.exists() {
        // List first 10 items in temp directory for diagnostics
        let mut items = Vec::new();
        if let Ok(mut entries) = fs::read_dir(&temp_extract).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                items.push(entry.file_name().to_string_lossy().to_string());
                if items.len() >= 10 {
                    break;
                }
            }
        }
        let items_str = if items.is_empty() {
            " (empty folder)".to_string()
        } else {
            format!(" (first items: {})", items.join(", "))
        };
        return Err(InstallError::ExtractFailed(format!(
            "executable not found after extraction{items_str}"
        ))
        .into());
    }

    // On Unix, set executable permission on the binary before finalizing
    #[cfg(unix)]
    {
        let mut perms = fs::metadata(&temp_executable).await?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&temp_executable, perms)
            .await
            .map_err(|e| {
                InstallError::ExtractFailed(format!("failed to set execute permission: {e}"))
            })?;
    }

    // Finalizing
    let _ = app_handle.emit(
        "install-progress",
        serde_json::json!({
            "tag": tag,
            "downloaded": downloaded,
            "total": total_size,
            "percent": 100,
            "stage": "finalizing",
            "speedMbps": 0.0
        }),
    );

    // Atomic rename
    if version_dir.exists() {
        fs::remove_dir_all(&version_dir).await?;
    }
    fs::rename(&temp_extract, &version_dir).await?;

    let now = time::OffsetDateTime::now_utc();
    let installed_at = now
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();

    Ok(InstalledVersion {
        tag: tag.to_string(),
        path: version_dir.to_string_lossy().to_string(),
        executable: executable_path.to_string_lossy().to_string(),
        installed_at,
    })
}

async fn extract_zip(zip_path: PathBuf, dest: PathBuf) -> Result<(), InstallError> {
    // Run extraction in blocking task to avoid Send issues with zip crate types
    tokio::task::spawn_blocking(move || -> Result<(), InstallError> {
        let file = StdFile::open(&zip_path)?;
        let mut archive = zip::ZipArchive::new(file)?;

        let mut extracted_count = 0;

        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;

            // Use enclosed_name() which returns None if path tries to escape
            let Some(entry_path) = entry.enclosed_name() else {
                return Err(InstallError::ExtractFailed(
                    "unsafe entry in archive (zip-slip)".to_string(),
                ));
            };

            // Reject absolute paths, Windows prefixes, and parent directory components
            if entry_path.components().any(|c| {
                matches!(
                    c,
                    Component::RootDir | Component::Prefix(_) | Component::ParentDir
                )
            }) {
                return Err(InstallError::ExtractFailed(
                    "unsafe entry in archive".to_string(),
                ));
            }

            let target_path = dest.join(entry_path);

            if entry.is_dir() {
                std::fs::create_dir_all(&target_path)?;
            } else {
                if let Some(parent) = target_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut outfile = StdFile::create(&target_path)?;
                std::io::copy(&mut entry, &mut outfile)?;
            }
            extracted_count += 1;
        }

        if extracted_count == 0 {
            return Err(InstallError::ExtractFailed(
                "nothing extracted (empty archive)".to_string(),
            ));
        }

        Ok(())
    })
    .await
    .map_err(|e| InstallError::ExtractFailed(e.to_string()))?
}

async fn extract_tar_gz(tar_gz_path: PathBuf, dest: PathBuf) -> Result<(), InstallError> {
    // Run extraction in blocking task to avoid Send issues with tar crate types
    tokio::task::spawn_blocking(move || -> Result<(), InstallError> {
        let file = StdFile::open(&tar_gz_path)?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);

        let mut extracted_count = 0;

        // Entries share one stream, so each has to be unpacked before asking for the next.
        for entry in archive.entries()? {
            let mut entry = entry?;

            // Path traversal protection: reject .. components, absolute paths, and Windows prefixes
            let unsafe_path = entry
                .path()?
                .components()
                .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir));
            if unsafe_path {
                return Err(InstallError::ExtractFailed(
                    "unsafe entry in archive".to_string(),
                ));
            }

            // unpack_in also refuses to write through a symlink that leaves `dest`. It returns
            // false for a path with nothing to create, like "./".
            if entry.unpack_in(&dest)? {
                extracted_count += 1;
            }
        }

        if extracted_count == 0 {
            return Err(InstallError::ExtractFailed(
                "nothing extracted (empty archive)".to_string(),
            ));
        }

        Ok(())
    })
    .await
    .map_err(|e| InstallError::ExtractFailed(e.to_string()))?
}

async fn normalize_install_structure(extract_dir: &Path) -> Result<(), InstallError> {
    // Check if there's a single top-level folder
    let mut entries = fs::read_dir(extract_dir).await?;
    let mut first_entry = None;
    let mut entry_count = 0;

    while let Some(entry) = entries.next_entry().await? {
        entry_count += 1;
        if first_entry.is_none() {
            first_entry = Some(entry.path());
        }
    }

    // If there's exactly one folder at root, move its contents up
    if entry_count == 1
        && let Some(single_dir) = first_entry
        && single_dir.is_dir()
    {
        // Moved aside first: where names ignore case, `Weft/weft` would land on its own parent.
        let staging = extract_dir.join(".unpacked");
        fs::rename(&single_dir, &staging).await?;
        let mut entries = fs::read_dir(&staging).await?;
        while let Some(entry) = entries.next_entry().await? {
            let target = extract_dir.join(entry.file_name());
            fs::rename(entry.path(), target).await?;
        }
        fs::remove_dir(staging).await?;
    }

    Ok(())
}

#[tauri::command]
pub async fn get_installed_versions(
    app_handle: tauri::AppHandle,
) -> Result<Vec<InstalledVersion>, AppError> {
    let versions_dir = get_versions_dir(&app_handle)?;

    if !versions_dir.exists() {
        return Ok(Vec::new());
    }

    let mut versions = Vec::new();
    let mut entries = fs::read_dir(&versions_dir).await?;

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let tag = entry.file_name().to_string_lossy().to_string();
        // The launcher's own temporary folders can hold an executable too.
        if tag.starts_with('.') {
            continue;
        }
        let executable = path.join(executable_name());

        if executable.exists() {
            let metadata = fs::metadata(&path).await?;
            let installed_at = metadata
                .created()
                .or_else(|_| metadata.modified())
                .ok()
                .and_then(|t| {
                    time::OffsetDateTime::from_unix_timestamp(
                        t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64,
                    )
                    .ok()
                })
                .and_then(|dt| {
                    dt.format(&time::format_description::well_known::Rfc3339)
                        .ok()
                })
                .unwrap_or_default();

            versions.push(InstalledVersion {
                tag,
                path: path.to_string_lossy().to_string(),
                executable: executable.to_string_lossy().to_string(),
                installed_at,
            });
        }
    }

    versions.sort_by(|a, b| b.installed_at.cmp(&a.installed_at));
    Ok(versions)
}

#[tauri::command]
pub async fn remove_version(app_handle: tauri::AppHandle, tag: String) -> Result<(), AppError> {
    validate_name(&tag)?;
    let versions_dir = get_versions_dir(&app_handle)?;
    let version_dir = versions_dir.join(&tag);

    if !version_dir.exists() {
        return Err(InstallError::NotInstalled(tag).into());
    }

    // Nothing is deleted while any game is running
    if let Some(running) = running_game(&app_handle) {
        return Err(InstallError::GameRunning(running).into());
    }

    // Try to rename the folder first (atomic on Windows, fails if file in use)
    let removing_dir = versions_dir.join(format!("{REMOVING_PREFIX}{tag}"));
    // A delete that failed halfway would otherwise block this rename for good.
    fs::remove_dir_all(&removing_dir).await.ok();
    match fs::rename(&version_dir, &removing_dir).await {
        Ok(_) => {
            // Rename succeeded, now delete the renamed folder
            fs::remove_dir_all(&removing_dir).await?;
            crate::mods::profile::forget_version(&app_handle, &tag);
            Ok(())
        }
        Err(e) => {
            // Rename failed - likely file in use on Windows
            // Check if it's a "file in use" type error
            if e.kind() == std::io::ErrorKind::PermissionDenied
                || e.raw_os_error() == Some(32) // ERROR_SHARING_VIOLATION on Windows
                || e.raw_os_error() == Some(26)
            // ETXTBSY on Unix
            {
                Err(InstallError::VersionInUse(tag).into())
            } else {
                Err(e.into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("weft-launcher-test-{name}-{}", std::process::id()));
            std::fs::remove_dir_all(&dir).ok();
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    fn append(builder: &mut tar::Builder<impl std::io::Write>, path: &str, body: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder.append_data(&mut header, path, body).unwrap();
    }

    // The layout of a real release: everything in `Weft/`, with the executable named `weft`.
    #[test]
    fn tar_release_installs_with_its_contents() {
        let temp = TempDir::new("tar");
        let archive = temp.0.join("game.tar.gz");
        let gz = flate2::write::GzEncoder::new(
            StdFile::create(&archive).unwrap(),
            flate2::Compression::fast(),
        );
        let mut builder = tar::Builder::new(gz);
        append(&mut builder, "Weft/weft", b"the game");
        append(&mut builder, "Weft/assets/core/icon.png", b"an icon");
        builder.into_inner().unwrap().finish().unwrap();

        let dest = temp.0.join("out");
        std::fs::create_dir_all(&dest).unwrap();
        tauri::async_runtime::block_on(async {
            extract_tar_gz(archive, dest.clone()).await.unwrap();
            normalize_install_structure(&dest).await.unwrap();
        });

        assert_eq!(std::fs::read(dest.join("weft")).unwrap(), b"the game");
        assert_eq!(
            std::fs::read(dest.join("assets/core/icon.png")).unwrap(),
            b"an icon"
        );
    }

    #[test]
    fn names_stay_one_path_component() {
        for bad in ["", "..", ".tmp-v1", "a/b", "a\\b", "C:", "../v1"] {
            assert!(validate_name(bad).is_err(), "{bad:?} should be refused");
        }
        assert!(validate_name("v26.10.4").is_ok());
    }
}
