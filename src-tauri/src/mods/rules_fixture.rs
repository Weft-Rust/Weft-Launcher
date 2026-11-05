//! The mock's rule cases, `src/dev/fixtures/rules.json`, run through the real rules here, so the
//! dev mock (`src/dev/mockRules.ts`, tested against the same file) and the backend can't drift.
//!
//! The JSON belongs to the frontend; this file only adapts its shapes:
//! - a sha is written `<id>@<version>`, which is [`sha`] here;
//! - a build is `[version, abi, channel, deps]` and an abi is a name from `abi`;
//! - a lock entry is the test helper [`entry`] with the fields given changed.
//!
//! New cases in a known section need nothing here. A section or a case field this test doesn't
//! know fails it, naming what to adapt: a case that is read but not checked would let the two
//! sides drift unnoticed.

use serde_json::{Map, Value};

use super::catalog::{Catalog, Origin, Trust};
use super::index::Channel;
use super::plan::{self, CopyOutcome};
use super::profile::tests::{build, catalog_mod, entry, fit, sha};
use super::profile::{self, Fit, Lock, LockEntry, Revocation};
use crate::error::AppError;

const RULES: &str = include_str!("../../../src/dev/fixtures/rules.json");

struct Rules {
    root: Map<String, Value>,
}

fn obj(v: &Value) -> &Map<String, Value> {
    v.as_object()
        .unwrap_or_else(|| panic!("rules.json: expected an object, got {v}"))
}

fn arr(v: &Value) -> &Vec<Value> {
    v.as_array()
        .unwrap_or_else(|| panic!("rules.json: expected a list, got {v}"))
}

fn text(v: &Value) -> &str {
    v.as_str()
        .unwrap_or_else(|| panic!("rules.json: expected a string, got {v}"))
}

fn strings(v: &Value) -> Vec<String> {
    arr(v).iter().map(|s| text(s).to_string()).collect()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

/// Fails on any key of a case this test doesn't check.
fn only(what: &str, case: &Map<String, Value>, known: &[&str]) {
    let unknown: Vec<&String> = case
        .keys()
        .filter(|k| !known.contains(&k.as_str()))
        .collect();
    assert!(
        unknown.is_empty(),
        "rules.json {what}: fields {unknown:?} aren't checked against the backend; \
         add them to src-tauri/src/mods/rules_fixture.rs"
    );
}

/// `<id>@<version>` → the test helpers' sha of that build.
fn sha_of(s: &str) -> String {
    let (id, version) = s
        .split_once('@')
        .unwrap_or_else(|| panic!("rules.json: {s:?} is not <id>@<version>"));
    sha(id, version)
}

fn parse<T: serde::de::DeserializeOwned>(v: &Value) -> T {
    serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("rules.json: {v}: {e}"))
}

impl Rules {
    fn load() -> Rules {
        let root: Value = serde_json::from_str(RULES).expect("rules.json is JSON");
        Rules {
            root: obj(&root).clone(),
        }
    }

    fn section(&self, name: &str) -> &Map<String, Value> {
        obj(self
            .root
            .get(name)
            .unwrap_or_else(|| panic!("rules.json has no {name}")))
    }

    fn abi(&self, name: &Value) -> Option<String> {
        match name {
            Value::Null => None,
            v => Some(text(&self.section("abi")[text(v)]).to_string()),
        }
    }

