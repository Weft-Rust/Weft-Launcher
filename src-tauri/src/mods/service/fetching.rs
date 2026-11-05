//! The catalogue: the signed index and every source fetched (concurrently, each in its own
//! order), held in parts so a late answer never replaces a newer one; icons; the list of sources.

use super::*;

fn source_result(repo: String, f: SourceFetch) -> SourceResult {
    SourceResult {
        repo,
        mods: f.mods,
        freshness: f.freshness,
        checked: f.checked,
        error: f.error.map(AppError::from),
        no_mods: f.no_mods,
    }
}

/// The player's sources, or none and why: a damaged list is kept aside and said, never
/// taken for an empty one.
fn listed_sources(paths: &Paths) -> (Vec<String>, Option<AppError>) {
    match sources::list(paths) {
        Ok(repos) => (repos, None),
        Err(e) => (Vec::new(), Some(e.into())),
    }
}

fn index_status(state: &mut IndexState) -> IndexStatus {
    IndexStatus {
        freshness: state.freshness,
        generated: state.index.as_ref().map(|i| i.generated.clone()),
        signed_at: state.signed_at.map(rfc3339),
        error: state.error.take().map(AppError::from),
        cache_error: state.cache_error.take().map(AppError::from),
    }
}

fn build_catalog(mut state: IndexState, sources: Vec<SourceResult>) -> Catalog {
    let status = index_status(&mut state);
    catalog::build(state.index.as_ref(), status, sources)
}

fn index_cache(paths: &Paths) -> IndexCache {
    IndexCache::new(&paths.cache_dir(), index::public_key())
}

/// How many sources are asked at once: one slow source doesn't hold up the others.
const SOURCE_FETCHES_AT_ONCE: usize = 4;

/// The index and every source; refreshed from the network when `refresh` is set. The page sees
/// this list, and installs only what is in it.
///
/// Each call takes a ticket as it starts. What it found is merged into the held catalogue part
/// by part, and only over parts from refreshes that started before it ([`Ctx::publish_catalog`]):
/// a slow refresh that finishes last can't put an older answer back. It returns the merged
/// catalogue, which is what the page should show.
pub async fn load_catalog(ctx: &Ctx, refresh: bool) -> Result<Catalog, ModsError> {
    use futures_util::stream::{self, StreamExt};
    // Read from disk only, it never replaces a part a refresh brought: ticket 0 is the oldest.
    let ticket = if refresh { ctx.catalog_ticket() } else { 0 };
    let client = http()?;
    let cache = index_cache(&ctx.paths);
    let url = index::index_url();
    let index_load = index::load(&cache, refresh, OffsetDateTime::now_utc(), async {
        let bytes = index::fetch_bytes(&client, &url).await?;
        let sig = index::fetch_bytes(&client, &format!("{url}.minisig")).await?;
        let sig = String::from_utf8(sig)
            .map_err(|_| ModsError::IndexSignatureInvalid("not text".into()))?;
        Ok((bytes, sig))
    });
    let (repos, _) = listed_sources(&ctx.paths);
    let sources_load = stream::iter(repos)
        .map(|repo| {
            let (paths, client) = (&ctx.paths, &client);
            async move {
                let f = sources::fetch(paths, client, &repo, refresh).await;
                (source_result(repo, f), ticket)
            }
        })
        .buffered(SOURCE_FETCHES_AT_ONCE)
        .collect::<Vec<_>>();
    let (mut state, fetched) = futures_util::future::join(index_load, sources_load).await;
    // The list as it is now: a source removed meanwhile isn't brought back.
    let (listed, sources_error) = listed_sources(&ctx.paths);
    let parts = CatalogParts {
        index_status: index_status(&mut state),
        index: state.index,
        index_ticket: ticket,
        sources: fetched,
        sources_error,
    };
    Ok(ctx.publish_catalog(parts, &listed))
}

/// Asks one source again, alone: its answer replaces only its own part of the held catalogue,
/// so the others keep theirs and nothing waits on them. With nothing held yet, a whole load.
pub async fn refresh_source(ctx: &Ctx, repo: &str) -> Result<Catalog, ModsError> {
    let (listed, sources_error) = listed_sources(&ctx.paths);
    let Some(repo) = listed.iter().find(|r| index::same_repo(r, repo)).cloned() else {
        return Err(ModsError::SourceNotFound(repo.to_string()));
    };
    let ticket = ctx.catalog_ticket();
    let f = sources::fetch(&ctx.paths, &http()?, &repo, true).await;
    let (listed, _) = listed_sources(&ctx.paths);
    match ctx.publish_source(ticket, source_result(repo, f), &listed, sources_error) {
        Some(catalog) => Ok(catalog),
        None => load_catalog(ctx, false).await,
    }
}

