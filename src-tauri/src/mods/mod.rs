//! The mod manager. Each installed game version has its own set of mods, and the folders are the
//! state: `profiles/<tag>/mods` is passed to the game, `profiles/<tag>/mods-off` is not.
//! The rules and the trust model are in `docs/mods.md`.

mod abi;
mod archive;
mod commands;
mod fetch;
mod index;
mod plan;
mod profile;
mod verify;

use std::fmt::Display;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::error::AppError;

pub use commands::*;

#[derive(Debug, thiserror::Error)]
pub enum ModError {
    #[error("network: {0}")]
    Network(String),
    #[error("verification failed: {0}")]
    VerifyFailed(String),
    #[error("not a mod: {0}")]
    NotAMod(String),
    #[error("built for another game version")]
    WrongVersion,
    #[error("no library for this system")]
    NoLibraryForThisSystem,
    #[error("revoked: {}", .0.as_deref().unwrap_or("no reason given"))]
    Revoked(Option<String>),
    /// A mod to turn on needs this one, which isn't installed.
    #[error("needs {0}")]
    NeedsMod(String),
    #[error("{0} has no build for this game version")]
    NoBuildForVersion(String),
    #[error("the game version is running")]
    GameRunning,
    #[error("I/O: {0}")]
    Io(#[from] std::io::Error),
}

impl From<ModError> for AppError {
    fn from(err: ModError) -> Self {
        log(format_args!("error: {err}"));
        let (code, detail) = match err {
            ModError::Network(_) => ("Network", None),
            ModError::VerifyFailed(_) => ("VerifyFailed", None),
            ModError::NotAMod(_) => ("NotAMod", None),
            ModError::WrongVersion => ("WrongVersion", None),
            ModError::NoLibraryForThisSystem => ("NoLibraryForThisSystem", None),
            ModError::Revoked(reason) => ("Revoked", reason),
            ModError::NeedsMod(name) => ("NeedsMod", Some(name)),
            ModError::NoBuildForVersion(name) => ("NoBuildForVersion", Some(name)),
            ModError::GameRunning => ("GameRunning", None),
            ModError::Io(e) => ("Io", Some(e.to_string())),
        };
        AppError::new(code, detail)
    }
}

impl From<reqwest::Error> for ModError {
    fn from(err: reqwest::Error) -> Self {
        ModError::Network(err.to_string())
    }
}

/// Where the mod manager keeps its files, under the launcher's data folder.
#[derive(Clone)]
pub struct Dirs {
    root: PathBuf,
}

impl Dirs {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    fn profile(&self, tag: &str) -> PathBuf {
        self.root.join("profiles").join(tag)
    }
    fn index_cache(&self) -> PathBuf {
        self.root.join("cache").join("mod-index.json")
    }
    fn downloads(&self) -> PathBuf {
        self.root.join("downloads")
    }
}

static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();

/// Errors show one line in the UI; their details go to `logs/launcher.log`.
pub fn init_log(logs_dir: &Path) {
    let _ = std::fs::create_dir_all(logs_dir);
    let _ = LOG_FILE.set(logs_dir.join("launcher.log"));
}

pub fn log(msg: impl Display) {
    eprintln!("mods: {msg}");
    let Some(path) = LOG_FILE.get() else { return };
    let now = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{now} mods: {msg}");
    }
}

/// Mod ids are file names too: `[a-z0-9_]{1,64}`.
fn valid_id(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The mod every game ships with. It is never installed by the launcher.
const BASE: &str = "base";
