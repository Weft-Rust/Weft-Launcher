//! The mod set of one game version. `mods.lock.json` lists what is installed; the `mods/` folder
//! beside it holds exactly the turned-on ones and is what the game gets with `--mods`. A mod
//! that is off is not in that folder at all: the engine runs code even from mods it was told to
//! skip, so leaving the file out is the only real "off".

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::archive::current_platform;
use super::catalog::{Catalog, CatalogMod, CatalogVersion, Origin, Trust};
use super::error::ModsError;
use super::index::Channel;
use super::paths::{profile_dir, profiles_dir, store_dir, write_atomic};
use crate::download::sha256_file;
use crate::error::AppError;

/// Ships inside every Weft; never installed or checked by the launcher.
pub const BUILTIN: &[&str] = &["base"];

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub fn from_catalog(m: &CatalogMod, v: &CatalogVersion) -> Self {
        LockEntry {
            id: m.id.clone(),
            name: m.name.clone(),
            summary: m.summary.clone(),
            version: Some(v.version.clone()),
            channel: Some(v.channel),
            sha256: v.sha256.clone(),
            size: v.size,
            enabled: true,
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
        match &self.origin {
            Origin::Index => Some(format!("index:{}", self.id)),
            Origin::Source { repo } => Some(format!("source:{repo}:{}", self.id)),
            Origin::File { .. } => None,
        }
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
}

fn lock_path(app: &AppHandle, tag: &str) -> Result<PathBuf, ModsError> {
    Ok(profile_dir(app, tag)?.join("mods.lock.json"))
}

pub fn mods_dir(app: &AppHandle, tag: &str) -> Result<PathBuf, ModsError> {
    Ok(profile_dir(app, tag)?.join("mods"))
}

pub fn read_lock(app: &AppHandle, tag: &str) -> Result<Lock, ModsError> {
    let path = lock_path(app, tag)?;
    match std::fs::read(&path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Lock {
            schema: 1,
            mods: Vec::new(),
        }),
        Err(e) => Err(e.into()),
    }
}

pub fn write_lock(app: &AppHandle, tag: &str, lock: &Lock) -> Result<(), ModsError> {
    write_atomic(&lock_path(app, tag)?, &serde_json::to_vec_pretty(lock)?)
}

pub fn store_path(app: &AppHandle, sha256: &str) -> Result<PathBuf, ModsError> {
    Ok(store_dir(app)?.join(format!("{sha256}.zip")))
}

fn link_or_copy(from: &Path, to: &Path) -> std::io::Result<()> {
    if std::fs::hard_link(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to).map(|_| ())
}

/// Makes the profile's `mods/` hold exactly the turned-on mods, each with the bytes that were
/// verified at install. A file changed since then is replaced from the store; a changed store
/// file is an error, never handed to the game.
pub fn reconcile(app: &AppHandle, tag: &str, lock: &Lock) -> Result<(), ModsError> {
    let dir = mods_dir(app, tag)?;
    std::fs::create_dir_all(&dir)?;
    let wanted: Vec<&LockEntry> = lock.mods.iter().filter(|m| m.enabled).collect();

    for entry in std::fs::read_dir(&dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !wanted.iter().any(|m| format!("{}.zip", m.id) == name) {
            let path = entry.path();
            if path.is_dir() {
                std::fs::remove_dir_all(&path)?;
            } else {
                std::fs::remove_file(&path)?;
            }
        }
    }

    for m in wanted {
        let target = dir.join(format!("{}.zip", m.id));
        if target.exists() && sha256_file(&target)? == m.sha256 {
            continue;
        }
        let _ = std::fs::remove_file(&target);
        let stored = store_path(app, &m.sha256)?;
        let actual = sha256_file(&stored).map_err(|_| ModsError::NotInstalled(m.id.clone()))?;
        if actual != m.sha256 {
            return Err(ModsError::Sha256Mismatch {
                expected: m.sha256.clone(),
                actual,
            });
        }
        link_or_copy(&stored, &target)?;
    }
    Ok(())
}

