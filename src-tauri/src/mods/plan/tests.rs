use super::super::profile::tests::{
    ABI, OLD_ABI, build, catalog, catalog_mod, entry, fit, lock, sha,
};
use super::*;
use crate::error::ErrorCode;

const REL: Channel = Channel::Release;
const PRE: Channel = Channel::Prerelease;

fn source() -> Origin {
    Origin::Source {
        repo: "Someone/Lanterns".into(),
    }
}

/// cogwork needs showcase; lanterns (a source) needs glow, which only its source has;
/// shiny needs rcdep, which only has a prerelease; bad needs pulled, which is revoked.
fn world() -> Catalog {
    catalog(
        vec![
            catalog_mod(
                "cogwork",
                Origin::Index,
                vec![
                    build("cogwork", "0.2.0", ABI, REL, &["base", "showcase"]),
                    build("cogwork", "0.1.0", OLD_ABI, REL, &["showcase"]),
                ],
            ),
            catalog_mod(
                "showcase",
                Origin::Index,
                vec![build("showcase", "0.1.0", ABI, REL, &[])],
            ),
            catalog_mod(
                "lanterns",
                source(),
                vec![build("lanterns", "1.0.0", ABI, REL, &["glow"])],
            ),
            catalog_mod(
                "glow",
                source(),
                vec![build("glow", "1.0.0", ABI, REL, &[])],
            ),
            catalog_mod(
                "shiny",
                Origin::Index,
                vec![
                    build("shiny", "1.0.0", ABI, REL, &["rcdep"]),
                    build("shiny", "1.1.0-rc.1", ABI, PRE, &["rcdep"]),
                ],
            ),
            catalog_mod(
                "rcdep",
                Origin::Index,
                vec![build("rcdep", "0.1.0-rc.1", ABI, PRE, &[])],
            ),
            catalog_mod(
                "bad",
                Origin::Index,
                vec![build("bad", "1.0.0", ABI, REL, &["pulled"])],
            ),
            catalog_mod(
                "pulled",
                Origin::Index,
                vec![build("pulled", "1.0.0", ABI, REL, &[])],
            ),
            catalog_mod(
                "base",
                Origin::Index,
                vec![build("base", "1.0.0", ABI, REL, &[])],
            ),
        ],
        &[&sha("pulled", "1.0.0")],
    )
}

fn ids(items: &[PlanItem]) -> Vec<&str> {
    items.iter().map(|i| i.id.as_str()).collect()
}

#[test]
fn plans() {
    let c = world();
    let installed_off = |id: &str| {
        let mut e = entry(id, &[], Some(ABI));
        e.enabled = false;
        e
    };
    let mut pulled_installed = entry("pulled", &[], Some(ABI));
    pulled_installed.sha256 = sha("pulled", "1.0.0");
    struct Case {
        what: &'static str,
        sha: String,
        lock: Lock,
        install: &'static [&'static str],
        enable: &'static [&'static str],
        missing: &'static [&'static str],
        problem: Option<ErrorCode>,
    }
    let cases = [
        Case {
            what: "dependency from the index is installed",
            sha: sha("cogwork", "0.2.0"),
            lock: lock(vec![]),
            install: &["showcase"],
            enable: &[],
            missing: &[],
            problem: None,
        },
        Case {
            what: "installed dependency that is off is turned on",
            sha: sha("cogwork", "0.2.0"),
            lock: lock(vec![installed_off("showcase")]),
            install: &[],
            enable: &["showcase"],
            missing: &[],
            problem: None,
        },
        Case {
            what: "dependency from the same source",
            sha: sha("lanterns", "1.0.0"),
            lock: lock(vec![]),
            install: &["glow"],
            enable: &[],
            missing: &[],
            problem: None,
        },
        Case {
            what: "a release never pulls in a prerelease dependency",
            sha: sha("shiny", "1.0.0"),
            lock: lock(vec![]),
            install: &[],
            enable: &[],
            missing: &["rcdep"],
            problem: None,
        },
        Case {
            what: "a prerelease may",
            sha: sha("shiny", "1.1.0-rc.1"),
            lock: lock(vec![]),
            install: &["rcdep"],
            enable: &[],
            missing: &[],
            problem: None,
        },
        Case {
            what: "a revoked dependency is missing, not installed",
            sha: sha("bad", "1.0.0"),
            lock: lock(vec![]),
            install: &[],
            enable: &[],
            missing: &["pulled"],
            problem: None,
        },
        Case {
            what: "an installed revoked dependency doesn't count",
            sha: sha("bad", "1.0.0"),
            lock: lock(vec![pulled_installed]),
            install: &[],
            enable: &[],
            missing: &["pulled"],
            problem: None,
        },
        Case {
            what: "a build for another version (its dependencies are still listed)",
            sha: sha("cogwork", "0.1.0"),
            lock: lock(vec![]),
            install: &["showcase"],
            enable: &[],
            missing: &[],
            problem: Some(ErrorCode::ModIncompatible),
        },
        Case {
            what: "a revoked build",
            sha: sha("pulled", "1.0.0"),
            lock: lock(vec![]),
            install: &[],
            enable: &[],
            missing: &[],
            problem: Some(ErrorCode::ModRevoked),
        },
        Case {
            what: "the reserved id",
            sha: sha("base", "1.0.0"),
            lock: lock(vec![]),
            install: &[],
            enable: &[],
            missing: &[],
            problem: Some(ErrorCode::ModIdReserved),
        },
    ];
    for case in cases {
        let plan = plan_install(&c, &case.lock, "v1", &case.sha, Some(fit()), false).unwrap();
        assert_eq!(ids(&plan.install), case.install, "{}", case.what);
        assert_eq!(plan.enable, case.enable, "{}", case.what);
        assert_eq!(plan.missing, case.missing, "{}", case.what);
        assert_eq!(plan.problem.map(|p| p.code), case.problem, "{}", case.what);
    }
}

