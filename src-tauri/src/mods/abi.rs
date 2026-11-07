//! A Weft version's mod ABI, worked out the way the engine does: its `ABI_VERSION` is the
//! FNV-1a-64 hash of `crates/abi/src/lib.rs`. That file is fetched from the version's tag on
//! GitHub once, and the ABI is kept in the version's profile folder.

use super::{Dirs, ModError, index, is_hex, log};

const WEFT_SOURCE: &str = "https://raw.githubusercontent.com/Weft-Rust/Weft";

fn file(dirs: &Dirs, tag: &str) -> std::path::PathBuf {
    dirs.profile(tag).join("mod-abi")
}

/// The ABI of `tag`, if it was worked out before.
pub fn cached(dirs: &Dirs, tag: &str) -> Option<String> {
    let abi = std::fs::read_to_string(file(dirs, tag)).ok()?;
    is_hex(&abi, 16).then_some(abi)
}

/// The ABI of `tag`. `None` if the version is older than mods.
pub async fn get(dirs: &Dirs, tag: &str) -> Result<Option<String>, ModError> {
    if let Some(abi) = cached(dirs, tag) {
        return Ok(Some(abi));
    }
    let url = format!("{WEFT_SOURCE}/{tag}/crates/abi/src/lib.rs");
    let response = index::http().get(&url).send().await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let source = response.error_for_status()?.bytes().await?;
    let abi = format!("{:016x}", fnv1a64(&source));
    let kept = std::fs::create_dir_all(dirs.profile(tag))
        .and_then(|_| std::fs::write(file(dirs, tag), &abi));
    if let Err(e) = kept {
        log(format_args!("couldn't keep the mod ABI of {tag}: {e}"));
    }
    Ok(Some(abi))
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, &b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    })
}

#[cfg(test)]
#[test]
fn fnv1a64_matches_the_reference() {
    assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
    assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
    assert_eq!(fnv1a64(b"foobar"), 0x8594_4171_f739_67e8);
}
