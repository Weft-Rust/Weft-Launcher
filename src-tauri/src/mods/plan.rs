//! The rules for changing a mod set, on plain data: what an install brings along, what a copy
//! brings over, and what turning a mod on or off or removing it does to the others. Nothing here
//! touches the disk or the network; `commands.rs` does that around these.

use serde::Serialize;
use ts_rs::TS;

use super::catalog::{Catalog, CatalogMod, CatalogVersion, Origin, Trust};
use super::error::ModsError;
use super::index::{Channel, RESERVED_ID};
use super::profile::{BUILTIN, Fit, Lock, LockEntry, ProfileReport, best_version, fitting};
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub id: String,
    pub name: String,
    pub version: String,
    pub sha256: String,
    pub trust: Trust,
    pub channel: Channel,
    pub size: u64,
}

impl PlanItem {
    fn of(m: &CatalogMod, v: &CatalogVersion) -> Self {
        PlanItem {
            id: m.id.clone(),
            name: m.name.clone(),
            version: v.version.clone(),
            sha256: v.sha256.clone(),
            trust: v.trust,
            channel: v.channel,
            size: v.size,
        }
    }
}

/// The installed mod an install would replace.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlanReplaces {
    pub version: Option<String>,
    pub sha256: String,
    pub trust: Trust,
    pub enabled: bool,
}

/// What `install_mod(tag, sha256)` would do, without doing it.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    pub target: PlanItem,
    pub replaces: Option<PlanReplaces>,
    /// Dependencies that will be downloaded.
    pub install: Vec<PlanItem>,
    /// Ids of installed dependencies that will be turned on.
    pub enable: Vec<String>,
    /// Dependency ids with no fitting, non-revoked build.
    pub missing: Vec<String>,
    /// Why the install would fail, if it would.
    pub problem: Option<AppError>,
}

/// What a change did, with the profile as it is now. All lists hold mod ids.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChangeResult {
    pub report: ProfileReport,
    /// Mods downloaded or replaced by this change, dependencies included.
    pub installed: Vec<String>,
    /// Installed mods turned on because something needs them.
    pub also_enabled: Vec<String>,
    /// Mods turned off because what they need went away.
    pub also_disabled: Vec<String>,
    /// Dependencies nothing in the catalogue provides for this version.
    pub missing: Vec<String>,
}

/// What a copy did; `left_behind` are the turned-on mods of the old version that weren't
/// brought over, and why.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult {
    #[serde(flatten)]
    pub change: ChangeResult,
    pub left_behind: Vec<CopyItem>,
}

/// Whether this build may be installed here at all.
pub fn check_installable(
    catalog: &Catalog,
    m: &CatalogMod,
    v: &CatalogVersion,
    fit: Fit<'_>,
) -> Result<(), ModsError> {
    if m.id == RESERVED_ID {
        return Err(ModsError::IdReserved(m.id.clone()));
    }
    if let Some(r) = catalog.revocation(&v.sha256) {
        return Err(ModsError::Revoked(format!("{}: {}", m.name, r.reason)));
    }
    if !fit.platform_ok(v) {
        return Err(ModsError::NotForPlatform(m.name.clone()));
    }
    if v.abi != fit.abi {
        return Err(ModsError::Incompatible(m.name.clone()));
    }
    Ok(())
}

/// The builds to download for a change, and what else it turns on.
#[derive(Debug, Clone)]
pub struct Resolution {
    /// The mods asked for, by id.
    pub wanted: Vec<String>,
    /// The wanted builds first, then the dependencies they pull in.
    pub picks: Vec<(CatalogMod, CatalogVersion)>,
    /// Installed dependencies that are off and would be turned on.
    pub enable: Vec<String>,
    pub missing: Vec<String>,
}

