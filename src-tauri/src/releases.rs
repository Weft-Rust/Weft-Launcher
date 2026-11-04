use crate::config::WEFT_REPO;
use crate::error::AppError;
use reqwest::header::{
    ETAG, HeaderMap, HeaderValue, IF_NONE_MATCH, InvalidHeaderValue, USER_AGENT,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;
use thiserror::Error;
use time::OffsetDateTime;
use tokio::fs;

const USER_AGENT_VALUE: &str = concat!("weft-launcher/", env!("CARGO_PKG_VERSION"));
const GITHUB_API_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Debug, Error)]
pub enum ReleasesError {
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("HTTP header error: {0}")]
    InvalidHeader(#[from] InvalidHeaderValue),
    #[error("Cache corrupted: {0}")]
    CacheCorrupted(String),
    #[error("Asset not found for the current platform")]
    AssetNotFound,
    #[error("SHA256 digest missing in asset")]
    MissingDigest,
    #[error("GitHub API rate limit exceeded. Try again later.")]
    RateLimited,
    #[error("GitHub API access denied (403). Using cache if available.")]
    Forbidden,
    #[error("Offline and no cache available")]
    OfflineNoCache,
    #[error("Unexpected HTTP status: {0}")]
    UnexpectedStatus(u16),
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct AssetInfo {
    pub name: String,
    pub url: String,
    pub size: u64,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct Release {
    pub tag: String,
    pub name: String,
    pub published_at: String,
    pub body: String,
    pub prerelease: bool,
    pub asset: AssetInfo,
    // Goes to the frontend, but says nothing when read back from the cache file.
    #[serde(skip_deserializing)]
    pub from_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedReleases {
    etag: Option<String>,
    releases: Vec<Release>,
    fetched_at: String,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    published_at: String,
    body: Option<String>,
    prerelease: bool,
    assets: Vec<GitHubAsset>,
}

fn get_cache_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, ReleasesError> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| ReleasesError::Io(std::io::Error::other(e)))?;
    let cache_dir = app_data.join("cache");
    Ok(cache_dir)
}

fn get_cache_file(app_handle: &tauri::AppHandle) -> Result<PathBuf, ReleasesError> {
    Ok(get_cache_dir(app_handle)?.join("releases.json"))
}

async fn ensure_cache_dir(app_handle: &tauri::AppHandle) -> Result<(), ReleasesError> {
    let cache_dir = get_cache_dir(app_handle)?;
    fs::create_dir_all(&cache_dir).await?;
    Ok(())
}

fn current_platform_asset_suffix() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "windows-x64.zip";
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "linux-x64.tar.gz";
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "macos-arm64.tar.gz";
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64")
    )))]
    return "";
}

fn select_asset(assets: &[GitHubAsset], suffix: &str) -> Option<AssetInfo> {
    if suffix.is_empty() {
        return None;
    }
    let asset = assets.iter().find(|a| a.name.ends_with(suffix))?;
    let sha256 = asset
        .digest
        .as_ref()
        .and_then(|d| d.strip_prefix("sha256:"))
        .map(|s| s.to_string());
    Some(AssetInfo {
        name: asset.name.clone(),
        url: asset.browser_download_url.clone(),
        size: asset.size,
        sha256,
    })
}

fn parse_github_releases(
    gh_releases: Vec<GitHubRelease>,
    suffix: &str,
) -> Result<Vec<Release>, ReleasesError> {
    let published: Vec<_> = gh_releases.into_iter().filter(|r| !r.prerelease).collect();
    let any_published = !published.is_empty();

    // Early releases were Windows only: a release without this platform is just not offered.
    let releases: Vec<_> = published
        .into_iter()
        .filter_map(|gh| {
            let asset = select_asset(&gh.assets, suffix)?;
            Some(Release {
                name: gh.name.unwrap_or_else(|| gh.tag_name.clone()),
                tag: gh.tag_name,
                published_at: gh.published_at,
                body: gh.body.unwrap_or_default(),
                prerelease: gh.prerelease,
                asset,
                from_cache: false,
            })
        })
        .collect();

    if any_published && releases.is_empty() {
        return Err(ReleasesError::AssetNotFound);
    }
    Ok(releases)
}

fn github_api_url() -> String {
    format!("https://api.github.com/repos/{WEFT_REPO}/releases?per_page=100")
}

/// `None` means GitHub answered that the list behind `etag` hasn't changed.
async fn fetch_from_github(
    client: &reqwest::Client,
    etag: Option<&str>,
) -> Result<Option<(Vec<Release>, Option<String>)>, ReleasesError> {
    let url = github_api_url();
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_VALUE));
    if let Some(etag) = etag {
        headers.insert(IF_NONE_MATCH, HeaderValue::from_str(etag)?);
    }

    let response = client.get(&url).headers(headers).send().await?;

    let new_etag = response
        .headers()
        .get(ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    match response.status().as_u16() {
        200 => {
            let gh_releases: Vec<GitHubRelease> = response.json().await?;
            let releases = parse_github_releases(gh_releases, current_platform_asset_suffix())?;
            Ok(Some((releases, new_etag)))
        }
        304 => Ok(None),
        403 => {
            let remaining = response
                .headers()
                .get("X-RateLimit-Remaining")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u32>().ok())
                .unwrap_or(0);
            if remaining == 0 {
                Err(ReleasesError::RateLimited)
            } else {
                Err(ReleasesError::Forbidden)
            }
        }
        429 => Err(ReleasesError::RateLimited),
        status => match response.error_for_status() {
            Err(e) => Err(ReleasesError::Network(e)),
            Ok(_) => Err(ReleasesError::UnexpectedStatus(status)),
        },
    }
}

