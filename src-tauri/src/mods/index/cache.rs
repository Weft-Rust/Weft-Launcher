//! The verified index on disk, and how far it can be trusted: how old it is, and whether a
//! fetched one may replace it.
//!
//! - `cache/mod-index/<n>/` holds verified generations (index plus signature), checked again on
//!   every read, so the catalogue works offline.
//! - `cache/mod-index.state.json` holds the newest (`generated`, `signedAt`) pair ever accepted.
//!   It is a separate file so that deleting the cached index doesn't reset rollback protection.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use ts_rs::TS;

use super::super::error::ModsError;
use super::super::paths::{unique_suffix, write_atomic};
use super::format::{Index, generated_at};
use super::signature::{Signed, verify};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "lowercase")]
pub enum Freshness {
    /// Fetched and verified just now.
    Fresh,
    /// Verified, but signed more than [`STALE_AFTER`] ago: revocations since then may be missing.
    /// The entries are still used.
    Stale,
    /// The last good copy: not refreshed, or the refresh failed (then an error says why).
    Cached,
    /// Nothing usable yet.
    Unavailable,
}

/// An index signed longer ago than this is `stale`. The index repository re-signs weekly.
pub const STALE_AFTER: Duration = Duration::days(30);

/// How far ahead of this computer's clock an index may be dated. Further than that, it would
/// lock out every honest index until that date, so it is refused.
pub const FUTURE_SLACK: Duration = Duration::days(1);

pub struct IndexState {
    pub index: Option<Index>,
    pub signed_at: Option<OffsetDateTime>,
    pub freshness: Freshness,
    pub error: Option<ModsError>,
    /// The index was fetched and is in use, but couldn't be saved: it is fetched again at the
    /// next start, and offline until then the older saved copy (if any) is what shows.
    pub cache_error: Option<ModsError>,
}

/// How new an index is: `generated`, then the signing time. A re-signed index with the same
/// `generated` is newer; an index without a signing time is older than the same one with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Age {
    pub generated: OffsetDateTime,
    pub signed_at: Option<OffsetDateTime>,
}

impl Age {
    pub fn of(signed: &Signed) -> Option<Age> {
        Some(Age {
            generated: generated_at(&signed.index)?,
            signed_at: signed.signed_at,
        })
    }

