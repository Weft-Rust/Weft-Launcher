//! The JSON examples in `docs/mod-manager/INDEX_FORMAT.md` and `PROPOSAL.md`, read with the
//! launcher's own code: the documented format is the accepted one.

use super::catalog::{self, IndexStatus, Trust};
use super::index::{self, Freshness};
use super::sources::{GhAsset, GhRelease, ModJson, accept};

const DOC: &str = include_str!("../../../docs/mod-manager/INDEX_FORMAT.md");
const PROPOSAL: &str = include_str!("../../../docs/mod-manager/PROPOSAL.md");

fn json_blocks() -> Vec<serde_json::Value> {
    json_blocks_in(DOC)
}

fn json_blocks_in(doc: &str) -> Vec<serde_json::Value> {
    // A Windows checkout may have turned the line ends into CRLF.
    let doc = doc.replace("\r\n", "\n");
    let mut out = Vec::new();
    let mut rest = doc.as_str();
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
        cache_error: None,
    };
    let catalog = catalog::build(Some(&index), status, vec![]);
    let v = &catalog.mods[0].versions[0];
    assert_eq!(v.trust, Trust::Reviewed);
    assert_eq!(v.build_record, catalog::BuildRecord::Recorded);
    assert_eq!(v.platforms.len(), 3);
}

#[test]
fn the_mod_json_example_is_accepted() {
    assert_accepted(example("asset"));
}

/// The proposal links to INDEX_FORMAT instead of keeping its own examples; any it gains must be
/// valid too.
#[test]
fn the_proposal_has_no_stale_examples() {
    for raw in json_blocks_in(PROPOSAL) {
        if raw.get("asset").is_some() {
            assert_accepted(raw);
        } else if raw.get("mods").is_some() {
            index::parse(raw.to_string().as_bytes()).unwrap();
        }
    }
}

fn assert_accepted(raw: serde_json::Value) {
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

/// The proposal's list of commands is the one `lib.rs` registers from `mods::commands`.
#[test]
fn the_proposal_lists_every_mod_command() {
    let line = PROPOSAL
        .lines()
        .find(|l| l.starts_with("Tauri commands:"))
        .expect("a 'Tauri commands:' line in PROPOSAL.md");
    // The list is the first sentence.
    let list = line.split("`. ").next().unwrap();
    let listed: Vec<&str> = list
        .split('`')
        .skip(1)
        .step_by(2)
        .filter(|name| name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
        .collect();
    let registered: Vec<String> = crate::bindings::command_paths()
        .into_iter()
        .filter_map(|p| p.strip_prefix("mods::commands::").map(str::to_string))
        .collect();
    assert_eq!(listed, registered, "PROPOSAL.md's command list");
}

/// The documented defaults of a revocation are the ones the parser uses.
#[test]
fn the_revocation_defaults_are_documented() {
    let none = index::revocation(serde_json::json!({ "sha256": "a".repeat(64) })).unwrap();
    assert_eq!(none.reason, None, "a revocation without a reason has none");
    assert!(
        DOC.contains("| `revoked[].reason` | none (`null`) |"),
        "INDEX_FORMAT.md says a missing reason is none"
    );
    assert!(DOC.contains("Revocations fail closed"));
}

// ---------------------------------------------------------------------------------------------
// The JSON Schemas in docs/mod-manager/schema, held to the examples and to the launcher's checks.

const INDEX_SCHEMA: &str = include_str!("../../../docs/mod-manager/schema/index.schema.json");
const MOD_SCHEMA: &str = include_str!("../../../docs/mod-manager/schema/mod.schema.json");

/// What each `pattern` in the schemas stands for: the launcher's own check, so a pattern can't
/// drift from what is enforced without this table changing too. A pattern not here fails.
fn pattern_check(pattern: &str) -> fn(&str) -> bool {
    use super::abi::{is_abi, is_safe_ref};
    use super::index::{is_commit, is_mod_id, is_repo, is_rfc3339, is_semver, is_sha256};
    match pattern {
        r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$" => is_rfc3339,
        "^[a-z0-9_]{1,64}$" => is_mod_id,
        "^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$" => is_safe_ref,
        "^[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$" => is_repo,
        "^([0-9a-f]{40}|[0-9a-f]{64})$" => is_commit,
        "^[0-9a-f]{16}$" => is_abi,
        "^[0-9a-f]{64}$" => is_sha256,
        r"^\s*[0-9A-Fa-f]{64}\s*$" => |s| {
            let t = s.trim();
            t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit())
        },
        r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$" => {
            is_semver
        }
        "^https://" => |s| s.starts_with("https://"),
        r"^https://github\.com/" => |s| s.starts_with("https://github.com/"),
        r"^https://(github\.com|raw\.githubusercontent\.com|user-images\.githubusercontent\.com|[A-Za-z0-9-]+\.github\.io)/" => {
            crate::download::icon_url_allowed
        }
        other => {
            panic!("schema pattern {other:?} stands for no launcher check; add it to pattern_check")
        }
    }
}

