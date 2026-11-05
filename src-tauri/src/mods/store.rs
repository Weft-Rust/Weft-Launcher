//! The files behind the mod sets: `mods/store/<sha256>.zip` holds every verified mod once, each
//! profile's `mods.lock.json` lists what is installed, and the profile's `mods/` folder holds
//! exactly the turned-on mods, each as its own copy of the store file (never a hard link, so a
//! write to one can't reach the store or another version). A mod that is off is not in that folder at all: the engine runs
//! code even from mods it was told to skip, so leaving the file out is the only real "off".
//!
//! [`admit`] is the one way into the store: it hashes the file, checks the zip and the platform.
//! The callers hold `ModsLock` whenever they write a lock file or delete from the store.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::archive::{self, ArchiveInfo};
use super::error::ModsError;
use super::index::{Platform, is_mod_id, is_sha256};
use super::paths::{LOCK_FILE, Paths, REMOVED_FILE, unique_suffix, write_atomic};
use super::profile::{Lock, LockEntry};
use crate::download::sha256_file;

pub fn read_lock(paths: &Paths, tag: &str) -> Result<Lock, ModsError> {
    read_lock_file(&paths.lock_file(tag)?)
}

/// A lock file names files and folders by its ids and hashes, so they are checked before use:
/// a damaged or hand-edited file is an error, never a path.
fn check_lock(lock: &Lock) -> Result<(), ModsError> {
    if lock.schema > 1 {
        return Err(ModsError::LockInvalid(format!(
            "schema {} is from a newer launcher",
            lock.schema
        )));
    }
    for m in &lock.mods {
        if !is_mod_id(&m.id) {
            return Err(ModsError::LockInvalid(format!("mod id {:?}", m.id)));
        }
        if !is_sha256(&m.sha256) {
            return Err(ModsError::LockInvalid(format!("sha256 of {}", m.id)));
        }
    }
    Ok(())
}

fn read_lock_file(path: &Path) -> Result<Lock, ModsError> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let lock: Lock = serde_json::from_slice(&bytes)
                .map_err(|e| ModsError::LockInvalid(e.to_string()))?;
            check_lock(&lock)?;
            Ok(lock)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Lock::empty()),
        Err(e) => Err(e.into()),
    }
}

/// The mod most recently removed from a version, kept so the removal can be undone. Its store
/// file is kept until the version's next change.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    pub entry: LockEntry,
    /// Mods the removal turned off because they needed it.
    #[serde(default)]
    pub also_disabled: Vec<String>,
}

fn read_removed_file(path: &Path) -> Option<Removed> {
    let removed: Removed = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    (is_mod_id(&removed.entry.id) && is_sha256(&removed.entry.sha256)).then_some(removed)
}

pub fn read_removed(paths: &Paths, tag: &str) -> Result<Option<Removed>, ModsError> {
    Ok(read_removed_file(&paths.removed_file(tag)?))
}

pub fn write_removed(paths: &Paths, tag: &str, removed: &Removed) -> Result<(), ModsError> {
    write_atomic(
        &paths.removed_file(tag)?,
        &serde_json::to_vec_pretty(removed)?,
    )
}

