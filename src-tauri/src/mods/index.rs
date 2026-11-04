//! The curated mod index: `index.json` plus its minisign signature, as described in
//! `docs/mod-manager/INDEX_FORMAT.md`. Only an index signed with the key below is used. The last
//! one that verified is kept, so the catalogue works offline and an older index can't replace it.

use minisign_verify::{PublicKey, Signature};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use ts_rs::TS;

use super::abi::{is_abi, is_safe_ref};
use super::error::ModsError;
use super::paths::{unique_suffix, write_atomic};

pub const INDEX_URL: &str = "https://zorro909.github.io/weft-mods-index/v1/index.json";

/// `keys/index.pub` of the index repository.
pub const INDEX_PUBLIC_KEY: &str = "RWRelY1XUps7n+bc3RVDFwMAWzPYz4orZvxzRTo0M+hK2A0w02cQmfvh";

pub const MAX_INDEX_BYTES: usize = 8 * 1024 * 1024;

/// Reads a list one entry at a time and leaves out the entries that don't parse, so one bad
/// entry (an unknown channel, a missing field) never hides the rest.
fn lenient<'de, D, T>(d: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let raw = Vec::<serde_json::Value>::deserialize(d)?;
    Ok(raw
        .into_iter()
        .filter_map(|v| match serde_json::from_value(v) {
            Ok(t) => Some(t),
            Err(e) => {
                eprintln!("mod index: skipping an entry: {e}");
                None
            }
        })
        .collect())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Index {
    pub schema: u32,
    pub generated: String,
    #[serde(default, deserialize_with = "lenient")]
    pub weft: Vec<WeftAbi>,
    #[serde(default, deserialize_with = "lenient")]
    pub mods: Vec<IndexMod>,
    #[serde(default, deserialize_with = "lenient")]
    pub revoked: Vec<Revoked>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
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
    #[serde(default, deserialize_with = "lenient")]
    pub versions: Vec<IndexVersion>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Release,
    Prerelease,
    Experimental,
}

impl Channel {
    /// How far from a release: a player on `release` never gets a prerelease.
    pub fn rank(self) -> u8 {
        match self {
            Channel::Release => 0,
            Channel::Prerelease => 1,
            Channel::Experimental => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash, TS)]
pub enum Platform {
    #[serde(rename = "windows-x64")]
    WindowsX64,
    #[serde(rename = "linux-x64")]
    LinuxX64,
    #[serde(rename = "macos-arm64")]
    MacosArm64,
}

impl Platform {
    pub const ALL: [Platform; 3] = [
        Platform::WindowsX64,
        Platform::LinuxX64,
        Platform::MacosArm64,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Platform::WindowsX64 => "windows-x64",
            Platform::LinuxX64 => "linux-x64",
            Platform::MacosArm64 => "macos-arm64",
        }
    }

    /// `None` for a platform string this launcher doesn't know; such entries are ignored.
    pub fn parse(s: &str) -> Option<Platform> {
        Platform::ALL.into_iter().find(|p| p.as_str() == s)
    }

    /// The system this launcher runs on; `None` where the game isn't built.
    pub fn current() -> Option<Platform> {
        if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            Some(Platform::WindowsX64)
        } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            Some(Platform::LinuxX64)
        } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            Some(Platform::MacosArm64)
        } else {
            None
        }
    }
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
    /// Kept as text: a platform this launcher doesn't know is ignored, not an error.
    #[serde(default)]
    pub platforms: Vec<String>,
    pub asset: Asset,
    #[serde(default)]
    pub provenance: Option<Provenance>,
    #[serde(default)]
    pub reviewed: Option<Reviewed>,
}

