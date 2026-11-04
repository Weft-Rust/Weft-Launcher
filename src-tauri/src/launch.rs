use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::{Error as OpenerError, OpenerExt};
use thiserror::Error;
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;

use crate::error::AppError;
use crate::install::validate_name;

#[derive(Debug, Error)]
pub enum LaunchError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Version already running: {0}")]
    AlreadyRunning(String),
    #[error("Another game is running: {0}")]
    AnotherGameRunning(String),
    #[error("Executable not found: {0}")]
    ExecutableNotFound(String),
    #[error("Failed to spawn process: {0}")]
    ProcessSpawnFailed(String),
    #[error("Failed to create log directory: {0}")]
    LogDirCreateFailed(String),
    #[error("Game folder not found: {0}")]
    GameFolderNotFound(String),
    #[error("Failed to open: {0}")]
    OpenerError(#[from] OpenerError),
}

/// Remove ANSI escape codes from a string.
pub(crate) fn strip_ansi_codes(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Potential ANSI escape sequence: ESC [
            if chars.peek() == Some(&'[') {
                chars.next(); // consume '['
                // Skip until we find a letter (typically 'm' for SGR)
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
                continue;
            }
            // Not an ANSI sequence, keep the ESC char
            result.push(c);
        } else if c == '[' {
            // Handle case where ESC was already stripped: [...m
            // Peek ahead to see if this looks like an SGR sequence
            let mut peeked = chars.clone();
            let mut looks_like_sgr = false;
            let mut has_digit = false;
            for pc in peeked.by_ref() {
                if pc.is_ascii_digit() {
                    has_digit = true;
                } else if pc == ';' {
                    if !has_digit {
                        break;
                    }
                    has_digit = false;
                } else if pc == 'm' && has_digit {
                    looks_like_sgr = true;
                    break;
                } else {
                    break;
                }
            }
            if looks_like_sgr {
                // Consume the sequence
                for pc in chars.by_ref() {
                    if pc == 'm' {
                        break;
                    }
                }
                continue;
            }
            // Not an SGR sequence, keep the bracket
            result.push(c);
        } else {
            result.push(c);
        }
    }
    result
}

/// Extract game folder path from a log line containing "game folder <path>, cache <path>".
fn extract_game_folder_path(line: &str) -> Option<String> {
    let cleaned = strip_ansi_codes(line);
    let prefix = "game folder ";
    let suffix = ", cache ";
    let start = cleaned.find(prefix)?;
    let start = start + prefix.len();
    let end = cleaned[start..].find(suffix)?;
    Some(cleaned[start..start + end].trim().to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
pub enum GameState {
    Running,
    Stopped,
}

/// The `game-state` event.
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct GameStateEvent {
    pub tag: String,
    pub state: GameState,
    pub exit_code: Option<i32>,
    /// The game only ends with an error of its own, a panic or a fault when something went
    /// wrong. On Unix a signal leaves no exit code at all, so the code alone can't tell.
    pub crashed: bool,
    /// The mod that stopped the game from starting, when the log names one.
    pub mod_failure: Option<crate::mods::diagnose::ModFailure>,
}

/// Tags of the games this launcher has started and is waiting for.
#[derive(Default, Clone)]
pub struct RunningGames(Arc<Mutex<HashSet<String>>>);

impl RunningGames {
    /// The game that is running now, if any: only one runs at a time.
    pub fn current(&self) -> Option<String> {
        self.0.lock().unwrap().iter().next().cloned()
    }

    #[cfg(test)]
    pub fn insert(&self, tag: &str) {
        self.0.lock().unwrap().insert(tag.to_string());
    }
}

fn running_games(app_handle: &AppHandle) -> RunningGames {
    app_handle.state::<RunningGames>().inner().clone()
}

/// The game that is running now, if any: only one runs at a time.
pub fn running_game(app_handle: &AppHandle) -> Option<String> {
    running_games(app_handle).current()
}

fn get_versions_dir(app_handle: &AppHandle) -> Result<PathBuf, LaunchError> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| LaunchError::Io(std::io::Error::other(e)))?;
    Ok(app_data.join("versions"))
}

