//! One game version's mods. The folders are the state: `mods/<id>.zip` is on and is passed to the
//! game, `mods-off/<id>.zip` is off. Turning a mod on or off is a rename.

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

use super::archive::{self, Manifest};
use super::index::Index;
use super::{BASE, Dirs, ModError, abi, log, valid_id, verify};

#[derive(Debug, Clone)]
pub struct Installed {
    pub manifest: Manifest,
    pub sha256: String,
    pub on: bool,
    /// The zip has no `weft-mod.toml` for this id, so only the id (its file name) is known.
    pub bare: bool,
}

pub struct Profile {
    /// The version's mod ABI, once it was worked out.
    pub abi: Option<String>,
    pub on: PathBuf,
    off: PathBuf,
}

impl Profile {
    pub fn new(dirs: &Dirs, tag: &str) -> Self {
        let root = dirs.profile(tag);
        Self {
            abi: abi::cached(dirs, tag),
            on: root.join("mods"),
            off: root.join("mods-off"),
        }
    }

    fn file(&self, id: &str, on: bool) -> PathBuf {
        let dir = if on { &self.on } else { &self.off };
        dir.join(format!("{id}.zip"))
    }

    /// The installed mods by id: every zip named `<id>.zip` in the two folders, also one without
    /// a `weft-mod.toml`. Changes nothing. When both folders hold an id, the one in `mods-off`
    /// counts.
    pub fn read(&self) -> io::Result<BTreeMap<String, Installed>> {
        let mut mods = BTreeMap::new();
        for on in [false, true] {
            for path in files(if on { &self.on } else { &self.off })? {
                let id = path.file_stem().unwrap_or_default().to_string_lossy();
                let Some((manifest, sha256)) = read_cached(&path) else {
                    continue;
                };
                if mods.contains_key(id.as_ref()) {
                    continue;
                }
                let (manifest, bare) = match manifest.filter(|m| m.id == id) {
                    Some(m) => (m, false),
                    None => (unknown(&id), true),
                };
                let file = Installed {
                    manifest,
                    sha256,
                    on,
                    bare,
                };
                mods.insert(id.into_owned(), file);
            }
        }
        Ok(mods)
    }

    /// Moves a file out of the way into `mods-off` as `<name>.old`, where nothing reads it.
    fn set_aside(&self, path: &Path) -> io::Result<()> {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        log(format_args!("setting aside {}", path.display()));
        std::fs::rename(path, self.off.join(format!("{name}.old")))
    }

    pub fn set(&self, id: &str, on: bool) -> io::Result<()> {
        let (from, to) = (self.file(id, !on), self.file(id, on));
        if from.exists() {
            std::fs::create_dir_all(if on { &self.on } else { &self.off })?;
            if to.exists() {
                self.set_aside(&to)?;
            }
            std::fs::rename(from, to)?;
        }
        Ok(())
    }

    pub fn remove(&self, id: &str) -> io::Result<()> {
        for on in [true, false] {
            match std::fs::remove_file(self.file(id, on)) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
        }
        Ok(())
    }

    /// Puts a checked zip in place: where the installed one was, or on for a new mod.
    pub fn place(&self, id: &str, zip: &Path) -> io::Result<()> {
        std::fs::create_dir_all(&self.on)?;
        let on = !self.file(id, false).exists();
        std::fs::rename(zip, self.file(id, on))
    }

    /// Whether an installed build may be on: not revoked, and built for this version.
    pub fn fits(&self, m: &Installed, index: &Index) -> Result<(), ModError> {
        if let Some(r) = index.revoked(&m.sha256) {
            return Err(ModError::Revoked(r.reason.clone()));
        }
        let abi = self.abi.as_ref();
        if !m.bare && abi.is_some_and(|abi| *abi != m.manifest.abi) {
            return Err(ModError::WrongVersion);
        }
        Ok(())
    }

    /// Turns on `id` and, first, everything it needs. Fails if one of them isn't installed or
    /// doesn't fit.
    pub fn enable(&self, id: &str, index: &Index) -> Result<(), ModError> {
        let mods = self.read()?;
        let mut todo = vec![id.to_string()];
        let mut needed = Vec::new();
        while let Some(id) = todo.pop() {
            if needed.contains(&id) {
                continue;
            }
            let Some(m) = mods.get(&id) else {
                if id == BASE {
                    continue;
                }
                let name = index.find(&id).map_or(id.clone(), |m| m.name.clone());
                return Err(ModError::NeedsMod(name));
            };
            self.fits(m, index)?;
            todo.extend(m.manifest.deps.iter().cloned());
            needed.push(id);
        }
        for id in needed {
            self.set(&id, true)?;
        }
        Ok(())
    }

