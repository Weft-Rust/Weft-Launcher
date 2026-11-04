//! What a mod zip may contain before it is stored: the mod's library for each system and its
//! `assets/`, nothing else. The launcher never unpacks or runs a mod; this only reads the zip's
//! table of contents, so a strange file is refused before the game ever sees it.

use serde::Serialize;
use std::io::Read;
use std::path::{Component, Path};

use super::error::ModsError;
use super::index::is_mod_id;

const MAX_ENTRIES: usize = 20_000;
const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_RATIO: u64 = 200;
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

/// `windows-x64`, `linux-x64` or `macos-arm64`; empty where the game isn't built.
pub fn current_platform() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "windows-x64"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-x64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "macos-arm64"
    } else {
        ""
    }
}

fn platform_of_library(name: &str) -> Option<(&'static str, &str)> {
    if let Some(id) = name.strip_suffix(".dll") {
        return Some(("windows-x64", id));
    }
    let rest = name.strip_prefix("lib")?;
    if let Some(id) = rest.strip_suffix(".so") {
        return Some(("linux-x64", id));
    }
    rest.strip_suffix(".dylib").map(|id| ("macos-arm64", id))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInfo {
    pub id: String,
    pub libraries: Vec<String>,
    pub platforms: Vec<String>,
    pub has_assets: bool,
    pub entries: usize,
}

fn bad(reason: impl Into<String>) -> ModsError {
    ModsError::ArchiveInvalid(reason.into())
}

/// Checks the layout of a mod zip. With `expected_id`, the library names must say that id.
pub fn inspect<R: Read + std::io::Seek>(
    reader: R,
    expected_id: Option<&str>,
) -> Result<ArchiveInfo, ModsError> {
    let mut zip = zip::ZipArchive::new(reader)?;
    if zip.len() > MAX_ENTRIES {
        return Err(bad("too many files"));
    }

    let mut id: Option<String> = expected_id.map(str::to_string);
    let mut libraries = Vec::new();
    let mut platforms = Vec::new();
    let mut has_assets = false;
    let mut total: u64 = 0;

    for i in 0..zip.len() {
        let entry = zip.by_index_raw(i)?;
        let raw = entry.name().to_string();
        if raw.contains('\\') || raw.contains('\0') {
            return Err(bad(format!("odd file name {raw:?}")));
        }
        let Some(path) = entry.enclosed_name().map(Path::to_path_buf) else {
            return Err(bad(format!("unsafe path {raw:?}")));
        };
        if path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(bad(format!("unsafe path {raw:?}")));
        }
        if let Some(mode) = entry.unix_mode()
            && mode & 0o170000 == 0o120000
        {
            return Err(bad(format!("symbolic link {raw:?}")));
        }
        total = total.saturating_add(entry.size());
        if total > MAX_TOTAL_BYTES {
            return Err(bad("unpacks to more than 1 GB"));
        }
        if entry.size() > 1024 * 1024 && entry.size() / entry.compressed_size().max(1) > MAX_RATIO {
            return Err(bad(format!("{raw} is compressed suspiciously well")));
        }

        let mut parts = path.components();
        let first = parts
            .next()
            .and_then(|c| c.as_os_str().to_str())
            .unwrap_or("");
        let nested = parts.next().is_some();

        if first == "assets" {
            has_assets = true;
            continue;
        }
        if nested || entry.is_dir() {
            return Err(bad(format!("unexpected folder {raw:?}")));
        }
        let Some((platform, lib_id)) = platform_of_library(first) else {
            return Err(bad(format!("unexpected file {raw:?}")));
        };
        if !is_mod_id(lib_id) {
            return Err(bad(format!("library name {raw:?}")));
        }
        match &id {
            Some(known) if known != lib_id => {
                return Err(bad(format!(
                    "{raw} belongs to mod {lib_id:?}, not {known:?}"
                )));
            }
            Some(_) => {}
            None => id = Some(lib_id.to_string()),
        }
        if platforms.contains(&platform.to_string()) {
            return Err(bad(format!("two libraries for {platform}")));
        }
        platforms.push(platform.to_string());
        libraries.push(first.to_string());
    }

    let Some(id) = id.filter(|_| !libraries.is_empty()) else {
        return Err(bad("no mod library inside"));
    };
    platforms.sort();
    libraries.sort();
    Ok(ArchiveInfo {
        id,
        libraries,
        platforms,
        has_assets,
        entries: zip.len(),
    })
}

/// The name and description a mod gives itself in `assets/lang/en_us.lang`. Shown as what the
/// file says it is, nothing more.
pub fn read_lang(path: &Path, id: &str) -> (Option<String>, Option<String>) {
    let read = || -> Option<String> {
        let file = std::fs::File::open(path).ok()?;
        let mut zip = zip::ZipArchive::new(file).ok()?;
        let entry = zip.by_name("assets/lang/en_us.lang").ok()?;
        let mut text = String::new();
        entry.take(64 * 1024).read_to_string(&mut text).ok()?;
        Some(text)
    };
    let Some(text) = read() else {
        return (None, None);
    };
    let value = |key: &str| {
        text.lines().find_map(|l| {
            let (k, v) = l.split_once('=')?;
            (k.trim() == key)
                .then(|| v.trim().chars().take(140).collect::<String>())
                .filter(|v| !v.is_empty())
        })
    };
    (
        value(&format!("mod.{id}.name")),
        value(&format!("mod.{id}.description")),
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::write::FileOptions;

    pub fn make_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            for (name, body) in files {
                if name.ends_with('/') {
                    zip.add_directory(*name, FileOptions::default()).unwrap();
                } else {
                    zip.start_file(*name, FileOptions::default()).unwrap();
                    zip.write_all(body).unwrap();
                }
            }
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    fn check(files: &[(&str, &[u8])], id: Option<&str>) -> Result<ArchiveInfo, ModsError> {
        inspect(Cursor::new(make_zip(files)), id)
    }

    #[test]
    fn a_real_mod_layout_passes() {
        let info = check(
            &[
                ("cogwork.dll", b"pe"),
                ("libcogwork.so", b"elf"),
                ("libcogwork.dylib", b"macho"),
                ("assets/", b""),
                ("assets/lang/en_us.lang", b"mod.cogwork.name = Cogwork"),
            ],
            None,
        )
        .unwrap();
        assert_eq!(info.id, "cogwork");
        assert_eq!(info.platforms, ["linux-x64", "macos-arm64", "windows-x64"]);
        assert!(info.has_assets);
    }

    #[test]
    fn anything_else_is_refused() {
        let cases: &[&[(&str, &[u8])]] = &[
            &[("cogwork.dll", b""), ("run.exe", b"")],
            &[("cogwork.dll", b""), ("libother.so", b"")],
            &[("cogwork/cogwork.dll", b"")],
            &[("../cogwork.dll", b"")],
            &[("assets/x.png", b"")],
            &[("Cogwork.dll", b"")],
        ];
        for files in cases {
            assert!(check(files, None).is_err(), "{files:?}");
        }
        assert!(check(&[("cogwork.dll", b"")], Some("structures")).is_err());
    }
}
