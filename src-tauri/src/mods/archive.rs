//! What a mod zip may contain before it is stored: the mod's library for each system and its
//! `assets/`, nothing else. The launcher never unpacks a mod to disk or runs it: it reads the
//! zip's table of contents, then inflates every entry once into nothing, counting, so a strange
//! file, a damaged one or one that lies about its sizes is refused before the game ever sees it.

use serde::Serialize;
use std::io::Read;
use std::path::{Component, Path};
use thiserror::Error;
use ts_rs::TS;

use super::error::ModsError;
use super::index::{Platform, is_mod_id};

pub const MAX_ENTRIES: usize = 20_000;
pub const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_RATIO: u64 = 200;
/// Entries smaller than this are never called a zip bomb, however well they compress.
const RATIO_FLOOR: u64 = 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

/// The system this launcher runs on; `None` where the game isn't built.
pub fn current_platform() -> Option<Platform> {
    Platform::current()
}

fn platform_of_library(name: &str) -> Option<(Platform, &str)> {
    if let Some(id) = name.strip_suffix(".dll") {
        return Some((Platform::WindowsX64, id));
    }
    let rest = name.strip_prefix("lib")?;
    if let Some(id) = rest.strip_suffix(".so") {
        return Some((Platform::LinuxX64, id));
    }
    rest.strip_suffix(".dylib")
        .map(|id| (Platform::MacosArm64, id))
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInfo {
    pub id: String,
    pub libraries: Vec<String>,
    pub platforms: Vec<Platform>,
    pub has_assets: bool,
    pub entries: usize,
}

/// Why a zip is not a mod the launcher will store. The text goes to the player as the error
/// detail.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ArchiveProblem {
    #[error("not a zip file ({0})")]
    NotZip(String),
    #[error("more than {MAX_ENTRIES} files")]
    TooManyEntries,
    #[error("unpacks to more than 1 GB")]
    TooLarge,
    #[error("{0} is compressed suspiciously well")]
    Ratio(String),
    #[error("odd file name {0:?}")]
    OddName(String),
    #[error("unsafe path {0:?}")]
    UnsafePath(String),
    #[error("symbolic link {0:?}")]
    Symlink(String),
    #[error("unexpected folder {0:?}")]
    UnexpectedFolder(String),
    #[error("unexpected file {0:?}")]
    UnexpectedFile(String),
    #[error("library name {0:?}")]
    LibraryName(String),
    #[error("{file} belongs to mod {found:?}, not {expected:?}")]
    WrongMod {
        file: String,
        found: String,
        expected: String,
    },
    #[error("two libraries for {0}")]
    TwoLibraries(&'static str),
    #[error("no mod library inside")]
    NoLibrary,
    #[error("{0} unpacks to more than the zip says it does")]
    SizeMismatch(String),
    #[error("{0} is damaged ({1})")]
    Damaged(String, String),
    #[error("{0} is encrypted")]
    Encrypted(String),
}

/// Checks the layout of a mod zip. With `expected_id`, the library names must say that id.
pub fn inspect<R: Read + std::io::Seek>(
    reader: R,
    expected_id: Option<&str>,
) -> Result<ArchiveInfo, ModsError> {
    use ArchiveProblem as P;
    let not_zip = |e: zip::result::ZipError| P::NotZip(e.to_string());
    let mut zip = zip::ZipArchive::new(reader).map_err(not_zip)?;
    if zip.len() > MAX_ENTRIES {
        return Err(P::TooManyEntries.into());
    }

    let mut id: Option<String> = expected_id.map(str::to_string);
    let mut libraries = Vec::new();
    let mut platforms = Vec::new();
    let mut has_assets = false;
    let mut total: u64 = 0;

    for i in 0..zip.len() {
        let entry = zip.by_index_raw(i).map_err(not_zip)?;
        let raw = entry.name().to_string();
        if raw.contains('\\') || raw.contains('\0') {
            return Err(P::OddName(raw).into());
        }
        if let Some(mode) = entry.unix_mode()
            && mode & 0o170000 == 0o120000
        {
            return Err(P::Symlink(raw).into());
        }
        let Some(path) = entry.enclosed_name().map(Path::to_path_buf) else {
            return Err(P::UnsafePath(raw).into());
        };
        if path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(P::UnsafePath(raw).into());
        }
        // Declared sizes, from the central directory: a fast refusal. What each entry really
        // inflates to is counted below, against these same declared sizes.
        total = total.saturating_add(entry.size());
        if total > MAX_TOTAL_BYTES {
            return Err(P::TooLarge.into());
        }
        if entry.size() > RATIO_FLOOR && entry.size() / entry.compressed_size().max(1) > MAX_RATIO {
            return Err(P::Ratio(raw).into());
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
            return Err(P::UnexpectedFolder(raw).into());
        }
        let Some((platform, lib_id)) = platform_of_library(first) else {
            return Err(P::UnexpectedFile(raw).into());
        };
        if !is_mod_id(lib_id) {
            return Err(P::LibraryName(raw).into());
        }
        match &id {
            Some(known) if known != lib_id => {
                return Err(P::WrongMod {
                    file: raw,
                    found: lib_id.to_string(),
                    expected: known.clone(),
                }
                .into());
            }
            Some(_) => {}
            None => id = Some(lib_id.to_string()),
        }
        if platforms.contains(&platform) {
            return Err(P::TwoLibraries(platform.as_str()).into());
        }
        platforms.push(platform);
        libraries.push(first.to_string());
    }

    let Some(id) = id.filter(|_| !libraries.is_empty()) else {
        return Err(P::NoLibrary.into());
    };
    inflate_all(&mut zip)?;
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

/// Inflates every entry once into nothing, counting what comes out. An entry that inflates to
/// more than its declared size, that is shorter, whose checksum doesn't match, that can't be
/// inflated or that is encrypted refuses the zip: the declared sizes, which the limits were
/// checked against, then hold for what the game unpacks too. Reads at most the declared total,
/// which is at most MAX_TOTAL_BYTES, plus one buffer.
fn inflate_all<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
) -> Result<(), ArchiveProblem> {
    use ArchiveProblem as P;
    let mut buf = vec![0u8; 64 * 1024];
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let name = zip
            .by_index_raw(i)
            .map(|e| e.name().to_string())
            .map_err(|e| P::NotZip(e.to_string()))?;
        let mut entry = match zip.by_index(i) {
            Ok(entry) => entry,
            Err(zip::result::ZipError::UnsupportedArchive(why))
                if why == zip::result::ZipError::PASSWORD_REQUIRED =>
            {
                return Err(P::Encrypted(name));
            }
            Err(e) => return Err(P::Damaged(name, e.to_string())),
        };
        let declared = entry.size();
        let mut actual: u64 = 0;
        loop {
            let n = match entry.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n as u64,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(P::Damaged(name, e.to_string())),
            };
            actual += n;
            if actual > declared {
                return Err(P::SizeMismatch(name));
            }
            if total + actual > MAX_TOTAL_BYTES {
                return Err(P::TooLarge);
            }
        }
        if actual < declared {
            return Err(P::Damaged(name, "shorter than it says".into()));
        }
        total += actual;
    }
    Ok(())
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

    fn problem(result: Result<ArchiveInfo, ModsError>) -> ArchiveProblem {
        match result {
            Err(ModsError::ArchiveInvalid(p)) => p,
            other => panic!("expected an archive problem, got {other:?}"),
        }
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
        assert_eq!(
            info.platforms,
            [
                Platform::WindowsX64,
                Platform::LinuxX64,
                Platform::MacosArm64
            ]
        );
        assert!(info.has_assets);
    }

    #[test]
    fn anything_else_is_refused_for_its_own_reason() {
        use ArchiveProblem as P;
        type Case<'a> = (&'a [(&'a str, &'a [u8])], Option<&'a str>, P);
        let cases: &[Case] = &[
            (
                &[("cogwork.dll", b""), ("run.exe", b"")],
                None,
                P::UnexpectedFile("run.exe".into()),
            ),
            (
                &[("cogwork.dll", b""), ("libother.so", b"")],
                None,
                P::WrongMod {
                    file: "libother.so".into(),
                    found: "other".into(),
                    expected: "cogwork".into(),
                },
            ),
            (
                &[("cogwork/cogwork.dll", b"")],
                None,
                P::UnexpectedFolder("cogwork/cogwork.dll".into()),
            ),
            (
                &[("../cogwork.dll", b"")],
                None,
                P::UnsafePath("../cogwork.dll".into()),
            ),
            (
                &[("/abs/cogwork.dll", b"")],
                None,
                P::UnsafePath("/abs/cogwork.dll".into()),
            ),
            (
                &[("assets\\x.png", b""), ("cogwork.dll", b"")],
                None,
                P::OddName("assets\\x.png".into()),
            ),
            (&[("assets/x.png", b"")], None, P::NoLibrary),
            (
                &[("Cogwork.dll", b"")],
                None,
                P::LibraryName("Cogwork.dll".into()),
            ),
            (
                &[("cogwork.dll", b"")],
                Some("structures"),
                P::WrongMod {
                    file: "cogwork.dll".into(),
                    found: "cogwork".into(),
                    expected: "structures".into(),
                },
            ),
        ];
        for (files, id, want) in cases {
            assert_eq!(&problem(check(files, *id)), want, "{files:?}");
        }
        assert!(matches!(
            problem(inspect(Cursor::new(b"not a zip".to_vec()), None)),
            P::NotZip(_)
        ));
    }

    #[test]
    fn a_symbolic_link_is_refused() {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            zip.start_file("libcogwork.so", FileOptions::default())
                .unwrap();
            zip.write_all(b"elf").unwrap();
            zip.add_symlink("assets/link", "/etc/passwd", FileOptions::default())
                .unwrap();
            zip.finish().unwrap();
        }
        assert_eq!(
            problem(inspect(Cursor::new(buf.into_inner()), None)),
            ArchiveProblem::Symlink("assets/link".into())
        );
    }

    #[test]
    fn a_zip_bomb_is_refused() {
        let zeros = vec![0u8; 4 * 1024 * 1024];
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let deflate =
                FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("libcogwork.so", deflate).unwrap();
            zip.write_all(b"elf").unwrap();
            zip.start_file("assets/zeros.bin", deflate).unwrap();
            zip.write_all(&zeros).unwrap();
            zip.finish().unwrap();
        }
        assert_eq!(
            problem(inspect(Cursor::new(buf.into_inner()), None)),
            ArchiveProblem::Ratio("assets/zeros.bin".into())
        );
    }

    /// The entry count and the total size come from the zip's directory, so a zip can claim
    /// either without containing it. These build such directories by hand.
    fn central_directory_zip(entries: &[(&str, u64)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, size) in entries {
            let offset = out.len() as u32;
            let n = name.as_bytes();
            let size32 = (*size).min(u32::MAX as u64) as u32;
            // Local header, stored, no data (only the central directory is read).
            out.extend_from_slice(&0x04034b50u32.to_le_bytes());
            out.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            out.extend_from_slice(&0u32.to_le_bytes()); // crc
            out.extend_from_slice(&size32.to_le_bytes()); // compressed
            out.extend_from_slice(&size32.to_le_bytes()); // uncompressed
            out.extend_from_slice(&(n.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(n);
            central.extend_from_slice(&0x02014b50u32.to_le_bytes());
            central.extend_from_slice(&[20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            central.extend_from_slice(&0u32.to_le_bytes()); // crc
            central.extend_from_slice(&size32.to_le_bytes());
            central.extend_from_slice(&size32.to_le_bytes());
            central.extend_from_slice(&(n.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]);
            central.extend_from_slice(&0u32.to_le_bytes()); // external attributes
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(n);
        }
        let cd_offset = out.len() as u32;
        let count = entries.len() as u16;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x06054b50u32.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    #[test]
    fn too_many_entries_or_bytes_are_refused() {
        let names: Vec<String> = (0..=MAX_ENTRIES).map(|i| format!("assets/{i}")).collect();
        let entries: Vec<(&str, u64)> = names.iter().map(|n| (n.as_str(), 0)).collect();
        assert_eq!(
            problem(inspect(Cursor::new(central_directory_zip(&entries)), None)),
            ArchiveProblem::TooManyEntries
        );

        let big = [
            ("libcogwork.so", 600 * 1024 * 1024),
            ("assets/a", 600 * 1024 * 1024),
        ];
        assert_eq!(
            problem(inspect(Cursor::new(central_directory_zip(&big)), None)),
            ArchiveProblem::TooLarge
        );
    }

    /// A deflated zip of a library and one asset, and where that asset's headers are, so a test
    /// can make the zip lie about it.
    fn zip_with_asset(asset: &[u8]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let deflate =
                FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("libcogwork.so", deflate).unwrap();
            zip.write_all(b"elf").unwrap();
            zip.start_file("assets/data.bin", deflate).unwrap();
            zip.write_all(asset).unwrap();
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    /// Offsets of `name`'s local header and central directory entry.
    fn headers_of(zip: &[u8], name: &str) -> (usize, usize) {
        let find = |sig: &[u8; 4], name_len_at: usize, name_at: usize| {
            (0..zip.len() - 4)
                .find(|&i| {
                    &zip[i..i + 4] == sig && {
                        let n = u16::from_le_bytes([zip[i + name_len_at], zip[i + name_len_at + 1]])
                            as usize;
                        zip.get(i + name_at..i + name_at + n) == Some(name.as_bytes())
                    }
                })
                .unwrap()
        };
        (find(b"PK\x03\x04", 26, 30), find(b"PK\x01\x02", 28, 46))
    }

    /// Writes `size` as `name`'s uncompressed size, in both headers.
    fn declare_size(zip: &mut [u8], name: &str, size: u32) {
        let (local, central) = headers_of(zip, name);
        zip[local + 22..local + 26].copy_from_slice(&size.to_le_bytes());
        zip[central + 24..central + 28].copy_from_slice(&size.to_le_bytes());
    }

    /// A zip that says an entry is small, so it passes every declared limit, but inflates to
    /// megabytes: the count of what really comes out refuses it.
    #[test]
    fn a_zip_that_lies_about_its_sizes_is_refused() {
        let mut lying = zip_with_asset(&vec![0u8; 2 * 1024 * 1024]);
        declare_size(&mut lying, "assets/data.bin", 1000);
        assert_eq!(
            problem(inspect(Cursor::new(lying), None)),
            ArchiveProblem::SizeMismatch("assets/data.bin".into())
        );
        // A size larger than what is there is a lie too: the entry is cut short.
        let mut short = zip_with_asset(b"some asset bytes");
        declare_size(&mut short, "assets/data.bin", 4000);
        assert!(matches!(
            problem(inspect(Cursor::new(short), None)),
            ArchiveProblem::Damaged(name, _) if name == "assets/data.bin"
        ));
    }

    #[test]
    fn a_damaged_or_encrypted_entry_is_refused() {
        let body: Vec<u8> = (0..64 * 1024u32).map(|i| (i * 7 % 251) as u8).collect();
        let good = zip_with_asset(&body);
        assert!(inspect(Cursor::new(good.clone()), None).is_ok());

        // Bytes of the compressed stream changed: it doesn't inflate, or its checksum fails.
        let mut damaged = good.clone();
        let (local, _) = headers_of(&damaged, "assets/data.bin");
        let data = local + 30 + "assets/data.bin".len();
        for b in &mut damaged[data + 8..data + 40] {
            *b ^= 0x5a;
        }
        assert!(matches!(
            problem(inspect(Cursor::new(damaged), None)),
            ArchiveProblem::Damaged(name, _) if name == "assets/data.bin"
        ));

        // The encrypted flag, in both headers.
        let mut encrypted = good;
        let (local, central) = headers_of(&encrypted, "assets/data.bin");
        encrypted[local + 6] |= 1;
        encrypted[central + 8] |= 1;
        assert_eq!(
            problem(inspect(Cursor::new(encrypted), None)),
            ArchiveProblem::Encrypted("assets/data.bin".into())
        );
    }
}
