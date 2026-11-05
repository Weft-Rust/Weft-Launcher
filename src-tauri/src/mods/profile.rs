//! The mod set of one game version, as data. `mods.lock.json` lists what is installed; the `mods/`
//! folder beside it holds exactly the turned-on ones (see `store.rs`). This module only decides:
//! the status of each mod, what would block the game, which update fits, and revocations.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use ts_rs::TS;

use super::catalog::{Catalog, CatalogMod, CatalogVersion, Origin, Trust};
use super::index::{Channel, Platform, RESERVED_ID};
use crate::error::AppError;

/// Ships inside every Weft; never installed or checked by the launcher.
pub const BUILTIN: &[&str] = &[RESERVED_ID];

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LockEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub summary: String,
    pub version: Option<String>,
    pub channel: Option<Channel>,
    pub sha256: String,
    pub size: u64,
    pub enabled: bool,
    pub trust: Trust,
    pub origin: Origin,
    /// Unknown for a file from the player's computer: only the game can read it from the library.
    pub abi: Option<String>,
    pub weft_tag: Option<String>,
    #[serde(default)]
    pub deps: Vec<String>,
    pub tag: Option<String>,
    pub source_repo: Option<String>,
    pub source_commit: Option<String>,
    pub icon: Option<String>,
    pub installed_at: String,
    /// Set when the index revoked this build, and kept even if the index can't be loaded later:
    /// the mod stays revoked, and off, until it is replaced or removed.
    #[serde(default)]
    pub revoked: Option<Revocation>,
}

/// Why and when a revocation was applied to an installed build.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Revocation {
    /// The index's words; null when it gave none. Older launchers wrote "No reason given",
    /// which reads back as none.
    #[serde(default, deserialize_with = "given_reason")]
    #[ts(type = "string | null")]
    pub reason: Option<String>,
    /// RFC 3339 time the launcher applied it; unknown in lock files that never said.
    #[serde(default)]
    pub at: Option<String>,
}

impl LockEntry {
    pub fn from_catalog(m: &CatalogMod, v: &CatalogVersion, enabled: bool) -> Self {
        LockEntry {
            id: m.id.clone(),
            name: m.name.clone(),
            summary: m.summary.clone(),
            version: Some(v.version.clone()),
            channel: Some(v.channel),
            sha256: v.sha256.clone(),
            size: v.size,
            enabled,
            trust: v.trust,
            origin: m.origin.clone(),
            abi: Some(v.abi.clone()),
            weft_tag: v.weft_tag.clone(),
            deps: v.deps.clone(),
            tag: Some(v.tag.clone()),
            source_repo: Some(v.source_repo.clone()),
            source_commit: Some(v.source_commit.clone()),
            icon: m.icon.clone(),
            installed_at: now(),
            revoked: None,
        }
    }

    /// Why this build may not be used: the revocation recorded in the lock file, else the
    /// catalogue's.
    pub fn revoked_reason(&self, catalog: &Catalog) -> Option<String> {
        match &self.revoked {
            Some(r) => r.reason.clone(),
            None => catalog
                .revocation(&self.sha256)
                .and_then(|r| r.reason.clone()),
        }
    }

    /// Whether this build may not be used: revoked in the lock file or the catalogue.
    pub fn is_revoked(&self, catalog: &Catalog) -> bool {
        self.revoked.is_some() || catalog.revocation(&self.sha256).is_some()
    }

    pub fn catalog_key(&self) -> Option<String> {
        self.origin.key(&self.id)
    }
}

/// A revocation's reason as a lock file has it: a missing or empty one, or the English
/// placeholder older launchers wrote for one, is none.
fn given_reason<'de, D>(d: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let reason = Option::<String>::deserialize(d)?;
    Ok(reason
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty() && r != "No reason given"))
}

pub fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Lock {
    pub schema: u32,
    pub mods: Vec<LockEntry>,
}

impl Lock {
    pub fn empty() -> Self {
        Lock {
            schema: 1,
            mods: Vec::new(),
        }
    }

