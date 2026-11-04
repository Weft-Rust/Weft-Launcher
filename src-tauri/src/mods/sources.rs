//! GitHub repos the player added as mod sources. A release counts when it carries `<id>.zip` and
//! `<id>.mod.json` (see `docs/mod-manager/INDEX_FORMAT.md`). Nobody reviewed these, which the
//! catalogue says; what is checked is that the description and the zip agree with GitHub's own
//! record of the release.

use reqwest::header::{ETAG, IF_NONE_MATCH, USER_AGENT};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::AppHandle;

use super::error::ModsError;
use super::index::{
    Asset, Channel, Dep, IndexMod, IndexVersion, Provenance, SourceRef, WeftRef, is_repo,
    version_problem,
};
use super::paths::{cache_dir, sources_file, write_atomic};

const USER_AGENT_VALUE: &str = concat!("weft-launcher/", env!("CARGO_PKG_VERSION"));
const MAX_MOD_JSON_BYTES: usize = 64 * 1024;

#[derive(Debug, Default, Serialize, Deserialize)]
struct SourcesFile {
    repos: Vec<String>,
}

pub fn list(app: &AppHandle) -> Vec<String> {
    sources_file(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<SourcesFile>(&b).ok())
        .map(|f| f.repos.into_iter().filter(|r| is_repo(r)).collect())
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, repos: &[String]) -> Result<(), ModsError> {
    let file = SourcesFile {
        repos: repos.to_vec(),
    };
    write_atomic(&sources_file(app)?, &serde_json::to_vec_pretty(&file)?)
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
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    prerelease: bool,
    #[serde(default)]
    published_at: Option<String>,
    assets: Vec<GhAsset>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SourceCache {
    etag: Option<String>,
    mods: Vec<IndexMod>,
}

fn cache_path(app: &AppHandle, repo: &str) -> Result<std::path::PathBuf, ModsError> {
    Ok(cache_dir(app)?
        .join("mod-sources")
        .join(format!("{}.json", repo.replace('/', "__"))))
}

/// Checks one release's description against GitHub's record of the same release.
fn accept(repo: &str, release: &GhRelease, zip: &GhAsset, json: ModJson) -> Option<IndexMod> {
    let stem = zip.name.strip_suffix(".zip")?;
    let digest = zip.digest.as_deref()?.strip_prefix("sha256:")?;
    let agrees = json.schema == 1
        && json.id == stem
        && json.tag == release.tag_name
        && json.source.repo.eq_ignore_ascii_case(repo)
        && json.asset.name == zip.name
        && json.asset.url == zip.browser_download_url
        && json.asset.size == zip.size
        && json.asset.sha256.eq_ignore_ascii_case(digest);
    if !agrees {
        return None;
    }
    let mut channel = json.channel;
    // A release GitHub calls a prerelease never shows up as a plain release.
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
        reviewed: None,
    };
    if version_problem(&json.id, &version).is_some() {
        return None;
    }
    Some(IndexMod {
        id: json.id,
        name: json.name,
        summary: json.summary,
        authors: json.authors,
        license: json.license,
        homepage: json.homepage.filter(|u| u.starts_with("https://")),
        icon: json.icon.filter(|u| u.starts_with("https://")),
        versions: vec![version],
    })
}

/// Folds one entry per release into one entry per mod, newest version first.
fn merge(entries: Vec<IndexMod>) -> Vec<IndexMod> {
    let mut mods: Vec<IndexMod> = Vec::new();
    for entry in entries {
        match mods.iter_mut().find(|m| m.id == entry.id) {
            Some(m) => m.versions.extend(entry.versions),
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
    let bytes = response.bytes().await.ok()?;
    if bytes.len() > MAX_MOD_JSON_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

/// The mods of one source. Falls back to the last good answer when GitHub can't be reached.
pub async fn fetch(
    app: &AppHandle,
    client: &reqwest::Client,
    repo: &str,
    refresh: bool,
) -> Result<Vec<IndexMod>, ModsError> {
    let path = cache_path(app, repo)?;
    let cached: Option<SourceCache> = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    if !refresh && let Some(c) = cached {
        return Ok(c.mods);
    }

    let url = format!("https://api.github.com/repos/{repo}/releases?per_page=50");
    let mut request = client
        .get(&url)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .timeout(Duration::from_secs(15));
    if let Some(etag) = cached.as_ref().and_then(|c| c.etag.as_deref()) {
        request = request.header(IF_NONE_MATCH, etag);
    }
    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => return cached.map(|c| c.mods).ok_or(e.into()),
    };
    let etag = response
        .headers()
        .get(ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    match response.status().as_u16() {
        200 => {}
        304 => return Ok(cached.map(|c| c.mods).unwrap_or_default()),
        404 => return Err(ModsError::SourceNotFound(repo.to_string())),
        403 | 429 => return cached.map(|c| c.mods).ok_or(ModsError::RateLimited),
        status => {
            return cached
                .map(|c| c.mods)
                .ok_or(ModsError::Http { status, url });
        }
    }
    let releases: Vec<GhRelease> = response.json().await?;

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
    let mods = merge(entries);
    let cache = SourceCache {
        etag,
        mods: mods.clone(),
    };
    let _ = serde_json::to_vec(&cache).map(|b| write_atomic(&path, &b));
    Ok(mods)
}

/// Whether the repo exists, before it is added.
pub async fn exists(client: &reqwest::Client, repo: &str) -> Result<(), ModsError> {
    let url = format!("https://api.github.com/repos/{repo}");
    let response = client
        .get(&url)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    match response.status().as_u16() {
        200 => Ok(()),
        404 => Err(ModsError::SourceNotFound(repo.to_string())),
        403 | 429 => Err(ModsError::RateLimited),
        status => Err(ModsError::Http { status, url }),
    }
}

#[cfg(test)]
mod tests {
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
        assert!(accept("Zorro909/weft-mods", &r, &zip, json()).is_some());

        let mut j = json();
        j.asset.sha256 = "b".repeat(64);
        assert!(
            accept("Zorro909/weft-mods", &r, &zip, j).is_none(),
            "digest differs"
        );

        let mut j = json();
        j.tag = "cogwork-v9".into();
        assert!(
            accept("Zorro909/weft-mods", &r, &zip, j).is_none(),
            "tag differs"
        );

        assert!(
            accept("Other/repo", &r, &zip, json()).is_none(),
            "repo differs"
        );
    }

    #[test]
    fn github_prerelease_wins() {
        let (r, zip) = release(true);
        let m = accept("Zorro909/weft-mods", &r, &zip, json()).unwrap();
        assert_eq!(m.versions[0].channel, Channel::Prerelease);
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
}
