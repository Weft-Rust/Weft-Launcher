//! The mod manager's operations, one per command, on a [`Ctx`]. The rules they apply live in
//! `plan.rs` and `profile.rs`; this is where the disk, the network and the locks come in.
//!
//! - Every change to a profile or the store happens under `ModsLock`, so two clicks never write
//!   `mods.lock.json` at once. Downloads happen before taking it.
//! - The consent boundary is the plan the player reviewed. `plan`, `copy_preview` and
//!   `inspect_file` hand the page a `planToken` ([`plan::Consent`]); `install`, `copy` and
//!   `install_file` take it back. The token is recomputed from the current catalogue, profile
//!   and ABI before anything is downloaded and again under the lock at commit; when it differs,
//!   the command fails with `ModChangedMeanwhile` and writes nothing (see [`commit`]).
//! - Each of those commands, and `restore`, runs as an [`Operation`] with the page's id: its
//!   progress carries that id, and `cancel_mod_operation` stops it until it starts writing.
//! - Nothing rewrites a version's `mods/` folder while its game runs. Revocations that arrive
//!   meanwhile are reported as pending and applied when it stops ([`apply_pending`]).
//! - Hashing and copying files run off the async runtime ([`blocking`]).

use std::path::PathBuf;
use std::time::Duration;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::OwnedMutexGuard;

use super::abi::{abi_for_tag, cached_abi};
use super::archive::current_platform;
use super::catalog::{self, Catalog, CatalogMod, CatalogVersion, IndexStatus, SourceResult};
use super::context::{Ctx, Operation, Step, blocking, check_sha, ensure_installed};
use super::error::ModsError;
use super::index::{self, IndexCache, IndexState, RESERVED_ID};
use super::inspect::{self, FileInspection};
use super::install::{self, ProgressStage};
use super::paths::{Paths, write_atomic};
use super::plan::{
    self, ChangeResult, CopyOutcome, CopyPreview, CopyResult, InstallPlan, Resolution, plan_token,
};
use super::profile::{self, Fit, Lock, PlayerFile, ProfileReport};
use super::sources::{self, SourceFetch};
use super::store::{self, Removed, Reservation};
use crate::download::{read_capped, sha256_file};
use crate::error::AppError;

/// For the index, sources, icons and the ABI: redirects stay on GitHub, over https.
pub fn http() -> Result<reqwest::Client, ModsError> {
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .redirect(crate::download::redirect_policy())
        .build()?)
}

// ---------------------------------------------------------------------------------------------
// Catalogue

fn rfc3339(t: OffsetDateTime) -> String {
    t.format(&Rfc3339).unwrap_or_default()
}

fn source_result(repo: String, f: SourceFetch) -> SourceResult {
    SourceResult {
        repo,
        mods: f.mods,
        freshness: f.freshness,
        checked: f.checked,
        error: f.error.map(AppError::from),
        no_mods: f.no_mods,
    }
}

/// The player's sources, or none and why: a damaged list is kept aside and said, never
/// taken for an empty one.
fn listed_sources(paths: &Paths) -> (Vec<String>, Option<AppError>) {
    match sources::list(paths) {
        Ok(repos) => (repos, None),
        Err(e) => (Vec::new(), Some(e.into())),
    }
}

fn build_catalog(state: IndexState, sources: Vec<SourceResult>) -> Catalog {
    let status = IndexStatus {
        freshness: state.freshness,
        generated: state.index.as_ref().map(|i| i.generated.clone()),
        signed_at: state.signed_at.map(rfc3339),
        error: state.error.map(AppError::from),
    };
    catalog::build(state.index.as_ref(), status, sources)
}

fn index_cache(paths: &Paths) -> IndexCache {
    IndexCache::new(&paths.cache_dir(), index::public_key())
}

/// The index and every source; refreshed from the network when `refresh` is set. The page sees
/// this list, and installs only what is in it.
pub async fn load_catalog(ctx: &Ctx, refresh: bool) -> Result<Catalog, ModsError> {
    let client = http()?;
    let cache = index_cache(&ctx.paths);
    let url = index::index_url();
    let state = index::load(&cache, refresh, OffsetDateTime::now_utc(), async {
        let bytes = index::fetch_bytes(&client, &url).await?;
        let sig = index::fetch_bytes(&client, &format!("{url}.minisig")).await?;
        let sig = String::from_utf8(sig)
            .map_err(|_| ModsError::IndexSignatureInvalid("not text".into()))?;
        Ok((bytes, sig))
    })
    .await;
    let mut fetched = Vec::new();
    let (repos, sources_error) = listed_sources(&ctx.paths);
    for repo in repos {
        let f = sources::fetch(&ctx.paths, &client, &repo, refresh).await;
        fetched.push(source_result(repo, f));
    }
    let catalog = Catalog {
        sources_error,
        ..build_catalog(state, fetched)
    };
    ctx.hold_catalog(catalog.clone());
    Ok(catalog)
}

