//! Streams a download to a file and hashes it on the way, for game versions and mods alike.

use futures_util::StreamExt;
use reqwest::header::USER_AGENT;
use sha2::{Digest, Sha256};
use std::path::Path;
use thiserror::Error;
use tokio::io::AsyncWriteExt;

const USER_AGENT_VALUE: &str = concat!("weft-launcher/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Error)]
pub enum DownloadError {
    #[error("{0}")]
    Network(#[from] reqwest::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("HTTP {0}")]
    Status(reqwest::StatusCode),
    #[error("larger than {0} bytes")]
    TooLarge(u64),
}

#[derive(Debug, Clone, Copy)]
pub struct Progress {
    pub downloaded: u64,
    /// 0 when the server doesn't say.
    pub total: u64,
    pub percent: u32,
    pub speed_mbps: f64,
}

pub struct Downloaded {
    pub bytes: u64,
    /// Lowercase hex.
    pub sha256: String,
}

/// Where a redirect may lead: https, on GitHub's own hosts. Release downloads redirect from
/// `github.com` to `objects.githubusercontent.com` or `release-assets.githubusercontent.com`,
/// and GitHub Pages may redirect within `github.io`.
pub fn redirect_allowed(url: &url::Url) -> bool {
    let host = url.host_str().unwrap_or("");
    let on = |domain: &str| host == domain || host.ends_with(&format!(".{domain}"));
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && (on("github.com") || on("githubusercontent.com") || on("github.io"))
}

/// Where a mod's icon may come from: GitHub's own hosts for repository files and images, and
/// GitHub Pages. Anything else is dropped where a catalogue is read, and refused again before a
/// fetch, so browsing never tells another host the player's address.
pub fn icon_url_allowed(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    let pages = host
        .strip_suffix(".github.io")
        .is_some_and(|name| !name.is_empty() && !name.contains('.'));
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && (matches!(
            host,
            "github.com" | "raw.githubusercontent.com" | "user-images.githubusercontent.com"
        ) || pages)
}

/// Follows at most 10 redirects, each to an allowed place (see [`redirect_allowed`]).
pub fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 10 {
            attempt.error("too many redirects")
        } else if redirect_allowed(attempt.url()) {
            attempt.follow()
        } else {
            let to = attempt.url().to_string();
            attempt.error(format!("refused a redirect to {to}"))
        }
    })
}

/// No total timeout: a slow connection may take long, as long as data keeps coming.
pub fn client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(60))
        .redirect(redirect_policy())
        .build()
}

/// Reads at most `max` bytes of a response, chunk by chunk; `None` if it is longer. Nothing past
/// the limit is read, whatever the response claims its length is.
pub async fn read_capped(
    mut response: reqwest::Response,
    max: usize,
) -> Result<Option<Vec<u8>>, reqwest::Error> {
    if response.content_length().is_some_and(|n| n > max as u64) {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > max {
            return Ok(None);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Some(bytes))
}

/// Reports about every 1% (or 100 KB when the size is unknown). `max_bytes` stops a download that
/// grows past what was announced.
pub async fn to_file(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    max_bytes: Option<u64>,
    mut on_progress: impl FnMut(Progress),
) -> Result<Downloaded, DownloadError> {
    let response = client
        .get(url)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(DownloadError::Status(response.status()));
    }
    let total = response.content_length().unwrap_or(0);
    if let Some(max) = max_bytes
        && total > max
    {
        return Err(DownloadError::TooLarge(max));
    }

    let mut file = tokio::fs::File::create(dest).await?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_percent = 0u32;
    let mut last_bytes = 0u64;
    let mut last_time = std::time::Instant::now();
    #[cfg(debug_assertions)]
    let start = std::time::Instant::now();

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        downloaded += chunk.len() as u64;
        if let Some(max) = max_bytes
            && downloaded > max
        {
            return Err(DownloadError::TooLarge(max));
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await?;

        let percent = if total > 0 {
            ((downloaded as f64 / total as f64) * 100.0) as u32
        } else {
            0
        };
        let due = if total > 0 {
            percent > last_percent
        } else {
            downloaded >= last_bytes + 100_000
        };
        if due {
            let now = std::time::Instant::now();
            let elapsed = now.duration_since(last_time).as_secs_f64();
            let speed_mbps = if elapsed > 0.0 {
                (downloaded.saturating_sub(last_bytes) as f64 * 8.0 / 1_000_000.0) / elapsed
            } else {
                0.0
            };
            on_progress(Progress {
                downloaded,
                total,
                percent,
                speed_mbps,
            });
            last_percent = percent;
            last_bytes = downloaded;
            last_time = now;
        }

        // `WEFT_THROTTLE_KBPS=200 npm run tauri dev` shows the progress UI on a fast connection.
        #[cfg(debug_assertions)]
        if let Ok(val) = std::env::var("WEFT_THROTTLE_KBPS")
            && let Ok(kbps) = val.parse::<f64>()
            && kbps > 0.0
        {
            let expected = downloaded as f64 / (kbps * 1024.0);
            let actual = start.elapsed().as_secs_f64();
            if expected > actual {
                tokio::time::sleep(std::time::Duration::from_secs_f64(expected - actual)).await;
            }
        }
    }
    file.flush().await?;

    Ok(Downloaded {
        bytes: downloaded,
        sha256: format!("{:x}", hasher.finalize()),
    })
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// SHA-256 of a file on disk, lowercase hex.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirects_stay_on_github_over_https() {
        for ok in [
            "https://github.com/a/b/releases/download/t/x.zip",
            "https://objects.githubusercontent.com/github-production-release-asset/1",
            "https://release-assets.githubusercontent.com/x",
            "https://raw.githubusercontent.com/a/b/main/x",
            "https://weft-rust.github.io/weft-mods-index/v1/index.json",
        ] {
            assert!(redirect_allowed(&url::Url::parse(ok).unwrap()), "{ok}");
        }
        for bad in [
            "http://objects.githubusercontent.com/x",
            "https://evil.example/x",
            "https://github.com.evil.example/x",
            "https://notgithub.com/x",
            "https://github.com:8443/x",
            "https://user@github.com/x",
            "https://127.0.0.1/x",
        ] {
            assert!(!redirect_allowed(&url::Url::parse(bad).unwrap()), "{bad}");
        }
    }
}
