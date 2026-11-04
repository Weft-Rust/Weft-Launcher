//! The JSON examples in `docs/mod-manager/INDEX_FORMAT.md`, read with the launcher's own code:
//! the documented format is the accepted one.

use super::catalog::{self, IndexStatus, Trust};
use super::index::{self, Freshness};
use super::sources::{GhAsset, GhRelease, ModJson, accept};

const DOC: &str = include_str!("../../../docs/mod-manager/INDEX_FORMAT.md");

fn json_blocks() -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let mut rest = DOC;
    while let Some(start) = rest.find("```json\n") {
        let body = &rest[start + "```json\n".len()..];
        let end = body.find("\n```").expect("closed code block");
        out.push(
            serde_json::from_str(&body[..end])
                .unwrap_or_else(|e| panic!("example is not valid JSON: {e}\n{}", &body[..end])),
        );
        rest = &body[end..];
    }
    out
}

fn example(has: &str) -> serde_json::Value {
    json_blocks()
        .into_iter()
        .find(|v| v.get(has).is_some())
        .unwrap_or_else(|| panic!("no example with {has:?}"))
}

#[test]
fn the_index_example_parses_and_keeps_everything() {
    let raw = example("mods");
    let index = index::parse(raw.to_string().as_bytes()).unwrap();
    let raw_versions: usize = raw["mods"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["versions"].as_array().unwrap().len())
        .sum();
    let versions: usize = index.mods.iter().map(|m| m.versions.len()).sum();
    assert_eq!(versions, raw_versions, "an example version was dropped");
    assert_eq!(index.weft.len(), raw["weft"].as_array().unwrap().len());
    assert_eq!(
        index.revoked.len(),
        raw["revoked"].as_array().unwrap().len()
    );
    assert!(index.mods[0].icon.is_some() && index.mods[0].homepage.is_some());

    let status = IndexStatus {
        freshness: Freshness::Fresh,
        generated: None,
        signed_at: None,
        error: None,
    };
    let catalog = catalog::build(Some(&index), status, vec![]);
    let v = &catalog.mods[0].versions[0];
    assert_eq!(v.trust, Trust::Reviewed);
    assert!(v.provenance_verified);
    assert_eq!(v.platforms.len(), 3);
}

#[test]
fn the_mod_json_example_is_accepted() {
    let raw = example("asset");
    let json: ModJson = serde_json::from_value(raw.clone()).unwrap();
    let zip = GhAsset {
        name: json.asset.name.clone(),
        browser_download_url: json.asset.url.clone(),
        size: json.asset.size,
        digest: Some(format!("sha256:{}", json.asset.sha256)),
    };
    let release = GhRelease {
        tag_name: json.tag.clone(),
        draft: false,
        prerelease: false,
        published_at: None,
        assets: vec![zip.clone()],
    };
    let repo = json.source.repo.clone();
    let accepted = accept(&repo, &release, &zip, json).expect("the example is accepted");
    assert!(accepted.icon.is_some(), "the icon is an absolute URL");
    assert!(accepted.versions[0].reviewed.is_none());
}