impl IndexVersion {
    /// The platforms this launcher knows, in the entry's order.
    pub fn known_platforms(&self) -> Vec<Platform> {
        let mut out: Vec<Platform> = self
            .platforms
            .iter()
            .filter_map(|p| Platform::parse(p))
            .collect();
        out.dedup();
        out
    }
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

/// Ships inside every Weft; nothing may be installed under this id.
pub const RESERVED_ID: &str = "base";

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

/// GitHub treats `Owner/Repo` and `owner/repo` as one repo; so does the launcher.
pub fn same_repo(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Why `url` is not the release asset `<id>.zip` of `tag` in `repo`, if it isn't. It must be
/// `https://github.com/<owner>/<repo>/releases/download/<tag>/<id>.zip` exactly as written: no
/// other host, port, user, query or fragment, no `\`, no percent-encoding, no `.` or `..`.
pub fn asset_url_problem(id: &str, repo: &str, tag: &str, url: &str) -> Option<&'static str> {
    if url.contains('\\') {
        return Some("contains a backslash");
    }
    if url.contains('%') {
        return Some("percent-encoded");
    }
    let Ok(parsed) = url::Url::parse(url) else {
        return Some("not a URL");
    };
    // The parser resolves `.` and `..` and fixes up odd spellings; a URL that changes when
    // parsed is not the one that was reviewed.
    if parsed.as_str() != url {
        return Some("not in canonical form");
    }
    if parsed.scheme() != "https" {
        return Some("not https");
    }
    if parsed.host_str() != Some("github.com")
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Some("not github.com");
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Some("has a query or fragment");
    }
    let Some(segments) = parsed.path_segments() else {
        return Some("no path");
    };
    let segments: Vec<&str> = segments.collect();
    let Some((owner, name)) = repo.split_once('/') else {
        return Some("bad repo");
    };
    let zip = format!("{id}.zip");
    match segments.as_slice() {
        [o, r, "releases", "download", t, n]
            if o.eq_ignore_ascii_case(owner)
                && r.eq_ignore_ascii_case(name)
                && *t == tag
                && is_safe_ref(t)
                && *n == zip =>
        {
            None
        }
        _ => Some("not this repo's release asset"),
    }
}