/// The catalogue from what is on disk: the cached index and each source's last answer.
pub fn offline_catalog(paths: &Paths) -> Catalog {
    let state = index::cached(&index_cache(paths), OffsetDateTime::now_utc());
    let (repos, sources_error) = listed_sources(paths);
    let sources = repos
        .into_iter()
        .map(|repo| {
            let f = sources::cached(paths, &repo);
            source_result(repo, f)
        })
        .collect();
    Catalog {
        sources_error,
        ..build_catalog(state, sources)
    }
}

/// The list the page last saw, else the one on disk: never touches the network.
pub async fn current_catalog(ctx: &Ctx) -> Result<Catalog, ModsError> {
    if let Some(c) = ctx.held_catalog() {
        return Ok(c);
    }
    let paths = ctx.paths.clone();
    blocking(move || Ok(offline_catalog(&paths))).await
}

pub const MAX_ICON_BYTES: usize = 512 * 1024;
const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

/// An icon's bytes, read up to [`MAX_ICON_BYTES`] and only if they are a PNG.
pub async fn fetch_icon(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, ModsError> {
    let response = client
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(ModsError::Http {
            status: response.status().as_u16(),
            url: url.to_string(),
        });
    }
    let bytes = read_capped(response, MAX_ICON_BYTES)
        .await?
        .ok_or_else(|| ModsError::TooLarge("icon over 512 KB".into()))?;
    if !bytes.starts_with(PNG_MAGIC) {
        return Err(ModsError::IconInvalid(url.to_string()));
    }
    Ok(bytes)
}

/// A catalogue icon as PNG bytes, from the cache or the network. Only icons the catalogue
/// names, and only from GitHub's hosts ([`crate::download::icon_url_allowed`]); redirects are
/// held to GitHub too.
pub async fn icon_png(ctx: &Ctx, url: &str) -> Result<Vec<u8>, ModsError> {
    let known = ctx
        .held_catalog()
        .is_some_and(|c| c.mods.iter().any(|m| m.icon.as_deref() == Some(url)));
    if !known || !crate::download::icon_url_allowed(url) {
        return Err(ModsError::NotInCatalog(url.to_string()));
    }
    let cache = ctx.paths.cache_dir().join("mod-icons").join(format!(
        "{}.png",
        &crate::download::sha256_hex(url.as_bytes())[..32]
    ));
    if let Ok(bytes) = std::fs::read(&cache)
        && bytes.len() <= MAX_ICON_BYTES
        && bytes.starts_with(PNG_MAGIC)
    {
        return Ok(bytes);
    }
    let bytes = fetch_icon(&http()?, url).await?;
    let _ = write_atomic(&cache, &bytes);
    Ok(bytes)
}

// ---------------------------------------------------------------------------------------------
// Sources

/// The player's sources; `ModSourcesDamaged` when the list couldn't be read (it is kept aside).
pub fn source_list(ctx: &Ctx) -> Result<Vec<String>, ModsError> {
    sources::list(&ctx.paths)
}

/// Adds a repo as GitHub spells it. Adding one already there, in any case, keeps one entry.
pub async fn add_source(ctx: &Ctx, repo: &str) -> Result<Vec<String>, ModsError> {
    let repo = sources::normalize(repo)?;
    let canonical = sources::canonical_name(&http()?, ctx.github_api(), &repo).await?;
    let _held = ctx.lock_mods().await;
    // A damaged list is already kept aside: this starts a new one.
    let repos = sources::with_repo(sources::list_for_change(&ctx.paths)?, &canonical);
    sources::save(&ctx.paths, &repos)?;
    Ok(repos)
}

/// Mods installed from the repo stay installed; they just stop getting updates.
pub async fn remove_source(ctx: &Ctx, repo: &str) -> Result<Vec<String>, ModsError> {
    let _held = ctx.lock_mods().await;
    let repos = sources::without_repo(sources::list(&ctx.paths)?, repo);
    sources::save(&ctx.paths, &repos)?;
    Ok(repos)
}

// ---------------------------------------------------------------------------------------------
// Profiles
