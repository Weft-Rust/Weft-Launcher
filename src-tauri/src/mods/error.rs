use thiserror::Error;

use crate::error::AppError;

#[derive(Debug, Error)]
pub enum ModsError {
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("Zip error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("Unexpected HTTP status {status} for {url}")]
    Http { status: u16, url: String },
    #[error("GitHub API rate limit exceeded")]
    RateLimited,
    #[error("Index signature invalid: {0}")]
    IndexSignatureInvalid(String),
    #[error("Index is older than the one already verified")]
    IndexRollback,
    #[error("Index unusable: {0}")]
    IndexInvalid(String),
    #[error("Mod interface of {0} unknown")]
    AbiUnavailable(String),
    #[error("Not in the catalog: {0}")]
    NotInCatalog(String),
    #[error("{0} is not built for this game version")]
    Incompatible(String),
    #[error("{0} is not built for this system")]
    NotForPlatform(String),
    #[error("Revoked: {0}")]
    Revoked(String),
    #[error("Not a Weft mod: {0}")]
    ArchiveInvalid(String),
    #[error("SHA256 mismatch: expected {expected}, got {actual}")]
    Sha256Mismatch { expected: String, actual: String },
    #[error("The file changed since it was checked")]
    FileChanged,
    #[error("Mod not installed: {0}")]
    NotInstalled(String),
    #[error("Mods stop the game from starting: {0}")]
    Blocked(String),
    #[error("Invalid source: {0}")]
    SourceInvalid(String),
    #[error("Source not found: {0}")]
    SourceNotFound(String),
    #[error("Invalid name: {0}")]
    InvalidName(String),
    #[error("Version not installed: {0}")]
    VersionNotInstalled(String),
    #[error("The game is running: {0}")]
    GameRunning(String),
}

impl From<ModsError> for AppError {
    fn from(err: ModsError) -> Self {
        use ModsError::*;
        let (code, detail) = match err {
            Network(e) => ("Network", Some(e.to_string())),
            Io(e) => ("Io", Some(e.to_string())),
            Serde(e) => ("Serde", Some(e.to_string())),
            Zip(e) => ("ModArchiveInvalid", Some(e.to_string())),
            Http { status, url } => ("Network", Some(format!("HTTP {status} ({url})"))),
            RateLimited => ("RateLimited", None),
            IndexSignatureInvalid(d) => ("IndexSignatureInvalid", Some(d)),
            IndexRollback => ("IndexRollback", None),
            IndexInvalid(d) => ("IndexInvalid", Some(d)),
            AbiUnavailable(tag) => ("AbiUnavailable", Some(tag)),
            NotInCatalog(d) => ("ModNotInCatalog", Some(d)),
            Incompatible(d) => ("ModIncompatible", Some(d)),
            NotForPlatform(d) => ("ModNotForPlatform", Some(d)),
            Revoked(d) => ("ModRevoked", Some(d)),
            ArchiveInvalid(d) => ("ModArchiveInvalid", Some(d)),
            Sha256Mismatch { expected, actual } => (
                "Sha256Mismatch",
                Some(format!("expected {expected}, got {actual}")),
            ),
            FileChanged => ("ModFileChanged", None),
            NotInstalled(id) => ("ModNotInstalled", Some(id)),
            Blocked(ids) => ("ModsBlocked", Some(ids)),
            SourceInvalid(d) => ("ModSourceInvalid", Some(d)),
            SourceNotFound(d) => ("ModSourceNotFound", Some(d)),
            InvalidName(d) => ("InvalidName", Some(d)),
            VersionNotInstalled(tag) => ("NotInstalled", Some(tag)),
            GameRunning(tag) => ("GameRunning", Some(tag)),
        };
        AppError::new(code, detail)
    }
}