/// The requested builds plus whatever they need that isn't on yet. A dependency comes from the
/// index first, then from the same source as the mod that needs it. An installed dependency
/// that is revoked or built for another version doesn't count, and a revoked build is never
/// picked: with nothing else, the dependency is missing.
pub fn resolve(
    catalog: &Catalog,
    lock: &Lock,
    wanted: Vec<(CatalogMod, CatalogVersion)>,
    fit: Fit<'_>,
) -> Resolution {
    let mut res = Resolution {
        wanted: wanted.iter().map(|(m, _)| m.id.clone()).collect(),
        picks: Vec::new(),
        enable: Vec::new(),
        missing: Vec::new(),
    };
    let mut todo: std::collections::VecDeque<_> = wanted.into();
    while let Some((m, v)) = todo.pop_front() {
        if res.picks.iter().any(|(p, _)| p.id == m.id) {
            continue;
        }
        for dep in &v.deps {
            if BUILTIN.contains(&dep.as_str())
                || res.picks.iter().any(|(p, _)| &p.id == dep)
                || todo.iter().any(|(p, _)| &p.id == dep)
                || res.missing.contains(dep)
            {
                continue;
            }
            if let Some(have) = lock.get(dep)
                && have.abi.as_deref().is_none_or(|a| a == fit.abi)
                && catalog.revocation(&have.sha256).is_none()
            {
                if !have.enabled && !res.enable.contains(dep) {
                    res.enable.push(dep.clone());
                }
                continue;
            }
            let mut keys = vec![format!("index:{dep}")];
            if let Origin::Source { repo } = &m.origin {
                keys.push(format!("source:{repo}:{dep}"));
            }
            match keys
                .iter()
                .find_map(|k| best_version(catalog, k, fit, v.channel))
            {
                Some((dm, dv)) => todo.push_back((dm.clone(), dv.clone())),
                None => res.missing.push(dep.clone()),
            }
        }
        res.picks.push((m, v));
    }
    res
}

/// Whether the dependencies a change brings in end up on: they do when a wanted mod ends up on.
/// A wanted mod keeps its on/off state when it replaces an installed one; new ones are on.
fn deps_on(lock: &Lock, wanted: &[String]) -> bool {
    wanted
        .iter()
        .any(|id| lock.get(id).is_none_or(|e| e.enabled))
}

pub struct Committed {
    pub installed: Vec<String>,
    pub also_enabled: Vec<String>,
}

/// Writes a resolution into the lock. Replacing an installed mod keeps its on/off state; a mod
/// that is off stays off after an update, and so do the dependencies it brings.
pub fn commit(lock: &mut Lock, res: &Resolution) -> Committed {
    let on = deps_on(lock, &res.wanted);
    let mut installed = Vec::new();
    for (m, v) in &res.picks {
        let existing = lock.get(&m.id).map(|e| e.enabled);
        let enabled = if res.wanted.contains(&m.id) {
            existing.unwrap_or(true)
        } else {
            existing.unwrap_or(false) || on
        };
        lock.put(LockEntry::from_catalog(m, v, enabled));
        installed.push(m.id.clone());
    }
    let mut also_enabled = Vec::new();
    if on {
        for id in &res.enable {
            if let Some(e) = lock.get_mut(id)
                && !e.enabled
            {
                e.enabled = true;
                also_enabled.push(id.clone());
            }
        }
    }
    Committed {
        installed,
        also_enabled,
    }
}

/// The plan for installing the catalogue build `sha256` into game version `tag`. `fit` is `None`
/// when the version's mod interface is unknown; `running` when that version's game is running.
pub fn plan_install(
    catalog: &Catalog,
    lock: &Lock,
    tag: &str,
    sha256: &str,
    fit: Option<Fit<'_>>,
    running: bool,
) -> Result<InstallPlan, ModsError> {
    let (m, v) = catalog
        .find(sha256)
        .ok_or_else(|| ModsError::NotInCatalog(sha256.to_string()))?;
    let replaces = lock.get(&m.id).map(|e| PlanReplaces {
        version: e.version.clone(),
        sha256: e.sha256.clone(),
        trust: e.trust,
        enabled: e.enabled,
    });
    let mut plan = InstallPlan {
        target: PlanItem::of(m, v),
        replaces,
        install: Vec::new(),
        enable: Vec::new(),
        missing: Vec::new(),
        problem: None,
    };
    let Some(fit) = fit else {
        plan.problem = Some(ModsError::AbiUnavailable(tag.to_string()).into());
        return Ok(plan);
    };
    let res = resolve(catalog, lock, vec![(m.clone(), v.clone())], fit);
    let on = deps_on(lock, &res.wanted);
    plan.install = res
        .picks
        .iter()
        .filter(|(p, _)| p.id != m.id)
        .map(|(p, pv)| PlanItem::of(p, pv))
        .collect();
    plan.enable = if on { res.enable } else { Vec::new() };
    plan.missing = res.missing;
    plan.problem = check_installable(catalog, m, v, fit)
        .err()
        .or_else(|| running.then(|| ModsError::GameRunning(tag.to_string())))
        .map(AppError::from);
    Ok(plan)
}