/// Deletes stored files no profile uses any more.
pub fn collect_garbage(app: &AppHandle) -> Result<(), ModsError> {
    let mut used = HashSet::new();
    if let Ok(entries) = std::fs::read_dir(profiles_dir(app)?) {
        for entry in entries.flatten() {
            let tag = entry.file_name().to_string_lossy().to_string();
            if let Ok(lock) = read_lock(app, &tag) {
                used.extend(lock.mods.into_iter().map(|m| format!("{}.zip", m.sha256)));
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(store_dir(app)?) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !used.contains(&name) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

/// A deleted game version takes its mod set along.
pub fn forget_version(app: &AppHandle, tag: &str) {
    if let Ok(dir) = profile_dir(app, tag) {
        let _ = std::fs::remove_dir_all(dir);
    }
    let _ = collect_garbage(app);
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    pub version: String,
    pub sha256: String,
    pub channel: Channel,
    pub trust: Trust,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledMod {
    #[serde(flatten)]
    pub entry: LockEntry,
    pub status: ModStatus,
    pub missing_deps: Vec<String>,
    pub revoked_reason: Option<String>,
    pub update: Option<UpdateView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileReport {
    pub tag: String,
    pub version_abi: Option<String>,
    pub abi_error: Option<AppError>,
    pub mods: Vec<InstalledMod>,
    /// Turned-on mods that would stop the game from starting.
    pub blocking: Vec<String>,
    /// What sits in the player's own Weft mods folder. Loads into every version, unchecked.
    pub unmanaged: Vec<String>,
}

fn channel_rank(c: Channel) -> u8 {
    match c {
        Channel::Release => 0,
        Channel::Prerelease => 1,
        Channel::Experimental => 2,
    }
}

/// The newest version of `key` that fits `abi` here, no less stable than `at_most`.
pub fn best_version<'a>(
    catalog: &'a Catalog,
    key: &str,
    abi: &str,
    at_most: Channel,
) -> Option<(&'a CatalogMod, &'a CatalogVersion)> {
    let m = catalog.mods.iter().find(|m| m.key == key)?;
    m.versions
        .iter()
        .filter(|v| v.abi == abi)
        .filter(|v| v.platforms.iter().any(|p| p == current_platform()))
        .filter(|v| channel_rank(v.channel) <= channel_rank(at_most))
        .filter(|v| catalog.revocation(&v.sha256).is_none())
        .max_by(|a, b| {
            super::version::compare(&a.version, &b.version)
                .then(channel_rank(b.channel).cmp(&channel_rank(a.channel)))
        })
        .map(|v| (m, v))
}

/// A newer build for this version, or any fitting build for a mod that doesn't fit.
fn update_for(
    entry: &LockEntry,
    abi: Option<&str>,
    catalog: Option<&Catalog>,
) -> Option<UpdateView> {
    let catalog = catalog?;
    let abi = abi?;
    let key = entry.catalog_key()?;
    let at_most = entry.channel.unwrap_or(Channel::Release);
    let (_, v) = best_version(catalog, &key, abi, at_most)?;
    let fits_now = entry.abi.as_deref() == Some(abi);
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
    catalog: Option<&Catalog>,
    unmanaged: Vec<String>,
) -> ProfileReport {
    let enabled: BTreeSet<&str> = lock
        .mods
        .iter()
        .filter(|m| m.enabled)
        .map(|m| m.id.as_str())
        .collect();
    let mut mods = Vec::new();
    let mut blocking = Vec::new();
    for entry in &lock.mods {
        let revoked = catalog.and_then(|c| c.revocation(&entry.sha256));
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
            update: update_for(entry, version_abi.as_deref(), catalog),
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
mod tests {
    use super::*;

    fn entry(id: &str, deps: &[&str], abi: Option<&str>) -> LockEntry {
        LockEntry {
            id: id.into(),
            name: id.into(),
            summary: String::new(),
            version: Some("0.1.0".into()),
            channel: Some(Channel::Release),
            sha256: format!("{id:a>64}"),
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

    const ABI: &str = "f470b1cbb1f9ad91";

    #[test]
    fn statuses_and_blocking() {
        let mut lock = Lock {
            schema: 1,
            mods: vec![
                entry("cogwork", &["base", "showcase"], Some(ABI)),
                entry("showcase", &[], Some(ABI)),
                entry("old", &[], Some("5f0569a6bea71b81")),
                entry("file", &[], None),
            ],
        };
        lock.get_mut("showcase").unwrap().enabled = false;
        let r = report("v1", &lock, Some(ABI.into()), None, None, vec![]);
        let status = |id: &str| r.mods.iter().find(|m| m.entry.id == id).unwrap().status;
        assert_eq!(status("cogwork"), ModStatus::MissingDeps);
        assert_eq!(status("showcase"), ModStatus::Off);
        assert_eq!(status("old"), ModStatus::WrongVersion);
        assert_eq!(status("file"), ModStatus::Unchecked);
        assert_eq!(r.blocking, ["cogwork", "old"]);
    }

    #[test]
    fn dependency_walks() {
        let lock = Lock {
            schema: 1,
            mods: vec![
                entry("a", &["b"], Some(ABI)),
                entry("b", &["c", "base"], Some(ABI)),
                entry("c", &[], Some(ABI)),
                entry("d", &[], Some(ABI)),
            ],
        };
        let mut deps = lock.deps_of("a");
        deps.sort();
        assert_eq!(deps, ["b", "c"]);
        let mut dependents = lock.dependents_of("c");
        dependents.sort();
        assert_eq!(dependents, ["a", "b"]);
        assert!(lock.dependents_of("d").is_empty());
    }
}
