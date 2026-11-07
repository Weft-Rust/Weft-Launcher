//! A mod zip: `weft-mod.toml`, the library for each system, and `assets/`. The launcher never
//! unpacks it (the game does), but it checks the zip before it gets in.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use super::{BASE, ModError, is_hex, log, valid_id};

pub const MAX_ZIP: u64 = 512 << 20;
const MAX_ENTRIES: usize = 20_000;
const MAX_UNPACKED: u64 = 1 << 30;
const MAX_MANIFEST: u64 = 64 << 10;

/// `weft-mod.toml`, written by the mod's build.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub abi: String,
    #[serde(default)]
    pub deps: Vec<String>,
}

pub fn library_name(id: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{id}.dll")
    } else if cfg!(target_os = "macos") {
        format!("lib{id}.dylib")
    } else {
        format!("lib{id}.so")
    }
}

/// Checks a mod zip and returns its manifest.
pub fn inspect(path: &Path) -> Result<Manifest, ModError> {
    let not_a_mod = |why: String| ModError::NotAMod(format!("{}: {why}", path.display()));
    let file = File::open(path)?;
    if file.metadata()?.len() > MAX_ZIP {
        return Err(not_a_mod("larger than 512 MB".into()));
    }
    let mut zip = ZipArchive::new(file).map_err(|e| not_a_mod(e.to_string()))?;
    if zip.len() > MAX_ENTRIES {
        return Err(not_a_mod(format!("{} entries", zip.len())));
    }
    let manifest = read_manifest(&mut zip).map_err(not_a_mod)?;
    // `base` ships with the game; a file can't stand in for it.
    if manifest.id == BASE {
        return Err(not_a_mod("base ships with the game".into()));
    }
    let id = &manifest.id;
    let allowed = [
        "weft-mod.toml".to_string(),
        format!("{id}.dll"),
        format!("lib{id}.so"),
        format!("lib{id}.dylib"),
    ];
    let mut unpacked = 0u64;
    for i in 0..zip.len() {
        let entry = zip.by_index_raw(i).map_err(|e| not_a_mod(e.to_string()))?;
        let name = entry.name();
        let link = entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000);
        let safe = !name.contains('\\')
            && !name.starts_with('/')
            && !name.split('/').any(|part| part == "..")
            && entry.enclosed_name().is_some();
        if link || !safe || !(allowed.iter().any(|a| a == name) || name.starts_with("assets/")) {
            return Err(not_a_mod(format!("unexpected entry {name:?}")));
        }
        unpacked += entry.size();
        if unpacked > MAX_UNPACKED {
            return Err(not_a_mod("unpacks to more than 1 GB".into()));
        }
    }
    if zip.by_name(&library_name(id)).is_err() {
        return Err(ModError::NoLibraryForThisSystem);
    }
    Ok(manifest)
}

/// The manifest of a zip that is already installed, read without the checks above. `None` if it
/// has no valid `weft-mod.toml`. Fails if the file isn't a zip.
pub fn installed_manifest(path: &Path) -> Result<Option<Manifest>, ModError> {
    let mut zip = ZipArchive::new(File::open(path)?)
        .map_err(|e| ModError::NotAMod(format!("{}: {e}", path.display())))?;
    match read_manifest(&mut zip) {
        Ok(m) => Ok(Some(m)),
        Err(why) => {
            log(format_args!("{}: {why}", path.display()));
            Ok(None)
        }
    }
}

fn read_manifest(zip: &mut ZipArchive<File>) -> Result<Manifest, String> {
    let mut text = String::new();
    zip.by_name("weft-mod.toml")
        .map_err(|e| format!("weft-mod.toml: {e}"))?
        .take(MAX_MANIFEST + 1)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() as u64 > MAX_MANIFEST {
        return Err("weft-mod.toml is larger than 64 KB".into());
    }
    let m: Manifest = toml::from_str(&text).map_err(|e| e.to_string())?;
    let ok = valid_id(&m.id)
        && semver::Version::parse(&m.version).is_ok()
        && is_hex(&m.abi, 16)
        && m.deps.iter().all(|d| valid_id(d) && *d != m.id);
    if !ok {
        return Err(format!("invalid weft-mod.toml: {m:?}"));
    }
    Ok(m)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use zip::write::FileOptions;

    pub const ABI: &str = "f470b1cbb1f9ad91";

    pub fn manifest(id: &str, version: &str, deps: &[&str]) -> String {
        let deps: Vec<String> = deps.iter().map(|d| format!("{d:?}")).collect();
        format!(
            "id = {id:?}\nname = {:?}\nversion = {version:?}\nabi = {ABI:?}\ndeps = [{}]\n",
            id.to_uppercase(),
            deps.join(", ")
        )
    }

    /// Writes a zip with these entries (name, content) and returns its path.
    pub fn write_zip(dir: &Path, file: &str, entries: &[(&str, &str)]) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(file);
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        for (name, body) in entries {
            zip.start_file(*name, FileOptions::default()).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    /// A valid mod zip for this system.
    pub fn mod_zip(dir: &Path, id: &str, version: &str, deps: &[&str]) -> PathBuf {
        let toml = manifest(id, version, deps);
        let lib = library_name(id);
        let entries = [
            ("weft-mod.toml", toml.as_str()),
            (&lib, "lib"),
            ("assets/a.png", "png"),
        ];
        write_zip(dir, &format!("{id}.zip"), &entries)
    }

    pub fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("weft-mods-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_mod_zip_passes() {
        let dir = temp_dir("archive-ok");
        let m = inspect(&mod_zip(&dir, "cogwork", "0.2.0", &["base"])).unwrap();
        assert_eq!(
            (m.id.as_str(), m.deps),
            ("cogwork", vec!["base".to_string()])
        );
    }

    #[test]
    fn bad_zips_are_refused() {
        let dir = temp_dir("archive-bad");
        let toml = manifest("m", "1.0.0", &[]);
        let lib = library_name("m");
        let cases: &[(&[(&str, &str)], &str)] = &[
            (&[("readme.txt", "")], "NotAMod"),
            (&[("weft-mod.toml", "id = 3")], "NotAMod"),
            (
                &[("weft-mod.toml", &toml), (&lib, ""), ("../x", "")],
                "NotAMod",
            ),
            (
                &[("weft-mod.toml", &toml), (&lib, ""), ("assets/../../x", "")],
                "NotAMod",
            ),
            (
                &[("weft-mod.toml", &toml), (&lib, ""), ("/etc/x", "")],
                "NotAMod",
            ),
            (
                &[("weft-mod.toml", &toml), (&lib, ""), ("assets\\x", "")],
                "NotAMod",
            ),
            (
                &[("weft-mod.toml", &toml), (&lib, ""), ("other.dll", "")],
                "NotAMod",
            ),
            (
                &[("weft-mod.toml", &toml), ("assets/a", "")],
                "NoLibraryForThisSystem",
            ),
        ];
        for (i, (entries, want)) in cases.iter().enumerate() {
            let err = inspect(&write_zip(&dir, &format!("{i}.zip"), entries)).unwrap_err();
            assert!(format!("{err:?}").starts_with(want), "case {i}: {err:?}");
        }
        std::fs::write(dir.join("junk.zip"), "not a zip").unwrap();
        assert!(matches!(
            inspect(&dir.join("junk.zip")),
            Err(ModError::NotAMod(_))
        ));
    }
}
