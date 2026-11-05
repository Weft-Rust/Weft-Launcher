//! The rules for changing a mod set, on plain data: what an install brings along, what a copy
//! brings over, and what turning a mod on or off or removing it does to the others. Nothing here
//! touches the disk or the network; `service/` does that around these.
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

mod consent;
mod copies;
mod resolution;

pub use consent::*;
pub use copies::*;
pub use resolution::*;

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
    /// Whether the target is built for the version's mod interface; null when that is unknown.
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
        e.is_revoked(catalog).then(|| {
            let reason = e
                .revoked_reason(catalog)
                .unwrap_or_else(|| "no reason given".into());
            ModsError::Revoked(format!("{}: {reason}", e.name))
        })
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

#[cfg(test)]
mod tests;
