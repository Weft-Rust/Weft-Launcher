//! The curated mod index: `index.json` plus its minisign signature, as described in
//! `docs/mod-manager/INDEX_FORMAT.md`. Only an index signed with the embedded key is used. The
//! last one that verified is kept, so the catalogue works offline, and an older one than any
//! accepted before is refused.
//!
//! - `format.rs`: the JSON and the rules each entry must follow;
//! - `signature.rs`: the signature, and when it was made;
//! - `cache.rs`: the verified copies on disk, rollback protection and staleness;
//! - `fetch.rs`: getting it from the network, or not.

mod cache;
mod fetch;
mod format;
mod signature;

pub use cache::{Age, FUTURE_SLACK, Freshness, IndexCache, IndexState, STALE_AFTER, decide};
pub use fetch::{INDEX_URL, MAX_INDEX_BYTES, fetch_bytes, index_url, load};
pub use format::*;
pub use signature::{INDEX_PUBLIC_KEY, Signed, public_key, signed_at, verify};

#[cfg(test)]
pub(crate) mod tests {
    pub use super::format::tests::*;
}
