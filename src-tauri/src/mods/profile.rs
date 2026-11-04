//! The mod set of one game version, as data. `mods.lock.json` lists what is installed; the `mods/`
//! folder beside it holds exactly the turned-on ones (see `store.rs`). This module only decides:
//! the status of each mod, what would block the game, which update fits, and revocations.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
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
        }
    }

    pub fn catalog_key(&self) -> Option<String> {
        self.origin.key(&self.id)
    }
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
    pub missing_deps: Vec<String>,
    pub revoked_reason: Option<String>,
    pub update: Option<UpdateView>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProfileReport {
    pub tag: String,
    pub version_abi: Option<String>,
    pub abi_error: Option<AppError>,
    pub mods: Vec<InstalledMod>,
    /// Ids of turned-on mods that would stop the game from starting.
    pub blocking: Vec<String>,
    /// What sits in the player's own Weft mods folder. Loads into every version, unchecked.
    pub unmanaged: Vec<String>,
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
    unmanaged: Vec<String>,
) -> ProfileReport {
    let enabled: BTreeSet<&str> = lock
        .mods
        .iter()
        .filter(|m| m.enabled)
        .map(|m| m.id.as_str())
        .collect();
    let fit = version_abi.as_deref().map(|abi| Fit { abi, platform });
    let mut mods = Vec::new();
    let mut blocking = Vec::new();
    for entry in &lock.mods {
        let revoked = catalog.revocation(&entry.sha256);
        let missing: Vec<String> = entry
            .deps
            .iter()
            .filter(|d| !BUILTIN.contains(&d.as_str()) && !enabled.contains(d.as_str()))
            .cloned()
            .collect();
        let status = if revoked.is_some() {
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
        if matches!(status, ModStatus::WrongVersion | ModStatus::MissingDeps) {
            blocking.push(entry.id.clone());
        }
        mods.push(InstalledMod {
            update: update_for(entry, fit, catalog),
            entry: entry.clone(),
            status,
            missing_deps: missing,
            revoked_reason: revoked.map(|r| r.reason.clone()),
        });
    }
    ProfileReport {
        tag: tag.to_string(),
        version_abi,
        abi_error,
        mods,
        blocking,
        unmanaged,
    }
}

/// Turns off every revoked mod. Returns whether anything changed.
pub fn apply_revocations(lock: &mut Lock, catalog: &Catalog) -> bool {
    let mut changed = false;
    for m in &mut lock.mods {
        if m.enabled && catalog.revocation(&m.sha256).is_some() {
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
                    reason: "broken".into(),
                })
                .collect(),
            index: IndexStatus {
                freshness: Freshness::Fresh,
                generated: None,
                error: None,
            },
            sources: vec![],
            weft: vec![],
            platform: String::new(),
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
        assert!(l.get("b").unwrap().enabled);
        assert!(!apply_revocations(&mut l, &c));
    }
}