#[test]
fn plan_problems_and_replacement() {
    let c = world();
    let target = sha("cogwork", "0.2.0");
    let plan = plan_install(&c, &lock(vec![]), "v1", &target, None, false).unwrap();
    assert_eq!(plan.problem.unwrap().code, ErrorCode::AbiUnavailable);

    let plan = plan_install(&c, &lock(vec![]), "v1", &target, Some(fit()), true).unwrap();
    assert_eq!(plan.problem.unwrap().code, ErrorCode::GameRunning);

    let mut old = entry("cogwork", &["showcase"], Some(OLD_ABI));
    old.enabled = false;
    old.trust = Trust::Unreviewed;
    let plan = plan_install(&c, &lock(vec![old]), "v1", &target, Some(fit()), false).unwrap();
    let replaces = plan.replaces.unwrap();
    assert!(!replaces.enabled);
    assert_eq!(replaces.trust, Trust::Unreviewed);
    assert_eq!(ids(&plan.install), ["showcase"]);
    assert!(
        plan.enable.is_empty(),
        "nothing turns on for a mod that stays off"
    );

    assert!(matches!(
        plan_install(&c, &lock(vec![]), "v1", &"0".repeat(64), Some(fit()), false),
        Err(ModsError::NotInCatalog(_))
    ));
}

#[test]
fn an_update_keeps_the_on_off_state() {
    let c = world();
    let pick = |id: &str, v: &str| {
        let (m, v) = c.find(&sha(id, v)).unwrap();
        (m.clone(), v.clone())
    };
    let mut off = entry("cogwork", &["showcase"], Some(OLD_ABI));
    off.enabled = false;
    let mut l = lock(vec![off]);
    let res = resolve(&c, &l, vec![pick("cogwork", "0.2.0")], fit());
    let done = commit(&mut l, &res);
    assert_eq!(done.installed, ["cogwork", "showcase"]);
    assert!(!l.get("cogwork").unwrap().enabled, "off stays off");
    assert!(
        !l.get("showcase").unwrap().enabled,
        "its new dependency too"
    );
    assert_eq!(l.get("cogwork").unwrap().version.as_deref(), Some("0.2.0"));

    let mut l = lock(vec![entry("cogwork", &["showcase"], Some(OLD_ABI))]);
    let res = resolve(&c, &l, vec![pick("cogwork", "0.2.0")], fit());
    commit(&mut l, &res);
    assert!(l.get("cogwork").unwrap().enabled, "on stays on");
    assert!(l.get("showcase").unwrap().enabled);

    let mut showcase_off = entry("showcase", &[], Some(ABI));
    showcase_off.enabled = false;
    let mut l = lock(vec![showcase_off]);
    let res = resolve(&c, &l, vec![pick("cogwork", "0.2.0")], fit());
    let done = commit(&mut l, &res);
    assert!(l.get("cogwork").unwrap().enabled, "a new install is on");
    assert_eq!(done.also_enabled, ["showcase"]);
}

