//! The curated mod index: `index.json` plus its minisign signature, as described in
//! `docs/mod-manager/INDEX_FORMAT.md`. Only an index signed with the key below is used. The last
//! one that verified is kept, so the catalogue works offline and an older index can't replace it.

use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::AppHandle;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::abi::{is_abi, is_safe_ref};
use super::error::ModsError;
use super::paths::{cache_dir, write_atomic};

pub const INDEX_URL: &str = "https://zorro909.github.io/weft-mods-index/v1/index.json";

/// `keys/index.pub` of the index repository.
pub const INDEX_PUBLIC_KEY: &str = "RWRelY1XUps7n+bc3RVDFwMAWzPYz4orZvxzRTo0M+hK2A0w02cQmfvh";

const MAX_INDEX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Index {
    pub schema: u32,
    pub generated: String,
    #[serde(default)]
    pub weft: Vec<WeftAbi>,
    #[serde(default)]
    pub mods: Vec<IndexMod>,
    #[serde(default)]
    pub revoked: Vec<Revoked>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WeftAbi {
    pub tag: String,
    pub commit: String,
    pub abi: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexMod {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub versions: Vec<IndexVersion>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Release,
    Prerelease,
    Experimental,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexVersion {
    pub version: String,
    pub channel: Channel,
    pub tag: String,
    #[serde(default)]
    pub published: String,
    pub source: SourceRef,
    pub weft: WeftRef,
    #[serde(default)]
    pub deps: Vec<Dep>,
    #[serde(default)]
    pub platforms: Vec<String>,
    pub asset: Asset,
    #[serde(default)]
    pub provenance: Option<Provenance>,
    #[serde(default)]
    pub reviewed: Option<Reviewed>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceRef {
    pub repo: String,
    pub commit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeftRef {
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub commit: String,
    pub abi: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dep {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provenance {
    pub kind: String,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub workflow: Option<String>,
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
    #[serde(default)]
    pub verified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reviewed {
    pub by: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Revoked {
    pub sha256: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub at: String,
}

pub fn is_mod_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

pub fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn is_repo(s: &str) -> bool {
    let Some((owner, name)) = s.split_once('/') else {
        return false;
    };
    let part = |p: &str| {
        !p.is_empty()
            && p.len() <= 100
            && p != "."
            && p != ".."
            && p.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    };
    part(owner) && part(name)
}

/// The contract's rules for one version of one mod. A version that breaks them is left out.
pub fn version_problem(id: &str, v: &IndexVersion) -> Option<String> {
    if !is_repo(&v.source.repo) {
        return Some(format!("source repo {:?}", v.source.repo));
    }
    if v.asset.name != format!("{id}.zip") {
        return Some(format!("asset name {:?}", v.asset.name));
    }
    let prefix = format!("https://github.com/{}/releases/download/", v.source.repo);
    if !v.asset.url.starts_with(&prefix) || v.asset.url.contains("/../") {
        return Some(format!("asset url {:?}", v.asset.url));
    }
    if !is_sha256(&v.asset.sha256) {
        return Some("sha256".into());
    }
    if !is_abi(&v.weft.abi) {
        return Some("abi".into());
    }
    if let Some(tag) = &v.weft.tag
        && !is_safe_ref(tag)
    {
        return Some(format!("weft tag {tag:?}"));
    }
    if v.deps.iter().any(|d| !is_mod_id(&d.id)) {
        return Some("deps".into());
    }
    None
}

/// Keeps what follows the contract and drops the rest, so one bad entry doesn't hide the others.
pub fn sanitize(mut index: Index) -> Index {
    index.mods.retain(|m| is_mod_id(&m.id));
    for m in &mut index.mods {
        let id = m.id.clone();
        m.versions.retain(|v| match version_problem(&id, v) {
            None => true,
            Some(problem) => {
                eprintln!("mod index: dropping {id} {}: {problem}", v.version);
                false
            }
        });
        m.icon = m.icon.take().filter(|u| u.starts_with("https://"));
        m.homepage = m.homepage.take().filter(|u| u.starts_with("https://"));
    }
    index.mods.retain(|m| !m.versions.is_empty());
    index.weft.retain(|w| is_safe_ref(&w.tag) && is_abi(&w.abi));
    index.revoked.retain(|r| is_sha256(&r.sha256));
    index
}

pub fn verify(bytes: &[u8], signature: &str, public_key: &str) -> Result<Index, ModsError> {
    let key = PublicKey::from_base64(public_key.trim())
        .or_else(|_| PublicKey::decode(public_key))
        .map_err(|e| ModsError::IndexSignatureInvalid(format!("public key: {e}")))?;
    let signature = Signature::decode(signature)
        .map_err(|e| ModsError::IndexSignatureInvalid(e.to_string()))?;
    key.verify(bytes, &signature, false)
        .map_err(|e| ModsError::IndexSignatureInvalid(e.to_string()))?;
    let index: Index =
        serde_json::from_slice(bytes).map_err(|e| ModsError::IndexInvalid(e.to_string()))?;
    if index.schema != 1 {
        return Err(ModsError::IndexInvalid(format!("schema {}", index.schema)));
    }
    Ok(sanitize(index))
}

fn generated_at(index: &Index) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(&index.generated, &Rfc3339).ok()
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Freshness {
    /// Fetched and verified just now.
    Fresh,
    /// The last verified copy: offline, or the network answer wasn't usable.
    Cached,
    /// Nothing verified yet.
    Unavailable,
}

pub struct IndexState {
    pub index: Option<Index>,
    pub freshness: Freshness,
    pub error: Option<ModsError>,
}

fn public_key() -> String {
    #[cfg(debug_assertions)]
    if let Ok(key) = std::env::var("WEFT_MOD_INDEX_PUBKEY") {
        return key;
    }
    INDEX_PUBLIC_KEY.to_string()
}

fn index_url() -> String {
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("WEFT_MOD_INDEX_URL") {
        return url;
    }
    INDEX_URL.to_string()
}

fn cached(app: &AppHandle) -> Option<Index> {
    let dir = cache_dir(app).ok()?;
    let bytes = std::fs::read(dir.join("mod-index.json")).ok()?;
    let sig = std::fs::read_to_string(dir.join("mod-index.json.minisig")).ok()?;
    // Checked again: the cache is only a file on disk.
    verify(&bytes, &sig, &public_key()).ok()
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, ModsError> {
    let response = client
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(ModsError::Http {
            status,
            url: url.to_string(),
        });
    }
    if response.content_length().unwrap_or(0) as usize > MAX_INDEX_BYTES {
        return Err(ModsError::IndexInvalid("too large".into()));
    }
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_INDEX_BYTES {
        return Err(ModsError::IndexInvalid("too large".into()));
    }
    Ok(bytes.to_vec())
}

/// The newest index this launcher can trust. With `refresh` false only the cache is read.
pub async fn load(app: &AppHandle, client: &reqwest::Client, refresh: bool) -> IndexState {
    let cached = cached(app);
    if !refresh {
        let freshness = if cached.is_some() {
            Freshness::Cached
        } else {
            Freshness::Unavailable
        };
        return IndexState {
            index: cached,
            freshness,
            error: None,
        };
    }

    let url = index_url();
    let fetched = async {
        let bytes = fetch_text(client, &url).await?;
        let sig = fetch_text(client, &format!("{url}.minisig")).await?;
        let sig = String::from_utf8(sig)
            .map_err(|_| ModsError::IndexSignatureInvalid("not text".into()))?;
        let index = verify(&bytes, &sig, &public_key())?;
        Ok::<_, ModsError>((bytes, sig, index))
    }
    .await;

    match fetched {
        Ok((bytes, sig, index)) => {
            if let Some(old) = &cached
                && let (Some(new_at), Some(old_at)) = (generated_at(&index), generated_at(old))
                && new_at < old_at
            {
                return IndexState {
                    index: cached,
                    freshness: Freshness::Cached,
                    error: Some(ModsError::IndexRollback),
                };
            }
            if let Ok(dir) = cache_dir(app) {
                // Signature first: an index without its signature is never trusted from disk.
                let _ = write_atomic(&dir.join("mod-index.json.minisig"), sig.as_bytes());
                let _ = write_atomic(&dir.join("mod-index.json"), &bytes);
            }
            IndexState {
                index: Some(index),
                freshness: Freshness::Fresh,
                error: None,
            }
        }
        Err(error) => {
            let freshness = if cached.is_some() {
                Freshness::Cached
            } else {
                Freshness::Unavailable
            };
            IndexState {
                index: cached,
                freshness,
                error: Some(error),
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn version(id: &str, repo: &str, sha: &str) -> IndexVersion {
        IndexVersion {
            version: "0.2.0".into(),
            channel: Channel::Release,
            tag: format!("{id}-v0.2.0"),
            published: "2026-11-04T00:00:00Z".into(),
            source: SourceRef {
                repo: repo.into(),
                commit: "c".repeat(40),
            },
            weft: WeftRef {
                tag: Some("v26.11.1".into()),
                commit: "f".repeat(40),
                abi: "f470b1cbb1f9ad91".into(),
            },
            deps: vec![Dep { id: "base".into() }],
            platforms: vec!["linux-x64".into()],
            asset: Asset {
                name: format!("{id}.zip"),
                url: format!("https://github.com/{repo}/releases/download/{id}-v0.2.0/{id}.zip"),
                size: 10,
                sha256: sha.into(),
            },
            provenance: None,
            reviewed: None,
        }
    }

    #[test]
    fn contract_rules_drop_bad_versions() {
        let sha = "a".repeat(64);
        assert!(
            version_problem("cogwork", &version("cogwork", "Zorro909/weft-mods", &sha)).is_none()
        );

        let mut v = version("cogwork", "Zorro909/weft-mods", &sha);
        v.asset.url = "https://evil.example/cogwork.zip".into();
        assert!(version_problem("cogwork", &v).is_some());

        let mut v = version("cogwork", "Zorro909/weft-mods", &sha);
        v.asset.url = "https://github.com/Someone/else/releases/download/x/cogwork.zip".into();
        assert!(
            version_problem("cogwork", &v).is_some(),
            "url must be in the source repo"
        );

        let mut v = version("cogwork", "Zorro909/weft-mods", &sha);
        v.asset.name = "other.zip".into();
        assert!(version_problem("cogwork", &v).is_some());

        assert!(
            version_problem("cogwork", &version("cogwork", "Zorro909/weft-mods", "ABC")).is_some()
        );
        assert!(version_problem("cogwork", &version("cogwork", "../x", &sha)).is_some());
    }

    #[test]
    fn ids_and_repos() {
        assert!(is_mod_id("cogwork"));
        assert!(is_mod_id("my_mod2"));
        assert!(!is_mod_id("Cogwork"));
        assert!(!is_mod_id("a-b"));
        assert!(!is_mod_id(""));
        assert!(is_repo("Zorro909/weft-mods"));
        assert!(!is_repo("Zorro909"));
        assert!(!is_repo("a/b/c"));
        assert!(!is_repo("../b"));
    }

    // Signed with a throw-away key made for these tests (`minisign -G -W`); the private half was
    // never kept. The real key belongs to the index repository.
    const FIXTURE: &[u8] = include_bytes!("testdata/index.json");
    const FIXTURE_SIG: &str = include_str!("testdata/index.json.minisig");
    const FIXTURE_KEY: &str = include_str!("testdata/test.pub");

    #[test]
    fn a_signed_index_verifies() {
        let index = verify(FIXTURE, FIXTURE_SIG, FIXTURE_KEY).unwrap();
        assert_eq!(index.mods[0].id, "cogwork");
        assert_eq!(index.weft[0].abi, "f470b1cbb1f9ad91");
        // The bare base64 line works too, as embedded in the launcher.
        let key_line = FIXTURE_KEY.lines().nth(1).unwrap();
        assert!(verify(FIXTURE, FIXTURE_SIG, key_line).is_ok());
    }

    #[test]
    fn any_change_breaks_the_signature() {
        let mut tampered = FIXTURE.to_vec();
        let at = tampered.windows(7).position(|w| w == b"Cogwork").unwrap();
        tampered[at] = b'K';
        assert!(matches!(
            verify(&tampered, FIXTURE_SIG, FIXTURE_KEY),
            Err(ModsError::IndexSignatureInvalid(_))
        ));
        assert!(matches!(
            verify(FIXTURE, "not a signature", FIXTURE_KEY),
            Err(ModsError::IndexSignatureInvalid(_))
        ));
    }

    /// A copy of the live index, signed by the real key: the embedded key is the right
    /// one, and nothing the index publishes is dropped by the contract checks here.
    #[test]
    fn the_published_index_verifies_and_keeps_every_entry() {
        let bytes = include_bytes!("testdata/published-index.json");
        let sig = include_str!("testdata/published-index.json.minisig");
        let index = verify(bytes, sig, INDEX_PUBLIC_KEY).unwrap();
        let raw: Index = serde_json::from_slice(bytes).unwrap();
        let count = |i: &Index| i.mods.iter().map(|m| m.versions.len()).sum::<usize>();
        assert!(count(&raw) > 0);
        assert_eq!(count(&index), count(&raw));
        assert_eq!(index.weft.len(), raw.weft.len());
    }

    #[test]
    fn another_key_is_refused() {
        assert!(matches!(
            verify(FIXTURE, FIXTURE_SIG, INDEX_PUBLIC_KEY),
            Err(ModsError::IndexSignatureInvalid(_))
        ));
    }
}