/// The version changed again: its last removal can't be undone any more.
pub fn clear_removed(paths: &Paths, tag: &str) -> Result<(), ModsError> {
    match std::fs::remove_file(paths.removed_file(tag)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

pub fn write_lock(paths: &Paths, tag: &str, lock: &Lock) -> Result<(), ModsError> {
    write_atomic(&paths.lock_file(tag)?, &serde_json::to_vec_pretty(lock)?)
}

/// A copy of `from` at `to`, written beside it and renamed into place. `std::fs::copy` clones
/// the data where the system can (`clonefile` on APFS, `copy_file_range` on Linux, which
/// reflinks on Btrfs and XFS); either way the result is a file of its own.
fn copy_into(from: &Path, to: &Path) -> std::io::Result<()> {
    let tmp = to.with_file_name(format!(
        ".{}.{}.part",
        to.file_name().unwrap_or_default().to_string_lossy(),
        unique_suffix()
    ));
    let result = std::fs::copy(from, &tmp).and_then(|_| std::fs::rename(&tmp, to));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Makes the profile's `mods/` hold exactly the turned-on mods, each with the bytes that were
/// verified at install. A file changed since then is replaced from the store; a changed store
/// file is an error, never handed to the game.
///
/// Idempotent, and safe to interrupt: it works out what to do from the lock and the folder as
/// they are, never from what an earlier run meant to do, and every copy is written beside its
/// target and renamed into place, so a crash leaves at worst a `.part` file (removed by the next
/// run, like any name the lock doesn't have) and some mods not yet copied. Every save runs it,
/// and so does every launch (`service::prepare_launch`, under `ModsLock`), so the folder the
/// game reads is put right before each start whatever happened before.
pub fn reconcile(paths: &Paths, tag: &str, lock: &Lock) -> Result<(), ModsError> {
    let dir = paths.mods_dir(tag)?;
    std::fs::create_dir_all(&dir)?;
    let wanted: Vec<_> = lock.mods.iter().filter(|m| m.enabled).collect();

    for entry in std::fs::read_dir(&dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !wanted.iter().any(|m| format!("{}.zip", m.id) == name) {
            let path = entry.path();
            if path.is_dir() {
                std::fs::remove_dir_all(&path)?;
            } else {
                std::fs::remove_file(&path)?;
            }
        }
    }

    for m in wanted {
        let target = dir.join(format!("{}.zip", m.id));
        if target.exists() && sha256_file(&target)? == m.sha256 {
            continue;
        }
        let _ = std::fs::remove_file(&target);
        let stored = paths.store_object(&m.sha256);
        let actual = sha256_file(&stored).map_err(|_| ModsError::NotInstalled(m.id.clone()))?;
        if actual != m.sha256 {
            return Err(ModsError::Sha256Mismatch {
                expected: m.sha256.clone(),
                actual,
            });
        }
        copy_into(&stored, &target)?;
    }
    Ok(())
}

/// Store objects an install is still working on: downloading, checking, or written to the store
/// but not yet to a lock file. Garbage collection leaves these alone.
#[derive(Default, Clone)]
pub struct Reservations(Arc<Mutex<HashMap<String, usize>>>);

/// Holds a store object until dropped.
pub struct Reservation {
    owner: Reservations,
    sha256: String,
}

impl Reservations {
    pub fn reserve(&self, sha256: &str) -> Reservation {
        *self
            .0
            .lock()
            .unwrap()
            .entry(sha256.to_string())
            .or_default() += 1;
        Reservation {
            owner: self.clone(),
            sha256: sha256.to_string(),
        }
    }

    pub fn held(&self) -> HashSet<String> {
        self.0.lock().unwrap().keys().cloned().collect()
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let mut map = self.owner.0.lock().unwrap();
        if let Some(n) = map.get_mut(&self.sha256) {
            *n -= 1;
            if *n == 0 {
                map.remove(&self.sha256);
            }
        }
    }
}

/// Deletes stored files no profile uses and no install holds. If any lock file can't be read,
/// nothing is deleted: a mod set that can't be read must not lose its files.
pub fn collect_garbage(paths: &Paths, reservations: &Reservations) -> Result<usize, ModsError> {
    // Reservations first: an install releases its hold only after its lock file is written, so
    // whatever isn't held any more is in a lock file read below.
    let mut keep = reservations.held();
    match std::fs::read_dir(paths.profiles_dir()) {
        Ok(entries) => {
            for entry in entries.flatten() {
                if !entry.path().is_dir() {
                    continue;
                }
                let lock = read_lock_file(&entry.path().join(LOCK_FILE))?;
                keep.extend(lock.mods.into_iter().map(|m| m.sha256));
                if let Some(removed) = read_removed_file(&entry.path().join(REMOVED_FILE)) {
                    keep.insert(removed.entry.sha256);
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let mut removed = 0;
    let Ok(entries) = std::fs::read_dir(paths.store_dir()) else {
        return Ok(0);
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(sha) = name.strip_suffix(".zip").filter(|s| is_sha256(s)) else {
            continue;
        };
        if !keep.contains(sha) && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// A deleted game version takes its mod set along. The caller holds `ModsLock`.
pub fn forget_version(paths: &Paths, reservations: &Reservations, tag: &str) {
    if let Ok(dir) = paths.profile_dir(tag) {
        let _ = std::fs::remove_dir_all(dir);
    }
    if let Err(e) = collect_garbage(paths, reservations) {
        eprintln!("mods: garbage collection skipped: {e}");
    }
}

/// A new file in `downloads/` that no other download uses.
pub fn temp_path(paths: &Paths, sha256: &str) -> Result<PathBuf, ModsError> {
    let dir = paths.downloads_dir();
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("mod-{sha256}-{}.part", unique_suffix())))
}

/// What every file in the store passed: its bytes hash to `sha256`, it is a mod zip (of mod `id`,
/// when given), and it has a library for `platform`.
fn check(
    path: &Path,
    sha256: &str,
    id: Option<&str>,
    platform: Option<Platform>,
) -> Result<ArchiveInfo, ModsError> {
    let actual = sha256_file(path)?;
    if actual != sha256 {
        return Err(ModsError::Sha256Mismatch {
            expected: sha256.to_string(),
            actual,
        });
    }
    let info = archive::inspect(std::fs::File::open(path)?, id)?;
    if !platform.is_some_and(|p| info.platforms.contains(&p)) {
        return Err(ModsError::NotForPlatform(info.id));
    }
    Ok(info)
}

/// Checks a downloaded or copied file (see [`check`]) and moves it into the store under its
/// hash. The temporary file is gone afterwards, either way.
pub fn admit(
    paths: &Paths,
    tmp: &Path,
    sha256: &str,
    id: Option<&str>,
    platform: Option<Platform>,
) -> Result<ArchiveInfo, ModsError> {
    let result = (|| {
        let info = check(tmp, sha256, id, platform)?;
        std::fs::File::open(tmp)?.sync_all()?;
        std::fs::create_dir_all(paths.store_dir())?;
        std::fs::rename(tmp, paths.store_object(sha256))?;
        Ok(info)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    result
}

/// The same checks for a build the store already has. `None` when it has none, or only a
/// damaged copy, which a fresh download then replaces (deleting is left to garbage collection,
/// under `ModsLock`); an error when the stored bytes are right but aren't a mod that fits here.
pub fn admit_stored(
    paths: &Paths,
    sha256: &str,
    id: Option<&str>,
    platform: Option<Platform>,
) -> Result<Option<ArchiveInfo>, ModsError> {
    let stored = paths.store_object(sha256);
    if !stored.exists() {
        return Ok(None);
    }
    match check(&stored, sha256, id, platform) {
        Ok(info) => Ok(Some(info)),
        Err(ModsError::Sha256Mismatch { .. }) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Copies a file from the player's computer into the store, refusing it if its bytes are not the
/// ones that were inspected. Only a regular file, and no more than [`archive::MAX_FILE_BYTES`]
/// is read, even from a file that grows meanwhile.
pub fn admit_local(
    paths: &Paths,
    source: &Path,
    sha256: &str,
    id: Option<&str>,
    platform: Option<Platform>,
) -> Result<ArchiveInfo, ModsError> {
    super::inspect::checked_size(source)?;
    let tmp = temp_path(paths, sha256)?;
    let copied = (|| -> Result<(), ModsError> {
        use std::io::Read;
        let max = archive::MAX_FILE_BYTES;
        let mut from = std::fs::File::open(source)?.take(max + 1);
        let mut to = std::fs::File::create(&tmp)?;
        if std::io::copy(&mut from, &mut to)? > max {
            return Err(ModsError::TooLarge("larger than 512 MB".into()));
        }
        Ok(())
    })();
    if let Err(e) = copied {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    admit(paths, &tmp, sha256, id, platform).map_err(|e| match e {
        ModsError::Sha256Mismatch { .. } => ModsError::FileChanged,
        e => e,
    })
}

#[cfg(test)]
mod tests {
    use super::super::archive::tests::make_zip;
    use super::super::profile::tests::{ABI, entry, lock};
    use super::*;
    use crate::download::sha256_hex;

    fn setup() -> (tempfile::TempDir, Paths) {
        let tmp = tempfile::tempdir().unwrap();
        let paths = Paths::new(tmp.path());
        (tmp, paths)
    }

    /// Stores `bytes` and returns their hash.
    fn store(paths: &Paths, bytes: &[u8]) -> String {
        let sha = sha256_hex(bytes);
        std::fs::create_dir_all(paths.store_dir()).unwrap();
        std::fs::write(paths.store_object(&sha), bytes).unwrap();
        sha
    }

    fn installed(id: &str, sha: &str, enabled: bool) -> super::super::profile::LockEntry {
        let mut e = entry(id, &[], Some(ABI));
        e.sha256 = sha.to_string();
        e.enabled = enabled;
        e
    }

    #[test]
    fn reconcile_keeps_only_turned_on_mods() {
        let (_tmp, paths) = setup();
        let a = store(&paths, b"mod a");
        let b = store(&paths, b"mod b");
        let l = lock(vec![installed("a", &a, true), installed("b", &b, false)]);
        let dir = paths.mods_dir("v1").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("stray.zip"), b"x").unwrap();
        std::fs::write(dir.join("b.zip"), b"mod b").unwrap();

        reconcile(&paths, "v1", &l).unwrap();
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, ["a.zip"], "a mod that is off is absent");
        assert_eq!(std::fs::read(dir.join("a.zip")).unwrap(), b"mod a");

        // A changed copy in the profile is put back from the store.
        std::fs::remove_file(dir.join("a.zip")).unwrap();
        std::fs::write(dir.join("a.zip"), b"tampered").unwrap();
        reconcile(&paths, "v1", &l).unwrap();
        assert_eq!(std::fs::read(dir.join("a.zip")).unwrap(), b"mod a");
    }

    /// A reconcile that stopped partway (a crash, a full disk) is finished by the next one, and a
    /// reconcile with nothing to do changes nothing.
    #[test]
    fn an_interrupted_reconcile_is_finished_by_the_next() {
        let (_tmp, paths) = setup();
        let a = store(&paths, b"mod a");
        let b = store(&paths, b"mod b");
        let c = store(&paths, b"mod c");
        let l = lock(vec![
            installed("a", &a, true),
            installed("b", &b, true),
            installed("c", &c, false),
        ]);
        let dir = paths.mods_dir("v1").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        // As a run that died left it: a copy half written beside its target, the mod that was
        // turned off not yet taken away, one mod not copied at all, and one already right.
        std::fs::write(dir.join(".b.zip.123-4.part"), b"mod").unwrap();
        std::fs::write(dir.join("c.zip"), b"mod c").unwrap();
        std::fs::write(dir.join("a.zip"), b"mod a").unwrap();

        reconcile(&paths, "v1", &l).unwrap();
        let listing = || {
            let mut names: Vec<(String, Vec<u8>)> = std::fs::read_dir(&dir)
                .unwrap()
                .map(|e| {
                    let e = e.unwrap();
                    (
                        e.file_name().to_string_lossy().to_string(),
                        std::fs::read(e.path()).unwrap(),
                    )
                })
                .collect();
            names.sort();
            names
        };
        let after = listing();
        assert_eq!(
            after,
            [
                ("a.zip".to_string(), b"mod a".to_vec()),
                ("b.zip".to_string(), b"mod b".to_vec())
            ]
        );
        let modified = std::fs::metadata(dir.join("a.zip"))
            .unwrap()
            .modified()
            .unwrap();

        reconcile(&paths, "v1", &l).unwrap();
        assert_eq!(listing(), after, "again: the same folder");
        assert_eq!(
            std::fs::metadata(dir.join("a.zip"))
                .unwrap()
                .modified()
                .unwrap(),
            modified,
            "a right copy is left alone, not written again"
        );
    }

    /// Contract R4 §7: a version's folder holds copies. Writing into one in place reaches
    /// neither the store nor another version, and the next reconcile puts it right.
    #[test]
    fn profiles_hold_copies_not_links() {
        use std::io::Write;
        let (_tmp, paths) = setup();
        let a = store(&paths, b"mod a");
        let l = lock(vec![installed("a", &a, true)]);
        reconcile(&paths, "v1", &l).unwrap();
        reconcile(&paths, "v2", &l).unwrap();
        let in_v1 = paths.mods_dir("v1").unwrap().join("a.zip");
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(std::fs::metadata(&in_v1).unwrap().nlink(), 1);
            assert_eq!(
                std::fs::metadata(paths.store_object(&a)).unwrap().nlink(),
                1
            );
        }
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .open(&in_v1)
            .unwrap();
        f.write_all(b"evil!").unwrap();
        drop(f);
        assert_eq!(std::fs::read(paths.store_object(&a)).unwrap(), b"mod a");
        let in_v2 = paths.mods_dir("v2").unwrap().join("a.zip");
        assert_eq!(std::fs::read(&in_v2).unwrap(), b"mod a");

        reconcile(&paths, "v1", &l).unwrap();
        assert_eq!(std::fs::read(&in_v1).unwrap(), b"mod a");
        let names: Vec<String> = std::fs::read_dir(paths.mods_dir("v1").unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, ["a.zip"], "no temporary file is left");
    }

    #[test]
    fn reconcile_refuses_a_changed_store_file() {
        let (_tmp, paths) = setup();
        let a = store(&paths, b"mod a");
        std::fs::write(paths.store_object(&a), b"changed").unwrap();
        let l = lock(vec![installed("a", &a, true)]);
        assert!(matches!(
            reconcile(&paths, "v1", &l),
            Err(ModsError::Sha256Mismatch { .. })
        ));
        assert!(!paths.mods_dir("v1").unwrap().join("a.zip").exists());
    }

    #[test]
    fn garbage_collection_is_careful() {
        let (_tmp, paths) = setup();
        let reservations = Reservations::default();
        let used = store(&paths, b"used");
        let unused = store(&paths, b"unused");
        let in_flight = store(&paths, b"in flight");
        write_lock(&paths, "v1", &lock(vec![installed("a", &used, false)])).unwrap();

        let hold = reservations.reserve(&in_flight);
        assert_eq!(collect_garbage(&paths, &reservations).unwrap(), 1);
        assert!(paths.store_object(&used).exists());
        assert!(!paths.store_object(&unused).exists());
        assert!(
            paths.store_object(&in_flight).exists(),
            "held by an install"
        );

        drop(hold);
        assert!(reservations.held().is_empty());

        // One unreadable lock file: nothing at all is deleted.
        let dir = paths.profile_dir("v2").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(LOCK_FILE), b"{ not json").unwrap();
        assert!(collect_garbage(&paths, &reservations).is_err());
        assert!(paths.store_object(&in_flight).exists());

        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(collect_garbage(&paths, &reservations).unwrap(), 1);
        assert!(paths.store_object(&used).exists());
    }

    #[test]
    fn reservations_count() {
        let r = Reservations::default();
        let a = r.reserve("x");
        let b = r.reserve("x");
        drop(a);
        assert!(r.held().contains("x"));
        drop(b);
        assert!(r.held().is_empty());
    }

    #[test]
    fn temporary_files_never_collide() {
        let (_tmp, paths) = setup();
        let sha = "a".repeat(64);
        assert_ne!(
            temp_path(&paths, &sha).unwrap(),
            temp_path(&paths, &sha).unwrap()
        );
    }

    #[test]
    fn admitting_checks_the_file() {
        let (tmp, paths) = setup();
        let linux = Some(Platform::LinuxX64);
        let zip = make_zip(&[("libcogwork.so", b"elf")]);
        let sha = sha256_hex(&zip);
        let source = tmp.path().join("cogwork.zip");
        std::fs::write(&source, &zip).unwrap();

        assert!(matches!(
            admit_local(&paths, &source, &"0".repeat(64), None, linux),
            Err(ModsError::FileChanged)
        ));
        assert!(matches!(
            admit_local(&paths, &source, &sha, None, Some(Platform::WindowsX64)),
            Err(ModsError::NotForPlatform(_))
        ));
        assert!(matches!(
            admit_local(&paths, &source, &sha, Some("structures"), linux),
            Err(ModsError::ArchiveInvalid(_))
        ));
        let info = admit_local(&paths, &source, &sha, Some("cogwork"), linux).unwrap();
        assert_eq!(info.id, "cogwork");
        assert_eq!(std::fs::read(paths.store_object(&sha)).unwrap(), zip);
        let leftovers = std::fs::read_dir(paths.downloads_dir()).unwrap().count();
        assert_eq!(leftovers, 0, "no temporary file is left behind");
    }

    /// The store checks what it already has too: right bytes for another mod or system are
    /// refused, and a damaged copy counts as missing, so it is fetched again and replaced.
    #[test]
    fn a_stored_file_is_checked_again() {
        let (_tmp, paths) = setup();
        let linux = Some(Platform::LinuxX64);
        let zip = make_zip(&[("libcogwork.so", b"elf")]);
        let sha = store(&paths, &zip);
        assert_eq!(
            admit_stored(&paths, &sha, Some("cogwork"), linux)
                .unwrap()
                .unwrap()
                .id,
            "cogwork"
        );
        assert!(matches!(
            admit_stored(&paths, &sha, Some("structures"), linux),
            Err(ModsError::ArchiveInvalid(_))
        ));
        assert!(matches!(
            admit_stored(&paths, &sha, Some("cogwork"), Some(Platform::WindowsX64)),
            Err(ModsError::NotForPlatform(_))
        ));
        assert!(
            admit_stored(&paths, &"0".repeat(64), Some("cogwork"), linux)
                .unwrap()
                .is_none()
        );

        std::fs::write(paths.store_object(&sha), b"damaged").unwrap();
        assert!(
            admit_stored(&paths, &sha, Some("cogwork"), linux)
                .unwrap()
                .is_none()
        );
        let fresh = paths.downloads_dir().join("fresh.part");
        std::fs::create_dir_all(paths.downloads_dir()).unwrap();
        std::fs::write(&fresh, &zip).unwrap();
        admit(&paths, &fresh, &sha, Some("cogwork"), linux).unwrap();
        assert_eq!(
            std::fs::read(paths.store_object(&sha)).unwrap(),
            zip,
            "replaced"
        );
    }

    #[test]
    fn admitting_hashes_the_file_itself() {
        let (tmp, paths) = setup();
        let zip = make_zip(&[("libcogwork.so", b"elf")]);
        let file = tmp.path().join("x.part");
        std::fs::write(&file, &zip).unwrap();
        let claimed = sha256_hex(b"something else");
        assert!(matches!(
            admit(
                &paths,
                &file,
                &claimed,
                Some("cogwork"),
                Some(Platform::LinuxX64)
            ),
            Err(ModsError::Sha256Mismatch { .. })
        ));
        assert!(!file.exists() && !paths.store_object(&claimed).exists());
    }

    #[test]
    fn a_removed_mod_keeps_its_file_until_the_next_change() {
        let (_tmp, paths) = setup();
        let a = store(&paths, b"a");
        write_lock(&paths, "v1", &lock(vec![])).unwrap();
        let removed = Removed {
            entry: installed("a", &a, true),
            also_disabled: vec![],
        };
        write_removed(&paths, "v1", &removed).unwrap();
        assert_eq!(
            collect_garbage(&paths, &Reservations::default()).unwrap(),
            0
        );
        assert_eq!(read_removed(&paths, "v1").unwrap().unwrap().entry.id, "a");

        clear_removed(&paths, "v1").unwrap();
        clear_removed(&paths, "v1").unwrap();
        assert!(read_removed(&paths, "v1").unwrap().is_none());
        assert_eq!(
            collect_garbage(&paths, &Reservations::default()).unwrap(),
            1
        );
    }

    #[test]
    fn a_damaged_lock_file_is_refused() {
        let (_tmp, paths) = setup();
        let mut bad = lock(vec![installed("a", &"a".repeat(64), true)]);
        bad.mods[0].id = "../../evil".into();
        write_lock(&paths, "v1", &bad).unwrap();
        assert!(matches!(
            read_lock(&paths, "v1"),
            Err(ModsError::LockInvalid(_))
        ));

        let bad = lock(vec![installed("a", "../x", true)]);
        write_lock(&paths, "v1", &bad).unwrap();
        assert!(matches!(
            read_lock(&paths, "v1"),
            Err(ModsError::LockInvalid(_))
        ));

        let mut newer = lock(vec![]);
        newer.schema = 2;
        write_lock(&paths, "v1", &newer).unwrap();
        assert!(matches!(
            read_lock(&paths, "v1"),
            Err(ModsError::LockInvalid(_))
        ));
    }

    #[test]
    fn forgetting_a_version_frees_its_files() {
        let (_tmp, paths) = setup();
        let a = store(&paths, b"a");
        write_lock(&paths, "v1", &lock(vec![installed("a", &a, true)])).unwrap();
        forget_version(&paths, &Reservations::default(), "v1");
        assert!(!paths.profile_dir("v1").unwrap().exists());
        assert!(!paths.store_object(&a).exists());
    }
}