#[test]
fn the_enable_cascade() {
    let c = catalog(vec![], &[&sha("b", "0.1.0")]);
    let off = |id: &str, deps: &[&str]| {
        let mut e = entry(id, deps, Some(ABI));
        e.enabled = false;
        e
    };
    // a needs c needs d: turning a on turns both on.
    let mut l = lock(vec![off("a", &["c"]), off("c", &["d"]), off("d", &[])]);
    let (on, off_) = set_enabled(&mut l, &c, "a", true).unwrap();
    let mut on = on;
    on.sort();
    assert_eq!(on, ["c", "d"]);
    assert!(off_.is_empty());

    // Turning d off turns off everything that needs it.
    let (_, mut gone) = set_enabled(&mut l, &c, "d", false).unwrap();
    gone.sort();
    assert_eq!(gone, ["a", "c"]);

    // e needs the revoked b: refused, and nothing changes.
    let mut l = lock(vec![off("e", &["b"]), off("b", &[])]);
    let err = set_enabled(&mut l, &c, "e", true).unwrap_err();
    assert!(matches!(err, ModsError::Revoked(ref d) if d.starts_with("b name")));
    assert!(!l.get("e").unwrap().enabled && !l.get("b").unwrap().enabled);
    assert!(matches!(
        set_enabled(&mut l, &c, "b", true),
        Err(ModsError::Revoked(_))
    ));
    assert!(matches!(
        set_enabled(&mut l, &c, "zzz", true),
        Err(ModsError::NotInstalled(_))
    ));
}

#[test]
fn removing_turns_off_what_needed_it() {
    let mut l = lock(vec![
        entry("a", &["b"], Some(ABI)),
        entry("b", &[], Some(ABI)),
    ]);
    assert_eq!(remove(&mut l, "b").unwrap(), ["a"]);
    assert!(l.get("b").is_none());
    assert!(!l.get("a").unwrap().enabled);
    assert!(remove(&mut l, "b").is_err());
}

#[test]
fn copy_preview_outcomes() {
    let c = world();
    let mut local = entry("mytweak", &[], None);
    local.origin = Origin::File {
        name: "t.zip".into(),
    };
    let mut lanterns = entry("lanterns", &["glow"], Some(OLD_ABI));
    lanterns.origin = Origin::Source {
        repo: "someone/lanterns".into(),
    };
    let mut off = entry("shiny", &[], Some(OLD_ABI));
    off.enabled = false;
    let from = lock(vec![
        entry("cogwork", &["showcase"], Some(OLD_ABI)),
        entry("showcase", &[], Some(OLD_ABI)),
        entry("nobuild", &[], Some(OLD_ABI)),
        local,
        entry("pulled", &[], Some(OLD_ABI)),
        lanterns,
        off,
    ]);
    let to = lock(vec![entry("showcase", &[], Some(ABI))]);
    let (preview, picks) = copy_preview(&c, ("v1", &from), ("v2", &to), fit());
    let outcome = |id: &str| {
        preview
            .items
            .iter()
            .find(|i| i.id == id)
            .map(|i| (i.outcome, i.version.clone()))
    };
    assert_eq!(
        outcome("cogwork"),
        Some((CopyOutcome::Install, Some("0.2.0".into())))
    );
    assert_eq!(outcome("showcase"), Some((CopyOutcome::AlreadyThere, None)));
    assert_eq!(outcome("nobuild"), Some((CopyOutcome::NoBuild, None)));
    assert_eq!(outcome("mytweak"), Some((CopyOutcome::LocalFile, None)));
    assert_eq!(outcome("pulled"), Some((CopyOutcome::Revoked, None)));
    assert_eq!(
        outcome("lanterns"),
        Some((CopyOutcome::Install, Some("1.0.0".into())))
    );
    assert_eq!(outcome("shiny"), None, "only turned-on mods are copied");
    let picked: Vec<&str> = picks.iter().map(|(m, _)| m.id.as_str()).collect();
    assert_eq!(picked, ["cogwork", "lanterns"]);
    assert_eq!(preview.items[0].trust, Some(Trust::Reviewed));
    // What the items pull in: glow from the lanterns source; showcase is already there.
    assert_eq!(ids(&preview.deps), ["glow"]);
    assert!(preview.enable.is_empty() && preview.installed_off.is_empty());
}

