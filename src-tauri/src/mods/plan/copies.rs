//! "Copy mods from…": what each turned-on mod of one version gets in another.

use super::*;

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
