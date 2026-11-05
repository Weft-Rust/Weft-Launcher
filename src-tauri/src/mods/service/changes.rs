//! Changes to one version's set: plan, install (from the catalogue or a file), turn on or off,
//! remove and restore. Each checks the plan again under `ModsLock` before it writes.

use super::*;

/// What `install` would do with this build, without doing it.
pub async fn plan(ctx: &Ctx, tag: &str, sha256: &str) -> Result<InstallPlan, ModsError> {
    ensure_installed(&ctx.paths, tag)?;
    let sha = check_sha(sha256)?;
    let catalog = current_catalog(ctx).await?;
    let lock = store::read_lock(&ctx.paths, tag)?;
    let (abi, _) = version_abi(&ctx.paths, &catalog, tag, true).await;
    let fit = abi.as_deref().map(Fit::here);
    plan::plan_install(&catalog, &lock, tag, &sha, fit, ctx.is_running(tag))
}

// ---------------------------------------------------------------------------------------------
// Installing: stage, fetch, commit

/// An install resolved against the profile as it was, with its builds reserved, and the token
/// of what it does.
pub struct Staged {
    tag: String,
    catalog: Catalog,
    abi: String,
    wanted: Vec<(CatalogMod, CatalogVersion)>,
    snapshot: Lock,
    res: Resolution,
    held: Vec<Reservation>,
    pub token: String,
}

pub(super) fn plan_changed() -> ModsError {
    ModsError::ChangedMeanwhile("what this does changed since it was shown".into())
}

impl Staged {
    /// `ModChangedMeanwhile` unless this is the plan the player agreed to.
    pub fn agree(&self, plan_token: &str) -> Result<(), ModsError> {
        if self.token == plan_token {
            Ok(())
        } else {
            Err(plan_changed())
        }
    }
}

/// Resolves what `wanted` needs. `held` are reservations the caller already took.
pub fn stage(
    ctx: &Ctx,
    tag: &str,
    catalog: Catalog,
    abi: String,
    wanted: Vec<(CatalogMod, CatalogVersion)>,
    mut held: Vec<Reservation>,
) -> Result<Staged, ModsError> {
    let snapshot = store::read_lock(&ctx.paths, tag)?;
    let res = plan::resolve(&catalog, &snapshot, wanted.clone(), Fit::here(&abi));
    let token = plan_token(Some(&abi), &snapshot, &res);
    held.extend(
        res.picks
            .iter()
            .map(|(_, v)| ctx.reservations.reserve(&v.sha256)),
    );
    Ok(Staged {
        tag: tag.to_string(),
        catalog,
        abi,
        wanted,
        snapshot,
        res,
        held,
        token,
    })
}

fn step<'a>(op: &'a Operation, picks: &'a [(CatalogMod, CatalogVersion)], i: usize) -> Step<'a> {
    Step {
        op,
        index: i + 1,
        count: picks.len(),
        sha256: &picks[i].1.sha256,
        mod_id: &picks[i].0.id,
    }
}

/// Downloads every build the install needs into the store, unless it is there and intact.
pub async fn fetch(ctx: &Ctx, staged: &Staged, op: &Operation) -> Result<(), ModsError> {
    let platform = Fit::here(&staged.abi).platform;
    let picks = &staged.res.picks;
    for (i, (m, v)) in picks.iter().enumerate() {
        let at = step(op, picks, i);
        install::fetch_to_store(
            &ctx.paths,
            m,
            v,
            platform,
            op,
            ctx.checks_urls(),
            |stage, percent| ctx.emit(at, stage, percent),
        )
        .await?;
    }
    Ok(())
}

/// What every write that follows a download checks first, under `ModsLock`: the operation wasn't
/// cancelled, and the game version is still installed and not running. Gives the latest
/// catalogue: the one the page last loaded, else `fallback`.
fn recheck_under_lock(
    ctx: &Ctx,
    tag: &str,
    op: &Operation,
    fallback: Catalog,
) -> Result<Catalog, ModsError> {
    op.check()?;
    if ensure_installed(&ctx.paths, tag).is_err() {
        return Err(ModsError::ChangedMeanwhile(format!("{tag} was removed")));
    }
    if ctx.is_running(tag) {
        return Err(ModsError::ChangedMeanwhile(format!("{tag} was started")));
    }
    Ok(ctx.held_catalog().unwrap_or(fallback))
}