#[test]
fn a_copy_lists_what_it_turns_on_and_what_stays_off() {
    let c = world();
    let from = lock(vec![
        entry("cogwork", &["showcase"], Some(OLD_ABI)),
        entry("shiny", &["rcdep"], Some(OLD_ABI)),
    ]);
    let mut showcase_off = entry("showcase", &[], Some(ABI));
    showcase_off.enabled = false;
    let to = lock(vec![showcase_off]);
    let (preview, picks) = copy_preview(&c, ("v1", &from), ("v2", &to), fit());
    assert_eq!(preview.enable, ["showcase"]);
    assert_eq!(
        preview.installed_off,
        ["shiny"],
        "rcdep has only a prerelease"
    );

    let mut l = to.clone();
    let done = commit(&mut l, &resolve(&c, &to, picks, fit()));
    assert!(l.get("cogwork").unwrap().enabled && l.get("showcase").unwrap().enabled);
    assert!(!l.get("shiny").unwrap().enabled);
    assert_eq!(done.installed_off, ["shiny"]);
    assert_eq!(done.also_enabled, ["showcase"]);
}

/// `turnsOn = (replaces === null || replaces.enabled) && missing.length === 0`, and the
/// commit does what the plan said.
#[test]
fn turns_on_rules() {
    let c = world();
    let off = |id: &str, deps: &[&str]| {
        let mut e = entry(id, deps, Some(OLD_ABI));
        e.enabled = false;
        e
    };
    let mut showcase_off = entry("showcase", &[], Some(ABI));
    showcase_off.enabled = false;
    // What, lock, build, turns on, installed off, also enabled.
    type Case<'a> = (&'a str, Lock, String, bool, &'a [&'a str], &'a [&'a str]);
    let cases: Vec<Case> = vec![
        (
            "new, nothing missing",
            lock(vec![]),
            sha("cogwork", "0.2.0"),
            true,
            &[],
            &[],
        ),
        (
            "new, a dependency is missing",
            lock(vec![]),
            sha("shiny", "1.0.0"),
            false,
            &["shiny"],
            &[],
        ),
        (
            "an update of a mod that is on, a dependency missing",
            lock(vec![entry("shiny", &["rcdep"], Some(OLD_ABI))]),
            sha("shiny", "1.0.0"),
            false,
            &["shiny"],
            &[],
        ),
        (
            "an update of a mod that is off",
            lock(vec![off("cogwork", &["showcase"])]),
            sha("cogwork", "0.2.0"),
            false,
            &[],
            &[],
        ),
        (
            "a dependency that is off is turned on",
            lock(vec![showcase_off.clone()]),
            sha("cogwork", "0.2.0"),
            true,
            &[],
            &["showcase"],
        ),
        (
            "but not for a mod installed turned off",
            lock(vec![showcase_off, entry("rcdep", &[], Some(OLD_ABI))]),
            sha("bad", "1.0.0"),
            false,
            &["bad"],
            &[],
        ),
    ];
    for (what, l, build, turns_on, off_ids, enabled) in cases {
        let plan = plan_install(&c, &l, "v1", &build, Some(fit()), false).unwrap();
        assert_eq!(plan.turns_on, turns_on, "{what}: plan");
        assert_eq!(plan.enable, enabled, "{what}: plan enables");
        let rule = plan.replaces.as_ref().is_none_or(|r| r.enabled) && plan.missing.is_empty();
        assert_eq!(plan.turns_on, rule, "{what}: the contract's rule");

        let (m, v) = c.find(&build).unwrap();
        let mut after = l.clone();
        let res = resolve(&c, &l, vec![(m.clone(), v.clone())], fit());
        let done = commit(&mut after, &res);
        let target = after.get(&m.id).unwrap();
        assert_eq!(target.enabled, turns_on, "{what}: committed");
        assert_eq!(done.installed_off, off_ids, "{what}: installed off");
        assert_eq!(done.also_enabled, enabled, "{what}: also enabled");
        for dep in res.picks.iter().filter(|(p, _)| p.id != m.id) {
            assert_eq!(
                after.get(&dep.0.id).unwrap().enabled,
                turns_on,
                "{what}: {} comes along on or off with it",
                dep.0.id
            );
        }
    }
}