fn get_logs_dir(app_handle: &AppHandle) -> Result<PathBuf, LaunchError> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| LaunchError::Io(std::io::Error::other(e)))?;
    let logs_dir = app_data.join("logs");
    std::fs::create_dir_all(&logs_dir)
        .map_err(|e| LaunchError::LogDirCreateFailed(e.to_string()))?;
    Ok(logs_dir)
}

// Reads bytes, not text: a driver printing in the system's code page must not end the log.
async fn copy_to_log(stream: impl AsyncRead + Unpin, mut log: fs::File, label: &'static str) {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let text = String::from_utf8_lossy(&line);
        let entry = format!("[{label}] {}\n", text.trim_end());
        let _ = log.write_all(entry.as_bytes()).await;
    }
    let _ = log.flush().await;
}

#[tauri::command]
pub async fn launch_version(app_handle: AppHandle, tag: String) -> Result<(), AppError> {
    validate_name(&tag)?;
    let versions_dir = get_versions_dir(&app_handle)?;
    let version_dir = versions_dir.join(&tag);
    let executable = version_dir.join(if cfg!(target_os = "windows") {
        "weft.exe"
    } else {
        "weft"
    });

    if !executable.exists() {
        return Err(LaunchError::ExecutableNotFound(tag).into());
    }
    if let Some(running) = running_game(&app_handle) {
        return Err(if running == tag {
            LaunchError::AlreadyRunning(tag)
        } else {
            LaunchError::AnotherGameRunning(running)
        }
        .into());
    }

    // Refuses a mod set the game would refuse, before anything starts. Holds the mod lock until
    // the game is registered, so no mod change lands in between.
    let mods = crate::mods::prepare_launch(&app_handle, &tag).await?;

    let games = running_games(&app_handle);

    // Checked and registered under one lock, before spawning, so two clicks can't both pass.
    {
        let mut running = games.0.lock().unwrap();
        if running.contains(&tag) {
            return Err(LaunchError::AlreadyRunning(tag).into());
        }
        if let Some(other) = running.iter().next() {
            return Err(LaunchError::AnotherGameRunning(other.clone()).into());
        }
        running.insert(tag.clone());
    }
    let mods_dir = mods.release();

    let launch = Launch {
        tag: &tag,
        executable: &executable,
        version_dir: &version_dir,
        mods_dir: mods_dir.as_deref(),
    };
    if let Err(e) = start_game(&app_handle, &games, launch).await {
        games.0.lock().unwrap().remove(&tag);
        return Err(e.into());
    }
    Ok(())
}

/// The game's arguments. `--mods` is searched before the player's own mods folder, and the
/// first copy of a mod wins; without a folder nothing is passed.
fn game_args(mods_dir: Option<&Path>) -> Vec<std::ffi::OsString> {
    match mods_dir {
        Some(dir) => vec!["--mods".into(), dir.as_os_str().to_owned()],
        None => Vec::new(),
    }
}

struct Launch<'a> {
    tag: &'a str,
    executable: &'a Path,
    version_dir: &'a Path,
    mods_dir: Option<&'a Path>,
}

/// The first mod failure logged since `start`, the size of the log when this run began.
async fn mod_failure_since(
    log_path: &Path,
    start: u64,
) -> Option<crate::mods::diagnose::ModFailure> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = fs::File::open(log_path).await.ok()?;
    file.seek(std::io::SeekFrom::Start(start)).await.ok()?;
    let mut bytes = Vec::new();
    file.take(4 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .await
        .ok()?;
    crate::mods::diagnose::find(&String::from_utf8_lossy(&bytes))
}

