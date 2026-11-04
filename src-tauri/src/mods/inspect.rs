//! A zip from the player's computer: what can be told about it before installing, and the lock
//! entry it becomes when it isn't in the catalogue.

use serde::Serialize;
use std::path::Path;
use ts_rs::TS;

use super::archive::{self, ArchiveInfo, MAX_FILE_BYTES};
use super::catalog::{Catalog, CatalogVersion, Origin, Trust};
use super::error::ModsError;
use super::index::{Platform, RESERVED_ID};
use super::profile::{Lock, LockEntry, now};
use crate::download::sha256_file;
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CatalogMatch {
    pub key: String,
    pub name: String,
    pub fits_version: bool,
    /// The catalogue entry: trust, review, provenance and whether it was verified.
    pub build: CatalogVersion,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileInspection {
    pub file_name: String,
    pub size: u64,
    pub sha256: String,
    pub archive: Option<ArchiveInfo>,
    /// Why the file can't be a mod, if it can't.
    pub problem: Option<AppError>,
    /// What the mod's own language file calls it. Only what the file says about itself.
    pub name: Option<String>,
    pub summary: Option<String>,
    pub fits_system: bool,
    pub catalog_match: Option<CatalogMatch>,
    pub revoked_reason: Option<String>,
    /// The installed version of a mod with the same id, which this file would replace.
    pub replaces: Option<String>,
}

/// The file's size, or `ModTooLarge`.
pub fn checked_size(path: &Path) -> Result<u64, ModsError> {
    let size = std::fs::metadata(path)?.len();
    if size > MAX_FILE_BYTES {
        return Err(ModsError::TooLarge("larger than 512 MB".into()));
    }
    Ok(size)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Everything the launcher can say about the file at `path` for a version with mod interface
/// `abi` and mod set `lock`. A zip that isn't a mod is still described, with `problem` set.
pub fn inspect(
    path: &Path,
    catalog: &Catalog,
    abi: Option<&str>,
    platform: Option<Platform>,
    lock: &Lock,
) -> Result<FileInspection, ModsError> {
    let size = checked_size(path)?;
    let sha256 = sha256_file(path)?;
    let inspected = std::fs::File::open(path)
        .map_err(ModsError::from)
        .and_then(|f| archive::inspect(f, None))
        .and_then(|info| {
            if info.id == RESERVED_ID {
                Err(ModsError::IdReserved(info.id))
            } else {
                Ok(info)
            }
        });
    let (archive, problem) = match inspected {
        Ok(info) => (Some(info), None),
        Err(e) => (None, Some(AppError::from(e))),
    };
    let (name, summary) = archive
        .as_ref()
        .map(|a| archive::read_lang(path, &a.id))
        .unwrap_or_default();
    let catalog_match = catalog.find(&sha256).map(|(m, v)| CatalogMatch {
        key: m.key.clone(),
        name: m.name.clone(),
        fits_version: abi == Some(v.abi.as_str()),
        build: v.clone(),
    });
    let replaces = archive
        .as_ref()
        .and_then(|a| lock.get(&a.id))
        .map(|e| e.version.clone().unwrap_or_else(|| e.name.clone()));
    Ok(FileInspection {
        file_name: file_name(path),
        size,
        fits_system: archive
            .as_ref()
            .is_some_and(|a| platform.is_some_and(|p| a.platforms.contains(&p))),
        archive,
        problem,
        name,
        summary,
        revoked_reason: catalog.revocation(&sha256).map(|r| r.reason.clone()),
        catalog_match,
        replaces,
        sha256,
    })
}

/// The lock entry of a file that isn't in the catalogue: Unverified, named by what its language
/// file says, with nothing known about which version it fits.
pub fn local_entry(
    info: &ArchiveInfo,
    stored: &Path,
    source: &Path,
    sha256: &str,
) -> Result<LockEntry, ModsError> {
    let (name, summary) = archive::read_lang(stored, &info.id);
    Ok(LockEntry {
        id: info.id.clone(),
        name: name.unwrap_or_else(|| info.id.clone()),
        summary: summary.unwrap_or_default(),
        version: None,
        channel: None,
        sha256: sha256.to_string(),
        size: std::fs::metadata(stored)?.len(),
        enabled: true,
        trust: Trust::Unverified,
        origin: Origin::File {
            name: file_name(source),
        },
        abi: None,
        weft_tag: None,
        deps: Vec::new(),
        tag: None,
        source_repo: None,
        source_commit: None,
        icon: None,
        installed_at: now(),
        revoked: None,
    })
}

#[cfg(test)]
mod tests {
    use super::super::archive::tests::make_zip;
    use super::super::catalog::Origin;
    use super::super::index::Channel;
    use super::super::profile::tests::{ABI, build, catalog, catalog_mod, entry, lock};
    use super::*;
    use crate::download::sha256_hex;
    use crate::error::ErrorCode;

    const LINUX: Option<Platform> = Some(Platform::LinuxX64);

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn a_catalogued_file_shows_its_build() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = make_zip(&[
            ("libcogwork.so", b"elf"),
            ("assets/lang/en_us.lang", b"mod.cogwork.name = Cogwork\n"),
        ]);
        let path = write(tmp.path(), "cogwork.zip", &zip);
        let mut v = build("cogwork", "0.2.0", ABI, Channel::Release, &[]);
        v.sha256 = sha256_hex(&zip);
        let c = catalog(vec![catalog_mod("cogwork", Origin::Index, vec![v])], &[]);
        let installed = lock(vec![entry("cogwork", &[], Some(ABI))]);

        let got = inspect(&path, &c, Some(ABI), LINUX, &installed).unwrap();
        assert!(got.problem.is_none());
        assert!(got.fits_system);
        assert_eq!(got.name.as_deref(), Some("Cogwork"));
        assert_eq!(got.replaces.as_deref(), Some("0.1.0"));
        let found = got.catalog_match.unwrap();
        assert!(found.fits_version);
        assert_eq!(found.build.trust, Trust::Reviewed);
        assert_eq!(found.build.version, "0.2.0");

        let elsewhere = inspect(&path, &c, Some("0000000000000000"), None, &lock(vec![])).unwrap();
        assert!(!elsewhere.fits_system);
        assert!(!elsewhere.catalog_match.unwrap().fits_version);
    }

    #[test]
    fn a_file_that_is_not_a_mod_is_described_with_its_problem() {
        let tmp = tempfile::tempdir().unwrap();
        let c = catalog(vec![], &[]);
        let path = write(tmp.path(), "x.zip", &make_zip(&[("run.exe", b"")]));
        let got = inspect(&path, &c, Some(ABI), LINUX, &lock(vec![])).unwrap();
        assert!(got.archive.is_none());
        assert_eq!(got.problem.unwrap().code, ErrorCode::ModArchiveInvalid);

        let path = write(tmp.path(), "base.zip", &make_zip(&[("libbase.so", b"")]));
        let got = inspect(&path, &c, Some(ABI), LINUX, &lock(vec![])).unwrap();
        assert_eq!(got.problem.unwrap().code, ErrorCode::ModIdReserved);
    }

    #[test]
    fn a_local_entry_is_unverified() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = make_zip(&[("libmytweak.so", b"elf")]);
        let path = write(tmp.path(), "my tweak.zip", &zip);
        let info = archive::inspect(std::fs::File::open(&path).unwrap(), None).unwrap();
        let e = local_entry(&info, &path, &path, &sha256_hex(&zip)).unwrap();
        assert_eq!(e.trust, Trust::Unverified);
        assert_eq!(e.name, "mytweak");
        assert!(e.abi.is_none() && e.catalog_key().is_none());
        assert_eq!(
            e.origin,
            Origin::File {
                name: "my tweak.zip".into()
            }
        );
    }
}
