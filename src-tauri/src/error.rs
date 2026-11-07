use serde::Serialize;
use thiserror::Error;
use ts_rs::TS;

macro_rules! error_codes {
    ($($code:ident),* $(,)?) => {
        /// Every code an [`AppError`] can carry, across the whole app. On the wire a code is its
        /// variant name; `src/i18n/errors.ts` turns it into a translation key.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, TS)]
        pub enum ErrorCode {
            $($code),*
        }

        impl ErrorCode {
            pub const ALL: &'static [ErrorCode] = &[$(ErrorCode::$code),*];

            pub fn as_str(self) -> &'static str {
                match self {
                    $(ErrorCode::$code => stringify!($code)),*
                }
            }
        }
    };
}

error_codes! {
    // Shared
    Network,
    HttpStatus,
    Io,
    DiskFull,
    Serde,
    RateLimited,
    InvalidName,
    // Releases
    InvalidHeader,
    CacheCorrupted,
    AssetNotFound,
    MissingDigest,
    Forbidden,
    OfflineNoCache,
    // Installing game versions
    Zip,
    CreateDir,
    Sha256Mismatch,
    HashMissing,
    AlreadyInstalled,
    NotInstalled,
    DownloadFailed,
    ExtractFailed,
    GameRunning,
    VersionInUse,
    InstallInProgress,
    // Launching
    AlreadyRunning,
    AnotherGameRunning,
    ExecutableNotFound,
    ProcessSpawnFailed,
    LogDirCreateFailed,
    GameFolderNotFound,
    OpenerError,
    // Mods
    IndexSignatureInvalid,
    IndexRollback,
    IndexInvalid,
    AbiUnavailable,
    ModNotInCatalog,
    ModIncompatible,
    ModNotForPlatform,
    ModRevoked,
    ModArchiveInvalid,
    ModFileChanged,
    ModNotInstalled,
    ModStoreMissing,
    ModsBlocked,
    ModSourceInvalid,
    ModSourceNotFound,
    ModSourcesDamaged,
    ModSourceRateLimited,
    ModDownloadNotFound,
    ModTooLarge,
    ModIdReserved,
    ModChangedMeanwhile,
    ModCancelled,
    ModLockInvalid,
    ModUrlRefused,
    ModIconInvalid,
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What a command rejects with, and what successful payloads carry as an embedded error.
#[derive(Debug, Clone, Serialize, Error, TS)]
#[ts(rename = "AppErrorPayload")]
#[error("{code}{}", .detail.as_ref().map(|d| format!(": {}", d)).unwrap_or_default())]
pub struct AppError {
    pub code: ErrorCode,
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: ErrorCode, detail: Option<String>) -> Self {
        Self { code, detail }
    }
}

/// A full disk is its own problem: the player can fix it, a retry won't.
pub fn is_disk_full(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded
    )
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        let code = if is_disk_full(&err) {
            ErrorCode::DiskFull
        } else {
            ErrorCode::Io
        };
        AppError::new(code, Some(err.to_string()))
    }
}

impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        AppError::new(ErrorCode::Network, Some(err.to_string()))
    }
}

impl From<crate::releases::ReleasesError> for AppError {
    fn from(err: crate::releases::ReleasesError) -> Self {
        use crate::releases::ReleasesError::*;
        use ErrorCode as C;
        match err {
            Network(e) => AppError::new(C::Network, Some(e.to_string())),
            Io(e) => e.into(),
            Serde(e) => AppError::new(C::Serde, Some(e.to_string())),
            InvalidHeader(e) => AppError::new(C::InvalidHeader, Some(e.to_string())),
            CacheCorrupted(msg) => AppError::new(C::CacheCorrupted, Some(msg)),
            AssetNotFound => AppError::new(C::AssetNotFound, None),
            MissingDigest => AppError::new(C::MissingDigest, None),
            RateLimited => AppError::new(C::RateLimited, None),
            Forbidden => AppError::new(C::Forbidden, None),
            OfflineNoCache => AppError::new(C::OfflineNoCache, None),
            UnexpectedStatus(status) => AppError::new(C::Network, Some(format!("HTTP {status}"))),
        }
    }
}

