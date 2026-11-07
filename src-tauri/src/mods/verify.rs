//! Proof that GitHub Actions in the mod's repository built a zip: the Sigstore bundle that
//! `actions/attest-build-provenance` made for it, published as `<id>.mod.json`.

use sha2::{Digest, Sha256};
use sigstore_verify::trust_root::{SIGSTORE_PRODUCTION_TRUSTED_ROOT, TrustedRoot};
use sigstore_verify::types::{Bundle, Sha256Hash};
use sigstore_verify::{VerificationPolicy, verify};

use super::ModError;

const GITHUB_ACTIONS: &str = "https://token.actions.githubusercontent.com";

pub fn sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Checks that `mod_json` holds an attestation of the zip with this SHA-256, signed by a workflow
/// of `repo` (`owner/name`). The trust root is the one built into the launcher.
pub fn attestation(zip_sha256: &str, mod_json: &[u8], repo: &str) -> Result<(), ModError> {
    let fail = |e: &dyn std::fmt::Display| ModError::VerifyFailed(format!("{repo}: {e}"));
    let json: serde_json::Value = serde_json::from_slice(mod_json).map_err(|e| fail(&e))?;
    let bundle = Bundle::from_json(&json["attestation"].to_string()).map_err(|e| fail(&e))?;
    let digest = Sha256Hash::from_hex(zip_sha256).map_err(|e| fail(&e))?;
    let root = TrustedRoot::from_json(SIGSTORE_PRODUCTION_TRUSTED_ROOT).map_err(|e| fail(&e))?;
    let policy = VerificationPolicy::any_identity().require_issuer(GITHUB_ACTIONS);
    let result = verify(digest, &bundle, &policy, &root).map_err(|e| fail(&e))?;
    let source = result
        .certificate()
        .and_then(|c| c.ci_claims.source_repository_uri.as_deref())
        .unwrap_or_default();
    // GitHub treats owner and repository names case-insensitively.
    if !source.eq_ignore_ascii_case(&format!("https://github.com/{repo}")) {
        return Err(fail(&format!("built in {source:?}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `<id>.mod.json`, from the release `cogwork-v0.2.3-rc.22.gd5ca36d` of
    /// Zorro909/weft-mods, and the SHA-256 of its `cogwork.zip`.
    const MOD_JSON: &[u8] = include_bytes!("testdata/cogwork.mod.json");
    const SHA: &str = "8eba4b7381b98e924b9686416d5c0fc8dfb7427d3c936298d98e680784dc546e";

    #[test]
    fn a_real_attestation_verifies() {
        attestation(SHA, MOD_JSON, "Zorro909/weft-mods").unwrap();
        attestation(SHA, MOD_JSON, "zorro909/Weft-Mods").unwrap();
    }

    #[test]
    fn another_repo_or_other_bytes_fail() {
        let other = "0".repeat(64);
        for (sha, repo) in [
            (SHA, "Zorro909/weft-mods-index"),
            (SHA, "evil/weft-mods"),
            (other.as_str(), "Zorro909/weft-mods"),
        ] {
            let err = attestation(sha, MOD_JSON, repo).unwrap_err();
            assert!(matches!(err, ModError::VerifyFailed(_)), "{err}");
        }
    }

    #[test]
    fn garbage_fails() {
        assert!(attestation(SHA, b"{}", "Zorro909/weft-mods").is_err());
        assert!(attestation(SHA, b"not json", "Zorro909/weft-mods").is_err());
    }
}