/// A validator for the part of JSON Schema the schemas use, and only that: a keyword it doesn't
/// know fails, so the schemas stay checkable here.
struct Schemas {
    files: Vec<(&'static str, serde_json::Value)>,
}

impl Schemas {
    fn load() -> Self {
        let parse = |s: &str| serde_json::from_str::<serde_json::Value>(s).expect("schema is JSON");
        Schemas {
            files: vec![
                ("index.schema.json", parse(INDEX_SCHEMA)),
                ("mod.schema.json", parse(MOD_SCHEMA)),
            ],
        }
    }

    fn file(&self, name: &str) -> &serde_json::Value {
        &self
            .files
            .iter()
            .find(|(n, _)| *n == name)
            .unwrap_or_else(|| panic!("no schema {name}"))
            .1
    }

    /// Where `value` breaks `schema` (inside file `file`), as JSON-pointer-ish paths.
    fn errors(
        &self,
        file: &str,
        schema: &serde_json::Value,
        value: &serde_json::Value,
        at: &str,
    ) -> Vec<String> {
        use serde_json::Value as V;
        let mut out = Vec::new();
        let Some(rules) = schema.as_object() else {
            panic!("schema at {at} is not an object");
        };
        for (key, rule) in rules {
            match key.as_str() {
                "$schema" | "$id" | "$defs" | "title" | "description" | "format" => {}
                "$ref" => {
                    let r = rule.as_str().unwrap();
                    let (target, pointer) = r.split_once('#').unwrap();
                    let target = if target.is_empty() { file } else { target };
                    let resolved = self
                        .file(target)
                        .pointer(pointer)
                        .unwrap_or_else(|| panic!("no {r}"));
                    out.extend(self.errors(target, resolved, value, at));
                }
                "type" => {
                    let types: Vec<&str> = match rule {
                        V::String(t) => vec![t.as_str()],
                        V::Array(ts) => ts.iter().map(|t| t.as_str().unwrap()).collect(),
                        _ => panic!("type at {at}"),
                    };
                    let fits = |t: &str| match t {
                        "object" => value.is_object(),
                        "array" => value.is_array(),
                        "string" => value.is_string(),
                        "integer" => value.is_u64() || value.is_i64(),
                        "number" => value.is_number(),
                        "boolean" => value.is_boolean(),
                        "null" => value.is_null(),
                        other => panic!("type {other} at {at}"),
                    };
                    if !types.iter().any(|t| fits(t)) {
                        out.push(format!("{at}: not {types:?}"));
                    }
                }
                "const" if value != rule => out.push(format!("{at}: not {rule}")),
                "const" => {}
                "enum" if !rule.as_array().unwrap().contains(value) => {
                    out.push(format!("{at}: not one of {rule}"))
                }
                "enum" => {}
                "required" => {
                    if let Some(o) = value.as_object() {
                        for k in rule.as_array().unwrap() {
                            if !o.contains_key(k.as_str().unwrap()) {
                                out.push(format!("{at}: lacks {k}"));
                            }
                        }
                    }
                }
                "properties" => {
                    if let Some(o) = value.as_object() {
                        for (k, sub) in rule.as_object().unwrap() {
                            if let Some(v) = o.get(k) {
                                out.extend(self.errors(file, sub, v, &format!("{at}/{k}")));
                            }
                        }
                    }
                }
                "items" => {
                    if let Some(a) = value.as_array() {
                        for (i, v) in a.iter().enumerate() {
                            out.extend(self.errors(file, rule, v, &format!("{at}/{i}")));
                        }
                    }
                }
                "allOf" => {
                    for sub in rule.as_array().unwrap() {
                        out.extend(self.errors(file, sub, value, at));
                    }
                }
                "anyOf" => {
                    let any = rule
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|sub| self.errors(file, sub, value, at).is_empty());
                    if !any {
                        out.push(format!("{at}: matches none of anyOf"));
                    }
                }
                "not" => {
                    if self.errors(file, rule, value, at).is_empty() {
                        out.push(format!("{at}: matches what `not` rules out"));
                    }
                }
                "pattern" => {
                    if let Some(s) = value.as_str()
                        && !pattern_check(rule.as_str().unwrap())(s)
                    {
                        out.push(format!("{at}: {s:?} doesn't match {rule}"));
                    }
                }
                "minLength" => {
                    if let Some(s) = value.as_str()
                        && (s.chars().count() as u64) < rule.as_u64().unwrap()
                    {
                        out.push(format!("{at}: shorter than {rule}"));
                    }
                }
                "minimum" => {
                    if let Some(n) = value.as_f64()
                        && n < rule.as_f64().unwrap()
                    {
                        out.push(format!("{at}: below {rule}"));
                    }
                }
                other => panic!(
                    "schema keyword {other:?} at {at} isn't checked here; add it or leave it out"
                ),
            }
        }
        out
    }

