//! GitHub repos the player added as mod sources. A release counts when it carries `<id>.zip` and
//! `<id>.mod.json` (see `docs/mod-manager/INDEX_FORMAT.md`). Nobody reviewed these, which the
//! catalogue says; what is checked is that the description and the zip agree with GitHub's own
//! record of the release.

use reqwest::header::{ETAG, IF_NONE_MATCH, LINK, USER_AGENT};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use ts_rs::TS;

use super::error::ModsError;
use super::index::{
    Asset, Channel, Dep, Freshness, IndexMod, IndexVersion, Provenance, RESERVED_ID, SourceRef,
    WeftRef, clamp_summary, is_mod_id, is_repo, same_repo, version_problem,
};
use super::paths::{Paths, write_atomic};
use super::profile::now;
use crate::download::read_capped;

const USER_AGENT_VALUE: &str = concat!("weft-launcher/", env!("CARGO_PKG_VERSION"));
pub const MAX_MOD_JSON_BYTES: usize = 64 * 1024;
/// Releases are read 100 at a time, newest first, up to this many pages.
pub const MAX_RELEASE_PAGES: usize = 5;

#[derive(Debug, Default, Serialize, Deserialize)]
struct SourcesFile {
    repos: Vec<String>,
}

/// The player's sources. No file is no sources. A file that can't be read or isn't a sources
/// list is never taken for an empty one: it is moved aside, kept, and `ModSourcesDamaged` names
/// where, until the player saves a new list ([`save`]) or puts that one back.
pub fn list(paths: &Paths) -> Result<Vec<String>, ModsError> {
    let file = paths.sources_file();
    match std::fs::read(&file) {
        Ok(bytes) => match serde_json::from_slice::<SourcesFile>(&bytes) {
            Ok(f) => Ok(f.repos.into_iter().filter(|r| is_repo(r)).collect()),
            Err(e) => Err(set_aside(&file, &e.to_string())),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => match damaged_copy(&file) {
            Some(kept) => Err(ModsError::SourcesDamaged(kept.display().to_string())),
            None => Ok(Vec::new()),
        },
        Err(e) => Err(set_aside(&file, &e.to_string())),
    }
}

/// The list to change: a damaged one is already set aside and kept, so a change starts a new one.
pub fn list_for_change(paths: &Paths) -> Result<Vec<String>, ModsError> {
    match list(paths) {
        // Only once it is out of the way: a file that couldn't be moved is never overwritten.
        Err(ModsError::SourcesDamaged(_)) if !paths.sources_file().exists() => Ok(Vec::new()),
        other => other,
    }
}

/// `sources.json` moved to `sources.damaged-<seconds>.json` beside it, and the error naming it.
fn set_aside(file: &Path, why: &str) -> ModsError {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let kept = file.with_file_name(format!("sources.damaged-{stamp}.json"));
    match std::fs::rename(file, &kept) {
        Ok(()) => {
            eprintln!(
                "mod sources: {} is damaged ({why}); kept as {}",
                file.display(),
                kept.display()
            );
            ModsError::SourcesDamaged(kept.display().to_string())
        }
        // It can't even be moved: it stays where it is, and is still never overwritten
        // unasked (`list_for_change` only starts over once it is aside).
        Err(_) => ModsError::SourcesDamaged(file.display().to_string()),
    }
}

/// The newest damaged list set aside next to `file`, if there is one.
fn damaged_copy(file: &Path) -> Option<PathBuf> {
    let dir = file.parent()?;
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("sources.damaged-") && n.ends_with(".json"))
        })
        .max()
}

/// Writes the list. A damaged one set aside before stays where it is, kept.
pub fn save(paths: &Paths, repos: &[String]) -> Result<(), ModsError> {
    let file = SourcesFile {
        repos: repos.to_vec(),
    };
    write_atomic(&paths.sources_file(), &serde_json::to_vec_pretty(&file)?)
}

/// The list with `canonical` added, or replacing the same repo spelled another way.
pub fn with_repo(mut repos: Vec<String>, canonical: &str) -> Vec<String> {
    match repos.iter_mut().find(|r| same_repo(r, canonical)) {
        Some(r) => *r = canonical.to_string(),
        None => repos.push(canonical.to_string()),
    }
    repos
}

pub fn without_repo(mut repos: Vec<String>, repo: &str) -> Vec<String> {
    repos.retain(|r| !same_repo(r, repo));
    repos
}