    fn catalog(&self, name: &str) -> Catalog {
        let c = obj(&self.section("catalogs")[name]);
        only(&format!("catalogs.{name}"), c, &["rust", "mods", "revoked"]);
        let mods = arr(&c["mods"])
            .iter()
            .map(|m| {
                let m = obj(m);
                only(
                    &format!("catalogs.{name}.mods[]"),
                    m,
                    &["id", "origin", "builds"],
                );
                let id = text(&m["id"]);
                let origin = match text(&m["origin"]) {
                    "index" => Origin::Index,
                    repo => Origin::Source { repo: repo.into() },
                };
                let builds = arr(&m["builds"])
                    .iter()
                    .map(|b| {
                        let b = arr(b);
                        let channel: Channel = parse(&b[2]);
                        let deps = strings(&b[3]);
                        let deps: Vec<&str> = deps.iter().map(String::as_str).collect();
                        let abi = self.abi(&b[1]).expect("a build has an abi");
                        build(id, text(&b[0]), &abi, channel, &deps)
                    })
                    .collect();
                catalog_mod(id, origin, builds)
            })
            .collect();
        let revoked: Vec<String> = arr(&c["revoked"]).iter().map(|s| sha_of(text(s))).collect();
        let revoked: Vec<&str> = revoked.iter().map(String::as_str).collect();
        profile::tests::catalog(mods, &revoked)
    }

    fn entry(&self, spec: &Value) -> LockEntry {
        let s = obj(spec);
        only(
            "a lock entry",
            s,
            &[
                "id", "deps", "abi", "enabled", "version", "channel", "trust", "origin", "revoked",
            ],
        );
        let deps = s.get("deps").map(strings).unwrap_or_default();
        let deps: Vec<&str> = deps.iter().map(String::as_str).collect();
        let abi = match s.get("abi") {
            None => Some(super::profile::tests::ABI.to_string()),
            Some(a) => self.abi(a),
        };
        let mut e = entry(text(&s["id"]), &deps, abi.as_deref());
        if let Some(v) = s.get("version") {
            e.version = Some(text(v).into());
            e.sha256 = sha(&e.id, text(v));
        }
        if let Some(v) = s.get("enabled") {
            e.enabled = v.as_bool().expect("enabled is a bool");
        }
        if let Some(v) = s.get("channel") {
            e.channel = Some(parse(v));
        }
        if let Some(v) = s.get("trust") {
            e.trust = parse::<Trust>(v);
        }
        if let Some(v) = s.get("origin") {
            e.origin = parse(v);
        }
        if let Some(v) = s.get("revoked") {
            e.revoked = Some(parse::<Revocation>(v));
        }
        e
    }

    fn lock(&self, specs: &Value) -> Lock {
        super::profile::tests::lock(arr(specs).iter().map(|s| self.entry(s)).collect())
    }

    fn pick(
        &self,
        c: &Catalog,
        s: &str,
    ) -> (super::catalog::CatalogMod, super::catalog::CatalogVersion) {
        let (m, v) = c
            .find(&sha_of(s))
            .unwrap_or_else(|| panic!("rules.json: no build {s}"));
        (m.clone(), v.clone())
    }
}

fn code(e: Option<AppError>) -> Value {
    e.map_or(Value::Null, |e| Value::String(e.code.as_str().into()))
}

const SECTIONS: &[&str] = &[
    "_about",
    "abi",
    "catalogs",
    "plans",
    "commits",
    "toggles",
    "copies",
    "statuses",
    "updates",
    "shadowing",
    "revocations",
    "iconHosts",
];

#[test]
fn every_section_is_read() {
    let rules = Rules::load();
    let unknown: Vec<&String> = rules
        .root
        .keys()
        .filter(|k| !SECTIONS.contains(&k.as_str()))
        .collect();
    assert!(
        unknown.is_empty(),
        "rules.json has sections {unknown:?} that no Rust test reads; \
         add an adapter for them in src-tauri/src/mods/rules_fixture.rs"
    );
}