/// The catalogue from what is on disk: the cached index and each source's last answer.
pub fn offline_catalog(paths: &Paths) -> Catalog {
    let state = index::cached(&index_cache(paths), OffsetDateTime::now_utc());
    let (repos, sources_error) = listed_sources(paths);
    let sources = repos
        .into_iter()
        .map(|repo| {
            let f = sources::cached(paths, &repo);
            source_result(repo, f)
        })
        .collect();
    Catalog {
        sources_error,
        ..build_catalog(state, sources)
    }
}

/// The list the page last saw, else the one on disk: never touches the network.
pub async fn current_catalog(ctx: &Ctx) -> Result<Catalog, ModsError> {
    if let Some(c) = ctx.held_catalog() {
        return Ok(c);
    }
    let paths = ctx.paths.clone();
    blocking(move || Ok(offline_catalog(&paths))).await
}

pub const MAX_ICON_BYTES: usize = 512 * 1024;
const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

/// An icon's bytes, read up to [`MAX_ICON_BYTES`] and only if they are a PNG.
pub async fn fetch_icon(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, ModsError> {
    let response = client
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(ModsError::Http {
            status: response.status().as_u16(),
            url: url.to_string(),
        });
    }
    let bytes = read_capped(response, MAX_ICON_BYTES)
        .await?
        .ok_or_else(|| ModsError::TooLarge("icon over 512 KB".into()))?;
    if !bytes.starts_with(PNG_MAGIC) {
        return Err(ModsError::IconInvalid(url.to_string()));
    }
    Ok(bytes)
}

/// A catalogue icon as PNG bytes, from the cache or the network. Only icons the catalogue
/// names, and only over https.
pub async fn icon_png(ctx: &Ctx, url: &str) -> Result<Vec<u8>, ModsError> {
    let known = ctx
        .held_catalog()
        .is_some_and(|c| c.mods.iter().any(|m| m.icon.as_deref() == Some(url)));
    if !known || !url.starts_with("https://") {
        return Err(ModsError::NotInCatalog(url.to_string()));
    }
    let cache = ctx.paths.cache_dir().join("mod-icons").join(format!(
        "{}.png",
        &crate::download::sha256_hex(url.as_bytes())[..32]
    ));
    if let Ok(bytes) = std::fs::read(&cache)
        && bytes.len() <= MAX_ICON_BYTES
        && bytes.starts_with(PNG_MAGIC)
    {
        return Ok(bytes);
    }
    let bytes = fetch_icon(&http()?, url).await?;
    let _ = write_atomic(&cache, &bytes);
    Ok(bytes)
}

// ---------------------------------------------------------------------------------------------
// Sources

/// The player's sources; `ModSourcesDamaged` when the list couldn't be read (it is kept aside).
pub fn source_list(ctx: &Ctx) -> Result<Vec<String>, ModsError> {
    sources::list(&ctx.paths)
}

/// Adds a repo as GitHub spells it. Adding one already there, in any case, keeps one entry.
pub async fn add_source(ctx: &Ctx, repo: &str) -> Result<Vec<String>, ModsError> {
    let repo = sources::normalize(repo)?;
    let canonical = sources::canonical_name(&http()?, ctx.github_api(), &repo).await?;
    let _held = ctx.lock_mods().await;
    // A damaged list is already kept aside: this starts a new one.
    let repos = sources::with_repo(sources::list_for_change(&ctx.paths)?, &canonical);
    sources::save(&ctx.paths, &repos)?;
    Ok(repos)
}

/// Mods installed from the repo stay installed; they just stop getting updates.
pub async fn remove_source(ctx: &Ctx, repo: &str) -> Result<Vec<String>, ModsError> {
    let _held = ctx.lock_mods().await;
    let repos = sources::without_repo(sources::list(&ctx.paths)?, repo);
    sources::save(&ctx.paths, &repos)?;
    Ok(repos)
}

// ---------------------------------------------------------------------------------------------
// Profiles

