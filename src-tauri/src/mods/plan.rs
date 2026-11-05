//! The rules for changing a mod set, on plain data: what an install brings along, what a copy
//! brings over, and what turning a mod on or off or removing it does to the others. Nothing here
//! touches the disk or the network; `service.rs` does that around these.
//!
//! Dependencies resolve through the whole graph: through the builds an install picks and
//! through installed mods alike. A wanted mod that needs something no build provides, at any
//! depth, is installed turned off, so an install never stops Play from working.
//!
//! What the player reviews is bound by a [`Consent`] token: the backend recomputes it before
//! downloading and again at commit, and refuses (`ModChangedMeanwhile`) when it differs.

use serde::Serialize;
use std::collections::BTreeSet;
use ts_rs::TS;

use super::catalog::{Catalog, CatalogMod, CatalogVersion, Origin, Trust};
use super::error::ModsError;
use super::index::{Channel, RESERVED_ID};
use super::profile::{BUILTIN, Fit, Lock, LockEntry, ProfileReport, best_version, fitting};
use crate::download::sha256_hex;
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
    /// Whether the target is on after this install: it is new or on now, and nothing it needs,
    /// at any depth, is missing. With something missing it is installed turned off. False when
    /// the version's mod interface is unknown: then nothing can be resolved.
    pub turns_on: bool,
    /// Whether the target is built for the version's mod interface; `None` when that is unknown.
    pub fits_version: Option<bool>,
    /// Why the install would fail, if it would.
    pub problem: Option<AppError>,
    /// Pass to `install_mod`: the digest of what this plan asks the player to agree to.
    pub plan_token: String,
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
    /// Mods this change installed turned off, because something they need is missing.
    pub installed_off: Vec<String>,
    /// The id of the mod this change removed, while `restore_mod` can still bring it back.
    pub undo: Option<String>,
}

impl ChangeResult {
    /// A change that did nothing beyond what the report shows.
    pub fn of(report: ProfileReport) -> Self {
        ChangeResult {
            report,
            installed: Vec::new(),
            also_enabled: Vec::new(),
            also_disabled: Vec::new(),
            missing: Vec::new(),
            installed_off: Vec::new(),
            undo: None,
        }
    }
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
    /// Installed mods the graph goes through, on or off, with what they need.
    pub installed: Vec<(String, Vec<String>)>,
    /// Installed dependencies that are off and would be turned on.
    pub enable: Vec<String>,
    pub missing: Vec<String>,
}

/// A mod the resolution walks through: a build it picks, or an installed mod.
enum Node {
    Pick(Box<(CatalogMod, CatalogVersion)>),
    Have(String),
}