#[test]
fn plans() {
    let r = Rules::load();
    let s = r.section("plans");
    let c = r.catalog(text(&s["catalog"]));
    for case in arr(&s["cases"]) {
        let case = obj(case);
        let what = text(&case["what"]);
        only(
            &format!("plans: {what}"),
            case,
            &[
                "what",
                "target",
                "lock",
                "abi",
                "running",
                "install",
                "enable",
                "missing",
                "problem",
                "turnsOn",
                "replaces",
                "fitsVersion",
            ],
        );
        let lock = r.lock(&case["lock"]);
        let abi = match case.get("abi") {
            Some(a) => r.abi(a),
            None => Some(fit().abi.to_string()),
        };
        let f = abi.as_deref().map(|abi| Fit { abi, ..fit() });
        let running = case
            .get("running")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let target = sha_of(text(&case["target"]));
        let plan = plan::plan_install(&c, &lock, "v1", &target, f, running).unwrap();
        let installs: Vec<String> = plan.install.iter().map(|i| i.id.clone()).collect();
        assert_eq!(installs, strings(&case["install"]), "plan: {what}: install");
        assert_eq!(
            plan.enable,
            strings(&case["enable"]),
            "plan: {what}: enable"
        );
        assert_eq!(
            plan.missing,
            strings(&case["missing"]),
            "plan: {what}: missing"
        );
        assert_eq!(
            code(plan.problem.clone()),
            case["problem"],
            "plan: {what}: problem"
        );
        assert_eq!(
            Some(plan.turns_on),
            case["turnsOn"].as_bool(),
            "plan: {what}: turnsOn"
        );
        if let Some(want) = case.get("fitsVersion") {
            assert_eq!(
                plan.fits_version.map_or(Value::Null, Value::Bool),
                *want,
                "plan: {what}: fitsVersion"
            );
        }
        if let Some(want) = case.get("replaces") {
            let want = obj(want);
            only(
                &format!("plans: {what}: replaces"),
                want,
                &["enabled", "trust"],
            );
            let got = plan.replaces.as_ref().expect("replaces");
            if let Some(e) = want.get("enabled") {
                assert_eq!(
                    Some(got.enabled),
                    e.as_bool(),
                    "plan: {what}: replaces.enabled"
                );
            }
            if let Some(t) = want.get("trust") {
                assert_eq!(got.trust, parse::<Trust>(t), "plan: {what}: replaces.trust");
            }
        }
    }
}

#[test]
fn commits() {
    let r = Rules::load();
    let s = r.section("commits");
    let c = r.catalog(text(&s["catalog"]));
    for case in arr(&s["cases"]) {
        let case = obj(case);
        let what = text(&case["what"]);
        only(
            &format!("commits: {what}"),
            case,
            &[
                "what",
                "wanted",
                "lock",
                "installed",
                "alsoEnabled",
                "installedOff",
                "after",
            ],
        );
        let mut lock = r.lock(&case["lock"]);
        let wanted = strings(&case["wanted"])
            .iter()
            .map(|w| r.pick(&c, w))
            .collect();
        let res = plan::resolve(&c, &lock, wanted, fit());
        let done = plan::commit(&mut lock, &res);
        assert_eq!(
            done.installed,
            strings(&case["installed"]),
            "commit: {what}: installed"
        );
        assert_eq!(
            done.also_enabled,
            strings(&case["alsoEnabled"]),
            "commit: {what}: alsoEnabled"
        );
        assert_eq!(
            done.installed_off,
            strings(&case["installedOff"]),
            "commit: {what}: installedOff"
        );
        for (id, on) in obj(&case["after"]) {
            assert_eq!(
                lock.get(id).map(|e| e.enabled),
                on.as_bool(),
                "commit: {what}: {id} afterwards"
            );
        }
    }
}