    pub fn get(&self, id: &str) -> Option<&LockEntry> {
        self.mods.iter().find(|m| m.id == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut LockEntry> {
        self.mods.iter_mut().find(|m| m.id == id)
    }

    /// Adds the entry, or replaces the installed mod with the same id.
    pub fn put(&mut self, entry: LockEntry) {
        match self.get_mut(&entry.id) {
            Some(existing) => *existing = entry,
            None => {
                self.mods.push(entry);
                self.mods.sort_by(|a, b| a.id.cmp(&b.id));
            }
        }
    }

    /// Installed mods `id` needs, directly or through others.
    pub fn deps_of(&self, id: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut todo = vec![id.to_string()];
        while let Some(next) = todo.pop() {
            let Some(entry) = self.get(&next) else {
                continue;
            };
            for d in &entry.deps {
                if !out.contains(d) && d != id && self.get(d).is_some() {
                    out.push(d.clone());
                    todo.push(d.clone());
                }
            }
        }
        out
    }

    /// Turned-on mods that need `id`, directly or through others.
    pub fn dependents_of(&self, id: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut todo = vec![id.to_string()];
        while let Some(next) = todo.pop() {
            for m in self.mods.iter().filter(|m| m.enabled) {
                if m.deps.contains(&next) && !out.contains(&m.id) && m.id != id {
                    out.push(m.id.clone());
                    todo.push(m.id.clone());
                }
            }
        }
        out
    }

    /// The display name of an installed mod, or its id.
    pub fn name_of(&self, id: &str) -> String {
        self.get(id)
            .map(|e| e.name.clone())
            .unwrap_or_else(|| id.to_string())
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub enum ModStatus {
    /// On, and fits this version as far as the launcher can tell.
    Ready,
    Off,
    /// Built for another game version: Weft would refuse to start.
    WrongVersion,
    /// Needs a mod that isn't on.
    MissingDeps,
    /// Pulled from the index. Turned off and never handed to the game.
    Revoked,
    /// A file from the player's computer: whether it fits is only known when the game starts.
    Unchecked,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    pub version: String,
    pub sha256: String,
    pub channel: Channel,
    pub trust: Trust,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InstalledMod {
    #[serde(flatten)]
    pub entry: LockEntry,
    pub status: ModStatus,
    /// Dependencies that aren't on: not installed, or installed and off.
    pub missing_deps: Vec<String>,
    /// The part of `missing_deps` with no build installed at all.
    pub deps_not_installed: Vec<String>,
    pub revoked_reason: Option<String>,
    pub update: Option<UpdateView>,
}

/// Why a mod in `ProfileReport.blocking` stops the game.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub enum BlockingReason {
    WrongVersion,
    MissingDeps,
    /// Revoked, but still in the version's folder: the game that is running now started with
    /// it, and it is turned off once that game stops.
    Revoked,
    /// Revoked, and a file with its id in the player's own folder would load in its place.
    ShadowedRevoked,
}

/// What the launcher's copy of a shadowed mod is.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub enum Managed {
    On,
    Off,
    Revoked,
}

/// A file in the player's own mods folder with the id of a mod in this set. The engine loads
/// the first copy of an id it finds and searches the launcher's folder first, so this one loads
/// whenever the launcher's copy is off or revoked.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ShadowedMod {
    pub id: String,
    pub file: String,
    pub managed: Managed,
}

/// One entry of the player's own mods folder, and the mod id the engine would give it: the
/// stem of `<id>.zip`, or a folder's name. `None` for anything the engine skips.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayerFile {
    pub file: String,
    pub id: Option<String>,
}

impl PlayerFile {
    /// As `crates/engine/src/modloader.rs` `discover` names it.
    pub fn new(file: &str, is_dir: bool) -> PlayerFile {
        let zip_stem = file
            .len()
            .checked_sub(4)
            .filter(|&at| file.is_char_boundary(at) && file[at..].eq_ignore_ascii_case(".zip"))
            .map(|at| &file[..at]);
        let id = if is_dir { Some(file) } else { zip_stem };
        PlayerFile {
            file: file.to_string(),
            id: id.filter(|i| !i.is_empty()).map(str::to_string),
        }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProfileReport {
    pub tag: String,
    pub version_abi: Option<String>,
    pub abi_error: Option<AppError>,
    pub mods: Vec<InstalledMod>,
    /// Ids of mods that would stop the game from starting: turned-on mods that can't load, and
    /// revoked mods a file in the player's folder would stand in for.
    pub blocking: Vec<String>,
    /// Why each of `blocking` blocks.
    pub blocking_reasons: BTreeMap<String, BlockingReason>,
    /// What sits in the player's own Weft mods folder. Loads into every version, unchecked.
    pub unmanaged: Vec<String>,
    /// Files there with the id of a mod in this set.
    pub shadowed: Vec<ShadowedMod>,
    /// Ids of revoked mods still on, because the version's game is running: they are turned
    /// off when it stops.
    pub revocations_pending: Vec<String>,
}

/// What a build must match to be used here: the version's mod interface and this system.
#[derive(Debug, Clone, Copy)]
pub struct Fit<'a> {
    pub abi: &'a str,
    pub platform: Option<Platform>,
}

impl<'a> Fit<'a> {
    pub fn here(abi: &'a str) -> Self {
        Fit {
            abi,
            platform: Platform::current(),
        }
    }

