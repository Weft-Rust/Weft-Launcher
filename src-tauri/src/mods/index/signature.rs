//! The minisign signature over `index.json`. Only an index signed with the embedded key is used;
//! the signature's trusted comment, which the key also signs, says when it was signed.

use minisign_verify::{PublicKey, Signature};
use time::OffsetDateTime;

use super::super::error::ModsError;
use super::format::{Index, parse};

/// `keys/index.pub` of the index repository.
pub const INDEX_PUBLIC_KEY: &str = "RWRelY1XUps7n+bc3RVDFwMAWzPYz4orZvxzRTo0M+hK2A0w02cQmfvh";

pub fn public_key() -> String {
    #[cfg(debug_assertions)]
    if let Ok(key) = std::env::var("WEFT_MOD_INDEX_PUBKEY") {
        return key;
    }
    INDEX_PUBLIC_KEY.to_string()
}

/// An index whose signature verified, and when it was signed.
#[derive(Debug, Clone)]
pub struct Signed {
    pub index: Index,
    /// From the trusted comment's `timestamp:<unix seconds>`, which `minisign -S` writes by
    /// default. `None` when the comment has none.
    pub signed_at: Option<OffsetDateTime>,
}

/// The `timestamp:` of a trusted comment such as `timestamp:1793819114 file:index.json`.
pub fn signed_at(trusted_comment: &str) -> Option<OffsetDateTime> {
    trusted_comment
        .split(['\t', ' '])
        .find_map(|part| part.strip_prefix("timestamp:"))
        .and_then(|secs| secs.parse::<i64>().ok())
        .and_then(|secs| OffsetDateTime::from_unix_timestamp(secs).ok())
}

pub fn verify(bytes: &[u8], signature: &str, public_key: &str) -> Result<Signed, ModsError> {
    let key = PublicKey::from_base64(public_key.trim())
        .or_else(|_| PublicKey::decode(public_key))
        .map_err(|e| ModsError::IndexSignatureInvalid(format!("public key: {e}")))?;
    let signature = Signature::decode(signature)
        .map_err(|e| ModsError::IndexSignatureInvalid(e.to_string()))?;
    key.verify(bytes, &signature, false)
        .map_err(|e| ModsError::IndexSignatureInvalid(e.to_string()))?;
    Ok(Signed {
        index: parse(bytes)?,
        signed_at: signed_at(signature.trusted_comment()),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    // Signed with a throw-away key made for these tests (`minisign -G -W`); the private half was
    // never kept. The real key belongs to the index repository.
    pub const FIXTURE: &[u8] = include_bytes!("../testdata/index.json");
    /// Signed 2026-11-04T18:05:00Z; `generated` is 2026-11-04T18:00:00Z.
    pub const FIXTURE_SIG: &str = include_str!("../testdata/index.json.minisig");
    /// The same bytes signed again a week later, as the index repository does.
    pub const FIXTURE_RESIGNED_SIG: &str = include_str!("../testdata/index.json.resigned.minisig");
    /// The same index with `generated` 2026-11-01T00:00:00Z, signed 2026-11-01T00:05:00Z.
    pub const OLDER: &[u8] = include_bytes!("../testdata/index-older.json");
    pub const OLDER_SIG: &str = include_str!("../testdata/index-older.json.minisig");
    pub const FIXTURE_KEY: &str = include_str!("../testdata/test.pub");

    pub fn at(rfc3339: &str) -> OffsetDateTime {
        OffsetDateTime::parse(rfc3339, &time::format_description::well_known::Rfc3339).unwrap()
    }

    #[test]
    fn a_signed_index_verifies_and_says_when_it_was_signed() {
        let signed = verify(FIXTURE, FIXTURE_SIG, FIXTURE_KEY).unwrap();
        assert_eq!(signed.index.mods[0].id, "cogwork");
        assert_eq!(signed.index.weft[0].abi, "f470b1cbb1f9ad91");
        assert_eq!(signed.signed_at, Some(at("2026-11-04T18:05:00Z")));
        // The bare base64 line works too, as embedded in the launcher.
        let key_line = FIXTURE_KEY.lines().nth(1).unwrap();
        assert!(verify(FIXTURE, FIXTURE_SIG, key_line).is_ok());
    }

    #[test]
    fn trusted_comments() {
        assert_eq!(
            signed_at("timestamp:1793819114\tfile:index.json\thashed"),
            Some(at("2026-11-04T19:05:14Z"))
        );
        assert_eq!(
            signed_at("timestamp:1793819114 file:index.json commit:5e4de0c"),
            Some(at("2026-11-04T19:05:14Z"))
        );
        assert_eq!(signed_at("test fixture"), None);
        assert_eq!(signed_at("timestamp:soon"), None);
    }

    #[test]
    fn any_change_breaks_the_signature() {
        let mut tampered = FIXTURE.to_vec();
        let at = tampered.windows(7).position(|w| w == b"Cogwork").unwrap();
        tampered[at] = b'K';
        assert!(matches!(
            verify(&tampered, FIXTURE_SIG, FIXTURE_KEY),
            Err(ModsError::IndexSignatureInvalid(_))
        ));
        assert!(matches!(
            verify(FIXTURE, "not a signature", FIXTURE_KEY),
            Err(ModsError::IndexSignatureInvalid(_))
        ));
        // A trusted comment changed to claim a newer signing time.
        let forged = FIXTURE_SIG.replace("timestamp:1793815500", "timestamp:1893815500");
        assert!(matches!(
            verify(FIXTURE, &forged, FIXTURE_KEY),
            Err(ModsError::IndexSignatureInvalid(_))
        ));
    }

    /// A copy of the live index, signed by the real key: the embedded key is the right
    /// one, and nothing the index publishes is dropped by the contract checks here.
    #[test]
    fn the_published_index_verifies_and_keeps_every_entry() {
        let bytes = include_bytes!("../testdata/published-index.json");
        let sig = include_str!("../testdata/published-index.json.minisig");
        let signed = verify(bytes, sig, INDEX_PUBLIC_KEY).unwrap();
        assert!(signed.signed_at.is_some());
        let index = signed.index;
        let raw: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        let raw_count: usize = raw["mods"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["versions"].as_array().unwrap().len())
            .sum();
        let count = index.mods.iter().map(|m| m.versions.len()).sum::<usize>();
        assert!(raw_count > 0);
        assert_eq!(count, raw_count);
        assert_eq!(index.weft.len(), raw["weft"].as_array().unwrap().len());
    }

    #[test]
    fn another_key_is_refused() {
        assert!(matches!(
            verify(FIXTURE, FIXTURE_SIG, INDEX_PUBLIC_KEY),
            Err(ModsError::IndexSignatureInvalid(_))
        ));
    }
}