    /// Keeps the set loadable: sets aside every file in `mods` that isn't an installed mod, then
    /// turns off every mod that doesn't fit or needs a mod that is off or missing. Runs after
    /// every change and before launch. Deletes nothing.
    pub fn settle(&self, index: &Index) -> io::Result<BTreeMap<String, Installed>> {
        std::fs::create_dir_all(&self.on)?;
        std::fs::create_dir_all(&self.off)?;
        let mut mods = self.read()?;
        for path in files(&self.on)? {
            let id = path.file_stem().unwrap_or_default().to_string_lossy();
            let listed = mods
                .get(id.as_ref())
                .is_some_and(|m| m.on && path == self.file(&id, true));
            if !listed {
                self.set_aside(&path)?;
            }
        }
        loop {
            let broken = mods.iter().find(|(_, m)| {
                m.on && (self.fits(m, index).is_err()
                    || m.manifest.deps.iter().any(|d| !met(&mods, d)))
            });
            let Some((id, _)) = broken else {
                return Ok(mods);
            };
            let id = id.clone();
            log(format_args!(
                "turning off {id}: it doesn't fit, or a mod it needs is off"
            ));
            self.set(&id, false)?;
            mods.get_mut(&id).unwrap().on = false;
        }
    }
}

/// Whether a mod's dependency is met: installed and on. `base` ships with the game, so it's met
/// unless a copy of it is installed here and off.
fn met(mods: &BTreeMap<String, Installed>, dep: &str) -> bool {
    mods.get(dep).map_or(dep == BASE, |m| m.on)
}

/// All that's known of a zip without a `weft-mod.toml`.
fn unknown(id: &str) -> Manifest {
    Manifest {
        id: id.to_string(),
        name: id.to_string(),
        version: String::new(),
        abi: String::new(),
        deps: Vec::new(),
    }
}

