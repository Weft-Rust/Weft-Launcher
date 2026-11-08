//! Mods of each installed version: zips in `versions/<tag>/launcher-mods`, passed to the game
//! with `--mods`, and those turned off listed in `launcher-mods/off.txt`, passed with `--off`.
//! The game does the rest: what needs a mod that is off or missing doesn't load.
//!
//! The index (Weft-Mods-Index, built there from each mod's source) lists mods and their builds. A
//! build marked `verified` had its source read by a maintainer; an installed zip is verified when
//! its SHA-256 is such a build's.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::error::AppError;

const INDEX_URL: &str =
    "https://raw.githubusercontent.com/Weft-Rust/Weft-Mods-Index/gh-pages/index.json";
const USER_AGENT: &str = concat!("weft-launcher/", env!("CARGO_PKG_VERSION"));

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Index {
    pub mods: Vec<IndexMod>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct IndexMod {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub author: String,
    /// Where its source is.
    #[serde(default)]
    pub source: String,
    /// Newest first.
    pub builds: Vec<Build>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Build {
    pub version: String,
    /// The `mod-abi.txt` of the game versions it loads in.
    pub abi: String,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub deps: Vec<String>,
    #[serde(default)]
    pub verified: bool,
    /// The Weft release it was built for.
    #[serde(default)]
    pub weft: String,
    /// Built again for a newer Weft from the code submitted for an older one.
    #[serde(default)]
    pub auto: bool,
}

#[derive(Serialize)]
pub struct Installed {
    id: String,
    /// From the index, if the zip is one of its builds.
    name: Option<String>,
    version: Option<String>,
    verified: bool,
    on: bool,
}

#[derive(Serialize)]
pub struct ModList {
    /// `None`: the version is older than mods in the launcher.
    abi: Option<String>,
    mods: Vec<Installed>,
}

fn err(code: &'static str, detail: impl ToString) -> AppError {
    AppError::new(code, Some(detail.to_string()))
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path().app_data_dir().map_err(|e| err("Io", e))
}

fn version_dir(app: &AppHandle, tag: &str) -> Result<PathBuf, AppError> {
    crate::install::validate_name(tag)?;
    Ok(data_dir(app)?.join("versions").join(tag))
}

fn mods_dir(version: &Path) -> PathBuf {
    version.join("launcher-mods")
}

/// Mod ids name their zip and library: `[a-z0-9_]`.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn read_off(version: &Path) -> Vec<String> {
    std::fs::read_to_string(mods_dir(version).join("off.txt"))
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

fn write_off(version: &Path, off: &[String]) -> Result<(), AppError> {
    std::fs::create_dir_all(mods_dir(version))?;
    std::fs::write(mods_dir(version).join("off.txt"), off.join("\n"))?;
    Ok(())
}

/// The ids of the zips there.
fn zips(version: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(mods_dir(version)) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")))
        .filter_map(|p| Some(p.file_stem()?.to_string_lossy().into_owned()))
        .collect();
    ids.sort();
    ids
}

fn sha256_of(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(format!("{:x}", Sha256::digest(&bytes)))
}

/// Changes only while the version isn't running: the game has the zips open.
fn not_running(app: &AppHandle, tag: &str) -> Result<(), AppError> {
    match crate::launch::running_game(app) {
        Some(running) if running == tag => Err(err("GameRunning", running)),
        _ => Ok(()),
    }
}

/// What to add to the game's command line for this version's mods.
pub fn launch_args(version: &Path) -> Vec<std::ffi::OsString> {
    let dir = mods_dir(version);
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut args = vec!["--mods".into(), dir.into_os_string()];
    let off = read_off(version);
    if !off.is_empty() {
        args.extend(["--off".into(), off.join(",").into()]);
    }
    args
}

fn client() -> Result<reqwest::Client, AppError> {
    Ok(reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(60))
        .user_agent(USER_AGENT)
        .build()?)
}

/// The index, from the network or else the last copy that came.
async fn index(app: &AppHandle, refresh: bool) -> Result<Index, AppError> {
    let cache = data_dir(app)?.join("cache").join("mod-index.json");
    let cached = || -> Option<Index> { serde_json::from_slice(&std::fs::read(&cache).ok()?).ok() };
    if !refresh && let Some(i) = cached() {
        return Ok(i);
    }
    let fetched = async {
        let bytes = client()?
            .get(INDEX_URL)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        let index: Index = serde_json::from_slice(&bytes).map_err(|e| err("Serde", e))?;
        Ok::<_, AppError>((index, bytes))
    }
    .await;
    match fetched {
        Ok((index, bytes)) => {
            if let Some(dir) = cache.parent() {
                std::fs::create_dir_all(dir).ok();
            }
            std::fs::write(&cache, &bytes).ok();
            Ok(index)
        }
        Err(e) => cached().ok_or(e),
    }
}

#[tauri::command]
pub async fn mods_index(app: AppHandle, refresh: bool) -> Result<Index, AppError> {
    index(&app, refresh).await
}

#[tauri::command]
pub async fn mods_list(app: AppHandle, tag: String) -> Result<ModList, AppError> {
    let version = version_dir(&app, &tag)?;
    let abi = std::fs::read_to_string(version.join("mod-abi.txt"))
        .ok()
        .map(|s| s.trim().to_string());
    let index = index(&app, false).await.unwrap_or_default();
    let off = read_off(&version);
    let mods = zips(&version)
        .into_iter()
        .map(|id| {
            let sha = sha256_of(&mods_dir(&version).join(format!("{id}.zip")));
            let found = index.mods.iter().find_map(|m| {
                let b = m
                    .builds
                    .iter()
                    .find(|b| sha.as_deref() == Some(b.sha256.as_str()))?;
                Some((m, b))
            });
            Installed {
                name: found.map(|(m, _)| m.name.clone()),
                version: found.map(|(_, b)| b.version.clone()),
                verified: found.is_some_and(|(_, b)| b.verified),
                on: !off.contains(&id),
                id,
            }
        })
        .collect();
    Ok(ModList { abi, mods })
}

/// Installs the newest build of `id` for the version, and what it needs that isn't there.
#[tauri::command]
pub async fn mods_install(app: AppHandle, tag: String, id: String) -> Result<(), AppError> {
    not_running(&app, &tag)?;
    let version = version_dir(&app, &tag)?;
    let abi = std::fs::read_to_string(version.join("mod-abi.txt"))
        .map_err(|_| err("ModsUnsupported", &tag))?
        .trim()
        .to_string();
    let index = index(&app, false).await?;
    let installed = zips(&version);
    let mut todo = vec![id];
    let mut done: Vec<String> = Vec::new();
    while let Some(id) = todo.pop() {
        // The one asked for is installed again (an update), what it needs only if missing.
        if done.contains(&id) || (installed.contains(&id) && !done.is_empty()) {
            continue;
        }
        // What ships with the game isn't in the index.
        let Some(m) = index.mods.iter().find(|m| m.id == id) else {
            continue;
        };
        let build = m
            .builds
            .iter()
            .find(|b| b.abi == abi)
            .ok_or_else(|| err("NoBuild", &m.name))?;
        if !valid_id(&m.id) {
            return Err(err("InvalidName", &m.id));
        }
        download(
            &build.url,
            &build.sha256,
            &mods_dir(&version).join(format!("{}.zip", m.id)),
        )
        .await?;
        todo.extend(build.deps.iter().cloned());
        done.push(id);
    }
    Ok(())
}

async fn download(url: &str, sha256: &str, to: &Path) -> Result<(), AppError> {
    let bytes = client()?
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if !actual.eq_ignore_ascii_case(sha256) {
        return Err(err(
            "Sha256Mismatch",
            format!("expected {sha256}, got {actual}"),
        ));
    }
    std::fs::create_dir_all(to.parent().unwrap_or(to))?;
    let part = to.with_extension("part");
    std::fs::write(&part, &bytes)?;
    std::fs::rename(&part, to)?;
    Ok(())
}

#[tauri::command]
pub async fn mods_set_on(
    app: AppHandle,
    tag: String,
    id: String,
    on: bool,
) -> Result<(), AppError> {
    not_running(&app, &tag)?;
    let version = version_dir(&app, &tag)?;
    let mut off = read_off(&version);
    off.retain(|o| *o != id);
    if !on {
        off.push(id);
        off.sort();
    }
    write_off(&version, &off)
}

#[tauri::command]
pub async fn mods_remove(app: AppHandle, tag: String, id: String) -> Result<(), AppError> {
    not_running(&app, &tag)?;
    if !valid_id(&id) {
        return Err(err("InvalidName", &id));
    }
    let version = version_dir(&app, &tag)?;
    std::fs::remove_file(mods_dir(&version).join(format!("{id}.zip")))?;
    let mut off = read_off(&version);
    off.retain(|o| *o != id);
    write_off(&version, &off)
}

/// What a zip from the player's computer is: its mod id (the game names a mod after its library,
/// so the file may be called anything), and whether the index has it as a verified build.
#[derive(Serialize)]
pub struct FileMod {
    id: String,
    name: Option<String>,
    version: Option<String>,
    verified: bool,
}

fn inspect(app: &AppHandle, path: &Path) -> Result<FileMod, AppError> {
    let file = std::fs::File::open(path)?;
    let zip = zip::ZipArchive::new(file).map_err(|e| err("NotAMod", e))?;
    let id = zip
        .file_names()
        .filter(|n| !n.contains('/'))
        .find_map(|n| {
            let unix = n.strip_suffix(".so").or_else(|| n.strip_suffix(".dylib"));
            unix.and_then(|n| n.strip_prefix("lib"))
                .or_else(|| n.strip_suffix(".dll"))
                .map(str::to_string)
        })
        .filter(|id| valid_id(id))
        .ok_or_else(|| err("NotAMod", path.display()))?;
    let sha = sha256_of(path);
    let cache = data_dir(app)?.join("cache").join("mod-index.json");
    let index: Index = std::fs::read(cache)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let found = index.mods.iter().find_map(|m| {
        let b = m
            .builds
            .iter()
            .find(|b| sha.as_deref() == Some(b.sha256.as_str()))?;
        Some((m, b))
    });
    Ok(FileMod {
        id,
        name: found.map(|(m, _)| m.name.clone()),
        version: found.map(|(_, b)| b.version.clone()),
        verified: found.is_some_and(|(_, b)| b.verified),
    })
}

#[tauri::command]
pub async fn mods_inspect_file(app: AppHandle, path: String) -> Result<FileMod, AppError> {
    inspect(&app, Path::new(&path))
}

#[tauri::command]
pub async fn mods_install_file(app: AppHandle, tag: String, path: String) -> Result<(), AppError> {
    not_running(&app, &tag)?;
    let id = inspect(&app, Path::new(&path))?.id;
    let to = mods_dir(&version_dir(&app, &tag)?).join(format!("{id}.zip"));
    std::fs::create_dir_all(to.parent().unwrap_or(&to))?;
    std::fs::copy(&path, &to)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mods_off_go_to_the_game() {
        let version = std::env::temp_dir().join(format!("weft-mods-{}", std::process::id()));
        assert!(
            launch_args(&version).is_empty(),
            "no folder, nothing to pass"
        );
        write_off(&version, &["a".into(), "b".into()]).unwrap();
        let args: Vec<String> = launch_args(&version)
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[0], "--mods");
        assert_eq!(args[2..], ["--off".to_string(), "a,b".to_string()]);
        std::fs::remove_dir_all(&version).ok();
    }
}
