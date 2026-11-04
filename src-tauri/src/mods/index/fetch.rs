//! Getting the index: from GitHub Pages when asked to refresh, else from the cache.

use std::time::Duration;
use time::OffsetDateTime;

use super::super::error::ModsError;
use super::cache::{Age, IndexCache, IndexState, decide, from_cache};
use super::signature::verify;

pub const INDEX_URL: &str = "https://zorro909.github.io/weft-mods-index/v1/index.json";

pub const MAX_INDEX_BYTES: usize = 8 * 1024 * 1024;

pub fn index_url() -> String {
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("WEFT_MOD_INDEX_URL") {
        return url;
    }
    INDEX_URL.to_string()
}

pub async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, ModsError> {
    let response = client
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(ModsError::Http {
            status,
            url: url.to_string(),
        });
    }
    crate::download::read_capped(response, MAX_INDEX_BYTES)
        .await?
        .ok_or_else(|| ModsError::IndexInvalid("too large".into()))
}

fn remember(cache: &IndexCache, age: Option<Age>) {
    if let Some(age) = age
        && let Err(e) = cache.raise(age)
    {
        eprintln!("mod index: could not record its age: {e}");
    }
}

/// The newest index this launcher can trust. With `refresh` false only the cache is read, and
/// nothing touches the network. `fetch` returns the index bytes and their signature.
pub async fn load<F>(cache: &IndexCache, refresh: bool, now: OffsetDateTime, fetch: F) -> IndexState
where
    F: std::future::Future<Output = Result<(Vec<u8>, String), ModsError>>,
{
    let cached = cache.read().map(|(_, s)| s);
    // A cache written before the state file existed still counts as accepted.
    remember(cache, cached.as_ref().and_then(Age::of));
    if !refresh {
        return from_cache(cached, now);
    }
    let fetched = fetch.await.and_then(|(bytes, sig)| {
        let signed = verify(&bytes, &sig, &cache.key)?;
        Ok((bytes, sig, signed))
    });
    let (raw, fetched) = match fetched {
        Ok((bytes, sig, signed)) => (Some((bytes, sig)), Ok(signed)),
        Err(e) => (None, Err(e)),
    };
    let new_age = fetched.as_ref().ok().and_then(Age::of);
    let (state, store) = decide(cached, fetched, cache.highest(), now);
    if store && let Some((bytes, sig)) = raw {
        if let Err(e) = cache.write(&bytes, &sig) {
            eprintln!("mod index: could not cache: {e}");
        }
        remember(cache, new_age);
    }
    state
}

#[cfg(test)]
mod tests {
    use super::super::cache::Freshness;
    use super::super::signature::tests::{
        FIXTURE, FIXTURE_KEY, FIXTURE_RESIGNED_SIG, FIXTURE_SIG, OLDER, OLDER_SIG, at,
    };
    use super::*;
    use std::path::Path;