    pub fn platform_ok(&self, v: &CatalogVersion) -> bool {
        self.platform.is_some_and(|p| v.platforms.contains(&p))
    }

    pub fn accepts(&self, v: &CatalogVersion) -> bool {
        v.abi == self.abi && self.platform_ok(v)
    }
}

/// The builds of `key` that fit here, no less stable than `at_most`, revoked ones included.
pub fn fitting<'a>(
    catalog: &'a Catalog,
    key: &str,
    fit: Fit<'_>,
    at_most: Channel,
) -> Option<(&'a CatalogMod, Vec<&'a CatalogVersion>)> {
    let m = catalog.by_key(key)?;
    let versions = m
        .versions
        .iter()
        .filter(|v| fit.accepts(v) && v.channel.rank() <= at_most.rank())
        .collect();
    Some((m, versions))
}

/// The newest build of `key` that fits here, no less stable than `at_most`, and not revoked.
pub fn best_version<'a>(
    catalog: &'a Catalog,
    key: &str,
    fit: Fit<'_>,
    at_most: Channel,
) -> Option<(&'a CatalogMod, &'a CatalogVersion)> {
    let (m, versions) = fitting(catalog, key, fit, at_most)?;
    versions
        .into_iter()
        .filter(|v| catalog.revocation(&v.sha256).is_none())
        .max_by(|a, b| {
            super::version::compare(&a.version, &b.version)
                .then(b.channel.rank().cmp(&a.channel.rank()))
        })
        .map(|v| (m, v))
}

/// A newer build for this version, or any fitting build for a mod that doesn't fit.
pub fn update_for(
    entry: &LockEntry,
    fit: Option<Fit<'_>>,
    catalog: &Catalog,
) -> Option<UpdateView> {
    let fit = fit?;
    let key = entry.catalog_key()?;
    let at_most = entry.channel.unwrap_or(Channel::Release);
    let (_, v) = best_version(catalog, &key, fit, at_most)?;
    let fits_now = entry.abi.as_deref() == Some(fit.abi);
    let newer = entry
        .version
        .as_deref()
        .is_none_or(|cur| super::version::compare(&v.version, cur).is_gt());
    if v.sha256 == entry.sha256 || (fits_now && !newer) {
        return None;
    }
    Some(UpdateView {
        version: v.version.clone(),
        sha256: v.sha256.clone(),
        channel: v.channel,
        trust: v.trust,
    })
}

