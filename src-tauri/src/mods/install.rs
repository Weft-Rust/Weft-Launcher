//! Getting a catalogue build into the store: download it through the shared `download.rs`, and
//! hand it to `store::admit`, which checks its hash and its zip and moves it in under its hash.
//! Callers reserve the hash first (see `store::Reservations`) and hold it until the lock file
//! names the build. A download belongs to an [`Operation`] and stops when that is cancelled,
//! leaving no partial file.

use serde::Serialize;
use ts_rs::TS;

use super::archive::MAX_FILE_BYTES;
use super::catalog::{CatalogMod, CatalogVersion};
use super::context::{Operation, blocking};
use super::error::ModsError;
use super::index::{Platform, asset_url_problem};
use super::paths::Paths;
use super::store;
use crate::download;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub enum ProgressStage {
    Downloading,
    Verifying,
    /// Sent before the profile is rewritten.
    Installing,
}

/// The `mod-progress` event.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModProgress {
    /// The id the page gave the operation this file belongs to.
    pub operation_id: String,
    pub sha256: String,
    pub mod_id: String,
    pub stage: ProgressStage,
    pub percent: u32,
    /// This file's place in the operation, 1-based: file `index` of `count`.
    pub index: u32,
    pub count: u32,
}

/// Downloads one build into the store, unless the store already has it intact. Either way the
/// store's own checks ([`store::admit`], [`store::admit_stored`]) decide what goes in: a
/// download that doesn't hash to the pinned SHA-256 never reaches the store. With `check_url`,
/// a URL that isn't the build's own GitHub release asset is refused before anything is fetched,
/// whatever the catalogue says. Cancelling `op` stops the download: `ModCancelled`, and the
/// partial file is gone.
pub async fn fetch_to_store(
    paths: &Paths,
    m: &CatalogMod,
    v: &CatalogVersion,
    platform: Option<Platform>,
    op: &Operation,
    check_url: bool,
    mut progress: impl FnMut(ProgressStage, u32),
) -> Result<(), ModsError> {
    op.check()?;
    let admit_stored = {
        let (paths, sha, id) = (paths.clone(), v.sha256.clone(), m.id.clone());
        blocking(move || store::admit_stored(&paths, &sha, Some(&id), platform))
    };
    if admit_stored.await?.is_some() {
        return Ok(());
    }
    if check_url
        && let Some(why) = asset_url_problem(&m.id, &v.source_repo, &v.tag, &v.url)
    {
        return Err(ModsError::UrlRefused(format!("{}: {why}", v.url)));
    }
    let tmp = store::temp_path(paths, &v.sha256)?;
    progress(ProgressStage::Downloading, 0);
    let client = download::client()?;
    let limit = v.size.saturating_add(1024).min(MAX_FILE_BYTES);
    let result = {
        let download = std::pin::pin!(download::to_file(
            &client,
            &v.url,
            &tmp,
            Some(limit),
            |p| progress(ProgressStage::Downloading, p.percent),
        ));
        let cancelled = std::pin::pin!(op.cancelled());
        match futures_util::future::select(download, cancelled).await {
            futures_util::future::Either::Left((r, _)) => {
                r.map_err(|e| ModsError::from_download(e, &v.url))
            }
            futures_util::future::Either::Right(_) => Err(ModsError::Cancelled),
        }
    };
    if let Err(e) = result.and_then(|_| op.check()) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    progress(ProgressStage::Verifying, 100);
    let (paths, sha, id) = (paths.clone(), v.sha256.clone(), m.id.clone());
    blocking(move || store::admit(&paths, &tmp, &sha, Some(&id), platform)).await?;
    Ok(())
}