pub async fn version_abi(
    paths: &Paths,
    catalog: &Catalog,
    tag: &str,
    network: bool,
) -> (Option<String>, Option<AppError>) {
    if let Some(abi) = cached_abi(paths, tag, &catalog.weft) {
        return (Some(abi), None);
    }
    if !network {
        return (
            None,
            Some(ModsError::AbiUnavailable(tag.to_string()).into()),
        );
    }
    let client = match http() {
        Ok(c) => c,
        Err(e) => return (None, Some(e.into())),
    };
    match abi_for_tag(paths, &client, tag, &catalog.weft).await {
        Ok(abi) => (Some(abi), None),
        Err(e) => (None, Some(e.into())),
    }
}

/// The version's mod interface, or why it can't be known: nothing can be installed without it.
pub async fn require_abi(paths: &Paths, catalog: &Catalog, tag: &str) -> Result<String, ModsError> {
    match version_abi(paths, catalog, tag, true).await {
        (Some(abi), _) => Ok(abi),
        (None, error) => Err(ModsError::AbiUnavailable(
            error
                .and_then(|e| e.detail)
                .unwrap_or_else(|| tag.to_string()),
        )),
    }
}

/// What the player put into their own Weft mods folder, which every version loads after the
/// launcher's. Only listed, never changed.
async fn unmanaged(paths: &Paths) -> Vec<PlayerFile> {
    let Some(folder) = crate::launch::find_game_folder_in(&paths.logs_dir()).await else {
        return Vec::new();
    };
    player_files(&folder.join("mods"))
}

pub fn player_files(dir: &std::path::Path) -> Vec<PlayerFile> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PlayerFile> = entries
        .flatten()
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            PlayerFile::new(&name, e.path().is_dir())
        })
        .filter(|f| !f.file.starts_with('.'))
        .collect();
    files.sort_by(|a, b| a.file.cmp(&b.file));
    files
}

pub async fn build_report(
    ctx: &Ctx,
    tag: &str,
    lock: &Lock,
    catalog: &Catalog,
    network: bool,
) -> ProfileReport {
    let (abi, abi_error) = version_abi(&ctx.paths, catalog, tag, network).await;
    profile::report(
        tag,
        lock,
        abi,
        abi_error,
        catalog,
        current_platform(),
        unmanaged(&ctx.paths).await,
    )
}

/// The profile after a change, with nothing else to report yet.
async fn change_result(ctx: &Ctx, tag: &str, lock: &Lock, catalog: &Catalog) -> ChangeResult {
    ChangeResult::of(build_report(ctx, tag, lock, catalog, false).await)
}

/// Makes the version's `mods/` folder hold exactly its turned-on mods.
async fn reconcile(ctx: &Ctx, tag: &str, lock: &Lock) -> Result<(), ModsError> {
    let (paths, tag, lock) = (ctx.paths.clone(), tag.to_string(), lock.clone());
    blocking(move || store::reconcile(&paths, &tag, &lock)).await
}

/// Writes a changed mod set under `ModsLock`. Three files change, each atomically, in an order
/// where stopping after any step (an error, or the launcher being closed) leaves a state that
/// is still true:
///
/// 1. The undo record of an earlier removal goes first, since this is the version's next
///    change. If that fails, nothing changed.
/// 2. `mods.lock.json`, the one record of the set. If that fails, nothing changed but the
///    lost Undo. Once it is written, the change is made.
/// 3. For a removal, its undo record. If that fails, the removal stands without an Undo:
///    `false` says so, and nothing else is wrong.
/// 4. The version's `mods/` folder, made to match the lock. If that fails, the error is
///    returned with the change made: the folder is made to match again by the next change and
///    before every Play ([`prepare_launch`]), so the game never starts with the old one.
///
/// `held` reservations are let go once the lock file names their builds, and unused store
/// files go. Returns whether an undo record for `undo` was kept.
async fn save(
    ctx: &Ctx,
    tag: &str,
    lock: &Lock,
    undo: Option<&Removed>,
    held: Vec<Reservation>,
) -> Result<bool, ModsError> {
    if undo.is_none() {
        store::clear_removed(&ctx.paths, tag)?;
    }
    store::write_lock(&ctx.paths, tag, lock)?;
    let kept = match undo {
        Some(removed) => match store::write_removed(&ctx.paths, tag, removed) {
            Ok(()) => true,
            Err(e) => {
                eprintln!("mods: the removal from {tag} can't be undone: {e}");
                false
            }
        },
        None => false,
    };
    drop(held);
    reconcile(ctx, tag, lock).await?;
    ctx.collect_garbage().await;
    Ok(kept)
}