#[test]
fn a_plan_holds_until_the_profile_changes_under_it() {
    let c = world();
    let pick = |id: &str, v: &str| {
        let (m, v) = c.find(&sha(id, v)).unwrap();
        (m.clone(), v.clone())
    };
    let before = lock(vec![]);
    let res = resolve(&c, &before, vec![pick("cogwork", "0.2.0")], fit());
    assert!(still_holds((&before, &res), (&before, &res)).is_ok());

    // Showcase got installed meanwhile: less to do, still fine.
    let with_showcase = lock(vec![entry("showcase", &[], Some(ABI))]);
    let now = resolve(&c, &with_showcase, vec![pick("cogwork", "0.2.0")], fit());
    assert!(still_holds((&before, &res), (&with_showcase, &now)).is_ok());

    // Planned with showcase installed, which was removed meanwhile: it needs downloading.
    let res = resolve(&c, &with_showcase, vec![pick("cogwork", "0.2.0")], fit());
    let now = resolve(&c, &before, vec![pick("cogwork", "0.2.0")], fit());
    let why = still_holds((&with_showcase, &res), (&before, &now)).unwrap_err();
    assert!(why.contains("showcase"), "{why}");

    // Showcase was turned off meanwhile: committing would turn it on unasked.
    let mut showcase_off = with_showcase.clone();
    showcase_off.get_mut("showcase").unwrap().enabled = false;
    let now = resolve(&c, &showcase_off, vec![pick("cogwork", "0.2.0")], fit());
    assert!(still_holds((&with_showcase, &res), (&showcase_off, &now)).is_err());

    // The mod being updated was turned off meanwhile: it would end up off.
    let on = lock(vec![
        entry("cogwork", &["showcase"], Some(OLD_ABI)),
        entry("showcase", &[], Some(ABI)),
    ]);
    let mut off = on.clone();
    off.get_mut("cogwork").unwrap().enabled = false;
    let res = resolve(&c, &on, vec![pick("cogwork", "0.2.0")], fit());
    let now = resolve(&c, &off, vec![pick("cogwork", "0.2.0")], fit());
    let why = still_holds((&on, &res), (&off, &now)).unwrap_err();
    assert!(why.contains("off"), "{why}");
}

#[test]
fn a_recorded_revocation_is_honoured_without_the_catalogue() {
    let c = catalog(vec![], &[]);
    let mut pulled = entry("pulled", &[], Some(ABI));
    pulled.enabled = false;
    pulled.revoked = Some(super::super::profile::Revocation {
        reason: Some("deletes saves".into()),
        at: Some("2026-11-05T00:00:00Z".into()),
    });
    let mut needs = entry("needs", &["pulled"], Some(ABI));
    needs.enabled = false;
    let mut l = lock(vec![pulled, needs]);
    let err = set_enabled(&mut l, &c, "pulled", true).unwrap_err();
    assert!(matches!(err, ModsError::Revoked(ref d) if d.contains("deletes saves")));
    assert!(set_enabled(&mut l, &c, "needs", true).is_err());
    assert!(!l.get("pulled").unwrap().enabled && !l.get("needs").unwrap().enabled);
}