/// The entries of a folder that may not exist yet. Hidden files are left alone: macOS writes
/// `.DS_Store` and `._<name>` into folders on its own.
fn files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let shown = |e: &std::fs::DirEntry| !e.file_name().to_string_lossy().starts_with('.');
    match std::fs::read_dir(dir) {
        Ok(entries) => Ok(entries.flatten().filter(shown).map(|e| e.path()).collect()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

/// Manifest (if it has one) and SHA-256 of an installed zip, remembered by path, size and
/// modification time. `None` if the file isn't a zip named `<id>.zip`.
fn read_cached(path: &Path) -> Option<(Option<Manifest>, String)> {
    type Key = (PathBuf, u64, SystemTime);
    type Read = (Option<Manifest>, String);
    static CACHE: LazyLock<Mutex<HashMap<Key, Read>>> = LazyLock::new(Default::default);
    let meta = std::fs::metadata(path).ok()?;
    let stem_ok = path.extension().is_some_and(|e| e == "zip")
        && path
            .file_stem()
            .is_some_and(|s| valid_id(&s.to_string_lossy()));
    if !meta.is_file() || !stem_ok {
        return None;
    }
    let key = (path.to_path_buf(), meta.len(), meta.modified().ok()?);
    if let Some(hit) = CACHE.lock().unwrap().get(&key) {
        return Some(hit.clone());
    }
    let manifest = archive::installed_manifest(path)
        .map_err(|e| log(format_args!("{e}")))
        .ok()?;
    let sha256 = verify::sha256(&std::fs::read(path).ok()?);
    CACHE
        .lock()
        .unwrap()
        .insert(key, (manifest.clone(), sha256.clone()));
    Some((manifest, sha256))
}

#[cfg(test)]
mod tests {
    use super::super::archive::tests::{ABI, manifest, mod_zip, temp_dir, write_zip};
    use super::super::index::Revoked;
    use super::*;

    fn profile(name: &str) -> Profile {
        Profile::new(&Dirs::new(temp_dir(name)), "v1")
    }

    /// A profile whose version has this mod ABI.
    fn profile_with_abi(name: &str, abi: &str) -> Profile {
        let dirs = Dirs::new(temp_dir(name));
        std::fs::create_dir_all(dirs.profile("v1")).unwrap();
        std::fs::write(dirs.profile("v1").join("mod-abi"), abi).unwrap();
        Profile::new(&dirs, "v1")
    }

    fn on(p: &Profile) -> Vec<String> {
        let mods = p.read().unwrap();
        mods.into_iter()
            .filter(|(_, m)| m.on)
            .map(|(id, _)| id)
            .collect()
    }

    #[test]
    fn turning_off_a_mod_turns_off_what_needs_it() {
        let p = profile("settle-off");
        mod_zip(&p.on, "tubes", "1.0.0", &["base"]);
        mod_zip(&p.on, "cogwork", "1.0.0", &["tubes"]);
        mod_zip(&p.on, "lanterns", "1.0.0", &[]);
        let index = Index::default();
        assert_eq!(on(&p), ["cogwork", "lanterns", "tubes"]);
        p.set("tubes", false).unwrap();
        p.settle(&index).unwrap();
        assert_eq!(on(&p), ["lanterns"]);

        p.enable("cogwork", &index).unwrap();
        assert_eq!(on(&p), ["cogwork", "lanterns", "tubes"]);
    }

    #[test]
    fn turning_on_needs_installed_dependencies() {
        let p = profile("enable-missing");
        mod_zip(&p.off, "cogwork", "1.0.0", &["tubes"]);
        let err = p.enable("cogwork", &Index::default()).unwrap_err();
        assert!(
            matches!(err, ModError::NeedsMod(ref n) if n == "tubes"),
            "{err:?}"
        );
        assert!(on(&p).is_empty());
    }

    #[test]
    fn revoked_mods_and_hand_placed_files_are_turned_off() {
        let p = profile("settle-revoked");
        let zip = mod_zip(&p.on, "bad", "1.0.0", &[]);
        mod_zip(&p.on, "needs_bad", "1.0.0", &["bad"]);
        std::fs::write(p.on.join("notes.txt"), "hi").unwrap();
        std::fs::write(p.on.join("fake.zip"), "not a zip").unwrap();
        let sha256 = verify::sha256(&std::fs::read(zip).unwrap());
        let index = Index {
            revoked: vec![Revoked {
                sha256,
                reason: None,
            }],
            ..Index::default()
        };
        let mods = p.settle(&index).unwrap();
        assert_eq!(mods.len(), 2);
        assert!(on(&p).is_empty());
        assert!(p.off.join("notes.txt.old").exists() && p.off.join("fake.zip.old").exists());
        assert!(matches!(
            p.enable("bad", &index),
            Err(ModError::Revoked(None))
        ));
    }

    #[test]
    fn zips_without_a_manifest_and_base_are_listed_and_kept() {
        // A known version: an unknown file isn't turned off for its ABI.
        let p = profile_with_abi("settle-bare", ABI);
        write_zip(&p.on, "oldmod.zip", &[("liboldmod.so", "lib")]);
        write_zip(
            &p.off,
            "base.zip",
            &[("weft-mod.toml", &manifest("base", "1.0.0", &[]))],
        );
        mod_zip(&p.on, "cogwork", "1.0.0", &["base", "oldmod"]);
        std::fs::write(p.on.join(".DS_Store"), "").unwrap();
        let index = Index::default();
        let mods = p.settle(&index).unwrap();
        assert!(mods["oldmod"].bare && mods["oldmod"].manifest.name == "oldmod");
        assert!(!mods["base"].bare && p.on.join(".DS_Store").exists());
        // Base is installed here and off, so what needs it is turned off, and turned on with it.
        assert_eq!(on(&p), ["oldmod"]);
        p.enable("cogwork", &index).unwrap();
        assert_eq!(on(&p), ["base", "cogwork", "oldmod"]);
    }

    #[test]
    fn builds_for_another_version_and_duplicates_are_turned_off() {
        let p = profile_with_abi("settle-abi", &"0".repeat(16));
        mod_zip(&p.on, "other_abi", "1.0.0", &[]);
        mod_zip(&p.on, "twice", "1.0.0", &[]);
        mod_zip(&p.off, "twice", "1.0.0", &[]);
        let index = Index::default();
        p.settle(&index).unwrap();
        assert!(on(&p).is_empty());
        assert!(!p.on.join("twice.zip").exists() && p.off.join("twice.zip.old").exists());
        assert!(matches!(
            p.enable("other_abi", &index),
            Err(ModError::WrongVersion)
        ));
    }
}
