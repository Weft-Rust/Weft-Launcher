//! Before Play: what the game is handed, or why it would not start.

use super::*;

/// What Play does with a version's mod set.
#[derive(Debug, PartialEq, Eq)]
pub enum LaunchPlan {
    /// Nothing is on: the game starts without `--mods`.
    NoMods,
    /// `--mods <the version's mods folder>`.
    Mods,
    /// The game would refuse to start: the names of the mods that stop it.
    Blocked(Vec<String>),
}

/// Blockers come first: the player's own folder loads even without `--mods`, so a revoked mod
/// shadowed there blocks with nothing on.
pub fn launch_plan(lock: &Lock, report: &ProfileReport) -> LaunchPlan {
    if !report.blocking.is_empty() {
        return LaunchPlan::Blocked(report.blocking.iter().map(|id| lock.name_of(id)).collect());
    }
    if lock.mods.iter().any(|m| m.enabled) {
        LaunchPlan::Mods
    } else {
        LaunchPlan::NoMods
    }
}

/// The outcome of the pre-Play check. Holds `ModsLock` until [`LaunchMods::release`], so no mod
/// change can land between this check and the game counting as running.
pub struct LaunchMods {
    dir: Option<PathBuf>,
    _held: OwnedMutexGuard<()>,
}

impl LaunchMods {
    /// The folder to hand to `--mods`, letting mod changes go ahead again.
    pub fn release(self) -> Option<PathBuf> {
        self.dir
    }
}

/// Before Play: the folder to hand to `--mods`, or why the game would not start. Never touches
/// the network: it uses the catalogue the page last saw or the cached one, and the cached ABI.
/// Without a known ABI the mods are only unchecked, and the game itself has the last word.
pub async fn prepare_launch(ctx: &Ctx, tag: &str) -> Result<LaunchMods, ModsError> {
    let catalog = current_catalog(ctx).await?;
    let held = ctx.lock_mods().await;
    ctx.ensure_not_running(tag)?;
    let mut lock = store::read_lock(&ctx.paths, tag)?;
    if profile::apply_revocations(&mut lock, &catalog) {
        store::write_lock(&ctx.paths, tag, &lock)?;
    }
    reconcile(ctx, tag, &lock).await?;
    let report = build_report(ctx, tag, &lock, &catalog, false).await;
    let dir = match launch_plan(&lock, &report) {
        LaunchPlan::NoMods => None,
        LaunchPlan::Mods => Some(ctx.paths.mods_dir(tag)?),
        LaunchPlan::Blocked(names) => return Err(ModsError::Blocked(names.join(", "))),
    };
    Ok(LaunchMods { dir, _held: held })
}