/// Records and applies the catalogue's revocations to the version's mod set, unless its game
/// is running: then the lock and the folder stay as the game started with them, and the report
/// lists the revoked mods as pending. The caller holds `ModsLock`.
async fn apply_revocations(ctx: &Ctx, tag: &str, catalog: &Catalog) -> Result<Lock, ModsError> {
    let lock = store::read_lock(&ctx.paths, tag)?;
    let mut applied = lock.clone();
    if !profile::apply_revocations(&mut applied, catalog) {
        return Ok(lock);
    }
    if ctx.is_running(tag) {
        return Ok(lock);
    }
    store::write_lock(&ctx.paths, tag, &applied)?;
    reconcile(ctx, tag, &applied).await?;
    Ok(applied)
}

/// The version's mod set, with revocations applied (or pending, while its game runs).
pub async fn profile(ctx: &Ctx, tag: &str) -> Result<ProfileReport, ModsError> {
    ensure_installed(&ctx.paths, tag)?;
    let catalog = current_catalog(ctx).await?;
    let lock = {
        let _held = ctx.lock_mods().await;
        apply_revocations(ctx, tag, &catalog).await?
    };
    Ok(build_report(ctx, tag, &lock, &catalog, true).await)
}

/// After the version's game stopped: the revocations that waited for it.
pub async fn apply_pending(ctx: &Ctx, tag: &str) -> Result<(), ModsError> {
    if ensure_installed(&ctx.paths, tag).is_err() {
        return Ok(());
    }
    let catalog = current_catalog(ctx).await?;
    let _held = ctx.lock_mods().await;
    apply_revocations(ctx, tag, &catalog).await.map(|_| ())
}

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

fn plan_changed() -> ModsError {
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

async fn run_install(
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

struct CopyInputs {
    catalog: Catalog,
    abi: String,
    preview: CopyPreview,
    picks: Vec<(CatalogMod, CatalogVersion)>,
}

async fn copy_inputs(ctx: &Ctx, from: &str, to: &str) -> Result<CopyInputs, ModsError> {
    ensure_installed(&ctx.paths, to)?;
    let source = store::read_lock(&ctx.paths, from)?;
    let target = store::read_lock(&ctx.paths, to)?;
    let catalog = current_catalog(ctx).await?;
    let abi = require_abi(&ctx.paths, &catalog, to).await?;
    let (preview, picks) =
        plan::copy_preview(&catalog, (from, &source), (to, &target), Fit::here(&abi));
    Ok(CopyInputs {
        catalog,
        abi,
        preview,
        picks,
    })
}

/// What `copy` would bring over.
pub async fn copy_preview(ctx: &Ctx, from: &str, to: &str) -> Result<CopyPreview, ModsError> {
    Ok(copy_inputs(ctx, from, to).await?.preview)
}

/// Brings the turned-on mods of one version to another, each as the build made for the new one,
/// as previewed with `plan_token`. Mods the new version already has are left as they are.
pub async fn copy(
    ctx: &Ctx,
    from: &str,
    to: &str,
    plan_token: &str,
    operation_id: &str,
) -> Result<CopyResult, ModsError> {
    let op = ctx.operations.begin(operation_id)?;
    ctx.ensure_not_running(to)?;
    let inputs = copy_inputs(ctx, from, to).await?;
    if inputs.preview.plan_token != plan_token {
        return Err(plan_changed());
    }
    let left_behind = inputs
        .preview
        .items
        .into_iter()
        .filter(|i| {
            matches!(
                i.outcome,
                CopyOutcome::NoBuild | CopyOutcome::LocalFile | CopyOutcome::Revoked
            )
        })
        .collect();
    let change = if inputs.picks.is_empty() {
        let lock = store::read_lock(&ctx.paths, to)?;
        change_result(ctx, to, &lock, &inputs.catalog).await
    } else {
        let agreed = Agreed {
            plan_token,
            op: &op,
        };
        run_install(
            ctx,
            to,
            inputs.catalog,
            inputs.abi,
            inputs.picks,
            Vec::new(),
            agreed,
        )
        .await?
    };
    Ok(CopyResult {
        change,
        left_behind,
    })
}

/// A deleted game version takes its mod set along.
pub async fn forget_version(ctx: &Ctx, tag: &str) {
    let _guard = ctx.lock_mods().await;
    let (paths, reservations, tag) = (ctx.paths.clone(), ctx.reservations.clone(), tag.to_string());
    let _ = blocking(move || {
        store::forget_version(&paths, &reservations, &tag);
        Ok(())
    })
    .await;
}

// ---------------------------------------------------------------------------------------------
// Before Play

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