async fn start_game(
    app_handle: &AppHandle,
    games: &RunningGames,
    launch: Launch<'_>,
) -> Result<(), LaunchError> {
    let Launch {
        tag,
        executable,
        version_dir,
        mods_dir,
    } = launch;
    let logs_dir = get_logs_dir(app_handle)?;
    let log_path = logs_dir.join(format!("{tag}.log"));
    let log_start = fs::metadata(&log_path).await.map(|m| m.len()).unwrap_or(0);
    let log_stdout = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .await?;
    let log_stderr = log_stdout.try_clone().await?;

    let mut cmd = TokioCommand::new(executable);
    cmd.current_dir(version_dir)
        .args(game_args(mods_dir))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| LaunchError::ProcessSpawnFailed(e.to_string()))?;

    let stdout = child.stdout.take().expect("stdout not captured");
    let stderr = child.stderr.take().expect("stderr not captured");
    let stdout_log = tokio::spawn(copy_to_log(stdout, log_stdout, "stdout"));
    let stderr_log = tokio::spawn(copy_to_log(stderr, log_stderr, "stderr"));

    let _ = app_handle.emit(
        crate::ipc::GAME_STATE,
        GameStateEvent {
            tag: tag.to_string(),
            state: GameState::Running,
            exit_code: None,
            crashed: false,
            mod_failure: None,
        },
    );

    let app_handle = app_handle.clone();
    let games = games.clone();
    let tag = tag.to_string();
    tokio::spawn(async move {
        let status = child.wait().await.ok();

        // So the log is complete when the player opens it. Something the game left running may
        // hold the pipes open, hence the limit.
        let logs = futures_util::future::join(stdout_log, stderr_log);
        let _ = tokio::time::timeout(Duration::from_secs(2), logs).await;

        games.0.lock().unwrap().remove(&tag);
        let crashed = status.is_some_and(|s| !s.success());
        let mod_failure = if crashed {
            mod_failure_since(&log_path, log_start).await
        } else {
            None
        };
        let _ = app_handle.emit(
            crate::ipc::GAME_STATE,
            GameStateEvent {
                tag,
                state: GameState::Stopped,
                exit_code: status.and_then(|s| s.code()),
                crashed,
                mod_failure,
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub async fn get_running_versions(app_handle: AppHandle) -> Result<Vec<String>, AppError> {
    Ok(running_game(&app_handle).into_iter().collect())
}

#[tauri::command]
pub async fn open_game_folder(app_handle: AppHandle, _tag: String) -> Result<(), AppError> {
    match find_game_folder(&app_handle).await {
        Some(folder) => Ok(open_path(&app_handle, &folder)?),
        None => Err(LaunchError::GameFolderNotFound(
            "not in the logs yet, start the game once".to_string(),
        )
        .into()),
    }
}

/// The game's data folder, as the newest log that names one says. The game prints it at start.
pub async fn find_game_folder(app_handle: &AppHandle) -> Option<PathBuf> {
    find_game_folder_in(&get_logs_dir(app_handle).ok()?).await
}

/// The same, given the launcher's logs folder.
pub async fn find_game_folder_in(logs_dir: &Path) -> Option<PathBuf> {
    let mut entries = fs::read_dir(logs_dir).await.ok()?;
    let mut log_files = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("log")
            && let Ok(metadata) = entry.metadata().await
            && let Ok(modified) = metadata.modified()
        {
            log_files.push((path, modified));
        }
    }
    log_files.sort_by_key(|a| std::cmp::Reverse(a.1));

    for (log_path, _) in log_files {
        let Ok(file) = fs::File::open(&log_path).await else {
            continue;
        };
        let mut lines = BufReader::new(file).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // A folder that no longer exists may still be named in an old log.
            if let Some(folder) = extract_game_folder_path(&line).map(PathBuf::from)
                && folder.exists()
            {
                return Some(folder);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn open_log(app_handle: AppHandle, tag: String) -> Result<(), AppError> {
    validate_name(&tag)?;
    let logs_dir = get_logs_dir(&app_handle)?;
    let log_file = logs_dir.join(format!("{tag}.log"));
    if !log_file.exists() {
        return Err(LaunchError::GameFolderNotFound(format!(
            "log file not found: {}",
            log_file.display()
        ))
        .into());
    }
    open_path(&app_handle, &log_file)?;
    Ok(())
}

pub(crate) fn open_path(app_handle: &AppHandle, path: &Path) -> Result<(), LaunchError> {
    // Programs spawned from the AppImage crash on its bundled libraries; reveal goes over D-Bus.
    if cfg!(target_os = "linux") && std::env::var_os("APPDIR").is_some() {
        app_handle.opener().reveal_item_in_dir(path)?;
        return Ok(());
    }
    app_handle
        .opener()
        .open_path(path.to_string_lossy().as_ref(), None::<&str>)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mods_argument() {
        assert!(game_args(None).is_empty(), "no folder, no --mods");
        let dir = Path::new("/data/profiles/v26.11.1/mods");
        assert_eq!(
            game_args(Some(dir)),
            ["--mods", "/data/profiles/v26.11.1/mods"]
        );
    }
}