/// Turns a mod on or off. On turns on the installed mods it needs, and refuses when it or any of
/// them is revoked; off turns off what needs it. Returns what else changed.
pub fn set_enabled(
    lock: &mut Lock,
    catalog: &Catalog,
    id: &str,
    enabled: bool,
) -> Result<(Vec<String>, Vec<String>), ModsError> {
    let entry = lock
        .get(id)
        .ok_or_else(|| ModsError::NotInstalled(id.to_string()))?;
    let revoked = |e: &LockEntry| {
        catalog
            .revocation(&e.sha256)
            .map(|r| ModsError::Revoked(format!("{}: {}", e.name, r.reason)))
    };
    let (mut also_enabled, mut also_disabled) = (Vec::new(), Vec::new());
    if enabled {
        if let Some(e) = revoked(entry) {
            return Err(e);
        }
        let deps = lock.deps_of(id);
        if let Some(e) = deps.iter().filter_map(|d| lock.get(d)).find_map(revoked) {
            return Err(e);
        }
        for dep in deps {
            if let Some(d) = lock.get_mut(&dep)
                && !d.enabled
            {
                d.enabled = true;
                also_enabled.push(dep);
            }
        }
    } else {
        for dependent in lock.dependents_of(id) {
            if let Some(d) = lock.get_mut(&dependent) {
                d.enabled = false;
                also_disabled.push(dependent);
            }
        }
    }
    if let Some(e) = lock.get_mut(id) {
        e.enabled = enabled;
    }
    Ok((also_enabled, also_disabled))
}

/// Removes a mod and turns off what needed it. Returns those.
pub fn remove(lock: &mut Lock, id: &str) -> Result<Vec<String>, ModsError> {
    if lock.get(id).is_none() {
        return Err(ModsError::NotInstalled(id.to_string()));
    }
    let also_disabled = lock.dependents_of(id);
    for dependent in &also_disabled {
        if let Some(d) = lock.get_mut(dependent) {
            d.enabled = false;
        }
    }
    lock.mods.retain(|m| m.id != id);
    Ok(also_disabled)
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub enum CopyOutcome {
    /// A build for the new version will be installed.
    Install,
    /// The new version already has this mod; it is left as it is.
    AlreadyThere,
    /// No build for the new version yet.
    NoBuild,
    /// A file from the player's computer: the launcher can't find a build of it.
    LocalFile,
    /// The only fitting builds are revoked.
    Revoked,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CopyItem {
    pub id: String,
    pub name: String,
    pub outcome: CopyOutcome,
    /// The build that will be installed (outcome `install`).
    pub version: Option<String>,
    pub trust: Option<Trust>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CopyPreview {
    pub from: String,
    pub to: String,
    pub items: Vec<CopyItem>,
}

/// What copying the turned-on mods of `from` into `to` would bring over, each as the build made
/// for `to`, and the builds to install. Mods `to` already has are skipped.
pub fn copy_preview(
    catalog: &Catalog,
    from: (&str, &Lock),
    to: (&str, &Lock),
    fit: Fit<'_>,
) -> (CopyPreview, Vec<(CatalogMod, CatalogVersion)>) {
    let mut items = Vec::new();
    let mut picks = Vec::new();
    for entry in from.1.mods.iter().filter(|m| m.enabled) {
        let item = |outcome, pick: Option<&CatalogVersion>| CopyItem {
            id: entry.id.clone(),
            name: entry.name.clone(),
            outcome,
            version: pick.map(|v| v.version.clone()),
            trust: pick.map(|v| v.trust),
        };
        if to.1.get(&entry.id).is_some() {
            items.push(item(CopyOutcome::AlreadyThere, None));
            continue;
        }
        let Some(key) = entry.catalog_key() else {
            items.push(item(CopyOutcome::LocalFile, None));
            continue;
        };
        let channel = entry.channel.unwrap_or(Channel::Release);
        if let Some((m, v)) = best_version(catalog, &key, fit, channel) {
            items.push(item(CopyOutcome::Install, Some(v)));
            picks.push((m.clone(), v.clone()));
        } else if fitting(catalog, &key, fit, channel).is_some_and(|(_, vs)| !vs.is_empty()) {
            items.push(item(CopyOutcome::Revoked, None));
        } else {
            items.push(item(CopyOutcome::NoBuild, None));
        }
    }
    let preview = CopyPreview {
        from: from.0.to_string(),
        to: to.0.to_string(),
        items,
    };
    (preview, picks)
}

#[cfg(test)]
mod tests {
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
    }
}
