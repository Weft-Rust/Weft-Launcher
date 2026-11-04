//! GitHub repos the player added as mod sources. A release counts when it carries `<id>.zip` and
//! `<id>.mod.json` (see `docs/mod-manager/INDEX_FORMAT.md`). Nobody reviewed these, which the
//! catalogue says; what is checked is that the description and the zip agree with GitHub's own
//! record of the release.

use reqwest::header::{ETAG, IF_NONE_MATCH, LINK, USER_AGENT};
use serde::{Deserialize, Serialize};
use std::time::Duration;

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

pub fn list(paths: &Paths) -> Vec<String> {
    std::fs::read(paths.sources_file())
        .ok()
        .and_then(|b| serde_json::from_slice::<SourcesFile>(&b).ok())
        .map(|f| f.repos.into_iter().filter(|r| is_repo(r)).collect())
        .unwrap_or_default()
}

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

#[derive(Debug, Default, Serialize, Deserialize)]
struct SourceCache {
    etag: Option<String>,
    mods: Vec<IndexMod>,
    /// When GitHub last answered; missing in caches older launchers wrote.
    #[serde(default)]
    checked: Option<String>,
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
) -> Option<IndexMod> {
    let stem = zip.name.strip_suffix(".zip")?;
    let digest = zip.digest.as_deref()?.strip_prefix("sha256:")?;
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
        return None;
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
        return None;
    }
    let mut summary = json.summary;
    clamp_summary(&mut summary);
    Some(IndexMod {
        id: json.id,
        name: json.name,
        summary,
        authors: json.authors,
        license: json.license,
        homepage: json.homepage.filter(|u| u.starts_with("https://")),
        icon: json.icon.filter(|u| u.starts_with("https://")),
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
}

/// The last good answer with the reason the refresh failed, or nothing and the reason.
fn fall_back(cached: Option<SourceCache>, error: ModsError) -> SourceFetch {
    match cached {
        Some(c) => SourceFetch {
            mods: c.mods,
            freshness: Freshness::Cached,
            checked: c.checked,
            error: Some(error),
        },
        None => SourceFetch {
            mods: Vec::new(),
            freshness: Freshness::Unavailable,
            checked: None,
            error: Some(error),
        },
    }
}

enum Listing {
    NotModified,
    Releases(Vec<GhRelease>, Option<String>),
}

async fn list_releases(
    client: &reqwest::Client,
    repo: &str,
    etag: Option<&str>,
) -> Result<Listing, ModsError> {
    let mut url = format!("https://api.github.com/repos/{repo}/releases?per_page=100");
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

fn read_cache(paths: &Paths, repo: &str) -> Option<SourceCache> {
    std::fs::read(cache_path(paths, repo))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
}

/// The last good answer of one source, without asking GitHub.
pub fn cached(paths: &Paths, repo: &str) -> SourceFetch {
    match read_cache(paths, repo) {
        Some(c) => SourceFetch {
            mods: c.mods,
            freshness: Freshness::Cached,
            checked: c.checked,
            error: None,
        },
        None => SourceFetch {
            mods: Vec::new(),
            freshness: Freshness::Unavailable,
            checked: None,
            error: None,
        },
    }
}

/// The mods of one source. When GitHub can't be asked or refuses, the last good answer is used
/// and the error comes along with it.
pub async fn fetch(
    paths: &Paths,
    client: &reqwest::Client,
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
        };
    }

    let etag = cached.as_ref().and_then(|c| c.etag.clone());
    let (releases, etag) = match list_releases(client, repo, etag.as_deref()).await {
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
            };
        }
        Err(e) => return fall_back(cached, e),
    };

    let mut entries = Vec::new();
    for release in releases.iter().filter(|r| !r.draft) {
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
            let Some(json) = get_mod_json(client, &json_asset.browser_download_url).await else {
                continue;
            };
            if let Some(entry) = accept(repo, release, zip, json) {
                entries.push(entry);
            }
        }
    }
    let cache = SourceCache {
        etag,
        mods: merge(entries),
        checked: Some(now()),
    };
    let _ = serde_json::to_vec(&cache).map(|b| write_atomic(&path, &b));
    SourceFetch {
        mods: cache.mods,
        freshness: Freshness::Fresh,
        checked: cache.checked,
        error: None,
    }
}

/// The repo as GitHub spells it, if it exists. A renamed repo gives its new name.
pub async fn canonical_name(client: &reqwest::Client, repo: &str) -> Result<String, ModsError> {
    #[derive(Deserialize)]
    struct GhRepo {
        full_name: String,
    }
    let url = format!("https://api.github.com/repos/{repo}");
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
        assert!(accept(repo, &r, &zip, json()).is_some());
        assert!(
            accept("zorro909/WEFT-MODS", &r, &zip, json()).is_some(),
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
            assert!(accept(repo, &r, &zip, j).is_none(), "{what} differs");
        }
        assert!(
            accept("Other/repo", &r, &zip, json()).is_none(),
            "repo differs"
        );

        let mut no_digest = zip.clone();
        no_digest.digest = None;
        assert!(accept(repo, &r, &no_digest, json()).is_none(), "no digest");
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
            assert!(accept(repo, &r, &zip, j).is_none(), "{id:?}");
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