    /// The time the age is judged by: when it was signed, or else when it was generated.
    fn reference(&self) -> OffsetDateTime {
        self.signed_at.unwrap_or(self.generated)
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateFile {
    generated: String,
    #[serde(default)]
    signed_at: Option<String>,
}

fn rfc3339(t: OffsetDateTime) -> String {
    t.format(&Rfc3339).unwrap_or_default()
}

fn parse_time(s: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(s, &Rfc3339).ok()
}

/// Verified index generations: `<dir>/<n>/index.json` and `index.json.minisig` are written as
/// one directory and renamed into place together, then `<dir>/current` names the new one. A crash
/// at any point leaves a complete pair behind: reading tries `current`, then every other
/// generation from the newest, then the single pair older launchers wrote.
pub struct IndexCache {
    dir: PathBuf,
    legacy: PathBuf,
    state: PathBuf,
    pub(super) key: String,
}

const KEEP_GENERATIONS: usize = 2;

/// Held while a generation is chosen, written and the old ones pruned.
static WRITING: std::sync::Mutex<()> = std::sync::Mutex::new(());

impl IndexCache {
    /// `cache_dir` is the launcher's `cache/` folder.
    pub fn new(cache_dir: &Path, key: String) -> Self {
        IndexCache {
            dir: cache_dir.join("mod-index"),
            legacy: cache_dir.join("mod-index.json"),
            state: cache_dir.join("mod-index.state.json"),
            key,
        }
    }

    pub(super) fn generations(&self) -> Vec<u64> {
        let mut out: Vec<u64> = std::fs::read_dir(&self.dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.parse().ok())
            .collect();
        out.sort_unstable_by(|a, b| b.cmp(a));
        out
    }

    fn current(&self) -> Option<u64> {
        std::fs::read_to_string(self.dir.join("current"))
            .ok()?
            .trim()
            .parse()
            .ok()
    }

    fn read_pair(&self, json: &Path) -> Option<Signed> {
        let bytes = std::fs::read(json).ok()?;
        let sig = std::fs::read_to_string(json.with_extension("json.minisig")).ok()?;
        // Checked again: the cache is only a file on disk.
        verify(&bytes, &sig, &self.key).ok()
    }

    /// The newest generation that still verifies, and its number (0 for the old single pair).
    pub fn read(&self) -> Option<(u64, Signed)> {
        let mut order: Vec<u64> = self.current().into_iter().collect();
        order.extend(self.generations());
        order.dedup();
        for generation in order {
            let json = self.dir.join(generation.to_string()).join("index.json");
            if let Some(signed) = self.read_pair(&json) {
                return Some((generation, signed));
            }
        }
        self.read_pair(&self.legacy).map(|s| (0, s))
    }

    /// Stores a verified pair as a new generation and drops all but the newest few.
    ///
    /// Choosing the generation number, writing it and pruning are one step under one lock: two
    /// refreshes at once never pick the same number, and neither takes the other's staging
    /// folder for crash debris. (One launcher runs at a time: the single-instance plugin.)
    pub fn write(&self, bytes: &[u8], signature: &str) -> Result<u64, ModsError> {
        let _held = WRITING.lock().unwrap_or_else(|e| e.into_inner());
        self.write_locked(bytes, signature)
    }

    /// As [`IndexCache::write`], unless the generation in use is already newer than `age`: a
    /// refresh that fetched an older index and finished last doesn't replace a newer one.
    /// `None` when nothing was written.
    pub fn write_if_newer(
        &self,
        bytes: &[u8],
        signature: &str,
        age: Age,
    ) -> Result<Option<u64>, ModsError> {
        let _held = WRITING.lock().unwrap_or_else(|e| e.into_inner());
        if self
            .read()
            .and_then(|(_, s)| Age::of(&s))
            .is_some_and(|held| held > age)
        {
            return Ok(None);
        }
        self.write_locked(bytes, signature).map(Some)
    }

    fn write_locked(&self, bytes: &[u8], signature: &str) -> Result<u64, ModsError> {
        std::fs::create_dir_all(&self.dir)?;
        let next = self.generations().first().map_or(1, |n| n + 1);
        let staging = self.dir.join(format!(".{next}.{}.tmp", unique_suffix()));
        let result = (|| {
            std::fs::create_dir_all(&staging)?;
            write_atomic(&staging.join("index.json"), bytes)?;
            write_atomic(&staging.join("index.json.minisig"), signature.as_bytes())?;
            std::fs::rename(&staging, self.dir.join(next.to_string()))?;
            write_atomic(&self.dir.join("current"), next.to_string().as_bytes())
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        result?;
        for old in self.generations().into_iter().skip(KEEP_GENERATIONS) {
            let _ = std::fs::remove_dir_all(self.dir.join(old.to_string()));
        }
        // Staging folders a crash left behind.
        for entry in std::fs::read_dir(&self.dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && name.ends_with(".tmp") && entry.path().is_dir() {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
        Ok(next)
    }

    /// The newest age ever accepted, from the state file.
    pub fn highest(&self) -> Option<Age> {
        let bytes = std::fs::read(&self.state).ok()?;
        let file: StateFile = serde_json::from_slice(&bytes).ok()?;
        Some(Age {
            generated: parse_time(&file.generated)?,
            signed_at: file.signed_at.as_deref().and_then(parse_time),
        })
    }

    /// Records `age` as accepted, unless a newer one already is. Two refreshes at once can't
    /// lower the floor: the read and the write happen under one lock.
    pub fn raise(&self, age: Age) -> Result<(), ModsError> {
        static RAISING: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _held = RAISING.lock().unwrap_or_else(|e| e.into_inner());
        if self.highest().is_some_and(|h| h >= age) {
            return Ok(());
        }
        let file = StateFile {
            generated: rfc3339(age.generated),
            signed_at: age.signed_at.map(rfc3339),
        };
        write_atomic(&self.state, &serde_json::to_vec_pretty(&file)?)
    }
}

/// The state of an index the launcher may use: `stale` when it is old and nothing went wrong.
fn usable(
    signed: Signed,
    freshness: Freshness,
    error: Option<ModsError>,
    now: OffsetDateTime,
) -> IndexState {
    let old = Age::of(&signed).is_some_and(|a| now - a.reference() > STALE_AFTER);
    let freshness = match freshness {
        Freshness::Fresh | Freshness::Cached if old && error.is_none() => Freshness::Stale,
        f => f,
    };
    IndexState {
        signed_at: signed.signed_at,
        index: Some(signed.index),
        freshness,
        error,
        cache_error: None,
    }
}

/// The cached copy, or nothing, with the reason the newer one wasn't used.
fn fallback(cached: Option<Signed>, error: Option<ModsError>, now: OffsetDateTime) -> IndexState {
    match cached {
        Some(signed) => usable(signed, Freshness::Cached, error, now),
        None => IndexState {
            index: None,
            signed_at: None,
            freshness: Freshness::Unavailable,
            error,
            cache_error: None,
        },
    }
}

/// The cached copy as it is, without asking for a newer one.
pub fn from_cache(cached: Option<Signed>, now: OffsetDateTime) -> IndexState {
    fallback(cached, None, now)
}

/// What to do with a freshly fetched index, given the verified copy held and the newest age
/// ever accepted. An index older than either is refused: someone serving an old index must not
/// bring back a revoked mod, even after the cache was deleted. So is one dated in the future.
pub fn decide(
    cached: Option<Signed>,
    fetched: Result<Signed, ModsError>,
    highest: Option<Age>,
    now: OffsetDateTime,
) -> (IndexState, bool /* store the fetched one */) {
    let floor = highest.max(cached.as_ref().and_then(Age::of));
    let new = match fetched {
        Err(error) => return (fallback(cached, Some(error), now), false),
        Ok(new) => new,
    };
    let Some(age) = Age::of(&new) else {
        let error = ModsError::IndexInvalid("no generated time".into());
        return (fallback(cached, Some(error), now), false);
    };
    if age.generated > now + FUTURE_SLACK || age.signed_at.is_some_and(|s| s > now + FUTURE_SLACK) {
        let error = ModsError::IndexInvalid("dated in the future".into());
        return (fallback(cached, Some(error), now), false);
    }
    if floor.is_some_and(|f| age < f) {
        return (fallback(cached, Some(ModsError::IndexRollback), now), false);
    }
    (usable(new, Freshness::Fresh, None, now), true)
}

#[cfg(test)]
mod tests {
    use super::super::signature::tests::{
        FIXTURE, FIXTURE_KEY, FIXTURE_RESIGNED_SIG, FIXTURE_SIG, OLDER, OLDER_SIG, at,
    };
    use super::*;

    fn signed(bytes: &[u8], sig: &str) -> Signed {
        verify(bytes, sig, FIXTURE_KEY).unwrap()
    }

    fn index_at(generated: &str, signed_at: Option<&str>) -> Signed {
        Signed {
            index: Index {
                schema: 1,
                generated: generated.into(),
                weft: vec![],
                mods: vec![],
                revoked: vec![],
            },
            signed_at: signed_at.map(at),
        }
    }

    const NOW: &str = "2026-11-05T00:00:00Z";

    #[test]
    fn an_older_index_is_refused() {
        let now = at(NOW);
        let held = || Some(index_at("2026-11-04T18:00:00Z", None));
        let (state, store) = decide(
            held(),
            Ok(index_at("2026-11-01T00:00:00Z", None)),
            None,
            now,
        );
        assert!(!store);
        assert_eq!(state.freshness, Freshness::Cached);
        assert!(matches!(state.error, Some(ModsError::IndexRollback)));
        assert_eq!(state.index.unwrap().generated, "2026-11-04T18:00:00Z");

        let (state, store) = decide(
            held(),
            Ok(index_at("2026-11-04T20:00:00Z", None)),
            None,
            now,
        );
        assert!(store);
        assert_eq!(state.freshness, Freshness::Fresh);
        assert!(state.error.is_none());

        let (state, store) = decide(held(), Err(ModsError::IndexInvalid("x".into())), None, now);
        assert!(!store);
        assert_eq!(state.freshness, Freshness::Cached);
        assert!(state.index.is_some() && state.error.is_some());

        let (state, _) = decide(None, Err(ModsError::IndexInvalid("x".into())), None, now);
        assert_eq!(state.freshness, Freshness::Unavailable);
    }

    /// The pair decides: the same `generated` signed later is newer, signed earlier is older.
    #[test]
    fn the_signing_time_breaks_ties() {
        let now = at(NOW);
        let highest = Age::of(&index_at(
            "2026-11-04T18:00:00Z",
            Some("2026-11-04T18:05:00Z"),
        ));
        let same_later = index_at("2026-11-04T18:00:00Z", Some("2026-11-04T19:00:00Z"));
        let same_earlier = index_at("2026-11-04T18:00:00Z", Some("2026-11-04T18:01:00Z"));
        let same_unsigned = index_at("2026-11-04T18:00:00Z", None);
        let same_exact = index_at("2026-11-04T18:00:00Z", Some("2026-11-04T18:05:00Z"));
        assert!(decide(None, Ok(same_later), highest, now).1);
        assert!(
            decide(None, Ok(same_exact), highest, now).1,
            "fetching the same index again"
        );
        for older in [same_earlier, same_unsigned] {
            let (state, store) = decide(None, Ok(older), highest, now);
            assert!(!store);
            assert!(matches!(state.error, Some(ModsError::IndexRollback)));
            assert_eq!(state.freshness, Freshness::Unavailable);
        }
    }

    #[test]
    fn an_index_from_the_future_is_refused() {
        let now = at(NOW);
        for (generated, signed_at) in [
            ("2027-01-01T00:00:00Z", None),
            ("2026-11-04T00:00:00Z", Some("2027-01-01T00:00:00Z")),
        ] {
            let (state, store) = decide(None, Ok(index_at(generated, signed_at)), None, now);
            assert!(!store, "{generated}");
            assert!(matches!(state.error, Some(ModsError::IndexInvalid(_))));
        }
        // A few hours ahead is only a clock that is off.
        let (_, store) = decide(None, Ok(index_at("2026-11-05T06:00:00Z", None)), None, now);
        assert!(store);
    }

    #[test]
    fn an_old_signature_makes_it_stale() {
        let fetched = || {
            Ok(index_at(
                "2026-09-01T00:00:00Z",
                Some("2026-09-01T00:00:00Z"),
            ))
        };
        let (state, store) = decide(None, fetched(), None, at(NOW));
        assert!(store, "a stale index is still used");
        assert_eq!(state.freshness, Freshness::Stale);
        assert!(state.index.is_some() && state.error.is_none());
        assert_eq!(state.signed_at, Some(at("2026-09-01T00:00:00Z")));

        let (state, _) = decide(None, fetched(), None, at("2026-09-20T00:00:00Z"));
        assert_eq!(state.freshness, Freshness::Fresh);

        // Without a signing time, `generated` is what counts.
        let (state, _) = decide(
            None,
            Ok(index_at("2026-09-01T00:00:00Z", None)),
            None,
            at(NOW),
        );
        assert_eq!(state.freshness, Freshness::Stale);

        // A cached copy read without refreshing is stale too; one shown because the refresh
        // failed stays `cached`, with the error.
        let old = || Some(index_at("2026-09-01T00:00:00Z", None));
        assert_eq!(from_cache(old(), at(NOW)).freshness, Freshness::Stale);
        let (state, _) = decide(old(), Err(ModsError::IndexRollback), None, at(NOW));
        assert_eq!(state.freshness, Freshness::Cached);
    }

    fn cache(dir: &Path) -> IndexCache {
        IndexCache::new(dir, FIXTURE_KEY.to_string())
    }

    /// Many refreshes storing at once: each gets its own generation, every write succeeds, the
    /// generation in use verifies, the newest few are kept and no staging folder is left.
    #[test]
    fn concurrent_writers_keep_complete_generations() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        let handles: Vec<_> = (0..12)
            .map(|_| {
                let dir = dir.clone();
                std::thread::spawn(move || cache(&dir).write(FIXTURE, FIXTURE_SIG))
            })
            .collect();
        let mut numbers: Vec<u64> = handles
            .into_iter()
            .map(|h| h.join().unwrap().unwrap())
            .collect();
        numbers.sort_unstable();
        assert_eq!(numbers, (1..=12).collect::<Vec<_>>(), "one generation each");
        let c = cache(&dir);
        assert_eq!(c.read().unwrap().0, 12);
        assert_eq!(c.generations(), [12, 11]);
        let leftovers: Vec<_> = std::fs::read_dir(dir.join("mod-index"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no staging folder left behind");
    }

    #[test]
    fn an_older_index_finishing_last_does_not_replace_a_newer_one() {
        use super::super::signature::tests::{OLDER, OLDER_SIG};
        let tmp = tempfile::tempdir().unwrap();
        let c = cache(tmp.path());
        let newer = Age::of(&verify(FIXTURE, FIXTURE_SIG, FIXTURE_KEY).unwrap()).unwrap();
        let older = Age::of(&verify(OLDER, OLDER_SIG, FIXTURE_KEY).unwrap()).unwrap();
        assert!(older < newer);
        assert_eq!(
            c.write_if_newer(FIXTURE, FIXTURE_SIG, newer).unwrap(),
            Some(1)
        );
        assert_eq!(c.write_if_newer(OLDER, OLDER_SIG, older).unwrap(), None);
        assert_eq!(c.read().unwrap().0, 1);
        assert_eq!(
            c.write_if_newer(FIXTURE, FIXTURE_SIG, newer).unwrap(),
            Some(2),
            "the same age again is stored"
        );
    }

    #[test]
    fn the_cache_falls_back_to_the_previous_generation() {
        let tmp = tempfile::tempdir().unwrap();
        let c = cache(tmp.path());
        assert!(c.read().is_none());
        assert_eq!(c.write(FIXTURE, FIXTURE_SIG).unwrap(), 1);
        assert_eq!(c.write(FIXTURE, FIXTURE_SIG).unwrap(), 2);
        assert_eq!(c.read().unwrap().0, 2);

        // The newest pair no longer verifies: the one before it is used.
        let newest = tmp.path().join("mod-index").join("2").join("index.json");
        let mut bytes = std::fs::read(&newest).unwrap();
        bytes[10] ^= 1;
        std::fs::write(&newest, bytes).unwrap();
        assert_eq!(c.read().unwrap().0, 1);

        // A crash half way through a write: a third generation without its signature, and
        // `current` pointing at it.
        let third = tmp.path().join("mod-index").join("3");
        std::fs::create_dir_all(&third).unwrap();
        std::fs::write(third.join("index.json"), FIXTURE).unwrap();
        std::fs::write(tmp.path().join("mod-index").join("current"), "3").unwrap();
        assert_eq!(c.read().unwrap().0, 1);

        // Only the newest few are kept.
        c.write(FIXTURE, FIXTURE_SIG).unwrap();
        assert_eq!(c.generations(), [4, 3]);
        assert_eq!(c.read().unwrap().0, 4);
    }

    #[test]
    fn the_cache_reads_the_pair_older_launchers_wrote() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("mod-index.json"), FIXTURE).unwrap();
        std::fs::write(tmp.path().join("mod-index.json.minisig"), FIXTURE_SIG).unwrap();
        assert_eq!(cache(tmp.path()).read().unwrap().0, 0);
        std::fs::write(tmp.path().join("mod-index.json.minisig"), "junk").unwrap();
        assert!(cache(tmp.path()).read().is_none());
    }

    #[test]
    fn the_state_file_only_moves_forward() {
        let tmp = tempfile::tempdir().unwrap();
        let c = cache(tmp.path());
        assert!(c.highest().is_none());
        let newer = Age::of(&signed(FIXTURE, FIXTURE_SIG)).unwrap();
        let older = Age::of(&signed(OLDER, OLDER_SIG)).unwrap();
        let resigned = Age::of(&signed(FIXTURE, FIXTURE_RESIGNED_SIG)).unwrap();
        assert!(older < newer && newer < resigned);
        c.raise(newer).unwrap();
        c.raise(older).unwrap();
        assert_eq!(c.highest(), Some(newer));
        c.raise(resigned).unwrap();
        assert_eq!(c.highest(), Some(resigned));
        assert!(tmp.path().join("mod-index.state.json").exists());
    }
}
