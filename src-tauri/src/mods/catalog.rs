//! Everything installable: the reviewed index plus the player's sources, as one list. The backend
//! keeps the last list it built, and installs only what is in it: the page names a file by its
//! hash, and the URL and hash always come from here, never from the page.

use serde::Serialize;
use std::sync::{Arc, Mutex};
use ts_rs::TS;

use super::archive::current_platform;
use super::index::{
    Channel, Freshness, Index, IndexMod, IndexVersion, Platform, Provenance, WeftAbi, same_repo,
};
use super::sources::NoModsReason;
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
    /// What `provenance` is worth: only a complete record in the signed index is `recorded`.
    pub build_record: BuildRecord,
    pub reviewed: Option<ReviewedView>,
    pub trust: Trust,
}

/// Where a build's provenance comes from, and whether it says enough to be shown as a record.
/// The launcher never verifies an attestation itself: at best the signed index records that its
/// CI did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum BuildRecord {
    /// No provenance at all.
    None,
    /// The publisher's own `<id>.mod.json` says so. Nothing checked it.
    Claimed,
    /// The signed index has a provenance record, but not a whole one: a kind the launcher doesn't
    /// know, or no repo, workflow or check time, or one that is malformed.
    Incomplete,
    /// The signed index records a GitHub Actions build: its repo, workflow and commit, and when
    /// the index CI checked the attestation.
    Recorded,
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
    /// The index shown was fetched and checked, but couldn't be saved: it is fetched again at
    /// the next start, and offline until then the older saved copy, if any, is what shows.
    pub cache_error: Option<AppError>,
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
    /// Why GitHub's answer has no mods in it, when it has none.
    pub no_mods: Option<NoModsReason>,
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
    /// The player's list of sources couldn't be read (`ModSourcesDamaged`): it was kept aside,
    /// and `sources` is empty until they save a new one.
    pub sources_error: Option<AppError>,
    /// Counts up each time the launcher holds a new catalogue (0: read from disk, never held).
    /// Answers can reach the page in any order; it keeps the one with the highest revision.
    /// A count of refreshes in one session, far below 2^53, so a JavaScript number holds it.
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RevokedView {
    pub sha256: String,
    /// The index's words; null when it gave none (the page says "No reason given" itself).
    pub reason: Option<String>,
}

impl RevokedView {
    /// For an error's detail, which is the backend's own words.
    pub fn detail(&self) -> String {
        self.reason
            .clone()
            .unwrap_or_else(|| "no reason given".into())
    }
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

    /// The revocation of a build, by its hash in any case.
    pub fn revocation(&self, sha256: &str) -> Option<&RevokedView> {
        self.revoked
            .iter()
            .find(|r| r.sha256.eq_ignore_ascii_case(sha256))
    }
}

/// What a catalogue is built from, each part with the ticket of the refresh that brought it.
/// Refreshes take tickets in the order they start; a part is replaced only by an answer from a
/// later one, so a slow refresh that finishes last can't put back older answers over newer ones.
#[derive(Debug, Clone)]
pub struct CatalogParts {
    pub index: Option<Index>,
    pub index_status: IndexStatus,
    pub index_ticket: u64,
    pub sources: Vec<(SourceResult, u64)>,
    pub sources_error: Option<AppError>,
}

impl CatalogParts {
    /// `new` over `old`, part by part, keeping whichever answer is from the later refresh. The
    /// sources are those `listed` now, in that order: one removed meanwhile doesn't come back,
    /// and one whose answer neither has yet waits for the next refresh.
    pub fn merge(old: Option<&CatalogParts>, new: CatalogParts, listed: &[String]) -> CatalogParts {
        let Some(old) = old else {
            let sources = new
                .sources
                .into_iter()
                .filter(|(s, _)| listed.iter().any(|r| same_repo(r, &s.repo)))
                .collect();
            return CatalogParts { sources, ..new };
        };
        let (index, index_status, index_ticket) = if new.index_ticket >= old.index_ticket {
            (new.index, new.index_status, new.index_ticket)
        } else {
            (
                old.index.clone(),
                old.index_status.clone(),
                old.index_ticket,
            )
        };
        let find = |list: &[(SourceResult, u64)], repo: &str| {
            list.iter().find(|(s, _)| same_repo(&s.repo, repo)).cloned()
        };
        let sources = listed
            .iter()
            .filter_map(
                |repo| match (find(&new.sources, repo), find(&old.sources, repo)) {
                    (Some(n), Some(o)) => Some(if n.1 >= o.1 { n } else { o }),
                    (n, o) => n.or(o),
                },
            )
            .collect();
        CatalogParts {
            index,
            index_status,
            index_ticket,
            sources,
            sources_error: new.sources_error,
        }
    }