#[test]
fn toggles() {
    let r = Rules::load();
    let s = r.section("toggles");
    let c = r.catalog(text(&s["catalog"]));
    for case in arr(&s["cases"]) {
        let case = obj(case);
        let what = text(&case["what"]);
        only(
            &format!("toggles: {what}"),
            case,
            &[
                "what",
                "lock",
                "action",
                "alsoEnabled",
                "alsoDisabled",
                "error",
                "after",
            ],
        );
        let mut lock = r.lock(&case["lock"]);
        let action = strings(&case["action"]);
        let (verb, id) = (action[0].as_str(), action[1].as_str());
        let result = match verb {
            "remove" => plan::remove(&mut lock, id).map(|off| (Vec::new(), off)),
            "on" | "off" => plan::set_enabled(&mut lock, &c, id, verb == "on"),
            other => panic!("rules.json toggles: {what}: unknown action {other:?}"),
        };
        if let Some(want) = case.get("error") {
            let err = result
                .err()
                .unwrap_or_else(|| panic!("toggle: {what}: expected {want}"));
            assert_eq!(
                Value::String(err.code().as_str().into()),
                *want,
                "toggle: {what}"
            );
            if want == "ModRevoked" {
                assert!(
                    lock.mods.iter().all(|e| !e.enabled),
                    "toggle: {what}: nothing changes"
                );
            }
            continue;
        }
        let (on, off) = result.unwrap_or_else(|e| panic!("toggle: {what}: {e}"));
        assert_eq!(
            sorted(on),
            strings(&case["alsoEnabled"]),
            "toggle: {what}: alsoEnabled"
        );
        assert_eq!(
            sorted(off),
            strings(&case["alsoDisabled"]),
            "toggle: {what}: alsoDisabled"
        );
        if let Some(after) = case.get("after") {
            for (id, on) in obj(after) {
                assert_eq!(
                    lock.get(id).map(|e| e.enabled),
                    on.as_bool(),
                    "toggle: {what}: {id}"
                );
            }
        }
    }
}

#[test]
fn copies() {
    let r = Rules::load();
    let s = r.section("copies");
    only(
        "copies",
        s,
        &["rust", "catalog", "from", "to", "outcomes", "picks"],
    );
    let c = r.catalog(text(&s["catalog"]));
    let (from, to) = (r.lock(&s["from"]), r.lock(&s["to"]));
    let (preview, picks) = plan::copy_preview(&c, ("v1", &from), ("v2", &to), fit());
    for (id, want) in obj(&s["outcomes"]) {
        let got = preview.items.iter().find(|i| &i.id == id).map(|i| {
            serde_json::json!([serde_json::to_value(i.outcome).unwrap(), i.version.clone()])
        });
        assert_eq!(got.unwrap_or(Value::Null), *want, "copy: {id}");
    }
    let picked: Vec<String> = picks.iter().map(|(m, _)| m.id.clone()).collect();
    assert_eq!(picked, strings(&s["picks"]), "copy: picks");
    assert!(
        preview
            .items
            .iter()
            .filter(|i| i.outcome == CopyOutcome::Install)
            .all(|i| i.trust.is_some())
    );
}

#[test]
fn statuses() {
    let r = Rules::load();
    let s = r.section("statuses");
    only(
        "statuses",
        s,
        &[
            "rust",
            "catalog",
            "lock",
            "cases",
            "blocking",
            "missingDeps",
            "depsNotInstalled",
            "revokedReason",
        ],
    );
    let c = r.catalog(text(&s["catalog"]));
    let lock = r.lock(&s["lock"]);
    let report =
        |abi: Option<String>| profile::report("v1", &lock, abi, None, &c, fit().platform, vec![]);
    for case in arr(&s["cases"]) {
        let case = arr(case);
        let (abi, id) = (r.abi(&case[0]), text(&case[1]));
        let got = report(abi.clone())
            .mods
            .iter()
            .find(|m| m.entry.id == id)
            .map(|m| serde_json::to_value(m.status).unwrap());
        assert_eq!(got.as_ref(), Some(&case[2]), "status of {id} with {abi:?}");
    }
    let full = report(Some(fit().abi.to_string()));
    assert_eq!(full.blocking, strings(&s["blocking"]), "blocking");
    let find = |id: &str| full.mods.iter().find(|m| m.entry.id == id).unwrap();
    for (id, want) in obj(&s["missingDeps"]) {
        assert_eq!(find(id).missing_deps, strings(want), "missingDeps of {id}");
    }
    for (id, want) in obj(&s["depsNotInstalled"]) {
        assert_eq!(
            find(id).deps_not_installed,
            strings(want),
            "depsNotInstalled of {id}"
        );
    }
    for (id, want) in obj(&s["revokedReason"]) {
        assert_eq!(
            find(id).revoked_reason.as_deref(),
            want.as_str(),
            "revokedReason of {id}"
        );
    }
}