/// The requested builds plus whatever they need that isn't on yet, through the whole graph. A
/// dependency that is installed, fits and isn't revoked is used (and turned on if off), and what
/// it needs is resolved in turn. Otherwise it comes from the index first, then from the same
/// source as the mod that needs it, and a revoked build is never picked: with nothing else, the
/// dependency is missing.
pub fn resolve(
    catalog: &Catalog,
    lock: &Lock,
    wanted: Vec<(CatalogMod, CatalogVersion)>,
    fit: Fit<'_>,
) -> Resolution {
    let mut res = Resolution {
        wanted: wanted.iter().map(|(m, _)| m.id.clone()).collect(),
        picks: Vec::new(),
        installed: Vec::new(),
        enable: Vec::new(),
        missing: Vec::new(),
    };
    let node_id = |n: &Node| match n {
        Node::Pick(p) => p.0.id.clone(),
        Node::Have(id) => id.clone(),
    };
    let mut todo: std::collections::VecDeque<Node> = wanted
        .into_iter()
        .map(|p| Node::Pick(Box::new(p)))
        .collect();
    while let Some(node) = todo.pop_front() {
        let id = node_id(&node);
        if res.picks.iter().any(|(p, _)| p.id == id) || res.installed.iter().any(|(i, _)| *i == id)
        {
            continue;
        }
        let (deps, origin, channel) = match &node {
            Node::Pick(p) => (p.1.deps.clone(), p.0.origin.clone(), p.1.channel),
            Node::Have(id) => {
                let e = lock.get(id).expect("an installed node is in the lock");
                (
                    e.deps.clone(),
                    e.origin.clone(),
                    e.channel.unwrap_or(Channel::Release),
                )
            }
        };
        for dep in &deps {
            if BUILTIN.contains(&dep.as_str())
                || res.picks.iter().any(|(p, _)| &p.id == dep)
                || res.installed.iter().any(|(i, _)| i == dep)
                || todo.iter().any(|n| &node_id(n) == dep)
                || res.missing.contains(dep)
            {
                continue;
            }
            if let Some(have) = lock.get(dep)
                && have.abi.as_deref().is_none_or(|a| a == fit.abi)
                && have.revoked_reason(catalog).is_none()
            {
                if !have.enabled && !res.enable.contains(dep) {
                    res.enable.push(dep.clone());
                }
                todo.push_back(Node::Have(dep.clone()));
                continue;
            }
            let mut keys = vec![format!("index:{dep}")];
            if let Origin::Source { repo } = &origin {
                keys.push(format!("source:{repo}:{dep}"));
            }
            match keys
                .iter()
                .find_map(|k| best_version(catalog, k, fit, channel))
            {
                Some((dm, dv)) => todo.push_back(Node::Pick(Box::new((dm.clone(), dv.clone())))),
                None => res.missing.push(dep.clone()),
            }
        }
        match node {
            Node::Pick(p) => res.picks.push(*p),
            Node::Have(id) => res.installed.push((id, deps)),
        }
    }
    res
}

impl Resolution {
    /// What `id` needs: its picked build's dependencies, else the installed mod's.
    fn deps_of(&self, id: &str) -> &[String] {
        self.picks
            .iter()
            .find(|(m, _)| m.id == id)
            .map(|(_, v)| v.deps.as_slice())
            .or_else(|| {
                self.installed
                    .iter()
                    .find(|(i, _)| i == id)
                    .map(|(_, d)| d.as_slice())
            })
            .unwrap_or(&[])
    }

    /// Whether the graph goes through `id`, as a pick or an installed mod.
    fn has_node(&self, id: &str) -> bool {
        self.picks.iter().any(|(m, _)| m.id == id) || self.installed.iter().any(|(i, _)| i == id)
    }

    /// Whether `id`, through the whole graph, needs something missing.
    fn needs_missing(&self, id: &str) -> bool {
        let mut seen = BTreeSet::new();
        let mut todo = vec![id.to_string()];
        while let Some(next) = todo.pop() {
            if !seen.insert(next.clone()) {
                continue;
            }
            for dep in self.deps_of(&next) {
                if self.missing.contains(dep) {
                    return true;
                }
                todo.push(dep.clone());
            }
        }
        false
    }
}

/// What committing a resolution to a lock does to on and off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    /// Picked and installed mods that end up on because a wanted mod that ends up on needs them,
    /// and those wanted mods.
    pub on: BTreeSet<String>,
    /// Installed mods that are off and are turned on.
    pub enable: Vec<String>,
    /// Wanted mods that are installed turned off, because something they need is missing.
    pub installed_off: Vec<String>,
}

/// A wanted mod ends up on when it is new or on now, and needs nothing missing; what it needs
/// ends up on with it. A wanted mod that is off stays off after an update, and so does what it
/// brings along.
pub fn outcome(lock: &Lock, res: &Resolution) -> Outcome {
    let mut installed_off = Vec::new();
    let mut todo = Vec::new();
    for id in &res.wanted {
        if res.needs_missing(id) {
            installed_off.push(id.clone());
        } else if lock.get(id).is_none_or(|e| e.enabled) {
            todo.push(id.clone());
        }
    }
    let mut on = BTreeSet::new();
    while let Some(id) = todo.pop() {
        if !on.insert(id.clone()) {
            continue;
        }
        for dep in res.deps_of(&id) {
            if res.has_node(dep) {
                todo.push(dep.clone());
            }
        }
    }
    let enable = res
        .enable
        .iter()
        .filter(|id| on.contains(*id))
        .cloned()
        .collect();
    Outcome {
        on,
        enable,
        installed_off,
    }
}