impl From<crate::install::InstallError> for AppError {
    fn from(err: crate::install::InstallError) -> Self {
        use crate::install::InstallError::*;
        use ErrorCode as C;
        match err {
            Network(e) => AppError::new(C::Network, Some(e.to_string())),
            Io(e) => e.into(),
            Serde(e) => AppError::new(C::Serde, Some(e.to_string())),
            Zip(e) => AppError::new(C::Zip, Some(e.to_string())),
            CreateDir(msg) => AppError::new(C::CreateDir, Some(msg)),
            Sha256Mismatch { expected, actual } => AppError::new(
                C::Sha256Mismatch,
                Some(format!("expected {}, got {}", expected, actual)),
            ),
            MissingDigest => AppError::new(C::MissingDigest, None),
            HashMissing => AppError::new(C::HashMissing, None),
            AssetNotFound => AppError::new(C::AssetNotFound, None),
            AlreadyInstalled(tag) => AppError::new(C::AlreadyInstalled, Some(tag)),
            NotInstalled(tag) => AppError::new(C::NotInstalled, Some(tag)),
            RateLimited => AppError::new(C::RateLimited, None),
            Forbidden => AppError::new(C::Forbidden, None),
            OfflineNoCache => AppError::new(C::OfflineNoCache, None),
            DownloadFailed(msg) => AppError::new(C::DownloadFailed, Some(msg)),
            ExtractFailed(msg) => AppError::new(C::ExtractFailed, Some(msg)),
            GameRunning(tag) => AppError::new(C::GameRunning, Some(tag)),
            VersionInUse(tag) => AppError::new(C::VersionInUse, Some(tag)),
            InvalidName(name) => AppError::new(C::InvalidName, Some(name)),
            InstallInProgress(tag) => AppError::new(C::InstallInProgress, Some(tag)),
        }
    }
}

impl From<crate::launch::LaunchError> for AppError {
    fn from(err: crate::launch::LaunchError) -> Self {
        use crate::launch::LaunchError::*;
        use ErrorCode as C;
        match err {
            Io(e) => e.into(),
            AlreadyRunning(tag) => AppError::new(C::AlreadyRunning, Some(tag)),
            AnotherGameRunning(tag) => AppError::new(C::AnotherGameRunning, Some(tag)),
            ExecutableNotFound(path_or_tag) => {
                AppError::new(C::ExecutableNotFound, Some(path_or_tag))
            }
            ProcessSpawnFailed(msg) => AppError::new(C::ProcessSpawnFailed, Some(msg)),
            LogDirCreateFailed(msg) => AppError::new(C::LogDirCreateFailed, Some(msg)),
            GameFolderNotFound(detail) => AppError::new(C::GameFolderNotFound, detail),
            OpenerError(e) => AppError::new(C::OpenerError, Some(e.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_keep_their_wire_strings() {
        for code in ErrorCode::ALL {
            assert_eq!(
                serde_json::to_value(code).unwrap(),
                serde_json::Value::String(code.as_str().to_string())
            );
        }
        let e = AppError::new(ErrorCode::ModsBlocked, Some("Cogwork".into()));
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"code":"ModsBlocked","detail":"Cogwork"}"#
        );
        assert_eq!(e.to_string(), "ModsBlocked: Cogwork");
    }

    #[test]
    fn a_full_disk_has_its_own_code() {
        let full = std::io::Error::from(std::io::ErrorKind::StorageFull);
        assert_eq!(AppError::from(full).code, ErrorCode::DiskFull);
        let other = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(AppError::from(other).code, ErrorCode::Io);
    }
}