#[test]
fn updates() {
    let r = Rules::load();
    let s = r.section("updates");
    let c = r.catalog(text(&s["catalog"]));
    for case in arr(&s["cases"]) {
        let case = obj(case);
        let what = text(&case["what"]);
        only(
            &format!("updates: {what}"),
            case,
            &["what", "entry", "want"],
        );
        let e = r.entry(&case["entry"]);
        let got = profile::update_for(&e, Some(fit()), &c).map(|u| u.version);
        assert_eq!(got.as_deref(), case["want"].as_str(), "update: {what}");
        assert!(
            profile::update_for(&e, None, &c).is_none(),
            "update: {what}: no ABI"
        );
    }
}

#[test]
fn shadowing() {
    let r = Rules::load();
    let s = r.section("shadowing");
    only(
        "shadowing",
        s,
        &[
            "rust",
            "catalog",
            "lock",
            "playerFolder",
            "unmanaged",
            "shadowed",
            "blocking",
            "blockingReasons",
        ],
    );
    let c = r.catalog(text(&s["catalog"]));
    let lock = r.lock(&s["lock"]);
    let folder = arr(&s["playerFolder"])
        .iter()
        .map(|f| {
            let f = obj(f);
            only("shadowing.playerFolder[]", f, &["file", "id"]);
            profile::PlayerFile {
                file: text(&f["file"]).to_string(),
                id: f["id"].as_str().map(str::to_string),
            }
        })
        .collect();
    let report = profile::report(
        "v1",
        &lock,
        Some(fit().abi.to_string()),
        None,
        &c,
        fit().platform,
        folder,
    );
    assert_eq!(report.unmanaged, strings(&s["unmanaged"]), "unmanaged");
    assert_eq!(
        serde_json::to_value(&report.shadowed).unwrap(),
        s["shadowed"],
        "shadowed"
    );
    assert_eq!(
        sorted(report.blocking.clone()),
        sorted(strings(&s["blocking"])),
        "blocking"
    );
    assert_eq!(
        serde_json::to_value(&report.blocking_reasons).unwrap(),
        s["blockingReasons"],
        "blockingReasons"
    );
}

#[test]
fn revocations() {
    use super::index::revocation;
    let r = Rules::load();
    let s = r.section("revocations");
    only(
        "revocations",
        s,
        &["rust", "entries", "kept", "dropped", "matches"],
    );
    let entries = arr(&s["entries"]);
    let kept: Vec<_> = entries.iter().cloned().filter_map(revocation).collect();
    assert_eq!(
        serde_json::to_value(&kept).unwrap(),
        s["kept"],
        "revocations kept"
    );
    let dropped = s["dropped"].as_u64().expect("dropped is a count") as usize;
    assert_eq!(entries.len() - kept.len(), dropped, "revocations dropped");
    let shas: Vec<&str> = kept.iter().map(|k| k.sha256.as_str()).collect();
    let c = profile::tests::catalog(vec![], &shas);
    for m in arr(&s["matches"]) {
        let m = arr(m);
        let (sha, want) = (text(&m[0]), m[1].as_bool().expect("a match is a bool"));
        assert_eq!(c.revocation(sha).is_some(), want, "revocation of {sha}");
    }
}

#[test]
fn icon_hosts() {
    let r = Rules::load();
    let s = r.section("iconHosts");
    only("iconHosts", s, &["rust", "cases"]);
    for case in arr(&s["cases"]) {
        let case = arr(case);
        let (url, want) = (text(&case[0]), case[1].as_bool().expect("a case is a bool"));
        assert_eq!(
            crate::download::icon_url_allowed(url),
            want,
            "icon from {url}"
        );
    }
}