pub struct Committed {
    pub installed: Vec<String>,
    pub also_enabled: Vec<String>,
    pub installed_off: Vec<String>,
}

/// Writes a resolution into the lock, following [`outcome`].
pub fn commit(lock: &mut Lock, res: &Resolution) -> Committed {
    let out = outcome(lock, res);
    let mut installed = Vec::new();
    for (m, v) in &res.picks {
        let was_on = lock.get(&m.id).is_some_and(|e| e.enabled);
        let wanted = res.wanted.contains(&m.id);
        let enabled = out.on.contains(&m.id) || (!wanted && was_on);
        lock.put(LockEntry::from_catalog(m, v, enabled));
        installed.push(m.id.clone());
    }
    let mut also_enabled = Vec::new();
    for id in &out.enable {
        if let Some(e) = lock.get_mut(id)
            && !e.enabled
        {
            e.enabled = true;
            also_enabled.push(id.clone());
        }
    }
    Committed {
        installed,
        also_enabled,
        installed_off: out.installed_off,
    }
}

/// What the player agrees to when confirming a plan, as the backend can recompute it: every
/// build that will be installed (hash and trust), every mod that ends up on, what is turned on,
/// what is installed off, what is missing, and the version's mod interface. Its [`token`]
/// (`planToken`) is opaque to the page.
///
/// [`token`]: Consent::token
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Consent {
    abi: Option<String>,
    wanted: Vec<String>,
    builds: Vec<String>,
    on: Vec<String>,
    enable: Vec<String>,
    installed_off: Vec<String>,
    missing: Vec<String>,
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v.dedup();
    v
}

impl Consent {
    pub fn of(abi: Option<&str>, res: &Resolution, out: &Outcome) -> Consent {
        Consent {
            abi: abi.map(str::to_string),
            wanted: sorted(res.wanted.clone()),
            builds: sorted(
                res.picks
                    .iter()
                    .map(|(m, v)| build_text(&m.id, &v.sha256, v.trust))
                    .collect(),
            ),
            on: out.on.iter().cloned().collect(),
            enable: sorted(out.enable.clone()),
            installed_off: sorted(out.installed_off.clone()),
            missing: sorted(res.missing.clone()),
        }
    }

    /// A file that isn't in the catalogue: one Unverified build, on or off.
    pub fn unverified(abi: Option<&str>, id: &str, sha256: &str, on: bool) -> Consent {
        Consent {
            abi: abi.map(str::to_string),
            wanted: vec![id.to_string()],
            builds: vec![build_text(id, sha256, Trust::Unverified)],
            on: if on { vec![id.to_string()] } else { Vec::new() },
            enable: Vec::new(),
            installed_off: Vec::new(),
            missing: Vec::new(),
        }
    }

    pub fn token(&self) -> String {
        let list = |v: &[String]| v.join(",");
        let text = format!(
            "weft-plan/1\nabi={}\nwanted={}\nbuilds={}\non={}\nenable={}\noff={}\nmissing={}\n",
            self.abi.as_deref().unwrap_or("?"),
            list(&self.wanted),
            list(&self.builds),
            list(&self.on),
            list(&self.enable),
            list(&self.installed_off),
            list(&self.missing),
        );
        sha256_hex(text.as_bytes())
    }
}

fn build_text(id: &str, sha256: &str, trust: Trust) -> String {
    format!("{id}={}:{trust:?}", sha256.to_ascii_lowercase())
}

/// The token of a resolution, with the version's mod interface.
pub fn plan_token(abi: Option<&str>, lock: &Lock, res: &Resolution) -> String {
    Consent::of(abi, res, &outcome(lock, res)).token()
}

/// The token of a plan that can't be resolved, because the version's mod interface is unknown.
fn unresolved_token(m: &CatalogMod, v: &CatalogVersion) -> String {
    let res = Resolution {
        wanted: vec![m.id.clone()],
        picks: vec![(m.clone(), v.clone())],
        installed: Vec::new(),
        enable: Vec::new(),
        missing: Vec::new(),
    };
    let out = Outcome {
        on: BTreeSet::new(),
        enable: Vec::new(),
        installed_off: Vec::new(),
    };
    Consent::of(None, &res, &out).token()
}

