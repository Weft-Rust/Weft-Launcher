use thiserror::Error;

use super::archive::ArchiveProblem;
use crate::download::DownloadError;
use crate::error::{AppError, ErrorCode, is_disk_full};

#[derive(Debug, Error)]
pub enum ModsError {
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("Unexpected HTTP status {status} for {url}")]
    Http { status: u16, url: String },
    /// A mod download that GitHub refused for too many requests.
    #[error("Too many requests")]
    RateLimited,
    /// GitHub's API refused to list a source's releases for too many requests.
    #[error("GitHub API rate limit exceeded")]
    SourceRateLimited,
    #[error("Not on the server any more: {0}")]
    DownloadNotFound(String),
    #[error("Too large: {0}")]
    TooLarge(String),
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
    ArchiveInvalid(ArchiveProblem),
    #[error("SHA256 mismatch: expected {expected}, got {actual}")]
    Sha256Mismatch { expected: String, actual: String },
    #[error("The file changed since it was checked")]
    FileChanged,
    #[error("Mod not installed: {0}")]
    NotInstalled(String),
    /// The display names of the mods that would stop the game.
    #[error("Mods stop the game from starting: {0}")]
    Blocked(String),
    #[error("Invalid source: {0}")]
    SourceInvalid(String),
    #[error("Source not found: {0}")]
    SourceNotFound(String),
    #[error("Invalid name: {0}")]
    InvalidName(String),
    /// `base` ships inside every Weft; nothing may install over it.
    #[error("Reserved mod id: {0}")]
    IdReserved(String),
    #[error("Version not installed: {0}")]
    VersionNotInstalled(String),
    #[error("The game is running: {0}")]
    GameRunning(String),
}

impl From<ArchiveProblem> for ModsError {
    fn from(p: ArchiveProblem) -> Self {
        ModsError::ArchiveInvalid(p)
    }
}

impl ModsError {
    /// A failed mod download, keeping what went wrong: gone, too big, full disk, rate limited
    /// or the network.
    pub fn from_download(err: DownloadError, url: &str) -> Self {
        match err {
            DownloadError::Status(s) if s.as_u16() == 404 || s.as_u16() == 410 => {
                ModsError::DownloadNotFound(url.to_string())
            }
            DownloadError::Status(s) if s.as_u16() == 429 || s.as_u16() == 403 => {
                ModsError::RateLimited
            }
            DownloadError::Status(s) => ModsError::Http {
                status: s.as_u16(),
                url: url.to_string(),
            },
            DownloadError::TooLarge(max) => ModsError::TooLarge(format!("more than {max} bytes")),
            DownloadError::Io(e) => ModsError::Io(e),
            DownloadError::Network(e) => ModsError::Network(e),
        }
    }

    pub fn code(&self) -> ErrorCode {
        use ErrorCode as C;
        use ModsError::*;
        match self {
            Network(_) | Http { .. } => C::Network,
            Io(e) if is_disk_full(e) => C::DiskFull,
            Io(_) => C::Io,
            Serde(_) => C::Serde,
            RateLimited => C::RateLimited,
            SourceRateLimited => C::ModSourceRateLimited,
            DownloadNotFound(_) => C::ModDownloadNotFound,
            TooLarge(_) => C::ModTooLarge,
            IndexSignatureInvalid(_) => C::IndexSignatureInvalid,
            IndexRollback => C::IndexRollback,
            IndexInvalid(_) => C::IndexInvalid,
            AbiUnavailable(_) => C::AbiUnavailable,
            NotInCatalog(_) => C::ModNotInCatalog,
            Incompatible(_) => C::ModIncompatible,
            NotForPlatform(_) => C::ModNotForPlatform,
            Revoked(_) => C::ModRevoked,
            ArchiveInvalid(_) => C::ModArchiveInvalid,
            Sha256Mismatch { .. } => C::Sha256Mismatch,
            FileChanged => C::ModFileChanged,
            NotInstalled(_) => C::ModNotInstalled,
            Blocked(_) => C::ModsBlocked,
            SourceInvalid(_) => C::ModSourceInvalid,
            SourceNotFound(_) => C::ModSourceNotFound,
            InvalidName(_) => C::InvalidName,
            IdReserved(_) => C::ModIdReserved,
            VersionNotInstalled(_) => C::NotInstalled,
            GameRunning(_) => C::GameRunning,
        }
    }
}

impl From<ModsError> for AppError {
    fn from(err: ModsError) -> Self {
        use ModsError::*;
        let code = err.code();
        let detail = match err {
            Network(e) => Some(e.to_string()),
            Io(e) => Some(e.to_string()),
            Serde(e) => Some(e.to_string()),
            Http { status, url } => Some(format!("HTTP {status} ({url})")),
            RateLimited | SourceRateLimited | IndexRollback | FileChanged => None,
            ArchiveInvalid(p) => Some(p.to_string()),
            Sha256Mismatch { expected, actual } => {
                Some(format!("expected {expected}, got {actual}"))
            }
            DownloadNotFound(d)
            | TooLarge(d)
            | IndexSignatureInvalid(d)
            | IndexInvalid(d)
            | AbiUnavailable(d)
            | NotInCatalog(d)
            | Incompatible(d)
            | NotForPlatform(d)
            | Revoked(d)
            | NotInstalled(d)
            | Blocked(d)
            | SourceInvalid(d)
            | SourceNotFound(d)
            | InvalidName(d)
            | IdReserved(d)
            | VersionNotInstalled(d)
            | GameRunning(d) => Some(d),
        };
        AppError::new(code, detail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::StatusCode;

    #[test]
    fn download_failures_keep_their_meaning() {
        let url = "https://github.com/a/b/releases/download/t/x.zip";
        let code = |e: DownloadError| AppError::from(ModsError::from_download(e, url)).code;
        assert_eq!(
            code(DownloadError::Status(StatusCode::NOT_FOUND)),
            ErrorCode::ModDownloadNotFound
        );
        assert_eq!(
            code(DownloadError::Status(StatusCode::GONE)),
            ErrorCode::ModDownloadNotFound
        );
        assert_eq!(
            code(DownloadError::Status(StatusCode::TOO_MANY_REQUESTS)),
            ErrorCode::RateLimited
        );
        assert_eq!(
            code(DownloadError::Status(StatusCode::BAD_GATEWAY)),
            ErrorCode::Network
        );
        assert_eq!(code(DownloadError::TooLarge(10)), ErrorCode::ModTooLarge);
        assert_eq!(
            code(DownloadError::Io(std::io::ErrorKind::StorageFull.into())),
            ErrorCode::DiskFull
        );
    }
}