/// The contract's rules for one version of one mod. A version that breaks them is left out.
pub fn version_problem(id: &str, v: &IndexVersion) -> Option<String> {
    if !is_repo(&v.source.repo) {
        return Some(format!("source repo {:?}", v.source.repo));
    }
    if !is_safe_ref(&v.tag) {
        return Some(format!("tag {:?}", v.tag));
    }
    if v.asset.name != format!("{id}.zip") {
        return Some(format!("asset name {:?}", v.asset.name));
    }
    if let Some(why) = asset_url_problem(id, &v.source.repo, &v.tag, &v.asset.url) {
        return Some(format!("asset url {:?}: {why}", v.asset.url));
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
/// Every version in the index must say who reviewed it: that is what Reviewed means.
pub fn sanitize(mut index: Index) -> Index {
    index
        .mods
        .retain(|m| is_mod_id(&m.id) && m.id != RESERVED_ID);
    for m in &mut index.mods {
        let id = m.id.clone();
        m.versions.retain(|v| {
            let problem = version_problem(&id, v).or_else(|| match &v.reviewed {
                Some(r) if !r.by.trim().is_empty() => None,
                _ => Some("no review recorded".into()),
            });
            match problem {
                None => true,
                Some(problem) => {
                    eprintln!("mod index: dropping {id} {}: {problem}", v.version);
                    false
                }
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

/// Reads index bytes whose signature already verified.
pub fn parse(bytes: &[u8]) -> Result<Index, ModsError> {
    let index: Index =
        serde_json::from_slice(bytes).map_err(|e| ModsError::IndexInvalid(e.to_string()))?;
    if index.schema != 1 {
        return Err(ModsError::IndexInvalid(format!("schema {}", index.schema)));
    }
    if generated_at(&index).is_none() {
        return Err(ModsError::IndexInvalid(format!(
            "generated {:?}",
            index.generated
        )));
    }
    Ok(sanitize(index))
}

pub fn verify(bytes: &[u8], signature: &str, public_key: &str) -> Result<Index, ModsError> {
    let key = PublicKey::from_base64(public_key.trim())
        .or_else(|_| PublicKey::decode(public_key))
        .map_err(|e| ModsError::IndexSignatureInvalid(format!("public key: {e}")))?;
    let signature = Signature::decode(signature)
        .map_err(|e| ModsError::IndexSignatureInvalid(e.to_string()))?;
    key.verify(bytes, &signature, false)
        .map_err(|e| ModsError::IndexSignatureInvalid(e.to_string()))?;
    parse(bytes)
}

fn generated_at(index: &Index) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(&index.generated, &Rfc3339).ok()
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
pub enum Freshness {
    /// Fetched and verified just now.
    Fresh,
    /// The last good copy: not refreshed, or the refresh failed (then an error says why).
    Cached,
    /// Nothing usable yet.
    Unavailable,
}

pub struct IndexState {
    pub index: Option<Index>,
    pub freshness: Freshness,
    pub error: Option<ModsError>,
}

pub fn public_key() -> String {
    #[cfg(debug_assertions)]
    if let Ok(key) = std::env::var("WEFT_MOD_INDEX_PUBKEY") {
        return key;
    }
    INDEX_PUBLIC_KEY.to_string()
}

pub fn index_url() -> String {
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("WEFT_MOD_INDEX_URL") {
        return url;
    }
    INDEX_URL.to_string()
}

// ---------------------------------------------------------------------------------------------
// The verified copy on disk

/// Verified index generations: `<dir>/<n>/index.json` and `index.json.minisig` are written as
/// one directory and renamed into place together, then `<dir>/current` names the new one. A crash
/// at any point leaves a complete pair behind: reading tries `current`, then every other
/// generation from the newest, then the single pair older launchers wrote.
pub struct IndexCache {
    dir: PathBuf,
    legacy: PathBuf,
    key: String,
}

const KEEP_GENERATIONS: usize = 2;

impl IndexCache {
    /// `cache_dir` is the launcher's `cache/` folder.
    pub fn new(cache_dir: &Path, key: String) -> Self {
        IndexCache {
            dir: cache_dir.join("mod-index"),
            legacy: cache_dir.join("mod-index.json"),
            key,
        }
    }

    fn generations(&self) -> Vec<u64> {
        let mut out: Vec<u64> = std::fs::read_dir(&self.dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.parse().ok())
            .collect();
        out.sort_unstable_by(|a, b| b.cmp(a));
        out
    }

    fn current(&self) -> Option<u64> {
        std::fs::read_to_string(self.dir.join("current"))
            .ok()?
            .trim()
            .parse()
            .ok()
    }

    fn read_pair(&self, json: &Path) -> Option<Index> {
        let bytes = std::fs::read(json).ok()?;
        let sig = std::fs::read_to_string(json.with_extension("json.minisig")).ok()?;
        // Checked again: the cache is only a file on disk.
        verify(&bytes, &sig, &self.key).ok()
    }

    /// The newest generation that still verifies, and its number (0 for the old single pair).
    pub fn read(&self) -> Option<(u64, Index)> {
        let mut order: Vec<u64> = self.current().into_iter().collect();
        order.extend(self.generations());
        order.dedup();
        for generation in order {
            let json = self.dir.join(generation.to_string()).join("index.json");
            if let Some(index) = self.read_pair(&json) {
                return Some((generation, index));
            }
        }
        self.read_pair(&self.legacy).map(|i| (0, i))
    }

    /// Stores a verified pair as a new generation and drops all but the newest few.
    pub fn write(&self, bytes: &[u8], signature: &str) -> Result<u64, ModsError> {
        std::fs::create_dir_all(&self.dir)?;
        let next = self.generations().first().map_or(1, |n| n + 1);
        let staging = self.dir.join(format!(".{next}.{}.tmp", unique_suffix()));
        let result = (|| {
            std::fs::create_dir_all(&staging)?;
            write_atomic(&staging.join("index.json"), bytes)?;
            write_atomic(&staging.join("index.json.minisig"), signature.as_bytes())?;
            std::fs::rename(&staging, self.dir.join(next.to_string()))?;
            write_atomic(&self.dir.join("current"), next.to_string().as_bytes())
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        result?;
        for old in self.generations().into_iter().skip(KEEP_GENERATIONS) {
            let _ = std::fs::remove_dir_all(self.dir.join(old.to_string()));
        }
        // Staging folders a crash left behind.
        for entry in std::fs::read_dir(&self.dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && name.ends_with(".tmp") && entry.path().is_dir() {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
        Ok(next)
    }
}

/// What to do with a freshly fetched index, given the verified copy already held. An index
/// older than that copy is refused: someone serving an old index must not bring back a
/// revoked mod.
pub fn decide(
    cached: Option<Index>,
    fetched: Result<Index, ModsError>,
) -> (IndexState, bool /* store the fetched one */) {
    let fallback = |cached: Option<Index>, error| {
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
    };
    match fetched {
        Err(error) => (fallback(cached, error), false),
        Ok(index) => {
            let older = cached.as_ref().is_some_and(|old| {
                match (generated_at(&index), generated_at(old)) {
                    (Some(new_at), Some(old_at)) => new_at < old_at,
                    (None, Some(_)) => true,
                    _ => false,
                }
            });
            if older {
                return (fallback(cached, ModsError::IndexRollback), false);
            }
            let state = IndexState {
                index: Some(index),
                freshness: Freshness::Fresh,
                error: None,
            };
            (state, true)
        }
    }
}

pub async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, ModsError> {
    let mut response = client
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
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > MAX_INDEX_BYTES {
            return Err(ModsError::IndexInvalid("too large".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// The newest index this launcher can trust. With `refresh` false only the cache is read.
/// `fetch` returns the index bytes and their signature.
pub async fn load<F>(cache: &IndexCache, refresh: bool, fetch: F) -> IndexState
where
    F: std::future::Future<Output = Result<(Vec<u8>, String), ModsError>>,
{
    let cached = cache.read().map(|(_, i)| i);
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
    let fetched = fetch.await.and_then(|(bytes, sig)| {
        let index = verify(&bytes, &sig, &cache.key)?;
        Ok((bytes, sig, index))
    });
    let (raw, fetched) = match fetched {
        Ok((bytes, sig, index)) => (Some((bytes, sig)), Ok(index)),
        Err(e) => (None, Err(e)),
    };
    let (state, store) = decide(cached, fetched);
    if store
        && let Some((bytes, sig)) = raw
        && let Err(e) = cache.write(&bytes, &sig)
    {
        eprintln!("mod index: could not cache: {e}");
    }
    state
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
            reviewed: Some(Reviewed {
                by: "Zorro909".into(),
                at: "2026-11-04".into(),
            }),
        }
    }

    #[test]
    fn contract_rules_drop_bad_versions() {
        let sha = "a".repeat(64);
        let ok = || version("cogwork", "Zorro909/weft-mods", &sha);
        assert!(version_problem("cogwork", &ok()).is_none());

        type Change = fn(&mut IndexVersion);
        let cases: &[(&str, Change)] = &[
            ("other host", |v| {
                v.asset.url = "https://evil.example/cogwork.zip".into()
            }),
            ("other repo", |v| {
                v.asset.url =
                    "https://github.com/Someone/else/releases/download/x/cogwork.zip".into()
            }),
            ("asset name", |v| v.asset.name = "other.zip".into()),
            ("sha256 shape", |v| v.asset.sha256 = "ABC".into()),
            ("repo shape", |v| v.source.repo = "../x".into()),
            ("tag shape", |v| v.tag = "../x".into()),
            ("url names another tag", |v| {
                v.asset.url =
                    "https://github.com/Zorro909/weft-mods/releases/download/cogwork-v9/cogwork.zip"
                        .into()
            }),
            ("abi shape", |v| v.weft.abi = "F00".into()),
            ("dep id", |v| v.deps = vec![Dep { id: "A-B".into() }]),
        ];
        for (what, change) in cases {
            let mut v = ok();
            change(&mut v);
            assert!(version_problem("cogwork", &v).is_some(), "{what}");
        }
    }

    /// The bypasses found in review: each one parsed into a URL in another repo, or a
    /// different file, while still starting with the right prefix.
    #[test]
    fn asset_url_bypasses_are_refused() {
        let repo = "Zorro909/weft-mods";
        let tag = "cogwork-v0.2.0";
        let good =
            "https://github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip";
        assert_eq!(asset_url_problem("cogwork", repo, tag, good), None);
        // Owner and repo compare without case, like GitHub does.
        assert_eq!(
            asset_url_problem("cogwork", "zorro909/WEFT-mods", tag, good),
            None
        );

        let bad = [
            r"https://github.com/Zorro909/weft-mods/releases/download/..\..\..\..\evil\repo\releases\download\x\cogwork.zip",
            "https://github.com/Zorro909/weft-mods/releases/download/%2e%2e/%2e%2e/%2e%2e/%2e%2e/evil/repo/releases/download/x/cogwork.zip",
            "https://github.com/Zorro909/weft-mods/releases/download/%2E%2E/x/cogwork.zip",
            "https://github.com/Zorro909/weft-mods/releases/download/x/..",
            "https://github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/../cogwork.zip",
            "https://github.com/Zorro909/weft-mods/releases/download/../../../evil/repo/releases/download/cogwork-v0.2.0/cogwork.zip",
            "https://github.com/Zorro909/weft-mods/releases/download/./cogwork-v0.2.0/cogwork.zip",
            "http://github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip",
            "https://github.com:8443/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip",
            "https://user@github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip",
            "https://github.com.evil.example/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip",
            "https://GITHUB.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip",
            "https://github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip?x=1",
            "https://github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip#x",
            "https://github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/other.zip",
            "https://github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/sub/cogwork.zip",
            "https://github.com/Zorro909/weft-mods/releases/latest/download/cogwork.zip",
            "https://github.com/Zorro909/weft-mods-evil/releases/download/cogwork-v0.2.0/cogwork.zip",
            "not a url",
        ];
        for url in bad {
            assert!(
                asset_url_problem("cogwork", repo, tag, url).is_some(),
                "{url}"
            );
        }
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
        assert!(same_repo("Zorro909/Weft-Mods", "zorro909/weft-mods"));
    }

    fn mod_json(id: &str, versions: &str) -> String {
        format!(r#"{{ "id": "{id}", "name": "{id}", "versions": [{versions}] }}"#)
    }

    fn version_json(id: &str, channel: &str, sha_char: char) -> String {
        let v = version(id, "Zorro909/weft-mods", &sha_char.to_string().repeat(64));
        let mut value = serde_json::to_value(&v).unwrap();
        value["channel"] = serde_json::Value::String(channel.into());
        value.to_string()
    }

    /// One broken entry, anywhere, costs only that entry.
    #[test]
    fn a_bad_entry_does_not_reject_the_index() {
        let good = version_json("cogwork", "release", 'a');
        let unknown_channel = version_json("cogwork", "nightly", 'b');
        let unreviewed = {
            let mut v: serde_json::Value =
                serde_json::from_str(&version_json("cogwork", "release", 'c')).unwrap();
            v["reviewed"] = serde_json::Value::Null;
            v.to_string()
        };
        let odd_platform = {
            let mut v: serde_json::Value =
                serde_json::from_str(&version_json("showcase", "release", 'd')).unwrap();
            v["platforms"] = serde_json::json!(["linux-x64", "plan9-mips"]);
            v.to_string()
        };
        let mods = [
            mod_json("cogwork", &[good, unknown_channel, unreviewed].join(",")),
            mod_json("showcase", &odd_platform),
            r#"{ "id": "noname", "versions": [] }"#.to_string(),
            mod_json("base", &version_json("base", "release", 'e')),
            r#""not even an object""#.to_string(),
        ];
        let json = format!(
            r#"{{ "schema": 1, "generated": "2026-11-04T00:00:00Z",
                 "weft": [ {{ "tag": "v26.11.1", "commit": "x", "abi": "f470b1cbb1f9ad91" }}, {{ "tag": 5 }} ],
                 "mods": [{}],
                 "revoked": [ {{ "sha256": "{}" }}, {{ "reason": "no hash" }} ] }}"#,
            mods.join(","),
            "f".repeat(64)
        );
        let index = parse(json.as_bytes()).unwrap();
        let ids: Vec<&str> = index.mods.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["cogwork", "showcase"]);
        assert_eq!(index.mods[0].versions.len(), 1, "only the good cogwork");
        assert_eq!(index.mods[0].versions[0].asset.sha256, "a".repeat(64));
        assert_eq!(
            index.mods[1].versions[0].known_platforms(),
            [Platform::LinuxX64]
        );
        assert_eq!(index.weft.len(), 1);
        assert_eq!(index.revoked.len(), 1);
    }

    #[test]
    fn an_index_needs_schema_1_and_a_date() {
        assert!(parse(br#"{ "schema": 2, "generated": "2026-11-04T00:00:00Z" }"#).is_err());
        assert!(parse(br#"{ "schema": 1, "generated": "yesterday" }"#).is_err());
        assert!(parse(br#"{ "schema": 1, "generated": "2026-11-04T00:00:00Z" }"#).is_ok());
    }

    // Signed with a throw-away key made for these tests (`minisign -G -W`); the private half was
    // never kept. The real key belongs to the index repository.
    pub const FIXTURE: &[u8] = include_bytes!("testdata/index.json");
    pub const FIXTURE_SIG: &str = include_str!("testdata/index.json.minisig");
    pub const FIXTURE_KEY: &str = include_str!("testdata/test.pub");

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
        let raw: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        let raw_count: usize = raw["mods"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["versions"].as_array().unwrap().len())
            .sum();
        let count = index.mods.iter().map(|m| m.versions.len()).sum::<usize>();
        assert!(raw_count > 0);
        assert_eq!(count, raw_count);
        assert_eq!(index.weft.len(), raw["weft"].as_array().unwrap().len());
    }

    #[test]
    fn another_key_is_refused() {
        assert!(matches!(
            verify(FIXTURE, FIXTURE_SIG, INDEX_PUBLIC_KEY),
            Err(ModsError::IndexSignatureInvalid(_))
        ));
    }

    fn index_at(generated: &str) -> Index {
        Index {
            schema: 1,
            generated: generated.into(),
            weft: vec![],
            mods: vec![],
            revoked: vec![],
        }
    }

    #[test]
    fn an_older_index_is_refused() {
        let held = || Some(index_at("2026-11-04T18:00:00Z"));
        let (state, store) = decide(held(), Ok(index_at("2026-11-01T00:00:00Z")));
        assert!(!store);
        assert_eq!(state.freshness, Freshness::Cached);
        assert!(matches!(state.error, Some(ModsError::IndexRollback)));
        assert_eq!(state.index.unwrap().generated, "2026-11-04T18:00:00Z");

        let (state, store) = decide(held(), Ok(index_at("2026-11-05T00:00:00Z")));
        assert!(store);
        assert_eq!(state.freshness, Freshness::Fresh);
        assert!(state.error.is_none());

        let (state, store) = decide(held(), Err(ModsError::IndexInvalid("x".into())));
        assert!(!store);
        assert_eq!(state.freshness, Freshness::Cached);
        assert!(state.index.is_some() && state.error.is_some());

        let (state, _) = decide(None, Err(ModsError::IndexInvalid("x".into())));
        assert_eq!(state.freshness, Freshness::Unavailable);
    }

    fn cache(dir: &Path) -> IndexCache {
        IndexCache::new(dir, FIXTURE_KEY.to_string())
    }

    #[test]
    fn the_cache_falls_back_to_the_previous_generation() {
        let tmp = tempfile::tempdir().unwrap();
        let c = cache(tmp.path());
        assert!(c.read().is_none());
        assert_eq!(c.write(FIXTURE, FIXTURE_SIG).unwrap(), 1);
        assert_eq!(c.write(FIXTURE, FIXTURE_SIG).unwrap(), 2);
        assert_eq!(c.read().unwrap().0, 2);

        // The newest pair no longer verifies: the one before it is used.
        let newest = tmp.path().join("mod-index").join("2").join("index.json");
        let mut bytes = std::fs::read(&newest).unwrap();
        bytes[10] ^= 1;
        std::fs::write(&newest, bytes).unwrap();
        assert_eq!(c.read().unwrap().0, 1);

        // A crash half way through a write: a third generation without its signature, and
        // `current` pointing at it.
        let third = tmp.path().join("mod-index").join("3");
        std::fs::create_dir_all(&third).unwrap();
        std::fs::write(third.join("index.json"), FIXTURE).unwrap();
        std::fs::write(tmp.path().join("mod-index").join("current"), "3").unwrap();
        assert_eq!(c.read().unwrap().0, 1);

        // Only the newest few are kept.
        c.write(FIXTURE, FIXTURE_SIG).unwrap();
        assert_eq!(c.generations(), [4, 3]);
        assert_eq!(c.read().unwrap().0, 4);
    }

    #[test]
    fn the_cache_reads_the_pair_older_launchers_wrote() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("mod-index.json"), FIXTURE).unwrap();
        std::fs::write(tmp.path().join("mod-index.json.minisig"), FIXTURE_SIG).unwrap();
        assert_eq!(cache(tmp.path()).read().unwrap().0, 0);
        std::fs::write(tmp.path().join("mod-index.json.minisig"), "junk").unwrap();
        assert!(cache(tmp.path()).read().is_none());
    }

    #[test]
    fn load_keeps_the_cache_when_refresh_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let c = cache(tmp.path());
        c.write(FIXTURE, FIXTURE_SIG).unwrap();
        fn run<F: std::future::Future>(fut: F) -> F::Output {
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(fut)
        }
        let state = run(load(&c, true, async {
            Ok((FIXTURE.to_vec(), "bad signature".to_string()))
        }));
        assert_eq!(state.freshness, Freshness::Cached);
        assert!(matches!(
            state.error,
            Some(ModsError::IndexSignatureInvalid(_))
        ));
        assert!(state.index.is_some());
        assert_eq!(c.generations(), [1], "nothing new was stored");

        let state = run(load(&c, true, async {
            Ok((FIXTURE.to_vec(), FIXTURE_SIG.to_string()))
        }));
        assert_eq!(state.freshness, Freshness::Fresh);
        assert_eq!(c.generations(), [2, 1]);
    }
}