    fn run<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(fut)
    }

    fn cache(dir: &Path) -> IndexCache {
        IndexCache::new(dir, FIXTURE_KEY.to_string())
    }

    const NOW: &str = "2026-11-05T00:00:00Z";

    fn serve(
        bytes: &[u8],
        sig: &str,
    ) -> impl Future<Output = Result<(Vec<u8>, String), ModsError>> {
        let answer = (bytes.to_vec(), sig.to_string());
        async move { Ok(answer) }
    }

    #[test]
    fn load_keeps_the_cache_when_refresh_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let c = cache(tmp.path());
        c.write(FIXTURE, FIXTURE_SIG).unwrap();
        let state = run(load(&c, true, at(NOW), serve(FIXTURE, "bad signature")));
        assert_eq!(state.freshness, Freshness::Cached);
        assert!(matches!(
            state.error,
            Some(ModsError::IndexSignatureInvalid(_))
        ));
        assert!(state.index.is_some());
        assert_eq!(c.generations(), [1], "nothing new was stored");

        let state = run(load(&c, true, at(NOW), serve(FIXTURE, FIXTURE_SIG)));
        assert_eq!(state.freshness, Freshness::Fresh);
        assert_eq!(state.signed_at, Some(at("2026-11-04T18:05:00Z")));
        assert_eq!(c.generations(), [2, 1]);
    }

    #[test]
    fn without_refresh_nothing_is_fetched() {
        let tmp = tempfile::tempdir().unwrap();
        let c = cache(tmp.path());
        type Fetch = std::pin::Pin<Box<dyn Future<Output = Result<(Vec<u8>, String), ModsError>>>>;
        let never: Fetch = Box::pin(async { panic!("fetched without being asked to") });
        let state = run(load(&c, false, at(NOW), never));
        assert_eq!(state.freshness, Freshness::Unavailable);
        assert!(state.error.is_none());
    }

    /// Deleting the cached index doesn't reset rollback protection: the state file remembers.
    #[test]
    fn rollback_protection_survives_a_deleted_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let c = cache(tmp.path());
        let state = run(load(&c, true, at(NOW), serve(FIXTURE, FIXTURE_SIG)));
        assert_eq!(state.freshness, Freshness::Fresh);

        std::fs::remove_dir_all(tmp.path().join("mod-index")).unwrap();
        let state = run(load(&c, true, at(NOW), serve(OLDER, OLDER_SIG)));
        assert_eq!(state.freshness, Freshness::Unavailable);
        assert!(matches!(state.error, Some(ModsError::IndexRollback)));
        assert!(c.read().is_none(), "the older index was not stored");

        // The newer one, and the same one signed again, still are.
        let state = run(load(&c, true, at(NOW), serve(FIXTURE, FIXTURE_SIG)));
        assert_eq!(state.freshness, Freshness::Fresh);
        let state = run(load(
            &c,
            true,
            at("2026-11-12T00:00:00Z"),
            serve(FIXTURE, FIXTURE_RESIGNED_SIG),
        ));
        assert_eq!(state.freshness, Freshness::Fresh);
        assert_eq!(state.signed_at, Some(at("2026-11-11T18:00:00Z")));

        // Now the first signature of those bytes is the older one.
        std::fs::remove_dir_all(tmp.path().join("mod-index")).unwrap();
        let state = run(load(&c, true, at(NOW), serve(FIXTURE, FIXTURE_SIG)));
        assert!(matches!(state.error, Some(ModsError::IndexRollback)));
    }

    /// A cache from before the state file existed sets the floor the first time it is read.
    #[test]
    fn an_existing_cache_sets_the_floor() {
        let tmp = tempfile::tempdir().unwrap();
        let c = cache(tmp.path());
        c.write(FIXTURE, FIXTURE_SIG).unwrap();
        assert!(c.highest().is_none());
        let state = run(load(&c, false, at(NOW), serve(OLDER, OLDER_SIG)));
        assert_eq!(state.freshness, Freshness::Cached);
        assert!(c.highest().is_some());
        std::fs::remove_dir_all(tmp.path().join("mod-index")).unwrap();
        let state = run(load(&c, true, at(NOW), serve(OLDER, OLDER_SIG)));
        assert!(matches!(state.error, Some(ModsError::IndexRollback)));
    }

    #[test]
    fn an_old_cache_is_stale_and_still_used() {
        let tmp = tempfile::tempdir().unwrap();
        let c = cache(tmp.path());
        c.write(FIXTURE, FIXTURE_SIG).unwrap();
        let later = at("2026-12-10T00:00:00Z");
        let state = run(load(&c, false, later, serve(FIXTURE, FIXTURE_SIG)));
        assert_eq!(state.freshness, Freshness::Stale);
        assert!(state.index.is_some());
        let state = run(load(&c, true, later, serve(FIXTURE, FIXTURE_SIG)));
        assert_eq!(
            state.freshness,
            Freshness::Stale,
            "fetched, but signed long ago"
        );
        assert!(state.error.is_none());
    }
}