/// Writes a downloaded install into the profile. Under `ModsLock`, it first checks that what
/// the player agreed to still holds ([`recheck_under_lock`]), and then that the consent does:
/// every wanted build is read again from the latest catalogue (the same hash may come with
/// other trust, dependencies or interface now) and must still be installable on the version's
/// mod interface as it is known now; none of the builds is revoked; and resolving again
/// against the latest profile, catalogue and interface gives the same plan token. Otherwise
/// `ModChangedMeanwhile` (`ModCancelled` if the operation was cancelled), and nothing is
/// written.
pub async fn commit(ctx: &Ctx, staged: Staged, op: &Operation) -> Result<ChangeResult, ModsError> {
    let Staged {
        tag,
        catalog,
        abi,
        wanted,
        snapshot,
        res,
        held,
        token,
    } = staged;
    let _guard = ctx.lock_mods().await;
    let catalog = recheck_under_lock(ctx, &tag, op, catalog)?;
    let changed = ModsError::ChangedMeanwhile;
    let abi_now = cached_abi(&ctx.paths, &tag, &catalog.weft).unwrap_or_else(|| abi.clone());
    if abi_now != abi {
        return Err(changed(format!("the mod interface of {tag} changed")));
    }
    let mut fresh = Vec::with_capacity(wanted.len());
    for (m, v) in &wanted {
        let Some((m, v)) = catalog.find(&v.sha256) else {
            return Err(changed(format!(
                "{} {} is no longer in the catalogue",
                m.name, v.version
            )));
        };
        fresh.push((m.clone(), v.clone()));
    }
    for (m, v) in &res.picks {
        if let Some(r) = catalog.revocation(&v.sha256) {
            return Err(changed(format!(
                "{} {} was revoked: {}",
                m.name,
                v.version,
                r.detail()
            )));
        }
    }
    for (m, v) in &fresh {
        plan::check_installable(&catalog, m, v, Fit::here(&abi_now))
            .map_err(|e| changed(format!("{} {}: {e}", m.name, v.version)))?;
    }
    let mut lock = store::read_lock(&ctx.paths, &tag)?;
    let now = plan::resolve(&catalog, &lock, fresh, Fit::here(&abi_now));
    plan::still_holds((&snapshot, &res), (&lock, &now)).map_err(changed)?;
    if plan_token(Some(&abi_now), &lock, &now) != token {
        return Err(plan_changed());
    }

    op.start_writing()?;
    for i in 0..now.picks.len() {
        ctx.emit(step(op, &now.picks, i), ProgressStage::Installing, 100);
    }
    let done = plan::commit(&mut lock, &now);
    save(ctx, &tag, &lock, None, held).await?;
    Ok(ChangeResult {
        installed: done.installed,
        also_enabled: done.also_enabled,
        installed_off: done.installed_off,
        missing: now.missing,
        ..change_result(ctx, &tag, &lock, &catalog).await
    })
}

/// Downloads and commits a staged install. A cancelled one also takes the builds it already
/// stored along, so it leaves no trace.
async fn finish(ctx: &Ctx, staged: Staged, op: &Operation) -> Result<ChangeResult, ModsError> {
    let result = match fetch(ctx, &staged, op).await {
        Ok(()) => commit(ctx, staged, op).await,
        Err(e) => {
            drop(staged);
            Err(e)
        }
    };
    if matches!(result, Err(ModsError::Cancelled)) {
        let _held = ctx.lock_mods().await;
        ctx.collect_garbage().await;
    }
    result
}

/// The operations a command takes for an install it agreed to.
pub struct Agreed<'a> {
    pub plan_token: &'a str,
    pub op: &'a Operation,
}

pub(super) async fn run_install(
    ctx: &Ctx,
    tag: &str,
    catalog: Catalog,
    abi: String,
    wanted: Vec<(CatalogMod, CatalogVersion)>,
    held: Vec<Reservation>,
    agreed: Agreed<'_>,
) -> Result<ChangeResult, ModsError> {
    let staged = stage(ctx, tag, catalog, abi, wanted, held)?;
    staged.agree(agreed.plan_token)?;
    finish(ctx, staged, agreed.op).await
}

/// Installs the catalogue build with this hash, and what it needs, as planned by [`plan`] with
/// `plan_token`. Installing another build of an installed mod replaces it and keeps it on or off
/// as it was; a mod that needs something missing, at any depth, is installed turned off.
pub async fn install(
    ctx: &Ctx,
    tag: &str,
    sha256: &str,
    plan_token: &str,
    operation_id: &str,
) -> Result<ChangeResult, ModsError> {
    let op = ctx.operations.begin(operation_id)?;
    ensure_installed(&ctx.paths, tag)?;
    let sha = check_sha(sha256)?;
    ctx.ensure_not_running(tag)?;
    let catalog = current_catalog(ctx).await?;
    let (m, v) = catalog
        .find(&sha)
        .map(|(m, v)| (m.clone(), v.clone()))
        .ok_or_else(|| ModsError::NotInCatalog(sha.clone()))?;
    let abi = require_abi(&ctx.paths, &catalog, tag).await?;
    plan::check_installable(&catalog, &m, &v, Fit::here(&abi))?;
    let agreed = Agreed {
        plan_token,
        op: &op,
    };
    run_install(ctx, tag, catalog, abi, vec![(m, v)], Vec::new(), agreed).await
}