/// What the launcher knows about each installed mod, and what would stop the game.
pub fn report(
    tag: &str,
    lock: &Lock,
    version_abi: Option<String>,
    abi_error: Option<AppError>,
    catalog: &Catalog,
    platform: Option<Platform>,
    unmanaged: Vec<PlayerFile>,
) -> ProfileReport {
    let enabled: BTreeSet<&str> = lock
        .mods
        .iter()
        .filter(|m| m.enabled)
        .map(|m| m.id.as_str())
        .collect();
    let fit = version_abi.as_deref().map(|abi| Fit { abi, platform });
    let mut mods = Vec::new();
    let mut reasons: Vec<(String, BlockingReason)> = Vec::new();
    let mut pending = Vec::new();
    let mut shadowed = Vec::new();
    for entry in &lock.mods {
        // Revoked is decided by the record, never by whether it gave a reason.
        let is_revoked = entry.is_revoked(catalog);
        let revoked = entry.revoked_reason(catalog);
        let missing: Vec<String> = entry
            .deps
            .iter()
            .filter(|d| !BUILTIN.contains(&d.as_str()) && !enabled.contains(d.as_str()))
            .cloned()
            .collect();
        let not_installed = missing
            .iter()
            .filter(|d| lock.get(d).is_none())
            .cloned()
            .collect();
        let status = if is_revoked {
            ModStatus::Revoked
        } else if !entry.enabled {
            ModStatus::Off
        } else if let (Some(have), Some(want)) = (entry.abi.as_deref(), version_abi.as_deref())
            && have != want
        {
            ModStatus::WrongVersion
        } else if !missing.is_empty() {
            ModStatus::MissingDeps
        } else if entry.abi.is_none() || version_abi.is_none() {
            ModStatus::Unchecked
        } else {
            ModStatus::Ready
        };
        let shadow = unmanaged
            .iter()
            .find(|f| f.id.as_deref() == Some(entry.id.as_str()));
        if let Some(f) = shadow {
            shadowed.push(ShadowedMod {
                id: entry.id.clone(),
                file: f.file.clone(),
                managed: match (is_revoked, entry.enabled) {
                    (true, _) => Managed::Revoked,
                    (false, true) => Managed::On,
                    (false, false) => Managed::Off,
                },
            });
        }
        if is_revoked && entry.enabled {
            pending.push(entry.id.clone());
        }
        let reason = match status {
            ModStatus::Revoked if shadow.is_some() => Some(BlockingReason::ShadowedRevoked),
            ModStatus::Revoked if entry.enabled => Some(BlockingReason::Revoked),
            ModStatus::WrongVersion => Some(BlockingReason::WrongVersion),
            ModStatus::MissingDeps => Some(BlockingReason::MissingDeps),
            _ => None,
        };
        if let Some(reason) = reason {
            reasons.push((entry.id.clone(), reason));
        }
        mods.push(InstalledMod {
            update: update_for(entry, fit, catalog),
            entry: entry.clone(),
            status,
            missing_deps: missing,
            deps_not_installed: not_installed,
            revoked_reason: revoked,
        });
    }
    ProfileReport {
        tag: tag.to_string(),
        version_abi,
        abi_error,
        mods,
        blocking: reasons.iter().map(|(id, _)| id.clone()).collect(),
        blocking_reasons: reasons.into_iter().collect(),
        unmanaged: unmanaged.into_iter().map(|f| f.file).collect(),
        shadowed,
        revocations_pending: pending,
    }
}

