use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
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
fn strip_ansi_codes(input: &str) -> String {
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

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameStateEvent {
    pub tag: String,
    pub state: String,
    pub exit_code: Option<i32>,
    /// The game only ends with an error of its own, a panic or a fault when something went
    /// wrong. On Unix a signal leaves no exit code at all, so the code alone can't tell.
    pub crashed: bool,
}

/// Tags of the games this launcher has started and is waiting for.
#[derive(Default, Clone)]
pub struct RunningGames(Arc<Mutex<HashSet<String>>>);

fn running_games(app_handle: &AppHandle) -> RunningGames {
    app_handle.state::<RunningGames>().inner().clone()
}

/// The game that is running now, if any: only one runs at a time.
pub fn running_game(app_handle: &AppHandle) -> Option<String> {
    let games = running_games(app_handle);
    let games = games.0.lock().unwrap();
    games.iter().next().cloned()
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

/// LD_LIBRARY_PATH minus the AppImage's old bundled libraries,
/// on which the game may crash with X11.
fn without_appimage_libs(appdir: &Path, library_path: &OsStr) -> Option<OsString> {
    let own = std::env::split_paths(library_path).filter(|p| !p.starts_with(appdir));
    std::env::join_paths(own).ok().filter(|p| !p.is_empty())
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

    if let Err(e) = start_game(&app_handle, &games, &tag, &executable, &version_dir).await {
        games.0.lock().unwrap().remove(&tag);
        return Err(e.into());
    }
    Ok(())
}

async fn start_game(
    app_handle: &AppHandle,
    games: &RunningGames,
    tag: &str,
    executable: &Path,
    version_dir: &Path,
) -> Result<(), LaunchError> {
    let logs_dir = get_logs_dir(app_handle)?;
    let log_path = logs_dir.join(format!("{tag}.log"));
    let log_stdout = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .await?;
    let log_stderr = log_stdout.try_clone().await?;

    let mods = crate::mods::prepare_launch(app_handle, tag)
        .await
        .map_err(|e| LaunchError::Io(std::io::Error::other(e)))?;
    let mut cmd = TokioCommand::new(executable);
    cmd.arg("--mods")
        .arg(mods)
        .current_dir(version_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    if cfg!(target_os = "linux")
        && let Some(appdir) = std::env::var_os("APPDIR")
    {
        let library_path = std::env::var_os("LD_LIBRARY_PATH")
            .and_then(|p| without_appimage_libs(Path::new(&appdir), &p));
        match library_path {
            Some(p) => cmd.env("LD_LIBRARY_PATH", p),
            None => cmd.env_remove("LD_LIBRARY_PATH"),
        };
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| LaunchError::ProcessSpawnFailed(e.to_string()))?;

    let stdout = child.stdout.take().expect("stdout not captured");
    let stderr = child.stderr.take().expect("stderr not captured");
    let stdout_log = tokio::spawn(copy_to_log(stdout, log_stdout, "stdout"));
    let stderr_log = tokio::spawn(copy_to_log(stderr, log_stderr, "stderr"));

    let _ = app_handle.emit(
        "game-state",
        GameStateEvent {
            tag: tag.to_string(),
            state: "running".to_string(),
            exit_code: None,
            crashed: false,
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
        let _ = app_handle.emit(
            "game-state",
            GameStateEvent {
                tag,
                state: "stopped".to_string(),
                exit_code: status.and_then(|s| s.code()),
                crashed: status.is_some_and(|s| !s.success()),
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
    let logs_dir = get_logs_dir(&app_handle)?;

    // Read all log files, sort by modification time (newest first)
    let mut entries = fs::read_dir(&logs_dir).await?;
    let mut log_files: Vec<_> = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("log")
            && let Ok(metadata) = entry.metadata().await
            && let Ok(modified) = metadata.modified()
        {
            log_files.push((path, modified));
        }
    }

    // Sort by modification time, newest first
    log_files.sort_by_key(|a| std::cmp::Reverse(a.1));

    // Search each log file for the "game folder" line
    for (log_path, _) in log_files {
        let file = fs::File::open(&log_path).await?;
        let reader = BufReader::new(file);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(game_folder) = extract_game_folder_path(&line) {
                let game_folder_path = PathBuf::from(&game_folder);
                if game_folder_path.exists() {
                    open_path(&app_handle, &game_folder_path)?;
                    return Ok(());
                }
                // Path from log doesn't exist, continue searching
            }
        }
    }

    // No valid game folder found in any log
    Err(
        LaunchError::GameFolderNotFound("not in the logs yet, start the game once".to_string())
            .into(),
    )
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

fn open_path(app_handle: &AppHandle, path: &Path) -> Result<(), LaunchError> {
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn game_keeps_only_the_players_own_libraries() {
        let strip = |p: &str| without_appimage_libs(Path::new("/tmp/.mount_Weft"), p.as_ref());
        // What the AppImage sets when the player had no LD_LIBRARY_PATH.
        assert_eq!(
            strip("/tmp/.mount_Weft/usr/lib/:/tmp/.mount_Weft/lib64/:"),
            None
        );
        assert_eq!(
            strip("/tmp/.mount_Weft/usr/lib/:/opt/mine/lib:/tmp/.mount_Weftx/lib"),
            Some("/opt/mine/lib:/tmp/.mount_Weftx/lib".into())
        );
    }
}