/// What the launcher can tell about a zip from the player's computer, before installing it.
pub async fn inspect_file(ctx: &Ctx, tag: &str, path: &str) -> Result<FileInspection, ModsError> {
    ensure_installed(&ctx.paths, tag)?;
    let catalog = current_catalog(ctx).await?;
    let (abi, _) = version_abi(&ctx.paths, &catalog, tag, true).await;
    let lock = store::read_lock(&ctx.paths, tag)?;
    let path = PathBuf::from(path);
    blocking(move || inspect::inspect(&path, &catalog, abi.as_deref(), current_platform(), &lock))
        .await
}

/// Installs a zip from the player's computer. `sha256` and `plan_token` are what
/// `inspect_file` showed, so a file swapped in between, or a plan that changed, is refused. A
/// file that is in the catalogue installs from these same bytes, with the catalogue's metadata,
/// trust and dependencies; anything else is Unverified. Either way, revocations are checked
/// again under the lock before anything is written, by the file's hash.
pub async fn install_file(
    ctx: &Ctx,
    tag: &str,
    path: &str,
    sha256: &str,
    plan_token: &str,
    operation_id: &str,
) -> Result<ChangeResult, ModsError> {
    let op = ctx.operations.begin(operation_id)?;
    ensure_installed(&ctx.paths, tag)?;
    let sha = check_sha(sha256)?;
    ctx.ensure_not_running(tag)?;
    let catalog = current_catalog(ctx).await?;
    if let Some(r) = catalog.revocation(&sha) {
        return Err(ModsError::Revoked(r.detail()));
    }
    let source = PathBuf::from(path);
    inspect::checked_size(&source)?;
    let hold = ctx.reservations.reserve(&sha);
    let admit = |id: Option<String>, platform| {
        let (paths, source, sha) = (ctx.paths.clone(), source.clone(), sha.clone());
        blocking(move || store::admit_local(&paths, &source, &sha, id.as_deref(), platform))
    };

    if let Some((m, v)) = catalog.find(&sha).map(|(m, v)| (m.clone(), v.clone())) {
        let abi = require_abi(&ctx.paths, &catalog, tag).await?;
        let platform = Fit::here(&abi).platform;
        plan::check_installable(&catalog, &m, &v, Fit::here(&abi))?;
        let staged = stage(ctx, tag, catalog, abi, vec![(m.clone(), v)], vec![hold])?;
        staged.agree(plan_token)?;
        let at = step(&op, &staged.res.picks, 0);
        ctx.emit(at, ProgressStage::Verifying, 0);
        admit(Some(m.id.clone()), platform).await?;
        ctx.emit(at, ProgressStage::Verifying, 100);
        return finish(ctx, staged, &op).await;
    }

    let (abi, _) = version_abi(&ctx.paths, &catalog, tag, true).await;
    let at = Step {
        op: &op,
        index: 1,
        count: 1,
        sha256: &sha,
        mod_id: "",
    };
    let result = async {
        ctx.emit(at, ProgressStage::Verifying, 0);
        let info = admit(None, current_platform()).await?;
        if info.id == RESERVED_ID {
            return Err(ModsError::IdReserved(info.id));
        }
        let at = Step {
            mod_id: &info.id,
            ..at
        };
        ctx.emit(at, ProgressStage::Verifying, 100);
        let mut entry = inspect::local_entry(&info, &ctx.paths.store_object(&sha), &source, &sha)?;

        let _guard = ctx.lock_mods().await;
        let latest = recheck_under_lock(ctx, tag, &op, catalog)?;
        // A revocation that arrived while the file was copied and hashed.
        if let Some(r) = latest.revocation(&sha) {
            return Err(ModsError::Revoked(r.detail()));
        }
        let mut lock = store::read_lock(&ctx.paths, tag)?;
        if inspect::file_token(abi.as_deref(), &info.id, &sha, &lock) != plan_token {
            return Err(plan_changed());
        }
        op.start_writing()?;
        ctx.emit(at, ProgressStage::Installing, 100);
        entry.enabled = lock.get(&entry.id).is_none_or(|e| e.enabled);
        lock.put(entry);
        save(ctx, tag, &lock, None, vec![hold]).await?;
        Ok((lock, latest, info.id))
    }
    .await;
    match result {
        Ok((lock, latest, id)) => Ok(ChangeResult {
            installed: vec![id],
            ..change_result(ctx, tag, &lock, &latest).await
        }),
        Err(e) => {
            // Whatever reached the store is nobody's now.
            let _held = ctx.lock_mods().await;
            ctx.collect_garbage().await;
            Err(e)
        }
    }
}

