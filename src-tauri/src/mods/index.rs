//! The mod index: an unsigned JSON file that the index repository's CI generates. It pins the
//! SHA-256 of every build it lists. The last copy that parsed is cached for offline use.

use semver::Version;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Dirs, ModError, is_hex, log, valid_id};

pub const INDEX_URL: &str = "https://weft-rust.github.io/weft-mods-index/v2/index.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Index {
    pub mods: Vec<IndexMod>,
    pub revoked: Vec<Revoked>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexMod {
    pub id: String,
    pub name: String,
    pub summary: String,
    /// `owner/name` on GitHub: where the builds are downloaded from and must be attested by.
    pub repo: String,
    pub builds: Vec<Build>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Build {
    pub version: String,
    pub tag: String,
    pub abi: String,
    pub deps: Vec<String>,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Revoked {
    pub sha256: String,
    #[serde(default)]
    pub reason: Option<String>,
}

impl Index {
    pub fn find(&self, id: &str) -> Option<&IndexMod> {
        self.mods.iter().find(|m| m.id == id)
    }

    pub fn revoked(&self, sha256: &str) -> Option<&Revoked> {
        self.revoked.iter().find(|r| r.sha256 == sha256)
    }

    /// The build with this hash, which makes a file verified.
    pub fn by_hash(&self, sha256: &str) -> Option<(&IndexMod, &Build)> {
        self.mods
            .iter()
            .flat_map(|m| m.builds.iter().map(move |b| (m, b)))
            .find(|(_, b)| b.sha256 == sha256)
    }

    /// The newest build of `id` for `abi` that isn't revoked.
    pub fn newest(&self, id: &str, abi: &str) -> Option<(&IndexMod, &Build)> {
        let m = self.find(id)?;
        let build = m
            .builds
            .iter()
            .filter(|b| b.abi == abi && self.revoked(&b.sha256).is_none())
            .max_by_key(|b| version(&b.version))?;
        Some((m, build))
    }
}

pub fn version(v: &str) -> Version {
    Version::parse(v).unwrap_or(Version::new(0, 0, 0))
}

/// Entries that break a rule are skipped, so one bad entry can't hide the rest.
pub fn parse(bytes: &[u8]) -> Result<Index, String> {
    #[derive(Deserialize)]
    struct Raw {
        schema: u32,
        #[serde(default)]
        mods: Vec<Value>,
        #[serde(default)]
        revoked: Vec<Value>,
    }
    let raw: Raw = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if raw.schema != 2 {
        return Err(format!("unknown schema {}", raw.schema));
    }
    Ok(Index {
        mods: raw
            .mods
            .into_iter()
            .filter_map(entry::<IndexMod>)
            .filter_map(checked)
            .collect(),
        revoked: raw
            .revoked
            .into_iter()
            .filter_map(entry::<Revoked>)
            .filter(|r| is_hex(&r.sha256, 64))
            .collect(),
    })
}

fn entry<T: DeserializeOwned>(v: Value) -> Option<T> {
    serde_json::from_value(v.clone())
        .map_err(|e| log(format_args!("index: skipping {v}: {e}")))
        .ok()
}

fn checked(mut m: IndexMod) -> Option<IndexMod> {
    if !valid_id(&m.id) || !valid_repo(&m.repo) {
        log(format_args!(
            "index: skipping mod {:?} from {:?}",
            m.id, m.repo
        ));
        return None;
    }
    m.builds.retain(|b| {
        let ok = Version::parse(&b.version).is_ok()
            && valid_tag(&b.tag)
            && is_hex(&b.abi, 16)
            && is_hex(&b.sha256, 64)
            && b.deps.iter().all(|d| valid_id(d));
        if !ok {
            log(format_args!("index: skipping {} {:?}", m.id, b.tag));
        }
        ok
    });
    // Newest first, which is what the UI offers.
    m.builds
        .sort_by_key(|b| std::cmp::Reverse(version(&b.version)));
    Some(m)
}

fn valid_repo(s: &str) -> bool {
    let part = |p: &str| {
        !p.is_empty()
            && p != "."
            && p != ".."
            && p.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    };
    s.split_once('/')
        .is_some_and(|(owner, name)| part(owner) && part(name))
}

fn valid_tag(s: &str) -> bool {
    (1..=100).contains(&s.len())
        && !s.starts_with('.')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

pub fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("weft-launcher")
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("HTTP client")
}

/// Fetches the index and caches it. An index that doesn't parse counts as unreachable.
pub async fn fetch(dirs: &Dirs) -> Result<Index, ModError> {
    let bytes = http()
        .get(INDEX_URL)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    let index = parse(&bytes).map_err(|e| ModError::Network(format!("index: {e}")))?;
    let path = dirs.index_cache();
    let tmp = path.with_extension("json.tmp");
    let saved = std::fs::create_dir_all(path.parent().unwrap())
        .and_then(|_| std::fs::write(&tmp, &bytes))
        .and_then(|_| std::fs::rename(&tmp, &path));
    if let Err(e) = saved {
        log(format_args!("index: couldn't cache: {e}"));
    }
    Ok(index)
}

/// The last index that was fetched, if any.
pub fn cached(dirs: &Dirs) -> Option<Index> {
    parse(&std::fs::read(dirs.index_cache()).ok()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "989b2191c0ffee00989b2191c0ffee00989b2191c0ffee00989b2191c0ffee00";

    #[test]
    fn bad_entries_are_skipped_and_the_rest_kept() {
        let json = format!(
            r#"{{"schema": 2, "weft": {{"v1": "f470b1cbb1f9ad91", "v0": "short"}},
            "mods": [
              {{"id": "cogwork", "name": "Cogwork", "summary": "", "repo": "Zorro909/weft-mods",
                "builds": [
                  {{"version": "0.2.0", "tag": "cogwork-v0.2.0", "abi": "f470b1cbb1f9ad91", "deps": ["base"], "sha256": "{SHA}"}},
                  {{"version": "0.3.0", "tag": ".hidden", "abi": "f470b1cbb1f9ad91", "deps": [], "sha256": "{SHA}"}},
                  {{"version": "x", "tag": "t", "abi": "f470b1cbb1f9ad91", "deps": [], "sha256": "{SHA}"}}
                ]}},
              {{"id": "../evil", "name": "", "summary": "", "repo": "a/b", "builds": []}},
              {{"id": "norepo", "name": "", "summary": "", "repo": "../b", "builds": []}},
              {{"id": "missing_fields"}}
            ],
            "revoked": [{{"sha256": "{SHA}"}}, {{"sha256": "nope", "reason": "x"}}]}}"#
        );
        let index = parse(json.as_bytes()).unwrap();
        assert_eq!(index.mods.len(), 1);
        assert_eq!(index.mods[0].builds.len(), 1);
        assert_eq!(index.revoked.len(), 1);
        assert!(index.revoked(SHA).unwrap().reason.is_none());
    }

    #[test]
    fn other_schemas_and_garbage_are_refused() {
        assert!(parse(br#"{"schema": 1, "mods": []}"#).is_err());
        assert!(parse(b"<html>").is_err());
    }

    #[test]
    fn newest_skips_other_abis_and_revoked_builds() {
        let build = |v: &str, abi: &str, sha: char| Build {
            version: v.into(),
            tag: format!("m-v{v}"),
            abi: abi.into(),
            deps: vec![],
            sha256: sha.to_string().repeat(64),
        };
        let index = Index {
            mods: vec![IndexMod {
                id: "m".into(),
                name: "M".into(),
                summary: String::new(),
                repo: "o/r".into(),
                builds: vec![
                    build("0.9.0", "aaaaaaaaaaaaaaaa", 'a'),
                    build("0.10.0", "aaaaaaaaaaaaaaaa", 'b'),
                    build("0.11.0", "aaaaaaaaaaaaaaaa", 'c'),
                    build("2.0.0", "bbbbbbbbbbbbbbbb", 'd'),
                ],
            }],
            revoked: vec![Revoked {
                sha256: "c".repeat(64),
                reason: None,
            }],
        };
        let (_, b) = index.newest("m", "aaaaaaaaaaaaaaaa").unwrap();
        assert_eq!(b.version, "0.10.0");
        assert!(index.newest("m", "cccccccccccccccc").is_none());
    }
}
