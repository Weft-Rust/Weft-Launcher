//! Everything installable: the reviewed index plus the player's sources, as one list. The backend
//! keeps the last list it built, and installs only what is in it: the page names a file by its
//! hash, and the URL and hash always come from here, never from the page.

use serde::Serialize;
use std::sync::Mutex;
use ts_rs::TS;

use super::archive::current_platform;
use super::index::{
    Channel, Freshness, Index, IndexMod, IndexVersion, Platform, WeftAbi, same_repo,
};
use crate::error::AppError;

#[derive(Debug, Clone, Copy, Serialize, serde::Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
pub enum Trust {
    /// In the signed index, with a recorded review of exactly these bytes.
    Reviewed,
    /// From a source the player added. Built and published by its repo, not reviewed.
    Unreviewed,
    /// A file from the player's computer. Nothing about where it came from can be checked.
    Unverified,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq, Eq, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Origin {
    Index,
    Source { repo: String },
    File { name: String },
}

impl Origin {
    /// The catalogue key of mod `id` from here; files from the player's computer have none.
    pub fn key(&self, id: &str) -> Option<String> {
        match self {
            Origin::Index => Some(format!("index:{id}")),
            Origin::Source { repo } => Some(format!("source:{repo}:{id}")),
            Origin::File { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CatalogVersion {
    pub version: String,
    pub channel: Channel,
    pub tag: String,
    pub published: String,
    pub source_repo: String,
    pub source_commit: String,
    pub weft_tag: Option<String>,
    pub abi: String,
    pub deps: Vec<String>,
    pub platforms: Vec<Platform>,
    pub sha256: String,
    pub size: u64,
    pub url: String,
    pub provenance: Option<ProvenanceView>,
    /// True only when `provenance` came from the signed index. A source's own `<id>.mod.json`
    /// may claim a provenance; that claim is shown, but it is false here.
    pub provenance_verified: bool,
    pub reviewed: Option<ReviewedView>,
    pub trust: Trust,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceView {
    pub repo: Option<String>,
    pub workflow: Option<String>,
    pub git_ref: Option<String>,
    pub verified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedView {
    pub by: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CatalogMod {
    /// Unique across origins: the index and a source may both have a `cogwork`.
    pub key: String,
    pub id: String,
    pub name: String,
    pub summary: String,
    pub authors: Vec<String>,
    pub license: Option<String>,
    pub homepage: Option<String>,
    pub icon: Option<String>,
    pub origin: Origin,
    pub versions: Vec<CatalogVersion>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub freshness: Freshness,
    pub generated: Option<String>,
    /// RFC 3339, from the signature's trusted comment (`timestamp:`).
    pub signed_at: Option<String>,
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    /// As GitHub spells it.
    pub repo: String,
    pub mods: usize,
    /// `cached`: the last good answer, because it wasn't refreshed or the refresh failed.
    pub freshness: Freshness,
    /// RFC 3339 time the data shown was fetched.
    pub checked: Option<String>,
    /// Set whenever the last refresh failed, even when cached data is shown.
    pub error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub mods: Vec<CatalogMod>,
    pub revoked: Vec<RevokedView>,
    pub index: IndexStatus,
    pub sources: Vec<SourceStatus>,
    pub weft: Vec<WeftAbi>,
    /// The system the launcher runs on (`windows-x64`, `linux-x64`, `macos-arm64`), or empty.
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RevokedView {
    pub sha256: String,
    pub reason: String,
}

impl Catalog {
    pub fn find(&self, sha256: &str) -> Option<(&CatalogMod, &CatalogVersion)> {
        self.mods.iter().find_map(|m| {
            m.versions
                .iter()
                .find(|v| v.sha256 == sha256)
                .map(|v| (m, v))
        })
    }

    /// Keys hold a repo name, and repos compare without case.
    pub fn by_key(&self, key: &str) -> Option<&CatalogMod> {
        self.mods.iter().find(|m| m.key.eq_ignore_ascii_case(key))
    }

    pub fn revocation(&self, sha256: &str) -> Option<&RevokedView> {
        self.revoked.iter().find(|r| r.sha256 == sha256)
    }
}

#[derive(Default)]
pub struct CatalogState(pub Mutex<Option<Catalog>>);

fn version_view(v: &IndexVersion, trust: Trust, from_index: bool) -> CatalogVersion {
    CatalogVersion {
        version: v.version.clone(),
        channel: v.channel,
        tag: v.tag.clone(),
        published: v.published.clone(),
        source_repo: v.source.repo.clone(),
        source_commit: v.source.commit.clone(),
        weft_tag: v.weft.tag.clone(),
        abi: v.weft.abi.clone(),
        deps: v.deps.iter().map(|d| d.id.clone()).collect(),
        platforms: v.known_platforms(),
        sha256: v.asset.sha256.to_ascii_lowercase(),
        size: v.asset.size,
        url: v.asset.url.clone(),
        provenance: v.provenance.as_ref().map(|p| ProvenanceView {
            repo: p.repo.clone(),
            workflow: p.workflow.clone(),
            git_ref: p.git_ref.clone(),
            verified_at: p.verified_at.clone(),
        }),
        provenance_verified: from_index && v.provenance.is_some(),
        // Only the index records reviews; a source can't claim one.
        reviewed: v
            .reviewed
            .as_ref()
            .filter(|_| from_index)
            .map(|r| ReviewedView {
                by: r.by.clone(),
                at: r.at.clone(),
            }),
        trust,
    }
}

fn mod_view(m: &IndexMod, origin: Origin, trust: Trust, skip: &[String]) -> CatalogMod {
    let key = origin
        .key(&m.id)
        .unwrap_or_else(|| format!("file:{}", m.id));
    let from_index = origin == Origin::Index;
    let mut versions: Vec<CatalogVersion> = m
        .versions
        .iter()
        .filter(|v| !skip.contains(&v.asset.sha256.to_ascii_lowercase()))
        .map(|v| version_view(v, trust, from_index))
        .collect();
    versions.sort_by(|a, b| super::version::compare(&b.version, &a.version));
    CatalogMod {
        key,
        id: m.id.clone(),
        name: m.name.clone(),
        summary: m.summary.clone(),
        authors: m.authors.clone(),
        license: m.license.clone(),
        homepage: m.homepage.clone(),
        icon: m.icon.clone(),
        origin,
        versions,
    }
}

/// One source as read for this catalogue: its mods (possibly from the cache) and how fresh
/// they are.
pub struct SourceResult {
    pub repo: String,
    pub mods: Vec<IndexMod>,
    pub freshness: Freshness,
    pub checked: Option<String>,
    pub error: Option<AppError>,
}

/// One list from the index and every source. A source release that is also in the index shows
/// once, as reviewed.
pub fn build(
    index: Option<&Index>,
    index_status: IndexStatus,
    sources: Vec<SourceResult>,
) -> Catalog {
    let mut mods = Vec::new();
    let mut reviewed_hashes = Vec::new();
    if let Some(index) = index {
        for m in &index.mods {
            reviewed_hashes.extend(
                m.versions
                    .iter()
                    .map(|v| v.asset.sha256.to_ascii_lowercase()),
            );
            mods.push(mod_view(m, Origin::Index, Trust::Reviewed, &[]));
        }
    }
    let mut statuses: Vec<SourceStatus> = Vec::new();
    for source in sources {
        if statuses.iter().any(|s| same_repo(&s.repo, &source.repo)) {
            continue;
        }
        let mut count = 0;
        for m in &source.mods {
            let view = mod_view(
                m,
                Origin::Source {
                    repo: source.repo.clone(),
                },
                Trust::Unreviewed,
                &reviewed_hashes,
            );
            if !view.versions.is_empty() {
                count += 1;
                mods.push(view);
            }
        }
        statuses.push(SourceStatus {
            repo: source.repo,
            mods: count,
            freshness: source.freshness,
            checked: source.checked,
            error: source.error,
        });
    }
    mods.sort_by_key(|m| m.name.to_lowercase());
    Catalog {
        mods,
        revoked: index
            .map(|i| {
                i.revoked
                    .iter()
                    .map(|r| RevokedView {
                        sha256: r.sha256.clone(),
                        reason: r.reason.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        index: index_status,
        sources: statuses,
        weft: index.map(|i| i.weft.clone()).unwrap_or_default(),
        platform: current_platform()
            .map(|p| p.as_str().to_string())
            .unwrap_or_default(),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::index::{Provenance, tests::version};
    use super::*;

    pub fn index_mod(id: &str, repo: &str, sha: &str) -> IndexMod {
        IndexMod {
            id: id.into(),
            name: id.into(),
            summary: String::new(),
            authors: vec![],
            license: None,
            homepage: None,
            icon: None,
            versions: vec![version(id, repo, sha)],
        }
    }

    fn status() -> IndexStatus {
        IndexStatus {
            freshness: Freshness::Fresh,
            generated: None,
            signed_at: None,
            error: None,
        }
    }

    fn source(repo: &str, mods: Vec<IndexMod>) -> SourceResult {
        SourceResult {
            repo: repo.into(),
            mods,
            freshness: Freshness::Fresh,
            checked: None,
            error: None,
        }
    }

    #[test]
    fn source_copy_of_a_reviewed_file_shows_once() {
        let sha = "a".repeat(64);
        let index = Index {
            schema: 1,
            generated: "2026-11-04T00:00:00Z".into(),
            weft: vec![],
            mods: vec![index_mod("cogwork", "Zorro909/weft-mods", &sha)],
            revoked: vec![],
        };
        let catalog = build(
            Some(&index),
            status(),
            vec![source(
                "Zorro909/weft-mods",
                vec![index_mod("cogwork", "Zorro909/weft-mods", &sha)],
            )],
        );
        assert_eq!(catalog.mods.len(), 1);
        assert_eq!(catalog.find(&sha).unwrap().1.trust, Trust::Reviewed);
        assert_eq!(catalog.sources[0].mods, 0);
    }

    /// Provenance is verified only when the signed index recorded it; a source's own claim is
    /// passed on but never marked verified, and a source can't claim a review.
    #[test]
    fn only_the_index_verifies_provenance() {
        let provenance = Provenance {
            kind: "github-attestation".into(),
            repo: Some("Zorro909/weft-mods".into()),
            workflow: Some(".github/workflows/release.yml".into()),
            git_ref: None,
            verified_at: None,
        };
        let mut reviewed = index_mod("cogwork", "Zorro909/weft-mods", &"a".repeat(64));
        reviewed.versions[0].provenance = Some(provenance.clone());
        let mut plain = index_mod("showcase", "Zorro909/weft-mods", &"b".repeat(64));
        plain.versions[0].provenance = None;
        let mut claimed = index_mod("lanterns", "Someone/lanterns", &"c".repeat(64));
        claimed.versions[0].provenance = Some(provenance);
        let index = Index {
            schema: 1,
            generated: "2026-11-04T00:00:00Z".into(),
            weft: vec![],
            mods: vec![reviewed, plain],
            revoked: vec![],
        };
        let catalog = build(
            Some(&index),
            status(),
            vec![source("Someone/lanterns", vec![claimed])],
        );
        let v = |sha: char| catalog.find(&sha.to_string().repeat(64)).unwrap().1;
        assert!(v('a').provenance_verified);
        assert!(!v('b').provenance_verified);
        assert!(v('c').provenance.is_some());
        assert!(!v('c').provenance_verified);
        assert!(v('c').reviewed.is_none());
        assert_eq!(v('c').trust, Trust::Unreviewed);
    }

    #[test]
    fn keys_ignore_repo_case_and_sources_show_once() {
        let catalog = build(
            None,
            status(),
            vec![
                source(
                    "Someone/Lanterns",
                    vec![index_mod("lanterns", "Someone/Lanterns", &"c".repeat(64))],
                ),
                source("someone/lanterns", vec![]),
            ],
        );
        assert_eq!(catalog.sources.len(), 1);
        assert!(catalog.by_key("source:someone/lanterns:lanterns").is_some());
    }
}
