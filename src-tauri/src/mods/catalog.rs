//! Everything installable: the reviewed index plus the player's sources, as one list. The backend
//! keeps the last list it built, and installs only what is in it: the page names a file by its
//! hash, and the URL and hash always come from here, never from the page.

use serde::Serialize;
use std::sync::Mutex;

use super::archive::current_platform;
use super::index::{Channel, Freshness, Index, IndexMod, IndexVersion, WeftAbi};

#[derive(Debug, Clone, Copy, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Trust {
    /// In the signed index: someone reviewed exactly these bytes.
    Reviewed,
    /// From a source the player added. Built and published by its repo, not reviewed.
    Unreviewed,
    /// A file from the player's computer. Nothing about where it came from can be checked.
    Unverified,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Origin {
    Index,
    Source { repo: String },
    File { name: String },
}

#[derive(Debug, Clone, Serialize)]
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
    pub platforms: Vec<String>,
    pub sha256: String,
    pub size: u64,
    pub url: String,
    pub provenance: Option<ProvenanceView>,
    pub reviewed: Option<ReviewedView>,
    pub trust: Trust,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceView {
    pub repo: Option<String>,
    pub workflow: Option<String>,
    pub git_ref: Option<String>,
    pub verified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedView {
    pub by: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub freshness: Freshness,
    pub generated: Option<String>,
    pub error: Option<crate::error::AppError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub repo: String,
    pub mods: usize,
    pub error: Option<crate::error::AppError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub mods: Vec<CatalogMod>,
    pub revoked: Vec<RevokedView>,
    pub index: IndexStatus,
    pub sources: Vec<SourceStatus>,
    pub weft: Vec<WeftAbi>,
    pub platform: &'static str,
}

#[derive(Debug, Clone, Serialize)]
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

    pub fn revocation(&self, sha256: &str) -> Option<&RevokedView> {
        self.revoked.iter().find(|r| r.sha256 == sha256)
    }
}

#[derive(Default)]
pub struct CatalogState(pub Mutex<Option<Catalog>>);

fn version_view(v: &IndexVersion, trust: Trust) -> CatalogVersion {
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
        platforms: v.platforms.clone(),
        sha256: v.asset.sha256.to_ascii_lowercase(),
        size: v.asset.size,
        url: v.asset.url.clone(),
        provenance: v.provenance.as_ref().map(|p| ProvenanceView {
            repo: p.repo.clone(),
            workflow: p.workflow.clone(),
            git_ref: p.git_ref.clone(),
            verified_at: p.verified_at.clone(),
        }),
        reviewed: v.reviewed.as_ref().map(|r| ReviewedView {
            by: r.by.clone(),
            at: r.at.clone(),
        }),
        trust,
    }
}

fn mod_view(m: &IndexMod, origin: Origin, trust: Trust, skip: &[String]) -> CatalogMod {
    let key = match &origin {
        Origin::Index => format!("index:{}", m.id),
        Origin::Source { repo } => format!("source:{repo}:{}", m.id),
        Origin::File { name } => format!("file:{name}"),
    };
    let mut versions: Vec<CatalogVersion> = m
        .versions
        .iter()
        .filter(|v| !skip.contains(&v.asset.sha256.to_ascii_lowercase()))
        .map(|v| version_view(v, trust))
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

/// One list from the index and every source. A source release that is also in the index shows
/// once, as reviewed.
pub fn build(
    index: Option<&Index>,
    index_status: IndexStatus,
    sources: Vec<(String, Result<Vec<IndexMod>, crate::error::AppError>)>,
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
    let mut statuses = Vec::new();
    for (repo, result) in sources {
        match result {
            Ok(list) => {
                let mut count = 0;
                for m in &list {
                    let view = mod_view(
                        m,
                        Origin::Source { repo: repo.clone() },
                        Trust::Unreviewed,
                        &reviewed_hashes,
                    );
                    if !view.versions.is_empty() {
                        count += 1;
                        mods.push(view);
                    }
                }
                statuses.push(SourceStatus {
                    repo,
                    mods: count,
                    error: None,
                });
            }
            Err(e) => statuses.push(SourceStatus {
                repo,
                mods: 0,
                error: Some(e),
            }),
        }
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
        platform: current_platform(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::index::tests::version;
    use super::*;

    fn index_mod(id: &str, repo: &str, sha: &str) -> IndexMod {
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
        let status = IndexStatus {
            freshness: Freshness::Fresh,
            generated: None,
            error: None,
        };
        let catalog = build(
            Some(&index),
            status,
            vec![(
                "Zorro909/weft-mods".into(),
                Ok(vec![index_mod("cogwork", "Zorro909/weft-mods", &sha)]),
            )],
        );
        assert_eq!(catalog.mods.len(), 1);
        assert_eq!(catalog.find(&sha).unwrap().1.trust, Trust::Reviewed);
        assert_eq!(catalog.sources[0].mods, 0);
    }
}