    fn check(&self, file: &str, value: &serde_json::Value) -> Vec<String> {
        self.errors(file, self.file(file), value, "")
    }
}

#[test]
fn the_examples_follow_the_schemas() {
    let s = Schemas::load();
    assert_eq!(
        s.check("index.schema.json", &example("mods")),
        Vec::<String>::new()
    );
    assert_eq!(
        s.check("mod.schema.json", &example("asset")),
        Vec::<String>::new()
    );
    // INDEX_FORMAT points at them.
    assert!(DOC.contains("schema/index.schema.json") && DOC.contains("schema/mod.schema.json"));
}

/// What the schemas rule out, the launcher drops or refuses too.
#[test]
fn the_schemas_and_the_launcher_agree_on_what_is_wrong() {
    let s = Schemas::load();
    type Change = fn(&mut serde_json::Value);
    let builds: &[(&str, Change)] = &[
        ("no sha256", |v| {
            v["asset"].as_object_mut().unwrap().remove("sha256");
        }),
        ("an uppercase sha256", |v| {
            v["asset"]["sha256"] = "A".repeat(64).into()
        }),
        ("an unknown channel", |v| v["channel"] = "beta".into()),
        ("a version that isn't semver", |v| {
            v["version"] = "1.2".into()
        }),
        ("a short commit", |v| {
            v["source"]["commit"] = "cceea78".into()
        }),
        ("an abi that isn't 16 hex", |v| {
            v["weft"]["abi"] = "f470".into()
        }),
        ("a dep that isn't a mod id", |v| {
            v["deps"] = serde_json::json!([{ "id": "Base" }])
        }),
        ("no reviewer", |v| v["reviewed"]["by"] = "".into()),
    ];
    for (what, change) in builds {
        let mut raw = example("mods");
        change(&mut raw["mods"][0]["versions"][0]);
        assert!(
            !s.check("index.schema.json", &raw).is_empty(),
            "the schema allows {what}"
        );
        let index = index::parse(raw.to_string().as_bytes()).unwrap();
        let kept: usize = index.mods.iter().map(|m| m.versions.len()).sum();
        assert_eq!(kept, 0, "the launcher keeps a build with {what}");
    }

    let mods: &[(&str, Change)] = &[
        ("the reserved id", |v| v["id"] = "base".into()),
        ("an id with capitals", |v| v["id"] = "Lanterns".into()),
        ("no schema", |v| {
            v.as_object_mut().unwrap().remove("schema");
        }),
    ];
    for (what, change) in mods {
        let mut raw = example("asset");
        change(&mut raw);
        assert!(
            !s.check("mod.schema.json", &raw).is_empty(),
            "the schema allows {what}"
        );
        let accepted = serde_json::from_value::<ModJson>(raw)
            .ok()
            .and_then(|json| {
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
                accept(&repo, &release, &zip, json).ok()
            });
        assert!(
            accepted.is_none(),
            "the launcher accepts a mod.json with {what}"
        );
    }

    // An icon off GitHub's hosts: the schema says no, and the launcher drops it.
    let mut raw = example("mods");
    raw["mods"][0]["icon"] = "https://tracker.example/icon.png".into();
    assert!(!s.check("index.schema.json", &raw).is_empty());
    assert!(
        index::parse(raw.to_string().as_bytes()).unwrap().mods[0]
            .icon
            .is_none()
    );
}
