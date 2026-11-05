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
    /// GitHub's API refused to list a source's releases for too many requests. `reset`: when
    /// GitHub said the limit ends (`x-ratelimit-reset`, Unix seconds), when it said.
    #[error("GitHub API rate limit exceeded")]
    SourceRateLimited { reset: Option<u64> },
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
    /// `sources.json` couldn't be read; it was kept, at this path.
    #[error("Sources list damaged; kept as {0}")]
    SourcesDamaged(String),
    #[error("Invalid name: {0}")]
    InvalidName(String),
    /// `base` ships inside every Weft; nothing may install over it.
    #[error("Reserved mod id: {0}")]
    IdReserved(String),
    #[error("Version not installed: {0}")]
    VersionNotInstalled(String),
    #[error("The game is running: {0}")]
    GameRunning(String),
    /// A download finished, but the profile, the catalogue or the version changed meanwhile in
    /// a way that makes the plan wrong.
    #[error("Changed meanwhile: {0}")]
    ChangedMeanwhile(String),
    /// `mods.lock.json` can't be used as it is.
    #[error("Mod set unreadable: {0}")]
    LockInvalid(String),
    /// The player cancelled the operation; nothing was changed.
    #[error("Cancelled")]
    Cancelled,
    /// A build's download URL isn't its GitHub release asset.
    #[error("Refused download URL {url}: {why}")]
    UrlRefused {
        url: String,
        why: super::index::UrlProblem,
    },
    /// A mod icon that isn't a PNG.
    #[error("Not a PNG icon: {0}")]
    IconInvalid(String),
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
            Network(_) => C::Network,
            // A gateway that couldn't reach what is behind it: as good as unreachable.
            Http {
                status: 502..=504, ..
            } => C::Network,
            // Otherwise the server answered: the network is up, so never "offline".
            Http { .. } => C::HttpStatus,
            Io(e) if is_disk_full(e) => C::DiskFull,
            Io(_) => C::Io,
            Serde(_) => C::Serde,
            RateLimited => C::RateLimited,
            SourceRateLimited { .. } => C::ModSourceRateLimited,
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
            SourcesDamaged(_) => C::ModSourcesDamaged,
            InvalidName(_) => C::InvalidName,
            IdReserved(_) => C::ModIdReserved,
            VersionNotInstalled(_) => C::NotInstalled,
            GameRunning(_) => C::GameRunning,
            ChangedMeanwhile(_) => C::ModChangedMeanwhile,
            LockInvalid(_) => C::ModLockInvalid,
            Cancelled => C::ModCancelled,
            UrlRefused { .. } => C::ModUrlRefused,
            IconInvalid(_) => C::ModIconInvalid,
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
            // The page reads the time from here (src/mods/select.ts `rateLimitReset`).
            SourceRateLimited { reset } => reset.map(|r| format!("resets at {r}")),
            RateLimited | IndexRollback | FileChanged | Cancelled => None,
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
            | SourcesDamaged(d)
            | InvalidName(d)
            | IdReserved(d)
            | VersionNotInstalled(d)
            | GameRunning(d)
            | ChangedMeanwhile(d)
            | IconInvalid(d) => Some(d),
            // The rule first, which the page says in words (src/i18n/errors.ts `urlRule`).
            UrlRefused { url, why } => Some(format!("{} {url}", why.rule())),
            LockInvalid(d) => Some(format!("mods.lock.json: {d}")),
        };
        AppError::new(code, detail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::StatusCode;

    #[test]
    fn an_answer_with_an_error_status_is_not_offline() {
        let http = |status| {
            ModsError::Http {
                status,
                url: "https://zorro909.github.io/weft-mods-index/v1/index.json".into(),
            }
            .code()
        };
        assert_eq!(http(404), ErrorCode::HttpStatus);
        assert_eq!(http(403), ErrorCode::HttpStatus);
        assert_eq!(http(500), ErrorCode::HttpStatus);
        assert_eq!(http(503), ErrorCode::Network);
    }

    #[test]
    fn a_refused_url_says_the_rule_first() {
        use crate::mods::index::UrlProblem;
        let e = AppError::from(ModsError::UrlRefused {
            url: "http://github.com/a/b/releases/download/t/x.zip".into(),
            why: UrlProblem::NotHttps,
        });
        assert_eq!(e.code, ErrorCode::ModUrlRefused);
        assert_eq!(
            e.detail.as_deref(),
            Some("notHttps http://github.com/a/b/releases/download/t/x.zip")
        );
    }

    #[test]
    fn a_rate_limit_says_when_it_ends() {
        let detail = |reset| AppError::from(ModsError::SourceRateLimited { reset }).detail;
        assert_eq!(
            detail(Some(1_793_000_000)).as_deref(),
            Some("resets at 1793000000")
        );
        assert_eq!(detail(None), None);
    }

    #[test]
    fn an_error_status_is_said_first_in_the_detail() {
        // The page reads the status from here (src/mods/select.ts `httpStatus`): keep it first.
        let e = AppError::from(ModsError::Http {
            status: 404,
            url: "https://zorro909.github.io/weft-mods-index/v1/index.json".into(),
        });
        assert_eq!(
            e.detail.as_deref(),
            Some("HTTP 404 (https://zorro909.github.io/weft-mods-index/v1/index.json)")
        );
    }

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
        assert_eq!(
            code(DownloadError::Status(StatusCode::INTERNAL_SERVER_ERROR)),
            ErrorCode::HttpStatus
        );
        assert_eq!(code(DownloadError::TooLarge(10)), ErrorCode::ModTooLarge);
        assert_eq!(
            code(DownloadError::Io(std::io::ErrorKind::StorageFull.into())),
            ErrorCode::DiskFull
        );
    }
}