async fn load_cache(
    app_handle: &tauri::AppHandle,
) -> Result<Option<CachedReleases>, ReleasesError> {
    let cache_file = get_cache_file(app_handle)?;
    if !cache_file.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&cache_file).await?;
    let cached: CachedReleases = serde_json::from_str(&content)?;
    Ok(Some(cached))
}

async fn save_cache(
    app_handle: &tauri::AppHandle,
    etag: Option<String>,
    releases: &[Release],
) -> Result<(), ReleasesError> {
    ensure_cache_dir(app_handle).await?;
    let cache_file = get_cache_file(app_handle)?;
    let now = OffsetDateTime::now_utc();
    let fetched_at = now
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    let cached = CachedReleases {
        etag,
        releases: releases.to_vec(),
        fetched_at,
    };
    let content = serde_json::to_string_pretty(&cached)?;
    let temp_file = cache_file.with_extension("json.tmp");
    fs::write(&temp_file, content).await?;
    fs::rename(&temp_file, &cache_file).await?;
    Ok(())
}

fn mark_cached(mut releases: Vec<Release>) -> Vec<Release> {
    for r in &mut releases {
        r.from_cache = true;
    }
    releases
}

#[tauri::command]
pub async fn list_versions(
    app_handle: tauri::AppHandle,
    force_refresh: bool,
) -> Result<Vec<Release>, AppError> {
    let client = reqwest::Client::builder()
        .timeout(GITHUB_API_TIMEOUT)
        .redirect(crate::download::redirect_policy())
        .build()
        .map_err(ReleasesError::Network)?;

    // A damaged cache is only a missed shortcut: the list is still on GitHub.
    let cached = load_cache(&app_handle).await.ok().flatten();

    if !force_refresh && let Some(cached) = cached {
        return Ok(mark_cached(cached.releases));
    }

    let etag = cached.as_ref().and_then(|c| c.etag.clone());

    match fetch_from_github(&client, etag.as_deref()).await {
        Ok(Some((releases, new_etag))) => {
            // Without the file the list is just fetched again next time.
            save_cache(&app_handle, new_etag, &releases).await.ok();
            Ok(releases)
        }
        // Confirmed current, so this isn't "showing the cache". The cache file stays as it is.
        Ok(None) => Ok(cached.map(|c| c.releases).unwrap_or_default()),
        Err(e) => match cached {
            Some(cached) => Ok(mark_cached(cached.releases)),
            None => Err(e.into()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, assets: &[&str]) -> GitHubRelease {
        GitHubRelease {
            tag_name: tag.to_string(),
            name: None,
            published_at: "2026-10-31T18:49:37Z".to_string(),
            body: None,
            prerelease: false,
            assets: assets
                .iter()
                .map(|name| GitHubAsset {
                    name: name.to_string(),
                    browser_download_url: format!("https://example.com/{name}"),
                    size: 1,
                    digest: Some("sha256:abc".to_string()),
                })
                .collect(),
        }
    }

    #[test]
    fn release_without_this_platform_is_skipped() {
        let list = vec![
            release("v26.10.4", &["Weft-26.10.4-linux-x64.tar.gz"]),
            release("v0.1.0", &["Weft-v0.1.0-windows-x64.zip"]),
        ];
        let releases = parse_github_releases(list, "linux-x64.tar.gz").unwrap();
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].tag, "v26.10.4");
        assert_eq!(releases[0].name, "v26.10.4");
        assert_eq!(releases[0].asset.sha256.as_deref(), Some("abc"));
    }

    #[test]
    fn platform_with_no_release_at_all_is_an_error() {
        let list = vec![release("v0.1.0", &["Weft-v0.1.0-windows-x64.zip"])];
        assert!(matches!(
            parse_github_releases(list, "linux-x64.tar.gz"),
            Err(ReleasesError::AssetNotFound)
        ));
    }

    #[test]
    fn from_cache_reaches_the_frontend_but_not_back_from_the_file() {
        let mut parsed = parse_github_releases(
            vec![release("v1", &["a-windows-x64.zip"])],
            "windows-x64.zip",
        )
        .unwrap();
        parsed[0].from_cache = true;
        let json = serde_json::to_string(&parsed[0]).unwrap();
        assert!(json.contains("\"from_cache\":true"));
        let back: Release = serde_json::from_str(&json).unwrap();
        assert!(!back.from_cache);
    }
}