/// Records every revocation the catalogue lists for an installed build, and turns off every
/// revoked mod. Returns whether anything changed.
pub fn apply_revocations(lock: &mut Lock, catalog: &Catalog) -> bool {
    let mut changed = false;
    for m in &mut lock.mods {
        if m.revoked.is_none()
            && let Some(r) = catalog.revocation(&m.sha256)
        {
            m.revoked = Some(Revocation {
                reason: r.reason.clone(),
                at: Some(now()),
            });
            changed = true;
        }
        if m.enabled && m.revoked.is_some() {
            m.enabled = false;
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::catalog::{IndexStatus, RevokedView};
    use super::super::index::Freshness;
    use super::*;

    pub const ABI: &str = "f470b1cbb1f9ad91";
    pub const OLD_ABI: &str = "5f0569a6bea71b81";

    pub fn sha(id: &str, version: &str) -> String {
        crate::download::sha256_hex(format!("{id}@{version}").as_bytes())
    }

    pub fn entry(id: &str, deps: &[&str], abi: Option<&str>) -> LockEntry {
        LockEntry {
            id: id.into(),
            name: format!("{id} name"),
            summary: String::new(),
            version: Some("0.1.0".into()),
            channel: Some(Channel::Release),
            sha256: sha(id, "0.1.0"),
            size: 1,
            enabled: true,
            trust: Trust::Reviewed,
            origin: Origin::Index,
            abi: abi.map(str::to_string),
            weft_tag: None,
            deps: deps.iter().map(|d| d.to_string()).collect(),
            tag: None,
            source_repo: None,
            source_commit: None,
            icon: None,
            installed_at: String::new(),
            revoked: None,
        }
    }

    pub fn lock(entries: Vec<LockEntry>) -> Lock {
        Lock {
            schema: 1,
            mods: entries,
        }
    }

    /// A catalogue build of `id` at `version` for `abi`, on Linux.
    pub fn build(
        id: &str,
        version: &str,
        abi: &str,
        channel: Channel,
        deps: &[&str],
    ) -> CatalogVersion {
        CatalogVersion {
            version: version.into(),
            channel,
            tag: format!("{id}-v{version}"),
            published: String::new(),
            source_repo: "Zorro909/weft-mods".into(),
            source_commit: "c".repeat(40),
            weft_tag: None,
            abi: abi.into(),
            deps: deps.iter().map(|d| d.to_string()).collect(),
            platforms: vec![Platform::LinuxX64],
            sha256: sha(id, version),
            size: 10,
            url: String::new(),
            provenance: None,
            provenance_verified: false,
            reviewed: None,
            trust: Trust::Reviewed,
        }
    }

    pub fn catalog_mod(id: &str, origin: Origin, versions: Vec<CatalogVersion>) -> CatalogMod {
        CatalogMod {
            key: origin.key(id).unwrap(),
            id: id.into(),
            name: format!("{id} name"),
            summary: String::new(),
            authors: vec![],
            license: None,
            homepage: None,
            icon: None,
            origin,
            versions,
        }
    }

    pub fn catalog(mods: Vec<CatalogMod>, revoked: &[&str]) -> Catalog {
        Catalog {
            mods,
            revoked: revoked
                .iter()
                .map(|s| RevokedView {
                    sha256: s.to_string(),
                    reason: Some("broken".into()),
                })
                .collect(),
            index: IndexStatus {
                freshness: Freshness::Fresh,
                generated: None,
                signed_at: None,
                error: None,
            },
            sources: vec![],
            weft: vec![],
            platform: String::new(),
            sources_error: None,
        }
    }

    pub fn fit() -> Fit<'static> {
        Fit {
            abi: ABI,
            platform: Some(Platform::LinuxX64),
        }
    }

    #[test]
    fn statuses_and_blocking() {
        let mut revoked = entry("pulled", &[], Some(ABI));
        revoked.enabled = false;
        let mut off = entry("showcase", &[], Some(ABI));
        off.enabled = false;
        let l = lock(vec![
            entry("cogwork", &["base", "showcase"], Some(ABI)),
            off,
            entry("old", &[], Some(OLD_ABI)),
            entry("file", &[], None),
            entry("fine", &["base"], Some(ABI)),
            revoked.clone(),
        ]);
        let c = catalog(vec![], &[&revoked.sha256]);
        let cases = [
            (Some(ABI), "cogwork", ModStatus::MissingDeps),
            (Some(ABI), "showcase", ModStatus::Off),
            (Some(ABI), "old", ModStatus::WrongVersion),
            (Some(ABI), "file", ModStatus::Unchecked),
            (Some(ABI), "fine", ModStatus::Ready),
            (Some(ABI), "pulled", ModStatus::Revoked),
            // Without the version's interface nothing can be called wrong, only unchecked.
            (None, "old", ModStatus::Unchecked),
            (None, "fine", ModStatus::Unchecked),
            (None, "cogwork", ModStatus::MissingDeps),
        ];
        for (abi, id, want) in cases {
            let r = report(
                "v1",
                &l,
                abi.map(str::to_string),
                None,
                &c,
                fit().platform,
                vec![],
            );
            let got = r.mods.iter().find(|m| m.entry.id == id).unwrap().status;
            assert_eq!(got, want, "{id} with abi {abi:?}");
        }
        let r = report("v1", &l, Some(ABI.into()), None, &c, fit().platform, vec![]);
        assert_eq!(r.blocking, ["cogwork", "old"]);
        assert_eq!(
            r.mods
                .iter()
                .find(|m| m.entry.id == "pulled")
                .unwrap()
                .revoked_reason
                .as_deref(),
            Some("broken")
        );
    }

    #[test]
    fn dependency_walks() {
        let l = lock(vec![
            entry("a", &["b"], Some(ABI)),
            entry("b", &["c", "base"], Some(ABI)),
            entry("c", &[], Some(ABI)),
            entry("d", &[], Some(ABI)),
        ]);
        let mut deps = l.deps_of("a");
        deps.sort();
        assert_eq!(deps, ["b", "c"]);
        let mut dependents = l.dependents_of("c");
        dependents.sort();
        assert_eq!(dependents, ["a", "b"]);
        assert!(l.dependents_of("d").is_empty());
    }

    #[test]
    fn update_offers() {
        let rel = Channel::Release;
        let c = catalog(
            vec![
                catalog_mod(
                    "cogwork",
                    Origin::Index,
                    vec![
                        build("cogwork", "0.3.0-rc.1", ABI, Channel::Prerelease, &[]),
                        build("cogwork", "0.2.0", ABI, rel, &[]),
                        build("cogwork", "0.1.0", ABI, rel, &[]),
                        build("cogwork", "0.0.9", OLD_ABI, rel, &[]),
                    ],
                ),
                catalog_mod(
                    "lanterns",
                    Origin::Source {
                        repo: "Someone/Lanterns".into(),
                    },
                    vec![build("lanterns", "1.1.0", ABI, rel, &[])],
                ),
                catalog_mod(
                    "pulled",
                    Origin::Index,
                    vec![build("pulled", "0.2.0", ABI, rel, &[])],
                ),
            ],
            &[&sha("pulled", "0.2.0")],
        );
        let installed = |id: &str, version: &str, abi: &str, channel: Channel| {
            let mut e = entry(id, &[], Some(abi));
            e.version = Some(version.into());
            e.sha256 = sha(id, version);
            e.channel = Some(channel);
            e
        };
        let mut from_source = installed("lanterns", "1.0.0", ABI, rel);
        // Installed when the source was added with other casing.
        from_source.origin = Origin::Source {
            repo: "someone/lanterns".into(),
        };
        let mut local = installed("cogwork", "0.1.0", ABI, rel);
        local.origin = Origin::File {
            name: "c.zip".into(),
        };
        let cases: Vec<(&str, LockEntry, Option<&str>)> = vec![
            (
                "older release",
                installed("cogwork", "0.1.0", ABI, rel),
                Some("0.2.0"),
            ),
            (
                "newest already",
                installed("cogwork", "0.2.0", ABI, rel),
                None,
            ),
            (
                "prerelease player gets the rc",
                installed("cogwork", "0.2.0", ABI, Channel::Prerelease),
                Some("0.3.0-rc.1"),
            ),
            (
                "built for another version: any fitting build",
                installed("cogwork", "0.0.9", OLD_ABI, rel),
                Some("0.2.0"),
            ),
            ("source, repo case differs", from_source, Some("1.1.0")),
            (
                "revoked build is never offered",
                installed("pulled", "0.1.0", ABI, rel),
                None,
            ),
            ("local file has no updates", local, None),
        ];
        for (what, e, want) in cases {
            let got = update_for(&e, Some(fit()), &c).map(|u| u.version);
            assert_eq!(got.as_deref(), want, "{what}");
        }
        assert!(update_for(&installed("cogwork", "0.1.0", ABI, rel), None, &c).is_none());
    }

    #[test]
    fn revocations_turn_mods_off() {
        let mut l = lock(vec![entry("a", &[], Some(ABI)), entry("b", &[], Some(ABI))]);
        let c = catalog(vec![], &[&sha("a", "0.1.0")]);
        assert!(apply_revocations(&mut l, &c));
        assert!(!l.get("a").unwrap().enabled);
        assert_eq!(
            l.get("a")
                .unwrap()
                .revoked
                .as_ref()
                .unwrap()
                .reason
                .as_deref(),
            Some("broken")
        );
        assert!(l.get("b").unwrap().enabled);
        assert!(l.get("b").unwrap().revoked.is_none());
        assert!(!apply_revocations(&mut l, &c));
    }

    /// The index can't be loaded any more: the lock file still knows, so the mod stays revoked
    /// and says why.
    #[test]
    fn a_recorded_revocation_survives_without_the_index() {
        let mut l = lock(vec![entry("a", &[], Some(ABI))]);
        apply_revocations(&mut l, &catalog(vec![], &[&sha("a", "0.1.0")]));
        let saved = serde_json::to_vec(&l).unwrap();
        let mut l: Lock = serde_json::from_slice(&saved).unwrap();

        let unavailable = catalog(vec![], &[]);
        let r = report(
            "v1",
            &l,
            Some(ABI.into()),
            None,
            &unavailable,
            fit().platform,
            vec![],
        );
        assert_eq!(r.mods[0].status, ModStatus::Revoked);
        assert_eq!(r.mods[0].revoked_reason.as_deref(), Some("broken"));

        // Even if something turned it back on, the next check turns it off again.
        l.mods[0].enabled = true;
        assert!(apply_revocations(&mut l, &unavailable));
        assert!(!l.mods[0].enabled);

        // A lock file written before revocations were recorded still reads.
        let old = r#"{"schema":1,"mods":[]}"#;
        assert!(serde_json::from_str::<Lock>(old).is_ok());
    }

    #[test]
    fn missing_dependencies_say_whether_they_are_installed() {
        let mut off = entry("showcase", &[], Some(ABI));
        off.enabled = false;
        let l = lock(vec![
            entry("cogwork", &["base", "showcase", "signals"], Some(ABI)),
            off,
        ]);
        let r = report(
            "v1",
            &l,
            Some(ABI.into()),
            None,
            &catalog(vec![], &[]),
            fit().platform,
            vec![],
        );
        let cogwork = r.mods.iter().find(|m| m.entry.id == "cogwork").unwrap();
        assert_eq!(cogwork.status, ModStatus::MissingDeps);
        assert_eq!(cogwork.missing_deps, ["showcase", "signals"]);
        assert_eq!(cogwork.deps_not_installed, ["signals"]);
    }
}