// ---------------------------------------------------------------------------------------------
// On, off, remove, undo

/// Turning a mod on turns on the installed mods it needs, and is refused when one of them is
/// revoked; turning it off turns off what needs it.
pub async fn set_enabled(
    ctx: &Ctx,
    tag: &str,
    id: &str,
    enabled: bool,
) -> Result<ChangeResult, ModsError> {
    ensure_installed(&ctx.paths, tag)?;
    ctx.ensure_not_running(tag)?;
    let catalog = current_catalog(ctx).await?;
    let _guard = ctx.lock_mods().await;
    ctx.ensure_not_running(tag)?;
    let mut lock = store::read_lock(&ctx.paths, tag)?;
    let (also_enabled, also_disabled) = plan::set_enabled(&mut lock, &catalog, id, enabled)?;
    save(ctx, tag, &lock, None, Vec::new()).await?;
    Ok(ChangeResult {
        also_enabled,
        also_disabled,
        ..change_result(ctx, tag, &lock, &catalog).await
    })
}

/// Removes a mod and turns off what needed it. Until the version's next change, the removal
/// can be undone with [`restore`]: the entry is kept, and so is its store file.
pub async fn remove(ctx: &Ctx, tag: &str, id: &str) -> Result<ChangeResult, ModsError> {
    ensure_installed(&ctx.paths, tag)?;
    ctx.ensure_not_running(tag)?;
    let catalog = current_catalog(ctx).await?;
    let _guard = ctx.lock_mods().await;
    ctx.ensure_not_running(tag)?;
    let mut lock = store::read_lock(&ctx.paths, tag)?;
    let entry = lock
        .get(id)
        .cloned()
        .ok_or_else(|| ModsError::NotInstalled(id.to_string()))?;
    let also_disabled = plan::remove(&mut lock, id)?;
    let removed = Removed {
        entry,
        also_disabled: also_disabled.clone(),
    };
    let kept = save(ctx, tag, &lock, Some(&removed), Vec::new()).await?;
    Ok(ChangeResult {
        also_disabled,
        undo: kept.then(|| id.to_string()),
        ..change_result(ctx, tag, &lock, &catalog).await
    })
}

/// Puts the most recently removed mod back exactly as it was: the same build, on or off as it
/// was, and the mods its removal turned off on again. `ModNotInstalled` when that isn't
/// possible any more: the version changed since, or the store file is gone or changed.
pub async fn restore(
    ctx: &Ctx,
    tag: &str,
    id: &str,
    operation_id: &str,
) -> Result<ChangeResult, ModsError> {
    let op = ctx.operations.begin(operation_id)?;
    ensure_installed(&ctx.paths, tag)?;
    ctx.ensure_not_running(tag)?;
    let catalog = current_catalog(ctx).await?;
    let _guard = ctx.lock_mods().await;
    ctx.ensure_not_running(tag)?;
    let gone = || ModsError::NotInstalled(id.to_string());
    let removed = store::read_removed(&ctx.paths, tag)?
        .filter(|r| r.entry.id == id)
        .ok_or_else(gone)?;
    let mut lock = store::read_lock(&ctx.paths, tag)?;
    if lock.get(id).is_some() {
        return Err(gone());
    }
    let (stored, sha) = (
        ctx.paths.store_object(&removed.entry.sha256),
        removed.entry.sha256.clone(),
    );
    let at = Step {
        op: &op,
        index: 1,
        count: 1,
        sha256: &removed.entry.sha256,
        mod_id: &removed.entry.id,
    };
    ctx.emit(at, ProgressStage::Verifying, 0);
    let intact =
        blocking(move || Ok(sha256_file(&stored).is_ok_and(|actual| actual == sha))).await?;
    if !intact {
        return Err(gone());
    }
    op.start_writing()?;
    ctx.emit(at, ProgressStage::Installing, 100);
    lock.put(removed.entry);
    let mut also_enabled = Vec::new();
    for dep in &removed.also_disabled {
        if let Some(e) = lock.get_mut(dep)
            && !e.enabled
        {
            e.enabled = true;
            also_enabled.push(dep.clone());
        }
    }
    profile::apply_revocations(&mut lock, &catalog);
    also_enabled.retain(|id| lock.get(id).is_some_and(|e| e.enabled));
    save(ctx, tag, &lock, None, Vec::new()).await?;
    Ok(ChangeResult {
        also_enabled,
        ..change_result(ctx, tag, &lock, &catalog).await
    })
}

// ---------------------------------------------------------------------------------------------
// Copying a mod set