/// Contract R4 §1: a needs b, which is installed and needs c. The graph goes through b.
#[test]
fn dependencies_resolve_through_installed_mods() {
    let a = build("a", "1.0.0", ABI, REL, &["b"]);
    let c_build = build("c", "1.0.0", ABI, REL, &[]);
    let catalog_with = |c: bool, revoked: &[&str]| {
        let mut mods = vec![catalog_mod("a", Origin::Index, vec![a.clone()])];
        if c {
            mods.push(catalog_mod("c", Origin::Index, vec![c_build.clone()]));
        }
        catalog(mods, revoked)
    };
    let off = |mut e: LockEntry| {
        e.enabled = false;
        e
    };
    let b = |enabled: bool| {
        let e = entry("b", &["c"], Some(ABI));
        if enabled { e } else { off(e) }
    };
    struct Case {
        what: &'static str,
        catalog: Catalog,
        lock: Lock,
        install: &'static [&'static str],
        enable: &'static [&'static str],
        missing: &'static [&'static str],
        turns_on: bool,
    }
    let cases = [
        Case {
            what: "c installed and off: both turn on",
            catalog: catalog_with(false, &[]),
            lock: lock(vec![b(false), off(entry("c", &[], Some(ABI)))]),
            install: &[],
            enable: &["b", "c"],
            missing: &[],
            turns_on: true,
        },
        Case {
            what: "b already on, c off: c turns on too",
            catalog: catalog_with(false, &[]),
            lock: lock(vec![b(true), off(entry("c", &[], Some(ABI)))]),
            install: &[],
            enable: &["c"],
            missing: &[],
            turns_on: true,
        },
        Case {
            what: "c not installed but in the catalogue: downloaded",
            catalog: catalog_with(true, &[]),
            lock: lock(vec![b(false)]),
            install: &["c"],
            enable: &["b"],
            missing: &[],
            turns_on: true,
        },
        Case {
            what: "c missing: a goes in off, b stays off",
            catalog: catalog_with(false, &[]),
            lock: lock(vec![b(false)]),
            install: &[],
            enable: &[],
            missing: &["c"],
            turns_on: false,
        },
        Case {
            what: "c installed for another version, no build here",
            catalog: catalog_with(false, &[]),
            lock: lock(vec![b(false), off(entry("c", &[], Some(OLD_ABI)))]),
            install: &[],
            enable: &[],
            missing: &["c"],
            turns_on: false,
        },
        Case {
            what: "c installed but revoked",
            catalog: catalog_with(true, &[&sha("c", "0.1.0"), &sha("c", "1.0.0")]),
            lock: lock(vec![b(false), off(entry("c", &[], Some(ABI)))]),
            install: &[],
            enable: &[],
            missing: &["c"],
            turns_on: false,
        },
    ];
    for case in cases {
        let target = sha("a", "1.0.0");
        let plan =
            plan_install(&case.catalog, &case.lock, "v1", &target, Some(fit()), false).unwrap();
        let mut enable = plan.enable.clone();
        enable.sort();
        assert_eq!(ids(&plan.install), case.install, "{}", case.what);
        assert_eq!(enable, case.enable, "{}", case.what);
        assert_eq!(plan.missing, case.missing, "{}", case.what);
        assert_eq!(plan.turns_on, case.turns_on, "{}", case.what);

        // The commit does what the plan says, and leaves nothing on that can't load.
        let (m, v) = case.catalog.find(&target).unwrap();
        let mut after = case.lock.clone();
        let res = resolve(
            &case.catalog,
            &case.lock,
            vec![(m.clone(), v.clone())],
            fit(),
        );
        commit(&mut after, &res);
        assert_eq!(
            after.get("a").unwrap().enabled,
            case.turns_on,
            "{}",
            case.what
        );
        let r = super::super::profile::report(
            "v1",
            &after,
            Some(ABI.into()),
            None,
            &case.catalog,
            fit().platform,
            vec![],
        );
        assert!(r.blocking.is_empty(), "{}: {:?}", case.what, r.blocking);
    }
}

/// The token changes with anything the player agreed to, and only with that.
#[test]
fn plan_tokens() {
    let c = world();
    let target = sha("cogwork", "0.2.0");
    let token = |l: &Lock, abi: &str| {
        plan_install(&c, l, "v1", &target, Some(Fit { abi, ..fit() }), false)
            .unwrap()
            .plan_token
    };
    let empty = lock(vec![]);
    assert_eq!(token(&empty, ABI), token(&empty, ABI), "stable");
    assert_eq!(
        plan_install(&c, &empty, "v1", &target, Some(fit()), true)
            .unwrap()
            .plan_token,
        token(&empty, ABI),
        "a running game is a problem, not a change of plan"
    );
    assert_ne!(token(&empty, ABI), token(&empty, OLD_ABI), "the ABI");
    let mut showcase_off = entry("showcase", &[], Some(ABI));
    showcase_off.enabled = false;
    let with_off = lock(vec![showcase_off]);
    assert_ne!(token(&empty, ABI), token(&with_off, ABI), "what turns on");
    assert_ne!(
        token(&with_off, ABI),
        token(&lock(vec![entry("showcase", &[], Some(ABI))]), ABI),
        "nothing turns on any more"
    );
}