/// Accepts `owner/repo` or a github.com URL of the repo.
pub fn normalize(input: &str) -> Result<String, ModsError> {
    let trimmed = input.trim().trim_end_matches('/');
    let trimmed = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let repo = ["https://github.com/", "http://github.com/", "github.com/"]
        .iter()
        .find_map(|p| trimmed.strip_prefix(p))
        .unwrap_or(trimmed);
    if is_repo(repo) {
        Ok(repo.to_string())
    } else {
        Err(ModsError::SourceInvalid(input.to_string()))
    }
}

/// `<id>.mod.json`: one version of one mod, with the mod's own fields beside it.
#[derive(Debug, Clone, Deserialize)]
pub struct ModJson {
    pub schema: u32,
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
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GhAsset {
    pub name: String,
    pub browser_download_url: String,
    pub size: u64,
    #[serde(default)]
    pub digest: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GhRelease {
    pub tag_name: String,
    #[serde(default)]
    pub draft: bool,
    pub prerelease: bool,
    #[serde(default)]
    pub published_at: Option<String>,
    pub assets: Vec<GhAsset>,
}

/// Why a source that GitHub answered has no mods to offer, by how far its best release got.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum NoModsReason {
    /// It has no published releases.
    NoReleases,
    /// No release carries an `<id>.zip` with its `<id>.mod.json`.
    NoModFiles,
    /// A release's `<id>.mod.json` couldn't be read, or isn't one.
    Unreadable,
    /// GitHub has no SHA-256 digest for the zip, so nothing could be checked.
    NoDigest,
    /// The description doesn't match GitHub's record of the release (tag, repo, asset, size or
    /// hash), or names another id.
    Disagrees,
    /// It matches, but breaks a rule every mod follows (version, interface, URL, dependencies).
    Invalid,
}

/// Keeps the reason that got furthest.
fn note(seen: &mut Option<NoModsReason>, why: NoModsReason) {
    *seen = Some(seen.map_or(why, |s| s.max(why)));
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SourceCache {
    etag: Option<String>,
    mods: Vec<IndexMod>,
    /// When GitHub last answered; missing in caches older launchers wrote.
    #[serde(default)]
    checked: Option<String>,
    /// Why there are no mods, when there are none.
    #[serde(default)]
    no_mods: Option<NoModsReason>,
}

fn cache_path(paths: &Paths, repo: &str) -> std::path::PathBuf {
    paths.cache_dir().join("mod-sources").join(format!(
        "{}.json",
        repo.to_ascii_lowercase().replace('/', "__")
    ))
}

/// Checks one release's description against GitHub's record of the same release:
/// schema 1; the id is a mod id (not `base`) and the zip's stem; the tag, repo, asset name, URL
/// and size equal GitHub's;
/// the SHA-256 equals GitHub's digest (a release without a digest is skipped); and then every
/// rule an index entry must follow. A GitHub prerelease is never a plain release.
pub(crate) fn accept(
    repo: &str,
    release: &GhRelease,
    zip: &GhAsset,
    json: ModJson,
) -> Result<IndexMod, NoModsReason> {
    let stem = zip
        .name
        .strip_suffix(".zip")
        .ok_or(NoModsReason::NoModFiles)?;
    let digest = zip
        .digest
        .as_deref()
        .and_then(|d| d.strip_prefix("sha256:"))
        .ok_or(NoModsReason::NoDigest)?;
    let agrees = json.schema == 1
        && is_mod_id(&json.id)
        && json.id != RESERVED_ID
        && json.id == stem
        && json.tag == release.tag_name
        && same_repo(&json.source.repo, repo)
        && json.asset.name == zip.name
        && json.asset.url == zip.browser_download_url
        && json.asset.size == zip.size
        && json.asset.sha256.eq_ignore_ascii_case(digest);
    if !agrees {
        return Err(NoModsReason::Disagrees);
    }
    let mut channel = json.channel;
    if release.prerelease && channel == Channel::Release {
        channel = Channel::Prerelease;
    }
    let version = IndexVersion {
        version: json.version,
        channel,
        tag: json.tag,
        published: release.published_at.clone().unwrap_or(json.published),
        source: SourceRef {
            repo: repo.to_string(),
            commit: json.source.commit,
        },
        weft: json.weft,
        deps: json.deps,
        platforms: json.platforms,
        asset: Asset {
            sha256: digest.to_ascii_lowercase(),
            ..json.asset
        },
        provenance: json.provenance,
        // A source can't review itself.
        reviewed: None,
    };
    if version_problem(&json.id, &version).is_some() {
        return Err(NoModsReason::Invalid);
    }
    let mut summary = json.summary;
    clamp_summary(&mut summary);
    Ok(IndexMod {
        id: json.id,
        name: json.name,
        summary,
        authors: json.authors,
        license: json.license,
        homepage: json.homepage.filter(|u| u.starts_with("https://")),
        icon: json.icon.filter(|u| crate::download::icon_url_allowed(u)),
        versions: vec![version],
    })
}

/// Folds one entry per release into one entry per mod, newest version first. `entries` come
/// in GitHub's order, newest release first: the mod's name, summary and icon come from its
/// newest release, and a version (or a zip) a later release publishes again replaces nothing.
fn merge(entries: Vec<IndexMod>) -> Vec<IndexMod> {
    let mut mods: Vec<IndexMod> = Vec::new();
    for entry in entries {
        match mods.iter_mut().find(|m| m.id == entry.id) {
            Some(m) => {
                for v in entry.versions {
                    let seen = m.versions.iter().any(|have| {
                        have.version == v.version || have.asset.sha256 == v.asset.sha256
                    });
                    if !seen {
                        m.versions.push(v);
                    }
                }
            }
            None => mods.push(entry),
        }
    }
    for m in &mut mods {
        m.versions
            .sort_by(|a, b| super::version::compare(&b.version, &a.version));
    }
    mods
}

async fn get_mod_json(client: &reqwest::Client, url: &str) -> Option<ModJson> {
    let response = client
        .get(url)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = read_capped(response, MAX_MOD_JSON_BYTES).await.ok()??;
    serde_json::from_slice(&bytes).ok()
}

/// The `rel="next"` URL of a GitHub `Link` header, if it stays on the API.
pub(crate) fn next_page(link: &str) -> Option<String> {
    link.split(',').find_map(|part| {
        let (url, params) = part.split_once(';')?;
        if !params.split(';').any(|p| p.trim() == r#"rel="next""#) {
            return None;
        }
        let url = url.trim().strip_prefix('<')?.strip_suffix('>')?;
        url.starts_with("https://api.github.com/")
            .then(|| url.to_string())
    })
}

/// One source as read now.
pub struct SourceFetch {
    pub mods: Vec<IndexMod>,
    pub freshness: Freshness,
    pub checked: Option<String>,
    pub error: Option<ModsError>,
    /// Why GitHub's answer has no mods, when it has none.
    pub no_mods: Option<NoModsReason>,
}

/// The last good answer with the reason the refresh failed, or nothing and the reason.
fn fall_back(cached: Option<SourceCache>, error: ModsError) -> SourceFetch {
    match cached {
        Some(c) => SourceFetch {
            mods: c.mods,
            freshness: Freshness::Cached,
            checked: c.checked,
            error: Some(error),
            no_mods: c.no_mods,
        },
        None => SourceFetch {
            mods: Vec::new(),
            freshness: Freshness::Unavailable,
            checked: None,
            error: Some(error),
            no_mods: None,
        },
    }
}

enum Listing {
    NotModified,
    Releases(Vec<GhRelease>, Option<String>),
}

async fn list_releases(
    client: &reqwest::Client,
    api: &str,
    repo: &str,
    etag: Option<&str>,
) -> Result<Listing, ModsError> {
    let mut url = format!("{api}/repos/{repo}/releases?per_page=100");
    let mut releases = Vec::new();
    let mut first_etag = None;
    for page in 0..MAX_RELEASE_PAGES {
        let mut request = client
            .get(&url)
            .header(USER_AGENT, USER_AGENT_VALUE)
            .timeout(Duration::from_secs(15));
        if page == 0
            && let Some(etag) = etag
        {
            request = request.header(IF_NONE_MATCH, etag);
        }
        let response = request.send().await?;
        let header = |name| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        let next = header(LINK).as_deref().and_then(next_page);
        if page == 0 {
            first_etag = header(ETAG);
        }
        match response.status().as_u16() {
            200 => {}
            304 if page == 0 => return Ok(Listing::NotModified),
            404 => return Err(ModsError::SourceNotFound(repo.to_string())),
            403 | 429 => return Err(ModsError::SourceRateLimited),
            status => return Err(ModsError::Http { status, url }),
        }
        releases.extend(response.json::<Vec<GhRelease>>().await?);
        match next {
            Some(n) => url = n,
            None => break,
        }
    }
    Ok(Listing::Releases(releases, first_etag))
}

/// The cached answer, checked again by the rules a fresh one passed ([`revalidate`]): the cache
/// is only a file on disk.
fn read_cache(paths: &Paths, repo: &str) -> Option<SourceCache> {
    let mut cache: SourceCache = std::fs::read(cache_path(paths, repo))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())?;
    cache.mods = revalidate(repo, std::mem::take(&mut cache.mods));
    Some(cache)
}

/// What [`accept`] lets through, applied to mods read back from the cache: a mod id that isn't
/// `base`, versions that follow the contract (`version_problem`, which includes the asset URL
/// rule), from this repo and claiming no review. Anything else is dropped and logged.
pub(crate) fn revalidate(repo: &str, mods: Vec<IndexMod>) -> Vec<IndexMod> {
    mods.into_iter()
        .filter_map(|mut m| {
            if !is_mod_id(&m.id) || m.id == RESERVED_ID {
                eprintln!("mod source {repo}: dropping cached mod {:?}", m.id);
                return None;
            }
            let id = m.id.clone();
            m.versions.retain(|v| {
                let problem = version_problem(&id, v)
                    .or_else(|| {
                        (!same_repo(&v.source.repo, repo)).then(|| "another repo".to_string())
                    })
                    .or_else(|| v.reviewed.is_some().then(|| "claims a review".to_string()));
                match problem {
                    None => true,
                    Some(why) => {
                        eprintln!(
                            "mod source {repo}: dropping cached {id} {}: {why}",
                            v.version
                        );
                        false
                    }
                }
            });
            m.icon = m
                .icon
                .take()
                .filter(|u| crate::download::icon_url_allowed(u));
            m.homepage = m.homepage.take().filter(|u| u.starts_with("https://"));
            clamp_summary(&mut m.summary);
            (!m.versions.is_empty()).then_some(m)
        })
        .collect()
}

/// The last good answer of one source, without asking GitHub.
pub fn cached(paths: &Paths, repo: &str) -> SourceFetch {
    match read_cache(paths, repo) {
        Some(c) => SourceFetch {
            mods: c.mods,
            freshness: Freshness::Cached,
            checked: c.checked,
            error: None,
            no_mods: c.no_mods,
        },
        None => SourceFetch {
            mods: Vec::new(),
            freshness: Freshness::Unavailable,
            checked: None,
            error: None,
            no_mods: None,
        },
    }
}

/// The mods of one source. When GitHub can't be asked or refuses, the last good answer is used
/// and the error comes along with it.
/// `api` is GitHub's API (`context::GITHUB_API`), or a stand-in in tests.
pub async fn fetch(
    paths: &Paths,
    client: &reqwest::Client,
    api: &str,
    repo: &str,
    refresh: bool,
) -> SourceFetch {
    let path = cache_path(paths, repo);
    let cached = read_cache(paths, repo);
    if !refresh && let Some(c) = cached {
        return SourceFetch {
            mods: c.mods,
            freshness: Freshness::Cached,
            checked: c.checked,
            error: None,
            no_mods: c.no_mods,
        };
    }

    let etag = cached.as_ref().and_then(|c| c.etag.clone());
    let (releases, etag) = match list_releases(client, api, repo, etag.as_deref()).await {
        Ok(Listing::Releases(r, e)) => (r, e),
        Ok(Listing::NotModified) => {
            let mut cache = cached.unwrap_or_default();
            cache.checked = Some(now());
            let _ = serde_json::to_vec(&cache).map(|b| write_atomic(&path, &b));
            return SourceFetch {
                mods: cache.mods,
                freshness: Freshness::Fresh,
                checked: cache.checked,
                error: None,
                no_mods: cache.no_mods,
            };
        }
        Err(e) => return fall_back(cached, e),
    };

    let mut entries = Vec::new();
    let mut why = None;
    let published: Vec<&GhRelease> = releases.iter().filter(|r| !r.draft).collect();
    if published.is_empty() {
        note(&mut why, NoModsReason::NoReleases);
    }
    for release in published {
        let mut pairs = 0;
        for json_asset in release
            .assets
            .iter()
            .filter(|a| a.name.ends_with(".mod.json"))
        {
            let stem = json_asset.name.trim_end_matches(".mod.json");
            let Some(zip) = release
                .assets
                .iter()
                .find(|a| a.name == format!("{stem}.zip"))
            else {
                continue;
            };
            pairs += 1;
            let Some(json) = get_mod_json(client, &json_asset.browser_download_url).await else {
                note(&mut why, NoModsReason::Unreadable);
                continue;
            };
            match accept(repo, release, zip, json) {
                Ok(entry) => entries.push(entry),
                Err(reason) => note(&mut why, reason),
            }
        }
        if pairs == 0 {
            note(&mut why, NoModsReason::NoModFiles);
        }
    }
    let mods = merge(entries);
    let cache = SourceCache {
        etag,
        no_mods: if mods.is_empty() { why } else { None },
        mods,
        checked: Some(now()),
    };
    let _ = serde_json::to_vec(&cache).map(|b| write_atomic(&path, &b));
    SourceFetch {
        mods: cache.mods,
        freshness: Freshness::Fresh,
        checked: cache.checked,
        error: None,
        no_mods: cache.no_mods,
    }
}

/// The repo as GitHub spells it, if it exists. A renamed repo gives its new name.
/// `api` is GitHub's API (`https://api.github.com`).
pub async fn canonical_name(
    client: &reqwest::Client,
    api: &str,
    repo: &str,
) -> Result<String, ModsError> {
    #[derive(Deserialize)]
    struct GhRepo {
        full_name: String,
    }
    let url = format!("{api}/repos/{repo}");
    let response = client
        .get(&url)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    match response.status().as_u16() {
        200 => {}
        404 => return Err(ModsError::SourceNotFound(repo.to_string())),
        403 | 429 => return Err(ModsError::SourceRateLimited),
        status => return Err(ModsError::Http { status, url }),
    }
    let found: GhRepo = response.json().await?;
    if is_repo(&found.full_name) {
        Ok(found.full_name)
    } else {
        Err(ModsError::SourceInvalid(found.full_name))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn a_damaged_list_is_set_aside_kept_and_said_until_a_new_one_is_saved() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = Paths::new(tmp.path());
        let file = paths.sources_file();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        assert_eq!(
            list(&paths).unwrap(),
            Vec::<String>::new(),
            "no file is no sources"
        );
        std::fs::write(&file, b"{ not json").unwrap();
        let Err(ModsError::SourcesDamaged(kept)) = list(&paths) else {
            panic!("a damaged list is said")
        };
        assert!(!file.exists(), "set aside");
        assert_eq!(
            std::fs::read(&kept).unwrap(),
            b"{ not json",
            "kept as it was"
        );
        // Said again, not taken for no sources, until a new list is saved.
        assert!(matches!(list(&paths), Err(ModsError::SourcesDamaged(k)) if k == kept));
        assert_eq!(list_for_change(&paths).unwrap(), Vec::<String>::new());
        save(&paths, &["a/b".to_string()]).unwrap();
        assert_eq!(list(&paths).unwrap(), ["a/b"]);
        assert!(Path::new(&kept).exists(), "the damaged one is still kept");
    }

    #[test]
    fn why_a_source_has_no_mods_is_how_far_it_got() {
        let mut why = None;
        note(&mut why, NoModsReason::NoModFiles);
        note(&mut why, NoModsReason::Disagrees);
        note(&mut why, NoModsReason::Unreadable);
        assert_eq!(why, Some(NoModsReason::Disagrees));
        let (r, zip) = release(false);
        let mut j = json();
        j.tag = "another-tag".into();
        assert_eq!(
            accept("Zorro909/weft-mods", &r, &zip, j).err(),
            Some(NoModsReason::Disagrees)
        );
    }

    #[test]
    fn a_source_icon_only_from_github_hosts() {
        let (r, zip) = release(false);
        let with = |icon: &str| {
            let mut j = json();
            j.icon = Some(icon.into());
            accept("Zorro909/weft-mods", &r, &zip, j).unwrap().icon
        };
        let ok = "https://raw.githubusercontent.com/Zorro909/weft-mods/main/icon.png";
        assert_eq!(with(ok).as_deref(), Some(ok));
        assert_eq!(with("https://tracker.example/pixel.png"), None);
        assert_eq!(with("https://objects.githubusercontent.com/icon.png"), None);
    }

    fn release(prerelease: bool) -> (GhRelease, GhAsset) {
        let zip = GhAsset {
            name: "cogwork.zip".into(),
            browser_download_url:
                "https://github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip"
                    .into(),
            size: 10,
            digest: Some(format!("sha256:{}", "a".repeat(64))),
        };
        let r = GhRelease {
            tag_name: "cogwork-v0.2.0".into(),
            draft: false,
            prerelease,
            published_at: Some("2026-11-04T00:00:00Z".into()),
            assets: vec![zip.clone()],
        };
        (r, zip)
    }

    fn json() -> ModJson {
        let v =
            super::super::index::tests::version("cogwork", "Zorro909/weft-mods", &"a".repeat(64));
        ModJson {
            schema: 1,
            id: "cogwork".into(),
            name: "Cogwork".into(),
            summary: String::new(),
            authors: vec![],
            license: None,
            homepage: None,
            icon: None,
            version: v.version,
            channel: v.channel,
            tag: v.tag,
            published: v.published,
            source: v.source,
            weft: v.weft,
            deps: v.deps,
            platforms: v.platforms,
            asset: v.asset,
            provenance: None,
        }
    }

    #[test]
    fn description_must_agree_with_github() {
        let (r, zip) = release(false);
        let repo = "Zorro909/weft-mods";
        assert!(accept(repo, &r, &zip, json()).is_ok());
        assert!(
            accept("zorro909/WEFT-MODS", &r, &zip, json()).is_ok(),
            "repos compare without case"
        );

        type Change = fn(&mut ModJson);
        let cases: &[(&str, Change)] = &[
            ("digest", |j| j.asset.sha256 = "b".repeat(64)),
            ("tag", |j| j.tag = "cogwork-v9".into()),
            ("schema", |j| j.schema = 2),
            ("id", |j| j.id = "other".into()),
            ("asset name", |j| j.asset.name = "other.zip".into()),
            ("size", |j| j.asset.size = 11),
            ("url", |j| j.asset.url.push_str("?x")),
            ("source repo", |j| j.source.repo = "Other/repo".into()),
        ];
        for (what, change) in cases {
            let mut j = json();
            change(&mut j);
            assert!(accept(repo, &r, &zip, j).is_err(), "{what} differs");
        }
        assert!(
            accept("Other/repo", &r, &zip, json()).is_err(),
            "repo differs"
        );

        let mut no_digest = zip.clone();
        no_digest.digest = None;
        assert_eq!(
            accept(repo, &r, &no_digest, json()).err(),
            Some(NoModsReason::NoDigest),
            "no digest"
        );
    }

    #[test]
    fn the_id_must_be_a_mod_id() {
        let repo = "Zorro909/weft-mods";
        for id in ["Cogwork", "cog-work", "cog.work", "base", ""] {
            let (r, mut zip) = release(false);
            zip.name = format!("{id}.zip");
            let mut j = json();
            j.id = id.to_string();
            j.asset.name = zip.name.clone();
            j.asset.url =
                format!("https://github.com/{repo}/releases/download/cogwork-v0.2.0/{id}.zip");
            zip.browser_download_url = j.asset.url.clone();
            assert!(accept(repo, &r, &zip, j).is_err(), "{id:?}");
        }
    }

    #[test]
    fn releases_merge_newest_first() {
        let entry = |name: &str, version: &str, sha: char| {
            let mut m = super::super::catalog::tests::index_mod(
                "cogwork",
                "Zorro909/weft-mods",
                &sha.to_string().repeat(64),
            );
            m.name = name.into();
            m.versions[0].version = version.into();
            m
        };
        let mods = merge(vec![
            entry("Cogwork 2", "0.3.0", 'c'),
            entry("Cogwork", "0.2.0", 'b'),
            entry("Old name", "0.2.0", 'a'),
            entry("Old name", "0.1.0", 'c'),
        ]);
        assert_eq!(mods.len(), 1);
        assert_eq!(
            mods[0].name, "Cogwork 2",
            "the newest release names the mod"
        );
        let versions: Vec<&str> = mods[0]
            .versions
            .iter()
            .map(|v| v.version.as_str())
            .collect();
        assert_eq!(versions, ["0.3.0", "0.2.0"]);
        assert_eq!(mods[0].versions[1].asset.sha256, "b".repeat(64));
    }

    #[test]
    fn github_prerelease_wins() {
        let (r, zip) = release(true);
        let m = accept("Zorro909/weft-mods", &r, &zip, json()).unwrap();
        assert_eq!(m.versions[0].channel, Channel::Prerelease);
        assert!(m.versions[0].reviewed.is_none());
    }

    #[test]
    fn repo_input_forms() {
        assert_eq!(
            normalize("Zorro909/weft-mods").unwrap(),
            "Zorro909/weft-mods"
        );
        assert_eq!(
            normalize(" https://github.com/Zorro909/weft-mods.git/ ").unwrap(),
            "Zorro909/weft-mods"
        );
        assert!(normalize("https://gitlab.com/a/b").is_err());
        assert!(normalize("nope").is_err());
    }

    #[test]
    fn repo_lists_ignore_case() {
        let list = vec!["zorro909/weft-mods".to_string(), "a/b".to_string()];
        assert_eq!(
            with_repo(list.clone(), "Zorro909/weft-mods"),
            ["Zorro909/weft-mods", "a/b"]
        );
        assert_eq!(with_repo(list.clone(), "c/d").len(), 3);
        assert_eq!(without_repo(list, "ZORRO909/Weft-Mods"), ["a/b"]);
    }

    #[test]
    fn pages_follow_link_headers() {
        let link = r#"<https://api.github.com/repositories/1/releases?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/releases?per_page=100&page=5>; rel="last""#;
        assert_eq!(
            next_page(link).as_deref(),
            Some("https://api.github.com/repositories/1/releases?per_page=100&page=2")
        );
        assert_eq!(next_page(r#"<https://evil.example/x>; rel="next""#), None);
        assert_eq!(next_page(r#"<https://api.github.com/x>; rel="prev""#), None);
    }

    #[test]
    fn a_failed_refresh_keeps_the_cache_and_says_why() {
        let cache = SourceCache {
            etag: None,
            mods: vec![super::super::catalog::tests::index_mod(
                "cogwork",
                "Zorro909/weft-mods",
                &"a".repeat(64),
            )],
            checked: Some("2026-11-01T00:00:00Z".into()),
            no_mods: None,
        };
        let got = fall_back(Some(cache), ModsError::SourceRateLimited);
        assert_eq!(got.freshness, Freshness::Cached);
        assert_eq!(got.mods.len(), 1);
        assert_eq!(got.checked.as_deref(), Some("2026-11-01T00:00:00Z"));
        assert!(matches!(got.error, Some(ModsError::SourceRateLimited)));

        let got = fall_back(None, ModsError::SourceNotFound("a/b".into()));
        assert_eq!(got.freshness, Freshness::Unavailable);
        assert!(got.mods.is_empty() && got.error.is_some());
    }

    /// Contract R4 §6: the cache is checked again on every read, not only when it was fetched.
    #[test]
    fn a_tampered_cache_is_checked_again() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = Paths::new(tmp.path());
        let repo = "Zorro909/weft-mods";
        let good = accept(repo, &release(false).0, &release(false).1, json()).unwrap();
        let mut elsewhere = good.clone();
        elsewhere.id = "showcase".into();
        elsewhere.versions[0].asset.name = "showcase.zip".into();
        elsewhere.versions[0].asset.url = "https://evil.example/showcase.zip".into();
        let mut reviewed = good.clone();
        reviewed.id = "lanterns".into();
        reviewed.versions[0].reviewed = Some(super::super::index::Reviewed {
            by: "me".into(),
            at: "now".into(),
        });
        let mut reserved = good.clone();
        reserved.id = RESERVED_ID.into();
        let cache = SourceCache {
            etag: None,
            mods: vec![good, elsewhere, reviewed, reserved],
            checked: None,
            no_mods: None,
        };
        write_atomic(
            &cache_path(&paths, repo),
            &serde_json::to_vec(&cache).unwrap(),
        )
        .unwrap();
        let got = cached(&paths, repo);
        let ids: Vec<&str> = got.mods.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["cogwork"]);
    }

    #[test]
    fn mod_json_reads_are_capped() {
        let run = |fut| {
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(fut)
        };
        let response = |body: Vec<u8>| reqwest::Response::from(http_response(body));
        assert_eq!(
            run(read_capped(response(vec![b'x'; 10]), 10))
                .unwrap()
                .unwrap()
                .len(),
            10
        );
        assert!(
            run(read_capped(response(vec![b'x'; 11]), 10))
                .unwrap()
                .is_none()
        );
    }

    fn http_response(body: Vec<u8>) -> ::http::Response<Vec<u8>> {
        ::http::Response::builder().status(200).body(body).unwrap()
    }
}