    pub fn build(&self) -> Catalog {
        let sources = self.sources.iter().map(|(s, _)| s.clone()).collect();
        Catalog {
            sources_error: self.sources_error.clone(),
            ..build(self.index.as_ref(), self.index_status.clone(), sources)
        }
    }
}

/// The catalogue the page last loaded, what it was built from, and the refresh tickets.
#[derive(Default)]
pub struct HeldCatalog {
    pub issued: u64,
    /// The revision of the catalogue held last.
    pub revision: u64,
    pub parts: Option<CatalogParts>,
    pub catalog: Option<Catalog>,
}

#[derive(Default, Clone)]
pub struct CatalogState(pub Arc<Mutex<HeldCatalog>>);

/// What a build's provenance is worth: a record only when the signed index has all of it.
pub fn build_record(provenance: Option<&Provenance>, from_index: bool) -> BuildRecord {
    match provenance {
        None => BuildRecord::None,
        Some(_) if !from_index => BuildRecord::Claimed,
        Some(p) if p.is_complete() => BuildRecord::Recorded,
        Some(_) => BuildRecord::Incomplete,
    }
}

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
        build_record: build_record(v.provenance.as_ref(), from_index),
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
#[derive(Debug, Clone)]
pub struct SourceResult {
    pub repo: String,
    pub mods: Vec<IndexMod>,
    pub freshness: Freshness,
    pub checked: Option<String>,
    pub error: Option<AppError>,
    pub no_mods: Option<NoModsReason>,
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
            no_mods: if count == 0 { source.no_mods } else { None },
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
                        sha256: r.sha256.to_ascii_lowercase(),
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
        sources_error: None,
        revision: 0,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::index::{Provenance, tests::version};
    use super::*;

    fn answer(repo: &str, sha: &str, freshness: Freshness) -> SourceResult {
        SourceResult {
            repo: repo.into(),
            mods: vec![index_mod("lanterns", repo, sha)],
            freshness,
            checked: None,
            error: None,
            no_mods: None,
        }
    }

    fn parts(ticket: u64, sources: Vec<SourceResult>, index_freshness: Freshness) -> CatalogParts {
        CatalogParts {
            index: None,
            index_status: IndexStatus {
                freshness: index_freshness,
                ..status()
            },
            index_ticket: ticket,
            sources: sources.into_iter().map(|s| (s, ticket)).collect(),
            sources_error: None,
        }
    }

    /// Two refreshes, the first finishing last: its answers don't replace the second's, part
    /// by part, and what neither had is kept from before.
    #[test]
    fn answers_arriving_in_reverse_order_keep_the_newer_parts() {
        let listed = vec!["a/one".to_string(), "b/two".to_string()];
        let first = parts(
            1,
            vec![
                answer("a/one", &"1".repeat(64), Freshness::Cached),
                answer("b/two", &"1".repeat(64), Freshness::Cached),
            ],
            Freshness::Cached,
        );
        let second = parts(
            2,
            vec![answer("a/one", &"2".repeat(64), Freshness::Fresh)],
            Freshness::Fresh,
        );
        // The second arrives first, over nothing; then the first, late.
        let held = CatalogParts::merge(None, second, &listed);
        let held = CatalogParts::merge(Some(&held), first, &listed);
        assert_eq!(
            held.index_status.freshness,
            Freshness::Fresh,
            "the index from the later refresh"
        );
        let one = held
            .sources
            .iter()
            .find(|(s, _)| s.repo == "a/one")
            .unwrap();
        assert_eq!(
            (one.0.freshness, one.1),
            (Freshness::Fresh, 2),
            "a/one from the later refresh"
        );
        let two = held
            .sources
            .iter()
            .find(|(s, _)| s.repo == "b/two")
            .unwrap();
        assert_eq!(two.1, 1, "b/two only the first had");
        let built = held.build();
        assert_eq!(built.mods[0].versions[0].sha256, "2".repeat(64));
    }

