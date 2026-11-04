//! The mod interface ("ABI") of a game version. Weft loads a mod only if the mod was built against
//! a byte-identical `crates/abi/src/lib.rs`: `ABI_VERSION` is the FNV-1a-64 hash of that file. So
//! the launcher can tell what a version accepts without running it, from the file at its tag.

use std::collections::BTreeMap;
use std::time::Duration;
use tauri::AppHandle;

use super::error::ModsError;
use super::index::WeftAbi;
use super::paths::{cache_dir, write_atomic};
use crate::config::WEFT_REPO;

pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h = (h ^ b as u64).wrapping_mul(0x0100_0000_01b3);
    }
    h
}

pub fn format_abi(hash: u64) -> String {
    format!("{hash:016x}")
}

pub fn is_abi(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A git ref that can go into a URL path as it is.
pub fn is_safe_ref(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && !s.starts_with('.')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

fn cache_file(app: &AppHandle) -> Result<std::path::PathBuf, ModsError> {
    Ok(cache_dir(app)?.join("abi.json"))
}

fn read_cache(app: &AppHandle) -> BTreeMap<String, String> {
    cache_file(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// The ABI of a cached tag, without going to the network. A tag's file never changes.
pub fn cached_abi(app: &AppHandle, tag: &str, table: &[WeftAbi]) -> Option<String> {
    table
        .iter()
        .find(|w| w.tag == tag)
        .map(|w| w.abi.clone())
        .or_else(|| read_cache(app).remove(tag))
}

pub async fn abi_for_tag(
    app: &AppHandle,
    client: &reqwest::Client,
    tag: &str,
    table: &[WeftAbi],
) -> Result<String, ModsError> {
    if let Some(abi) = cached_abi(app, tag, table) {
        return Ok(abi);
    }
    if !is_safe_ref(tag) {
        return Err(ModsError::InvalidName(tag.to_string()));
    }
    let url = format!("https://raw.githubusercontent.com/{WEFT_REPO}/{tag}/crates/abi/src/lib.rs");
    let response = client
        .get(&url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| ModsError::AbiUnavailable(tag.to_string()))?;
    if !response.status().is_success() {
        return Err(ModsError::AbiUnavailable(tag.to_string()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| ModsError::AbiUnavailable(tag.to_string()))?;
    let abi = format_abi(fnv1a64(&bytes));

    let mut cache = read_cache(app);
    cache.insert(tag.to_string(), abi.clone());
    // Without the cache the hash is just fetched again next time.
    if let Ok(path) = cache_file(app) {
        let _ = serde_json::to_vec_pretty(&cache).map(|b| write_atomic(&path, &b));
    }
    Ok(abi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv_matches_the_engine() {
        // The engine's own constants: an empty file hashes to the offset basis.
        assert_eq!(format_abi(fnv1a64(b"")), "cbf29ce484222325");
        assert_eq!(format_abi(fnv1a64(b"a")), "af63dc4c8601ec8c");
    }

    #[test]
    fn abi_and_ref_shapes() {
        assert!(is_abi("f470b1cbb1f9ad91"));
        assert!(!is_abi("F470B1CBB1F9AD91"));
        assert!(!is_abi("f470b1cb"));
        assert!(is_safe_ref("v26.11.1"));
        for bad in ["", "../x", "v1/../../x", "a?b", "a#b", ".hidden"] {
            assert!(!is_safe_ref(bad), "{bad:?}");
        }
    }
}