/// Whether a resolution made before a download still describes what committing now would do.
/// `before` is the lock and resolution the player agreed to; `now` the same against the latest
/// lock and catalogue. It holds when nothing more needs downloading, nothing more is turned on,
/// and each wanted mod ends up on or off as agreed. Otherwise, why not.
pub fn still_holds(before: (&Lock, &Resolution), now: (&Lock, &Resolution)) -> Result<(), String> {
    let (old_lock, old) = before;
    let (lock, new) = now;
    for (m, v) in &new.picks {
        if !old.picks.iter().any(|(_, o)| o.sha256 == v.sha256) {
            return Err(format!("{} {} is needed now", m.name, v.version));
        }
    }
    let (was, will) = (outcome(old_lock, old), outcome(lock, new));
    if let Some(id) = will.enable.iter().find(|id| !was.enable.contains(*id)) {
        return Err(format!("{} would be turned on too", lock.name_of(id)));
    }
    for id in &new.wanted {
        if was.on.contains(id) != will.on.contains(id) {
            let state = if will.on.contains(id) { "on" } else { "off" };
            return Err(format!("{} would end up {state}", lock.name_of(id)));
        }
    }
    Ok(())
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
        turns_on: false,
        replaces,
        install: Vec::new(),
        enable: Vec::new(),
        missing: Vec::new(),
        fits_version: fit.map(|f| v.abi == f.abi),
        problem: None,
        plan_token: unresolved_token(m, v),
    };
    let Some(fit) = fit else {
        plan.problem = Some(ModsError::AbiUnavailable(tag.to_string()).into());
        return Ok(plan);
    };
    let res = resolve(catalog, lock, vec![(m.clone(), v.clone())], fit);
    let out = outcome(lock, &res);
    plan.plan_token = Consent::of(Some(fit.abi), &res, &out).token();
    plan.install = res
        .picks
        .iter()
        .filter(|(p, _)| p.id != m.id)
        .map(|(p, pv)| PlanItem::of(p, pv))
        .collect();
    plan.enable = out.enable;
    plan.turns_on = out.on.contains(&m.id);
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
        e.revoked_reason(catalog)
            .map(|reason| ModsError::Revoked(format!("{}: {reason}", e.name)))
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
    /// That build's hash (outcome `install`).
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CopyPreview {
    pub from: String,
    pub to: String,
    pub items: Vec<CopyItem>,
    /// Dependencies of the items that will be downloaded as well.
    pub deps: Vec<PlanItem>,
    /// Ids of mods `to` already has, off, that will be turned on.
    pub enable: Vec<String>,
    /// Ids of items that will be installed turned off, because something they need is missing.
    pub installed_off: Vec<String>,
    /// Ids of dependencies nothing provides for `to`: why `installed_off` are off.
    pub missing: Vec<String>,
    /// Pass to `copy_mod_profile`: the digest of what this preview asks the player to agree to.
    pub plan_token: String,
}

/// What copying the turned-on mods of `from` into `to` would bring over, each as the build made
/// for `to`, with what that pulls in, and the builds to install. Mods `to` already has are
/// skipped.
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
            sha256: pick.map(|v| v.sha256.clone()),
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
    let res = resolve(catalog, to.1, picks.clone(), fit);
    let out = outcome(to.1, &res);
    let preview = CopyPreview {
        from: from.0.to_string(),
        to: to.0.to_string(),
        items,
        deps: res
            .picks
            .iter()
            .filter(|(m, _)| !res.wanted.contains(&m.id))
            .map(|(m, v)| PlanItem::of(m, v))
            .collect(),
        plan_token: Consent::of(Some(fit.abi), &res, &out).token(),
        enable: out.enable,
        installed_off: out.installed_off,
        missing: res.missing.clone(),
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
            reason: "deletes saves".into(),
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
}