    #[test]
    fn a_source_removed_meanwhile_does_not_come_back() {
        let held = parts(
            1,
            vec![answer("a/one", &"1".repeat(64), Freshness::Fresh)],
            Freshness::Fresh,
        );
        let late = parts(
            2,
            vec![answer("a/one", &"2".repeat(64), Freshness::Fresh)],
            Freshness::Fresh,
        );
        let merged = CatalogParts::merge(Some(&held), late, &[]);
        assert!(merged.sources.is_empty());
    }

    #[test]
    fn a_disk_read_never_replaces_a_refreshed_part() {
        let listed = vec!["a/one".to_string()];
        let fresh = parts(
            3,
            vec![answer("a/one", &"3".repeat(64), Freshness::Fresh)],
            Freshness::Fresh,
        );
        let from_disk = parts(
            0,
            vec![answer("a/one", &"0".repeat(64), Freshness::Cached)],
            Freshness::Cached,
        );
        let merged = CatalogParts::merge(Some(&fresh), from_disk, &listed);
        assert_eq!(merged.index_status.freshness, Freshness::Fresh);
        assert_eq!(merged.sources[0].1, 3);
    }

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
            cache_error: None,
        }
    }

    fn source(repo: &str, mods: Vec<IndexMod>) -> SourceResult {
        SourceResult {
            repo: repo.into(),
            mods,
            freshness: Freshness::Fresh,
            checked: None,
            error: None,
            no_mods: None,
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

    /// Provenance is a record only when the signed index recorded all of it; a source's own claim
    /// is passed on but never a record, and a source can't claim a review.
    #[test]
    fn only_the_index_records_provenance() {
        let provenance = Provenance {
            kind: "github-attestation".into(),
            repo: Some("Zorro909/weft-mods".into()),
            workflow: Some(".github/workflows/release.yml".into()),
            git_ref: None,
            verified_at: Some("2026-11-04T18:00:00Z".into()),
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
        assert_eq!(v('a').build_record, BuildRecord::Recorded);
        assert_eq!(v('b').build_record, BuildRecord::None);
        assert!(v('c').provenance.is_some());
        assert_eq!(v('c').build_record, BuildRecord::Claimed);
        assert!(v('c').reviewed.is_none());
        assert_eq!(v('c').trust, Trust::Unreviewed);
    }

    /// A provenance record in the signed index that doesn't say all of it (another kind, no
    /// workflow, no or a malformed check time, a repo that isn't one) is incomplete: never shown
    /// as a recorded build.
    #[test]
    fn an_incomplete_index_record_is_not_a_record() {
        let whole = Provenance {
            kind: "github-attestation".into(),
            repo: Some("Zorro909/weft-mods".into()),
            workflow: Some(".github/workflows/release.yml".into()),
            git_ref: Some("refs/heads/main".into()),
            verified_at: Some("2026-11-04T18:00:00Z".into()),
        };
        type Spoil = fn(&mut Provenance);
        let cases: [(&str, Spoil); 8] = [
            ("unknown kind", |p| p.kind = "unknown".into()),
            ("no repo", |p| p.repo = None),
            ("repo not a repo", |p| p.repo = Some("not a repo".into())),
            ("no workflow", |p| p.workflow = None),
            ("workflow outside", |p| {
                p.workflow = Some("../evil.yml".into())
            }),
            ("workflow not yaml", |p| {
                p.workflow = Some(".github/workflows/x.sh".into())
            }),
            ("no check time", |p| p.verified_at = None),
            ("bad check time", |p| {
                p.verified_at = Some("yesterday".into())
            }),
        ];
        for (i, (why, spoil)) in cases.iter().enumerate() {
            let mut p = whole.clone();
            spoil(&mut p);
            let sha = format!("{:064x}", i + 1);
            let mut m = index_mod("cogwork", "Zorro909/weft-mods", &sha);
            m.versions[0].provenance = Some(p);
            let index = Index {
                schema: 1,
                generated: "2026-11-04T00:00:00Z".into(),
                weft: vec![],
                mods: vec![m],
                revoked: vec![],
            };
            let catalog = build(Some(&index), status(), vec![]);
            let v = catalog.find(&sha).unwrap().1;
            assert_eq!(v.build_record, BuildRecord::Incomplete, "{why}");
            assert_eq!(v.trust, Trust::Reviewed, "{why}: the review still stands");
        }
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
