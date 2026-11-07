//! The operations in `service/`, run as the app runs them but without Tauri: a [`Ctx`] on a
//! temporary folder, a catalogue held as if the page had loaded it, and a local HTTP server
//! standing in for GitHub.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use super::archive::tests::make_zip;
use super::catalog::{Catalog, CatalogVersion, Origin, RevokedView};
use super::context::{Ctx, tests::with_version};
use super::error::ModsError;
use super::index::{Channel, Platform, WeftAbi};
use super::install::ProgressStage;
use super::plan::ChangeResult;
use super::profile::tests::{ABI, build, catalog, catalog_mod};
use super::profile::{Lock, ModStatus};
use super::service::{self, LaunchPlan};
use super::store;
use crate::download::sha256_hex;

const TAG: &str = "v1";

fn run<F: Future>(fut: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(fut)
}

/// What the stand-in server answers: status, extra headers, body.
type Answer = (u16, Vec<(&'static str, String)>, Vec<u8>);

/// Serves `answer(path)` to every request until the test ends. Returns the base URL.
fn serve(answer: impl Fn(&str) -> Answer + Send + 'static) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut request = Vec::new();
            let mut buf = [0u8; 1024];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => request.extend_from_slice(&buf[..n]),
                }
            }
            let text = String::from_utf8_lossy(&request);
            let path = text.split_whitespace().nth(1).unwrap_or("/").to_string();
            let (status, headers, body) = answer(&path);
            let ours = |k: &str| k == "no-length" || k == "slow";
            let mut head = format!("HTTP/1.1 {status} X\r\nConnection: close\r\n");
            if !headers.iter().any(|(k, _)| *k == "no-length") {
                head.push_str(&format!("Content-Length: {}\r\n", body.len()));
            }
            for (k, v) in headers.iter().filter(|(k, _)| !ours(k)) {
                head.push_str(&format!("{k}: {v}\r\n"));
            }
            head.push_str("\r\n");
            let _ = stream.write_all(head.as_bytes());
            // `slow`: half the body, a pause of that many milliseconds, then the rest.
            match headers.iter().find(|(k, _)| *k == "slow") {
                Some((_, ms)) => {
                    let half = body.len() / 2;
                    let _ = stream.write_all(&body[..half]);
                    let _ = stream.flush();
                    std::thread::sleep(std::time::Duration::from_millis(ms.parse().unwrap()));
                    let _ = stream.write_all(&body[half..]);
                }
                None => {
                    let _ = stream.write_all(&body);
                }
            }
        }
    });
    base
}

fn ok(body: Vec<u8>) -> Answer {
    (200, Vec::new(), body)
}

/// The library file name of mod `id` for `p`, as the engine looks for it.
fn library(id: &str, p: Platform) -> String {
    match p {
        Platform::WindowsX64 => format!("{id}.dll"),
        Platform::LinuxX64 => format!("lib{id}.so"),
        Platform::MacosArm64 => format!("lib{id}.dylib"),
    }
}

/// A mod zip with a library for every system, so the tests run on each; `salt` makes builds of
/// one mod differ.
fn zip_of(id: &str, salt: &str) -> Vec<u8> {
    let libs: Vec<String> = Platform::ALL.iter().map(|p| library(id, *p)).collect();
    let files: Vec<(&str, &[u8])> = libs.iter().map(|l| (l.as_str(), salt.as_bytes())).collect();
    make_zip(&files)
}

/// A catalogue build of `id` whose bytes are `zip`, downloaded from `base`.
fn build_of(id: &str, version: &str, zip: &[u8], deps: &[&str], base: &str) -> CatalogVersion {
    let mut v = build(id, version, ABI, Channel::Release, deps);
    v.platforms = Platform::ALL.to_vec();
    v.sha256 = sha256_hex(zip);
    v.size = zip.len() as u64;
    v.url = format!("{base}/{id}.zip");
    v
}

/// cogwork needs showcase; railways needs signals, which has no build.
struct World {
    catalog: Catalog,
    cogwork: Vec<u8>,
    showcase: Vec<u8>,
    railways: Vec<u8>,
}

impl World {
    fn new(base: &str) -> World {
        let cogwork = zip_of("cogwork", "0.2.0");
        let showcase = zip_of("showcase", "0.1.0");
        let railways = zip_of("railways", "1.0.0");
        let mut catalog = catalog(
            vec![
                catalog_mod(
                    "cogwork",
                    Origin::Index,
                    vec![build_of(
                        "cogwork",
                        "0.2.0",
                        &cogwork,
                        &["base", "showcase"],
                        base,
                    )],
                ),
                catalog_mod(
                    "showcase",
                    Origin::Index,
                    vec![build_of("showcase", "0.1.0", &showcase, &[], base)],
                ),
                catalog_mod(
                    "railways",
                    Origin::Index,
                    vec![build_of("railways", "1.0.0", &railways, &["signals"], base)],
                ),
            ],
            &[],
        );
        catalog.weft = vec![WeftAbi {
            tag: TAG.into(),
            commit: "f".repeat(40),
            abi: ABI.into(),
        }];
        World {
            catalog,
            cogwork,
            showcase,
            railways,
        }
    }

    fn sha(&self, id: &str) -> String {
        self.catalog
            .mods
            .iter()
            .find(|m| m.id == id)
            .unwrap()
            .versions[0]
            .sha256
            .clone()
    }

    /// Puts every build into the store, as if downloaded before.
    fn stored(self, ctx: &Ctx) -> World {
        for zip in [&self.cogwork, &self.showcase, &self.railways] {
            std::fs::create_dir_all(ctx.paths.store_dir()).unwrap();
            std::fs::write(ctx.paths.store_object(&sha256_hex(zip)), zip).unwrap();
        }
        self
    }
}

/// A server for the world's builds, and a context whose page loaded its catalogue.
fn setup(tmp: &tempfile::TempDir) -> (Ctx, World) {
    type Files = Arc<Mutex<Vec<(String, Vec<u8>)>>>;
    let bytes: Files = Arc::default();
    let served = bytes.clone();
    let base = serve(move |path| {
        let files = served.lock().unwrap();
        match files.iter().find(|(p, _)| p == path) {
            Some((_, b)) => ok(b.clone()),
            None => (404, Vec::new(), Vec::new()),
        }
    });
    let world = World::new(&base);
    *bytes.lock().unwrap() = vec![
        ("/cogwork.zip".into(), world.cogwork.clone()),
        ("/showcase.zip".into(), world.showcase.clone()),
        ("/railways.zip".into(), world.railways.clone()),
    ];
    let ctx = with_version(tmp.path(), TAG);
    ctx.hold_catalog(world.catalog.clone());
    (ctx, world)
}

fn next_op() -> String {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    format!("op-{}", N.fetch_add(1, Ordering::Relaxed))
}

/// Installs as the page does: plans, then installs with that plan's token.
async fn install(ctx: &Ctx, sha: &str) -> Result<ChangeResult, ModsError> {
    let plan = service::plan(ctx, TAG, sha).await?;
    service::install(ctx, TAG, sha, &plan.plan_token, &next_op()).await
}

async fn restore(ctx: &Ctx, id: &str) -> Result<ChangeResult, ModsError> {
    service::restore(ctx, TAG, id, &next_op()).await
}

fn build_mut<'a>(catalog: &'a mut Catalog, id: &str) -> &'a mut CatalogVersion {
    &mut catalog
        .mods
        .iter_mut()
        .find(|m| m.id == id)
        .unwrap()
        .versions[0]
}

fn lock_of(ctx: &Ctx) -> Lock {
    store::read_lock(&ctx.paths, TAG).unwrap()
}

fn handed_to_game(ctx: &Ctx) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(ctx.paths.mods_dir(TAG).unwrap())
        .map(|d| {
            d.flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

#[test]
fn an_install_downloads_checks_and_commits() {
    let tmp = tempfile::tempdir().unwrap();
    let (ctx, world) = setup(&tmp);
    let stages: Arc<Mutex<Vec<(String, ProgressStage)>>> = Arc::default();
    let seen = stages.clone();
    let ctx = ctx.with_progress(move |p| seen.lock().unwrap().push((p.mod_id, p.stage)));

    let done = run(install(&ctx, &world.sha("cogwork"))).unwrap();
    assert_eq!(done.installed, ["cogwork", "showcase"]);
    assert!(done.installed_off.is_empty() && done.undo.is_none());
    assert_eq!(handed_to_game(&ctx), ["cogwork.zip", "showcase.zip"]);
    assert!(ctx.paths.store_object(&world.sha("cogwork")).exists());
    let stages = stages.lock().unwrap();
    for stage in [
        ProgressStage::Downloading,
        ProgressStage::Verifying,
        ProgressStage::Installing,
    ] {
        assert!(stages.contains(&("cogwork".into(), stage)), "{stage:?}");
    }
    assert!(!ctx.lock.is_held());
}

/// A download whose bytes aren't the pinned ones never reaches the store or the profile.
#[test]
fn a_tampered_download_never_reaches_the_store() {
    let tmp = tempfile::tempdir().unwrap();
    let world = World::new("");
    let tampered = zip_of("showcase", "evil");
    let base = serve(move |_| ok(tampered.clone()));
    let mut catalog = world.catalog.clone();
    for m in &mut catalog.mods {
        m.versions[0].url = format!("{base}/{}.zip", m.id);
    }
    let ctx = with_version(tmp.path(), TAG);
    ctx.hold_catalog(catalog);

    let err = run(install(&ctx, &world.sha("showcase"))).unwrap_err();
    assert!(matches!(err, ModsError::Sha256Mismatch { .. }), "{err:?}");
    assert!(!ctx.paths.store_object(&world.sha("showcase")).exists());
    let leftovers = std::fs::read_dir(ctx.paths.downloads_dir())
        .unwrap()
        .count();
    assert_eq!(leftovers, 0, "the temporary file is gone");
    assert!(lock_of(&ctx).mods.is_empty());
}

#[test]
fn a_download_larger_than_announced_is_stopped() {
    for headers in [Vec::new(), vec![("no-length", String::new())]] {
        let tmp = tempfile::tempdir().unwrap();
        let world = World::new("");
        let big = vec![b'x'; world.showcase.len() + 4096];
        let base = serve(move |_| (200, headers.clone(), big.clone()));
        let mut catalog = world.catalog.clone();
        build_mut(&mut catalog, "showcase").url = format!("{base}/showcase.zip");
        let ctx = with_version(tmp.path(), TAG);
        ctx.hold_catalog(catalog);
        let err = run(install(&ctx, &world.sha("showcase"))).unwrap_err();
        assert!(matches!(err, ModsError::TooLarge(_)), "{err:?}");
        assert!(!ctx.paths.store_object(&world.sha("showcase")).exists());
    }
}

/// The store already has a file under the build's hash, but it is another mod: refused, and
/// nothing is fetched (the URL leads nowhere).
#[test]
fn a_stored_file_with_the_right_hash_is_still_checked() {
    let tmp = tempfile::tempdir().unwrap();
    let ctx = with_version(tmp.path(), TAG);
    let other = zip_of("structures", "x");
    let mut catalog = World::new("http://127.0.0.1:9").catalog;
    let showcase = build_mut(&mut catalog, "showcase");
    showcase.sha256 = sha256_hex(&other);
    std::fs::create_dir_all(ctx.paths.store_dir()).unwrap();
    std::fs::write(ctx.paths.store_object(&showcase.sha256), &other).unwrap();
    let sha = showcase.sha256.clone();
    ctx.hold_catalog(catalog);

    let err = run(install(&ctx, &sha)).unwrap_err();
    assert!(matches!(err, ModsError::ArchiveInvalid(_)), "{err:?}");
    assert!(lock_of(&ctx).mods.is_empty());
}

/// Contract item 1: a mod that needs something missing is installed turned off, and Play keeps
/// working.
#[test]
fn a_missing_dependency_installs_the_mod_turned_off() {
    let tmp = tempfile::tempdir().unwrap();
    let (ctx, world) = setup(&tmp);
    let plan = run(service::plan(&ctx, TAG, &world.sha("railways"))).unwrap();
    assert!(!plan.turns_on);
    assert_eq!(plan.missing, ["signals"]);

    let done = run(install(&ctx, &world.sha("railways"))).unwrap();
    assert_eq!(done.installed_off, ["railways"]);
    assert_eq!(done.missing, ["signals"]);
    assert!(!lock_of(&ctx).get("railways").unwrap().enabled);
    assert!(done.report.blocking.is_empty());
    let launch = run(service::prepare_launch(&ctx, TAG)).unwrap();
    assert_eq!(launch.release(), None, "nothing is on");
}

mod meanwhile {
    use super::*;

    /// Stages cogwork with showcase installed, so only cogwork is downloaded; `change` happens
    /// during the download; the commit must refuse.
    fn refused(change: impl FnOnce(&Ctx, &World)) -> ModsError {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        let world = world.stored(&ctx);
        run(install(&ctx, &world.sha("showcase"))).unwrap();
        let before = std::fs::read(ctx.paths.lock_file(TAG).unwrap()).unwrap();

        let (m, v) = world.catalog.find(&world.sha("cogwork")).unwrap();
        let op = ctx.operations.begin("refused").unwrap();
        let staged = service::stage(
            &ctx,
            TAG,
            world.catalog.clone(),
            ABI.into(),
            vec![(m.clone(), v.clone())],
            Vec::new(),
        )
        .unwrap();
        run(service::fetch(&ctx, &staged, &op)).unwrap();
        change(&ctx, &world);
        let err = run(service::commit(&ctx, staged, &op)).unwrap_err();
        if ctx.paths.lock_file(TAG).unwrap().exists() {
            let after = std::fs::read(ctx.paths.lock_file(TAG).unwrap()).unwrap();
            let unchanged = after == before || !String::from_utf8_lossy(&after).contains("cogwork");
            assert!(unchanged, "nothing was written");
        }
        err
    }

    fn detail(err: ModsError) -> String {
        match err {
            ModsError::ChangedMeanwhile(why) => why,
            e => panic!("expected ModChangedMeanwhile, got {e:?}"),
        }
    }

    #[test]
    fn the_version_was_removed() {
        let why = detail(refused(|ctx, _| {
            std::fs::remove_dir_all(ctx.paths.versions_dir().join(TAG)).unwrap();
        }));
        assert!(why.contains("removed"), "{why}");
    }

    #[test]
    fn the_build_was_revoked() {
        let why = detail(refused(|ctx, world| {
            let mut c = world.catalog.clone();
            c.revoked.push(RevokedView {
                sha256: world.sha("cogwork"),
                reason: Some("deletes saves".into()),
            });
            ctx.hold_catalog(c);
        }));
        assert!(why.contains("deletes saves"), "{why}");
    }

    #[test]
    fn the_build_left_the_catalogue() {
        let why = detail(refused(|ctx, world| {
            let mut c = world.catalog.clone();
            c.mods.retain(|m| m.id != "cogwork");
            ctx.hold_catalog(c);
        }));
        assert!(why.contains("no longer"), "{why}");
    }

    #[test]
    fn the_game_was_started() {
        let why = detail(refused(|ctx, _| ctx.games.insert(TAG)));
        assert!(why.contains("started"), "{why}");
    }

    #[test]
    fn the_plan_no_longer_holds() {
        // Showcase was removed meanwhile: cogwork would need it downloaded.
        let why = detail(refused(|ctx, _| {
            run(service::remove(ctx, TAG, "showcase")).unwrap();
        }));
        assert!(why.contains("showcase"), "{why}");
        // Showcase was turned off meanwhile: committing would turn it on unasked.
        let why = detail(refused(|ctx, _| {
            run(service::set_enabled(ctx, TAG, "showcase", false)).unwrap();
        }));
        assert!(why.contains("turned on"), "{why}");
    }

    /// The same hash, described differently by a refreshed catalogue: the consent is checked
    /// against what the catalogue says now, not what it said when the download started.
    #[test]
    fn the_same_builds_metadata_changed() {
        // Another tier.
        let why = detail(refused(|ctx, world| {
            let mut c = world.catalog.clone();
            build_mut(&mut c, "cogwork").trust = super::super::catalog::Trust::Unreviewed;
            ctx.hold_catalog(c);
        }));
        assert!(why.contains("changed since it was shown"), "{why}");
        // Another dependency, which would have to be downloaded too.
        let why = detail(refused(|ctx, world| {
            let mut c = world.catalog.clone();
            build_mut(&mut c, "cogwork").deps.push("railways".into());
            ctx.hold_catalog(c);
        }));
        assert!(why.contains("railways"), "{why}");
        // Built for another mod interface now.
        let why = detail(refused(|ctx, world| {
            let mut c = world.catalog.clone();
            build_mut(&mut c, "cogwork").abi = "0".repeat(16);
            ctx.hold_catalog(c);
        }));
        assert!(why.contains("cogwork"), "{why}");
    }

    #[test]
    fn the_versions_mod_interface_changed() {
        let why = detail(refused(|ctx, world| {
            let mut c = world.catalog.clone();
            c.weft[0].abi = "0".repeat(16);
            ctx.hold_catalog(c);
        }));
        assert!(why.contains("mod interface"), "{why}");
    }

    #[test]
    fn nothing_changed() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        let (m, v) = world.catalog.find(&world.sha("cogwork")).unwrap();
        let wanted = vec![(m.clone(), v.clone())];
        let op = ctx.operations.begin("nothing-changed").unwrap();
        let staged = service::stage(
            &ctx,
            TAG,
            world.catalog.clone(),
            ABI.into(),
            wanted,
            Vec::new(),
        )
        .unwrap();
        run(service::fetch(&ctx, &staged, &op)).unwrap();
        let done = run(service::commit(&ctx, staged, &op)).unwrap();
        assert_eq!(done.installed, ["cogwork", "showcase"]);
    }
}

#[test]
fn remove_can_be_undone_until_the_next_change() {
    let tmp = tempfile::tempdir().unwrap();
    let (ctx, world) = setup(&tmp);
    let world = world.stored(&ctx);
    run(install(&ctx, &world.sha("cogwork"))).unwrap();
    let showcase_before = lock_of(&ctx).get("showcase").unwrap().clone();

    let done = run(service::remove(&ctx, TAG, "showcase")).unwrap();
    assert_eq!(done.undo.as_deref(), Some("showcase"));
    assert_eq!(done.also_disabled, ["cogwork"]);
    assert!(
        ctx.paths.store_object(&world.sha("showcase")).exists(),
        "its file is kept for Undo"
    );
    assert_eq!(handed_to_game(&ctx), Vec::<String>::new());

    let done = run(restore(&ctx, "showcase")).unwrap();
    assert!(done.undo.is_none());
    assert_eq!(done.also_enabled, ["cogwork"]);
    let lock = lock_of(&ctx);
    let showcase = lock.get("showcase").unwrap();
    assert_eq!(showcase.sha256, showcase_before.sha256);
    assert_eq!(showcase.enabled, showcase_before.enabled);
    assert_eq!(showcase.installed_at, showcase_before.installed_at);
    assert_eq!(handed_to_game(&ctx), ["cogwork.zip", "showcase.zip"]);
    assert!(matches!(
        run(restore(&ctx, "showcase")),
        Err(ModsError::NotInstalled(_))
    ));

    // Any other change ends the undo, and the file goes with the next collection.
    run(service::remove(&ctx, TAG, "showcase")).unwrap();
    run(service::set_enabled(&ctx, TAG, "cogwork", false)).unwrap();
    assert!(matches!(
        run(restore(&ctx, "showcase")),
        Err(ModsError::NotInstalled(_))
    ));
    assert!(!ctx.paths.store_object(&world.sha("showcase")).exists());
}

#[test]
fn undo_needs_the_same_bytes() {
    let tmp = tempfile::tempdir().unwrap();
    let (ctx, world) = setup(&tmp);
    let world = world.stored(&ctx);
    run(install(&ctx, &world.sha("showcase"))).unwrap();
    run(service::set_enabled(&ctx, TAG, "showcase", false)).unwrap();
    run(service::remove(&ctx, TAG, "showcase")).unwrap();
    assert!(matches!(
        run(restore(&ctx, "cogwork")),
        Err(ModsError::NotInstalled(_))
    ));
    std::fs::write(ctx.paths.store_object(&world.sha("showcase")), b"changed").unwrap();
    assert!(matches!(
        run(restore(&ctx, "showcase")),
        Err(ModsError::NotInstalled(_))
    ));
    std::fs::write(
        ctx.paths.store_object(&world.sha("showcase")),
        &world.showcase,
    )
    .unwrap();
    run(restore(&ctx, "showcase")).unwrap();
    assert!(
        !lock_of(&ctx).get("showcase").unwrap().enabled,
        "back as it was: off"
    );
}

/// Before Play, with no catalogue loaded, nothing cached and no network: statuses are only
/// unchecked, recorded revocations still apply, and missing dependencies still block.
#[test]
fn prepare_launch_needs_neither_tauri_nor_the_network() {
    let tmp = tempfile::tempdir().unwrap();
    let world = World::new("http://127.0.0.1:9");
    let installer = with_version(tmp.path(), TAG);
    installer.hold_catalog(world.catalog.clone());
    let world = world.stored(&installer);
    run(install(&installer, &world.sha("cogwork"))).unwrap();
    // A fresh start: no catalogue held, no index cached, no ABI cached.
    let ctx = Ctx::new(installer.paths.clone());

    let launch = run(service::prepare_launch(&ctx, TAG)).unwrap();
    assert!(ctx.lock.is_held(), "held until the game counts as running");
    assert_eq!(launch.release(), Some(ctx.paths.mods_dir(TAG).unwrap()));
    assert!(!ctx.lock.is_held());
    let offline = service::offline_catalog(&ctx.paths);
    assert_eq!(
        offline.index.freshness,
        super::index::Freshness::Unavailable
    );
    let report = run(service::build_report(
        &ctx,
        TAG,
        &lock_of(&ctx),
        &offline,
        false,
    ));
    assert!(
        report.mods.iter().all(|m| m.status == ModStatus::Unchecked),
        "without the index or the ABI nothing can be called wrong"
    );

    // A revocation recorded earlier still turns the mod off, without the index.
    let mut lock = lock_of(&ctx);
    lock.get_mut("showcase").unwrap().revoked = Some(super::profile::Revocation {
        reason: Some("deletes saves".into()),
        at: None,
    });
    store::write_lock(&ctx.paths, TAG, &lock).unwrap();
    let err = run(service::prepare_launch(&ctx, TAG)).err().unwrap();
    assert!(
        matches!(err, ModsError::Blocked(ref names) if names == "cogwork name"),
        "{err:?}"
    );
    let lock = lock_of(&ctx);
    assert!(!lock.get("showcase").unwrap().enabled);
    assert_eq!(handed_to_game(&ctx), ["cogwork.zip"]);
}

#[test]
fn the_launch_plan() {
    use super::profile::tests::{entry, lock};
    use super::profile::{report, tests::fit};
    let mut off = entry("showcase", &[], Some(ABI));
    off.enabled = false;
    let mut revoked = entry("pulled", &[], Some(ABI));
    revoked.enabled = false;
    revoked.revoked = Some(super::profile::Revocation {
        reason: Some("x".into()),
        at: None,
    });
    let cases: Vec<(&str, Lock, LaunchPlan)> = vec![
        ("nothing installed", lock(vec![]), LaunchPlan::NoMods),
        (
            "only mods that are off",
            lock(vec![off.clone(), revoked.clone()]),
            LaunchPlan::NoMods,
        ),
        (
            "a mod that is on",
            lock(vec![entry("a", &["base"], Some(ABI)), off.clone()]),
            LaunchPlan::Mods,
        ),
        (
            "a local file, unchecked",
            lock(vec![entry("mytweak", &[], None)]),
            LaunchPlan::Mods,
        ),
        (
            "a dependency that is off",
            lock(vec![
                entry("cogwork", &["showcase"], Some(ABI)),
                off.clone(),
            ]),
            LaunchPlan::Blocked(vec!["cogwork name".into()]),
        ),
        (
            "built for another version",
            lock(vec![entry("old", &[], Some("5f0569a6bea71b81"))]),
            LaunchPlan::Blocked(vec!["old name".into()]),
        ),
    ];
    let c = catalog(vec![], &[]);
    for (what, l, want) in cases {
        let r = report(TAG, &l, Some(ABI.into()), None, &c, fit().platform, vec![]);
        assert_eq!(service::launch_plan(&l, &r), want, "{what}");
    }
}

#[test]
fn forgetting_a_version_waits_for_the_mods_lock() {
    let tmp = tempfile::tempdir().unwrap();
    let (ctx, world) = setup(&tmp);
    let world = world.stored(&ctx);
    run(install(&ctx, &world.sha("showcase"))).unwrap();
    run(async {
        let held = ctx.lock_mods().await;
        let waited = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            service::forget_version(&ctx, TAG),
        )
        .await;
        assert!(waited.is_err(), "it waits while an install holds the lock");
        assert!(ctx.paths.profile_dir(TAG).unwrap().exists());
        drop(held);
        service::forget_version(&ctx, TAG).await;
    });
    assert!(!ctx.paths.profile_dir(TAG).unwrap().exists());
    assert!(!ctx.paths.store_object(&world.sha("showcase")).exists());
}

mod icons {
    use super::*;

    fn png(len: usize) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
        b.resize(len, 0);
        b
    }

    #[test]
    fn only_small_pngs() {
        let base = serve(|path| match path {
            "/small.png" => ok(png(1000)),
            "/big.png" => ok(png(service::MAX_ICON_BYTES + 1)),
            "/big-unannounced.png" => (
                200,
                vec![("no-length", String::new())],
                png(service::MAX_ICON_BYTES + 1),
            ),
            "/not.png" => ok(b"<svg/>".to_vec()),
            _ => (404, Vec::new(), Vec::new()),
        });
        let client = service::http().unwrap();
        let get = |p: &str| run(service::fetch_icon(&client, &format!("{base}{p}")));
        assert_eq!(get("/small.png").unwrap().len(), 1000);
        for bad in ["/big.png", "/big-unannounced.png"] {
            assert!(matches!(get(bad), Err(ModsError::TooLarge(_))), "{bad}");
        }
        assert!(matches!(get("/not.png"), Err(ModsError::IconInvalid(_))));
        assert!(matches!(
            get("/gone.png"),
            Err(ModsError::Http { status: 404, .. })
        ));
    }

    #[test]
    fn redirects_stay_on_github_over_https() {
        let base = serve(|path| match path {
            "/away" => (
                302,
                vec![("Location", "http://127.0.0.1:9/x.png".into())],
                Vec::new(),
            ),
            _ => ok(png(10)),
        });
        let client = service::http().unwrap();
        let got = run(service::fetch_icon(&client, &format!("{base}/away")));
        assert!(matches!(got, Err(ModsError::Network(_))), "{got:?}");
    }

    #[test]
    fn only_catalogue_icons_over_https() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = with_version(tmp.path(), TAG);
        let mut c = catalog(vec![], &[]);
        let mut m = catalog_mod("cogwork", Origin::Index, vec![]);
        m.icon = Some("http://example.com/icon.png".into());
        c.mods.push(m);
        ctx.hold_catalog(c);
        for url in [
            "http://example.com/icon.png",
            "https://example.com/other.png",
        ] {
            assert!(matches!(
                run(service::icon_png(&ctx, url)),
                Err(ModsError::NotInCatalog(_))
            ));
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Round 4: consent, operations, files, copies, sources, profiles, shadowing

/// What an error must be.
type Expect = fn(&ModsError) -> bool;

fn revoke(ctx: &Ctx, world: &World, id: &str, reason: &str) {
    let mut c = ctx.held_catalog().unwrap_or_else(|| world.catalog.clone());
    c.revoked.push(RevokedView {
        sha256: world.sha(id),
        reason: Some(reason.into()),
    });
    ctx.hold_catalog(c);
}

mod consent {
    use super::*;

    /// Contract R4 §2: the token is checked before anything is downloaded.
    #[test]
    fn a_changed_plan_is_refused_before_downloading() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        let plan = run(service::plan(&ctx, TAG, &world.sha("cogwork"))).unwrap();
        assert_eq!(ids_of(&plan.install), ["showcase"]);
        // Showcase is installed meanwhile: the plan the player saw would now do something else.
        run(install(&ctx, &world.sha("showcase"))).unwrap();
        let before = std::fs::read(ctx.paths.lock_file(TAG).unwrap()).unwrap();
        let err = run(service::install(
            &ctx,
            TAG,
            &world.sha("cogwork"),
            &plan.plan_token,
            &next_op(),
        ))
        .unwrap_err();
        assert!(matches!(err, ModsError::ChangedMeanwhile(_)), "{err:?}");
        assert!(
            !ctx.paths.store_object(&world.sha("cogwork")).exists(),
            "nothing fetched"
        );
        assert_eq!(
            std::fs::read(ctx.paths.lock_file(TAG).unwrap()).unwrap(),
            before
        );

        // Planned again, it goes ahead.
        let plan = run(service::plan(&ctx, TAG, &world.sha("cogwork"))).unwrap();
        assert!(plan.install.is_empty());
        run(service::install(
            &ctx,
            TAG,
            &world.sha("cogwork"),
            &plan.plan_token,
            &next_op(),
        ))
        .unwrap();
    }

    /// The token is checked again at commit: less to do is still not what was agreed.
    #[test]
    fn a_plan_that_changed_during_the_download_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        let (m, v) = world.catalog.find(&world.sha("cogwork")).unwrap();
        let op = ctx.operations.begin("download").unwrap();
        let staged = service::stage(
            &ctx,
            TAG,
            world.catalog.clone(),
            ABI.into(),
            vec![(m.clone(), v.clone())],
            Vec::new(),
        )
        .unwrap();
        run(service::fetch(&ctx, &staged, &op)).unwrap();
        run(install(&ctx, &world.sha("showcase"))).unwrap();
        let err = run(service::commit(&ctx, staged, &op)).unwrap_err();
        assert!(matches!(err, ModsError::ChangedMeanwhile(_)), "{err:?}");
        assert!(lock_of(&ctx).get("cogwork").is_none());
    }

    /// The token covers trust: a build that became Reviewed is a different plan.
    #[test]
    fn the_token_covers_trust_and_the_abi() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        let plan = run(service::plan(&ctx, TAG, &world.sha("showcase"))).unwrap();
        let mut c = world.catalog.clone();
        build_mut(&mut c, "showcase").trust = super::super::catalog::Trust::Unreviewed;
        ctx.hold_catalog(c);
        let other = run(service::plan(&ctx, TAG, &world.sha("showcase"))).unwrap();
        assert_ne!(plan.plan_token, other.plan_token);
        assert_eq!(other.fits_version, Some(true));

        // Unknown ABI: unknown fit, never "no", and a token of its own.
        let p = super::super::plan::plan_install(
            &world.catalog,
            &Lock::empty(),
            TAG,
            &world.sha("showcase"),
            None,
            false,
        )
        .unwrap();
        assert_eq!(p.fits_version, None);
        assert!(!p.turns_on);
        assert_ne!(p.plan_token, plan.plan_token);
    }
}

fn ids_of(items: &[super::plan::PlanItem]) -> Vec<&str> {
    items.iter().map(|i| i.id.as_str()).collect()
}

mod operations {
    use super::*;

    /// Contract R4 §3: progress belongs to its operation and says which file of how many.
    #[test]
    fn progress_names_the_operation_and_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        let seen: Arc<Mutex<Vec<super::super::install::ModProgress>>> = Arc::default();
        let log = seen.clone();
        let ctx = ctx.with_progress(move |p| log.lock().unwrap().push(p));
        let plan = run(service::plan(&ctx, TAG, &world.sha("cogwork"))).unwrap();
        run(service::install(
            &ctx,
            TAG,
            &world.sha("cogwork"),
            &plan.plan_token,
            "op-a",
        ))
        .unwrap();
        let seen = seen.lock().unwrap();
        assert!(
            seen.iter()
                .all(|p| p.operation_id == "op-a" && p.count == 2)
        );
        let at = |id: &str| seen.iter().find(|p| p.mod_id == id).unwrap().index;
        assert_eq!((at("cogwork"), at("showcase")), (1, 2));
        assert!(ctx.operations.is_empty(), "forgotten once it ended");
        assert!(!ctx.operations.cancel("op-a"));
    }

    /// The events of an install, step by step, are the ones in `src/dev/fixtures/trace.json`,
    /// which the mock is held to as well.
    #[test]
    fn progress_follows_the_shared_trace() {
        const TRACE: &str = include_str!("../../../src/dev/fixtures/trace.json");
        let trace: serde_json::Value = serde_json::from_str(TRACE).unwrap();
        for (case, stored) in [
            ("installWithDependency", false),
            ("installWithStoredDependency", true),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let (ctx, world) = setup(&tmp);
            if stored {
                std::fs::create_dir_all(ctx.paths.store_dir()).unwrap();
                std::fs::write(
                    ctx.paths.store_object(&world.sha("showcase")),
                    &world.showcase,
                )
                .unwrap();
            }
            let seen: Arc<Mutex<Vec<super::super::install::ModProgress>>> = Arc::default();
            let log = seen.clone();
            let ctx = ctx.with_progress(move |p| log.lock().unwrap().push(p));
            let plan = run(service::plan(&ctx, TAG, &world.sha("cogwork"))).unwrap();
            run(service::install(
                &ctx,
                TAG,
                &world.sha("cogwork"),
                &plan.plan_token,
                "op-t",
            ))
            .unwrap();
            let seen = seen.lock().unwrap();
            let want = &trace[case];
            let count = want["count"].as_u64().unwrap() as u32;
            assert!(
                seen.iter()
                    .all(|p| p.operation_id == "op-t" && p.count == count),
                "{case}"
            );
            let want: Vec<String> = want["steps"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap().to_string())
                .collect();
            assert_eq!(collapse(&seen), want, "{case}");
        }
    }

    /// `file:stage:percent`, keeping the first and last percent of each run of one file's stage.
    fn collapse(events: &[super::super::install::ModProgress]) -> Vec<String> {
        let stage = |s: ProgressStage| {
            serde_json::to_value(s)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        };
        let mut runs: Vec<(u32, String, u32, u32)> = Vec::new();
        for e in events {
            let st = stage(e.stage);
            match runs.last_mut() {
                Some(r) if r.0 == e.index && r.1 == st => r.3 = e.percent,
                _ => runs.push((e.index, st, e.percent, e.percent)),
            }
        }
        runs.into_iter()
            .flat_map(|(i, st, first, last)| {
                let mut out = vec![format!("{i}:{st}:{first}")];
                if last != first {
                    out.push(format!("{i}:{st}:{last}"));
                }
                out
            })
            .collect()
    }

    /// Cancelling during the second download stops it at once, and leaves no trace: no lock
    /// change, no partial file, and not the first build either.
    #[test]
    fn a_cancelled_install_leaves_no_trace() {
        let tmp = tempfile::tempdir().unwrap();
        let world = World::new("");
        let (cogwork, showcase) = (world.cogwork.clone(), world.showcase.clone());
        let base = serve(move |path| match path {
            "/cogwork.zip" => ok(cogwork.clone()),
            _ => (200, vec![("slow", "3000".into())], showcase.clone()),
        });
        let mut catalog = world.catalog.clone();
        for m in &mut catalog.mods {
            m.versions[0].url = format!("{base}/{}.zip", m.id);
        }
        let ctx = with_version(tmp.path(), TAG);
        ctx.hold_catalog(catalog);
        let ops = ctx.operations.clone();
        let ctx = ctx.with_progress(move |p| {
            if p.mod_id == "showcase" && p.stage == ProgressStage::Downloading && p.percent > 0 {
                assert!(ops.cancel(&p.operation_id));
            }
        });
        let plan = run(service::plan(&ctx, TAG, &world.sha("cogwork"))).unwrap();
        let started = std::time::Instant::now();
        let err = run(service::install(
            &ctx,
            TAG,
            &world.sha("cogwork"),
            &plan.plan_token,
            "op-c",
        ))
        .unwrap_err();
        assert!(matches!(err, ModsError::Cancelled), "{err:?}");
        assert!(
            started.elapsed() < std::time::Duration::from_millis(2500),
            "it didn't wait"
        );
        assert!(!ctx.paths.lock_file(TAG).unwrap().exists());
        assert_eq!(
            std::fs::read_dir(ctx.paths.downloads_dir())
                .unwrap()
                .count(),
            0
        );
        let stored = std::fs::read_dir(ctx.paths.store_dir())
            .map(|d| d.count())
            .unwrap_or(0);
        assert_eq!(stored, 0, "the build it finished first is gone too");
        assert!(ctx.operations.is_empty());
        assert_eq!(
            crate::error::AppError::from(err).code,
            crate::error::ErrorCode::ModCancelled
        );
    }

    /// Once an operation writes, cancelling it is refused; an unknown id is just false.
    #[test]
    fn a_restore_can_be_cancelled_until_it_writes() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        let world = world.stored(&ctx);
        run(install(&ctx, &world.sha("showcase"))).unwrap();
        run(service::remove(&ctx, TAG, "showcase")).unwrap();
        let ops = ctx.operations.clone();
        let ctx = ctx.with_progress(move |p| {
            if p.stage == ProgressStage::Verifying {
                ops.cancel(&p.operation_id);
            }
        });
        let err = run(service::restore(&ctx, TAG, "showcase", "op-r")).unwrap_err();
        assert!(matches!(err, ModsError::Cancelled), "{err:?}");
        assert!(lock_of(&ctx).get("showcase").is_none());
        assert!(matches!(
            run(service::restore(&ctx, TAG, "showcase", "../bad")),
            Err(ModsError::InvalidName(_))
        ));
    }
}

mod files {
    use super::*;

    fn file(tmp: &tempfile::TempDir, name: &str, bytes: &[u8]) -> String {
        let path = tmp.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        path.to_string_lossy().to_string()
    }

    fn install_file(ctx: &Ctx, path: &str) -> Result<ChangeResult, ModsError> {
        let seen = run(service::inspect_file(ctx, TAG, path))?;
        run(service::install_file(
            ctx,
            TAG,
            path,
            &seen.sha256,
            &seen.plan_token,
            &next_op(),
        ))
    }

    fn stored_count(ctx: &Ctx) -> usize {
        std::fs::read_dir(ctx.paths.store_dir())
            .map(|d| d.count())
            .unwrap_or(0)
    }

    #[test]
    fn an_unknown_file_is_unverified_and_on() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, _) = setup(&tmp);
        let path = file(&tmp, "my tweak.zip", &zip_of("mytweak", "1"));
        let done = install_file(&ctx, &path).unwrap();
        assert_eq!(done.installed, ["mytweak"]);
        let e = lock_of(&ctx).get("mytweak").unwrap().clone();
        assert_eq!(e.trust, super::super::catalog::Trust::Unverified);
        assert!(e.enabled);
        assert_eq!(handed_to_game(&ctx), ["mytweak.zip"]);
    }

    #[test]
    fn a_catalogued_file_installs_as_its_build() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        let path = file(&tmp, "downloaded.zip", &world.cogwork);
        let seen = run(service::inspect_file(&ctx, TAG, &path)).unwrap();
        assert_eq!(
            seen.catalog_match.as_ref().unwrap().fits_version,
            Some(true)
        );
        let done = run(service::install_file(
            &ctx,
            TAG,
            &path,
            &seen.sha256,
            &seen.plan_token,
            &next_op(),
        ))
        .unwrap();
        assert_eq!(
            done.installed,
            ["cogwork", "showcase"],
            "its dependency comes too"
        );
        let e = lock_of(&ctx).get("cogwork").unwrap().clone();
        assert_eq!(e.trust, super::super::catalog::Trust::Reviewed);
    }

    #[test]
    fn refused_files_leave_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        // A library only for some other system.
        let other = Platform::ALL
            .into_iter()
            .find(|p| Some(*p) != Platform::current())
            .unwrap();
        let elsewhere = make_zip(&[(library("elsewhere", other).as_str(), b"x".as_slice())]);
        let cases: Vec<(&str, Vec<u8>, Expect)> = vec![
            ("base.zip", zip_of("base", "x"), |e| {
                matches!(e, ModsError::IdReserved(_))
            }),
            ("elsewhere.zip", elsewhere, |e| {
                matches!(e, ModsError::NotForPlatform(_))
            }),
        ];
        for (name, bytes, want) in cases {
            let path = file(&tmp, name, &bytes);
            let err = install_file(&ctx, &path).unwrap_err();
            assert!(want(&err), "{name}: {err:?}");
            assert_eq!(stored_count(&ctx), 0, "{name}");
        }

        // A revoked build, by hash, even when brought as a file.
        revoke(&ctx, &world, "showcase", "deletes saves");
        let path = file(&tmp, "showcase.zip", &world.showcase);
        assert!(matches!(
            install_file(&ctx, &path),
            Err(ModsError::Revoked(_))
        ));

        // A wrong token.
        let path = file(&tmp, "mytweak.zip", &zip_of("mytweak", "1"));
        let seen = run(service::inspect_file(&ctx, TAG, &path)).unwrap();
        let err = run(service::install_file(
            &ctx,
            TAG,
            &path,
            &seen.sha256,
            "not the token",
            &next_op(),
        ))
        .unwrap_err();
        assert!(matches!(err, ModsError::ChangedMeanwhile(_)), "{err:?}");
        assert!(!ctx.paths.lock_file(TAG).unwrap().exists());
        assert_eq!(stored_count(&ctx), 0);
    }

    /// Contract R4 §2: a revocation that arrives while an unknown file is copied and hashed is
    /// honoured at commit, by hash.
    #[test]
    fn a_revocation_during_the_copy_is_honoured() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        let bytes = zip_of("mytweak", "1");
        let path = file(&tmp, "mytweak.zip", &bytes);
        let seen = run(service::inspect_file(&ctx, TAG, &path)).unwrap();
        let (held, catalog) = (ctx.catalog.clone(), world.catalog.clone());
        let sha = sha256_hex(&bytes);
        let ctx = ctx.with_progress(move |p| {
            if p.stage == ProgressStage::Verifying && p.percent == 100 {
                let mut c = catalog.clone();
                c.revoked.push(RevokedView {
                    sha256: sha.to_ascii_uppercase(),
                    reason: Some("steals passwords".into()),
                });
                held.0.lock().unwrap().catalog = Some(c);
            }
        });
        let err = run(service::install_file(
            &ctx,
            TAG,
            &path,
            &seen.sha256,
            &seen.plan_token,
            &next_op(),
        ))
        .unwrap_err();
        assert!(
            matches!(err, ModsError::Revoked(ref r) if r == "steals passwords"),
            "{err:?}"
        );
        assert!(!ctx.paths.lock_file(TAG).unwrap().exists());
        assert_eq!(stored_count(&ctx), 0);
    }
}

mod copies {
    use super::super::plan::CopyOutcome;
    use super::super::profile::tests::entry;
    use super::*;

    const FROM: &str = "v0";

    fn from_lock() -> Lock {
        let mut local = entry("mytweak", &[], None);
        local.origin = Origin::File {
            name: "t.zip".into(),
        };
        let old = "5f0569a6bea71b81";
        super::super::profile::tests::lock(vec![
            entry("cogwork", &["showcase"], Some(old)),
            entry("railways", &["signals"], Some(old)),
            entry("nobuild", &[], Some(old)),
            local,
        ])
    }

    #[test]
    fn a_copy_does_what_its_preview_said() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, _) = setup(&tmp);
        store::write_lock(&ctx.paths, FROM, &from_lock()).unwrap();
        let preview = run(service::copy_preview(&ctx, FROM, TAG)).unwrap();
        assert_eq!(ids_of(&preview.deps), ["showcase"]);
        assert_eq!(preview.installed_off, ["railways"]);
        assert_eq!(preview.missing, ["signals"]);

        // A wrong token changes nothing.
        let err = run(service::copy(&ctx, FROM, TAG, "stale", &next_op())).unwrap_err();
        assert!(matches!(err, ModsError::ChangedMeanwhile(_)), "{err:?}");
        assert!(!ctx.paths.lock_file(TAG).unwrap().exists());

        let done = run(service::copy(
            &ctx,
            FROM,
            TAG,
            &preview.plan_token,
            &next_op(),
        ))
        .unwrap();
        assert_eq!(done.change.installed, ["cogwork", "railways", "showcase"]);
        assert_eq!(done.change.installed_off, ["railways"]);
        assert_eq!(done.change.missing, ["signals"]);
        let left: Vec<(&str, CopyOutcome)> = done
            .left_behind
            .iter()
            .map(|i| (i.id.as_str(), i.outcome))
            .collect();
        assert_eq!(
            left,
            [
                ("nobuild", CopyOutcome::NoBuild),
                ("mytweak", CopyOutcome::LocalFile)
            ]
        );
        assert_eq!(handed_to_game(&ctx), ["cogwork.zip", "showcase.zip"]);
        assert!(done.change.report.blocking.is_empty());
    }

    #[test]
    fn copying_into_a_running_version_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, _) = setup(&tmp);
        store::write_lock(&ctx.paths, FROM, &from_lock()).unwrap();
        let preview = run(service::copy_preview(&ctx, FROM, TAG)).unwrap();
        ctx.games.insert(TAG);
        let err = run(service::copy(
            &ctx,
            FROM,
            TAG,
            &preview.plan_token,
            &next_op(),
        ));
        assert!(matches!(err, Err(ModsError::GameRunning(_))));
    }
}

mod sources {
    use super::*;

    /// A sources list that can't be read is kept and said, in the catalogue too; never read as
    /// "no sources", and never written over.
    #[test]
    fn a_damaged_list_is_kept_and_said() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = with_version(tmp.path(), TAG);
        let file = ctx.paths.sources_file();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"{ \"repos\": [ not json").unwrap();
        let err = service::source_list(&ctx).unwrap_err();
        let ModsError::SourcesDamaged(kept) = err else {
            panic!("{err:?}")
        };
        assert_eq!(
            std::fs::read(&kept).unwrap(),
            b"{ \"repos\": [ not json",
            "kept as it was"
        );
        let offline = service::offline_catalog(&ctx.paths);
        assert_eq!(
            offline.sources_error.map(|e| e.code),
            Some(crate::error::ErrorCode::ModSourcesDamaged)
        );
        // Removing a source from a list that can't be read is refused, not done on an empty one.
        assert!(matches!(
            run(service::remove_source(&ctx, "a/b")),
            Err(ModsError::SourcesDamaged(_))
        ));
        assert!(std::path::Path::new(&kept).exists());
    }

    #[test]
    fn adding_a_source_asks_github_for_its_name() {
        let tmp = tempfile::tempdir().unwrap();
        let api = serve(|path| match path {
            "/repos/someone/lanterns" | "/repos/SOMEONE/Lanterns" => {
                ok(br#"{ "full_name": "Someone/Lanterns" }"#.to_vec())
            }
            "/repos/a/odd" => ok(br#"{ "full_name": "../../x" }"#.to_vec()),
            "/repos/a/limited" => (
                403,
                vec![("x-ratelimit-reset", "1793000000".into())],
                Vec::new(),
            ),
            _ => (404, Vec::new(), Vec::new()),
        });
        let ctx = with_version(tmp.path(), TAG).with_github_api(&api);
        let got = run(service::add_source(
            &ctx,
            "https://github.com/someone/lanterns",
        ))
        .unwrap();
        assert_eq!(got, ["Someone/Lanterns"], "as GitHub spells it");
        let got = run(service::add_source(&ctx, "SOMEONE/Lanterns")).unwrap();
        assert_eq!(got, ["Someone/Lanterns"], "once, in any case");

        let failures: Vec<(&str, Expect)> = vec![
            ("a/gone", |e| matches!(e, ModsError::SourceNotFound(_))),
            ("a/limited", |e| {
                matches!(
                    e,
                    ModsError::SourceRateLimited {
                        reset: Some(1_793_000_000)
                    }
                )
            }),
            ("a/odd", |e| matches!(e, ModsError::SourceInvalid(_))),
            ("not a repo", |e| matches!(e, ModsError::SourceInvalid(_))),
            ("https://gitlab.com/a/b", |e| {
                matches!(e, ModsError::SourceInvalid(_))
            }),
        ];
        for (input, want) in failures {
            let err = run(service::add_source(&ctx, input)).unwrap_err();
            assert!(want(&err), "{input}: {err:?}");
        }
        assert_eq!(service::source_list(&ctx).unwrap(), ["Someone/Lanterns"]);
        assert!(
            run(service::remove_source(&ctx, "someone/LANTERNS"))
                .unwrap()
                .is_empty()
        );
    }
}

mod profiles {
    use super::super::profile::{BlockingReason, Managed};
    use super::*;

    #[test]
    fn a_revocation_is_applied_when_the_profile_is_read() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        let world = world.stored(&ctx);
        run(install(&ctx, &world.sha("cogwork"))).unwrap();
        revoke(&ctx, &world, "showcase", "deletes saves");
        let report = run(service::profile(&ctx, TAG)).unwrap();
        let showcase = lock_of(&ctx).get("showcase").unwrap().clone();
        assert!(!showcase.enabled);
        assert_eq!(
            showcase.revoked.unwrap().reason.as_deref(),
            Some("deletes saves")
        );
        assert_eq!(handed_to_game(&ctx), ["cogwork.zip"]);
        assert!(report.revocations_pending.is_empty());
        assert_eq!(report.blocking, ["cogwork"], "it needs what was pulled");
        assert_eq!(
            report.blocking_reasons["cogwork"],
            BlockingReason::MissingDeps
        );
    }

    /// Must-do 2: nothing rewrites a running version's folder. The revocation waits, the report
    /// says so, and it is applied once the game stops.
    #[test]
    fn a_revocation_waits_while_the_game_runs() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        let world = world.stored(&ctx);
        run(install(&ctx, &world.sha("showcase"))).unwrap();
        let before = std::fs::read(ctx.paths.lock_file(TAG).unwrap()).unwrap();
        ctx.games.insert(TAG);
        revoke(&ctx, &world, "showcase", "deletes saves");

        let report = run(service::profile(&ctx, TAG)).unwrap();
        assert_eq!(report.revocations_pending, ["showcase"]);
        assert_eq!(report.blocking_reasons["showcase"], BlockingReason::Revoked);
        assert_eq!(
            std::fs::read(ctx.paths.lock_file(TAG).unwrap()).unwrap(),
            before
        );
        assert_eq!(
            handed_to_game(&ctx),
            ["showcase.zip"],
            "the running game's folder is left"
        );
        run(service::apply_pending(&ctx, TAG)).unwrap();
        assert_eq!(handed_to_game(&ctx), ["showcase.zip"], "still running");

        ctx.games.remove(TAG);
        run(service::apply_pending(&ctx, TAG)).unwrap();
        assert!(!lock_of(&ctx).get("showcase").unwrap().enabled);
        assert!(handed_to_game(&ctx).is_empty());
        let report = run(service::profile(&ctx, TAG)).unwrap();
        assert!(report.revocations_pending.is_empty() && report.blocking.is_empty());
    }

    /// Contract R4 §6, end to end: an index revocation with an uppercase hash and no reason or
    /// time still revokes.
    #[test]
    fn an_index_revocation_fails_closed() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        let world = world.stored(&ctx);
        run(install(&ctx, &world.sha("showcase"))).unwrap();
        let json = format!(
            r#"{{ "schema": 1, "generated": "2026-11-04T00:00:00Z",
                 "revoked": [ {{ "sha256": "{}", "at": null }} ] }}"#,
            world.sha("showcase").to_ascii_uppercase()
        );
        let index = super::super::index::parse(json.as_bytes()).unwrap();
        let status = world.catalog.index.clone();
        let from_index = super::super::catalog::build(Some(&index), status, Vec::new());
        let mut c = world.catalog.clone();
        c.revoked = from_index.revoked;
        ctx.hold_catalog(c);
        let report = run(service::profile(&ctx, TAG)).unwrap();
        let m = &report.mods[0];
        assert_eq!(m.status, ModStatus::Revoked);
        // Revoked all the same; no reason is none, said by the page in the player's language.
        assert_eq!(m.revoked_reason, None);
        let plan = run(service::plan(&ctx, TAG, &world.sha("showcase"))).unwrap();
        assert_eq!(
            plan.problem.unwrap().code,
            crate::error::ErrorCode::ModRevoked
        );
    }

    /// Contract R4 §4: a file in the player's own folder with a managed mod's id.
    #[test]
    fn the_players_folder_can_shadow_a_mod() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        let world = world.stored(&ctx);
        let game = tmp.path().join("game");
        let mine = game.join("mods");
        std::fs::create_dir_all(mine.join("cogwork")).unwrap();
        for f in ["showcase.ZIP", "Railways.zip", "notes.txt", ".hidden.zip"] {
            std::fs::write(mine.join(f), b"x").unwrap();
        }
        std::fs::create_dir_all(ctx.paths.logs_dir()).unwrap();
        std::fs::write(
            ctx.paths.logs_dir().join("v1.log"),
            format!(
                "[stderr]     0.010 INFO  [weft] game folder {}, cache {}\n",
                game.display(),
                tmp.path().join("cache").display()
            ),
        )
        .unwrap();
        run(install(&ctx, &world.sha("cogwork"))).unwrap();
        run(install(&ctx, &world.sha("railways"))).unwrap();

        let report = run(service::profile(&ctx, TAG)).unwrap();
        let shadowed: Vec<(&str, &str, Managed)> = report
            .shadowed
            .iter()
            .map(|s| (s.id.as_str(), s.file.as_str(), s.managed))
            .collect();
        assert_eq!(
            shadowed,
            [
                ("cogwork", "cogwork", Managed::On),
                ("showcase", "showcase.ZIP", Managed::On)
            ],
            "Railways.zip is another id to the engine; notes.txt and hidden files are skipped"
        );
        assert!(
            report.blocking.is_empty(),
            "the launcher's copy loads first"
        );

        // Turned off: the player's copy loads instead, a warning only.
        run(service::set_enabled(&ctx, TAG, "cogwork", false)).unwrap();
        let report = run(service::profile(&ctx, TAG)).unwrap();
        assert_eq!(report.shadowed[0].managed, Managed::Off);
        assert!(report.blocking.is_empty());

        // Revoked: the player's copy would load the pulled mod. That blocks, even with
        // nothing on.
        run(service::set_enabled(&ctx, TAG, "showcase", false)).unwrap();
        revoke(&ctx, &world, "showcase", "deletes saves");
        let report = run(service::profile(&ctx, TAG)).unwrap();
        assert_eq!(report.shadowed[1].managed, Managed::Revoked);
        assert_eq!(report.blocking, ["showcase"]);
        assert_eq!(
            report.blocking_reasons["showcase"],
            BlockingReason::ShadowedRevoked
        );
        let err = run(service::prepare_launch(&ctx, TAG)).err().unwrap();
        assert!(
            matches!(err, ModsError::Blocked(ref n) if n == "showcase name"),
            "{err:?}"
        );
    }

    /// Contract R4 §7, through the service: the file handed to the game is a copy of its own.
    #[cfg(unix)]
    #[test]
    fn an_install_hands_the_game_a_copy() {
        use std::os::unix::fs::MetadataExt;
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        run(install(&ctx, &world.sha("showcase"))).unwrap();
        let handed = ctx.paths.mods_dir(TAG).unwrap().join("showcase.zip");
        assert_eq!(std::fs::metadata(handed).unwrap().nlink(), 1);
        let stored = ctx.paths.store_object(&world.sha("showcase"));
        assert_eq!(std::fs::metadata(stored).unwrap().nlink(), 1);
    }
}

mod graph {
    use super::*;

    /// hearth needs cogwork needs showcase; cogwork and showcase are installed and off.
    fn with_hearth(tmp: &tempfile::TempDir) -> (Ctx, World, String) {
        let (ctx, mut world) = setup(tmp);
        let hearth = zip_of("hearth", "1");
        let base = world.catalog.mods[0].versions[0]
            .url
            .rsplit_once('/')
            .unwrap()
            .0
            .to_string();
        let v = build_of("hearth", "1.0.0", &hearth, &["cogwork"], &base);
        let sha = v.sha256.clone();
        world
            .catalog
            .mods
            .push(catalog_mod("hearth", Origin::Index, vec![v]));
        ctx.hold_catalog(world.catalog.clone());
        let world = world.stored(&ctx);
        run(install(&ctx, &world.sha("cogwork"))).unwrap();
        run(service::set_enabled(&ctx, TAG, "showcase", false)).unwrap();
        assert!(lock_of(&ctx).mods.iter().all(|m| !m.enabled));
        // Stored as if downloaded before; the server doesn't have it.
        std::fs::write(ctx.paths.store_object(&sha), &hearth).unwrap();
        (ctx, world, sha)
    }

    /// Contract R4 §1: turning on through an installed dependency turns on what it needs too.
    #[test]
    fn an_install_turns_on_the_whole_chain() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, _world, hearth) = with_hearth(&tmp);
        let plan = run(service::plan(&ctx, TAG, &hearth)).unwrap();
        let mut enable = plan.enable.clone();
        enable.sort();
        assert_eq!(enable, ["cogwork", "showcase"]);
        assert!(plan.turns_on);
        let done = run(service::install(
            &ctx,
            TAG,
            &hearth,
            &plan.plan_token,
            &next_op(),
        ))
        .unwrap();
        let mut also = done.also_enabled.clone();
        also.sort();
        assert_eq!(also, ["cogwork", "showcase"]);
        assert_eq!(
            handed_to_game(&ctx),
            ["cogwork.zip", "hearth.zip", "showcase.zip"]
        );
        assert!(done.report.blocking.is_empty());
    }

    /// When the end of the chain is revoked, the wanted mod goes in off and nothing else turns
    /// on.
    #[test]
    fn a_broken_chain_installs_the_mod_off() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world, hearth) = with_hearth(&tmp);
        revoke(&ctx, &world, "showcase", "deletes saves");
        let plan = run(service::plan(&ctx, TAG, &hearth)).unwrap();
        assert_eq!(plan.missing, ["showcase"]);
        assert!(!plan.turns_on);
        assert!(plan.enable.is_empty());
        let done = run(service::install(
            &ctx,
            TAG,
            &hearth,
            &plan.plan_token,
            &next_op(),
        ))
        .unwrap();
        assert_eq!(done.installed_off, ["hearth"]);
        assert!(done.also_enabled.is_empty());
        assert!(handed_to_game(&ctx).is_empty());
        assert!(done.report.blocking.is_empty(), "Play keeps working");
    }
}

/// A change writes three files (the lock, the undo record, the folder). Each step that fails, or
/// a launcher closed between two, leaves a state that is true, and the next start or Play
/// finishes the job.
mod saves {
    use super::*;

    /// Something stands where the version's mods folder goes, so making it fails.
    fn block_folder(ctx: &Ctx) -> std::path::PathBuf {
        let dir = ctx.paths.mods_dir(TAG).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::write(&dir, b"in the way").unwrap();
        dir
    }

    #[test]
    fn a_folder_that_cant_be_written_leaves_the_change_made_and_play_repairs_it() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        run(install(&ctx, &world.sha("cogwork"))).unwrap();
        assert_eq!(handed_to_game(&ctx), ["cogwork.zip", "showcase.zip"]);
        let dir = block_folder(&ctx);
        let err = run(service::set_enabled(&ctx, TAG, "cogwork", false)).unwrap_err();
        assert!(matches!(err, ModsError::Io(_)), "{err:?}");
        // The lock is the record of the set: the change is made.
        assert!(!lock_of(&ctx).get("cogwork").unwrap().enabled);

        // The launcher starts again, the obstacle gone: Play hands the game the set as it is.
        std::fs::remove_file(&dir).unwrap();
        let ctx = Ctx::new(ctx.paths.clone());
        assert!(
            run(service::prepare_launch(&ctx, TAG))
                .unwrap()
                .release()
                .is_some()
        );
        assert_eq!(handed_to_game(&ctx), ["showcase.zip"]);
    }

    #[test]
    fn a_launcher_closed_between_the_lock_and_the_folder_is_repaired_at_play() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        run(install(&ctx, &world.sha("cogwork"))).unwrap();
        // What a change that stopped after the lock and before the folder leaves behind.
        let mut lock = lock_of(&ctx);
        lock.get_mut("cogwork").unwrap().enabled = false;
        store::write_lock(&ctx.paths, TAG, &lock).unwrap();
        assert_eq!(
            handed_to_game(&ctx),
            ["cogwork.zip", "showcase.zip"],
            "the folder is behind"
        );

        let ctx = Ctx::new(ctx.paths.clone());
        let offline = service::offline_catalog(&ctx.paths);
        let report = run(service::build_report(
            &ctx,
            TAG,
            &lock_of(&ctx),
            &offline,
            false,
        ));
        let cogwork = report
            .mods
            .iter()
            .find(|m| m.entry.id == "cogwork")
            .unwrap();
        assert!(!cogwork.entry.enabled, "the page shows the lock");
        assert!(
            run(service::prepare_launch(&ctx, TAG))
                .unwrap()
                .release()
                .is_some()
        );
        assert_eq!(handed_to_game(&ctx), ["showcase.zip"]);
    }

    #[test]
    fn a_store_copy_that_is_gone_is_said_as_such_and_installing_the_build_again_brings_it_back() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        run(install(&ctx, &world.sha("showcase"))).unwrap();
        std::fs::remove_file(ctx.paths.store_object(&world.sha("showcase"))).unwrap();
        // The game's copy goes too, so the launch has to copy it again from the store.
        let _ = std::fs::remove_file(ctx.paths.mods_dir(TAG).unwrap().join("showcase.zip"));
        let Err(err) = run(service::prepare_launch(&ctx, TAG)) else {
            panic!("a launch with a store copy gone went ahead");
        };
        assert!(
            matches!(err, ModsError::StoreMissing(ref id) if id == "showcase"),
            "{err:?}"
        );
        assert_eq!(
            crate::error::AppError::from(err).code,
            crate::error::ErrorCode::ModStoreMissing
        );
        // The same build installed again: downloaded, and the launch goes ahead.
        run(install(&ctx, &world.sha("showcase"))).unwrap();
        assert!(ctx.paths.store_object(&world.sha("showcase")).exists());
        assert!(
            run(service::prepare_launch(&ctx, TAG))
                .unwrap()
                .release()
                .is_some()
        );
        assert_eq!(handed_to_game(&ctx), ["showcase.zip"]);
    }

    #[test]
    fn a_removal_whose_undo_cant_be_kept_still_stands_without_an_undo() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        run(install(&ctx, &world.sha("showcase"))).unwrap();
        // Something stands where the undo record goes.
        let record = ctx.paths.removed_file(TAG).unwrap();
        std::fs::create_dir_all(record.join("in-the-way")).unwrap();
        let done = run(service::remove(&ctx, TAG, "showcase")).unwrap();
        assert_eq!(done.undo, None, "no Undo is offered that couldn't work");
        assert!(lock_of(&ctx).get("showcase").is_none());
        assert_eq!(handed_to_game(&ctx), Vec::<String>::new());

        // After a restart it is still removed, and there is nothing to undo.
        let ctx = Ctx::new(ctx.paths.clone());
        ctx.hold_catalog(world.catalog.clone());
        let err = run(restore(&ctx, "showcase")).unwrap_err();
        assert!(matches!(err, ModsError::NotInstalled(_)), "{err:?}");
    }

    #[test]
    fn an_old_undo_that_cant_be_cleared_stops_the_change_before_it_is_made() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        run(install(&ctx, &world.sha("showcase"))).unwrap();
        let before = std::fs::read(ctx.paths.lock_file(TAG).unwrap()).unwrap();
        let record = ctx.paths.removed_file(TAG).unwrap();
        std::fs::create_dir_all(record.join("in-the-way")).unwrap();
        let err = run(service::set_enabled(&ctx, TAG, "showcase", false)).unwrap_err();
        assert!(matches!(err, ModsError::Io(_)), "{err:?}");
        assert_eq!(
            std::fs::read(ctx.paths.lock_file(TAG).unwrap()).unwrap(),
            before,
            "nothing changed"
        );
        assert_eq!(handed_to_game(&ctx), ["showcase.zip"]);
    }

    /// A removal's Undo is gone after a restart only if the record is: it is a file, not memory.
    #[test]
    fn an_undo_survives_a_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        run(install(&ctx, &world.sha("showcase"))).unwrap();
        let done = run(service::remove(&ctx, TAG, "showcase")).unwrap();
        assert_eq!(done.undo.as_deref(), Some("showcase"));
        let ctx = Ctx::new(ctx.paths.clone());
        ctx.hold_catalog(world.catalog.clone());
        run(restore(&ctx, "showcase")).unwrap();
        assert!(lock_of(&ctx).get("showcase").unwrap().enabled);
        assert_eq!(handed_to_game(&ctx), ["showcase.zip"]);
    }
}

mod catalogue {
    use super::super::catalog::CatalogUpdate;
    use super::super::index::Freshness;
    use super::super::index::tests::{FIXTURE, FIXTURE_KEY, FIXTURE_SIG};
    use super::super::sources;
    use super::*;
    use std::time::{Duration, Instant};

    /// The index (and its revocations) is held and said as soon as it verifies: a source that
    /// takes long to answer doesn't hold it back. The whole answer still comes at the end.
    #[test]
    fn the_index_does_not_wait_for_a_slow_source() {
        let tmp = tempfile::tempdir().unwrap();
        let index = serve(|path| match path {
            "/index.json" => ok(FIXTURE.to_vec()),
            "/index.json.minisig" => ok(FIXTURE_SIG.as_bytes().to_vec()),
            _ => (404, Vec::new(), Vec::new()),
        });
        // A source whose releases take a second and a half to arrive.
        let api = serve(|_| (200, vec![("slow", "1500".into())], b"[]".to_vec()));
        let said: Arc<Mutex<Vec<(Instant, CatalogUpdate, u64)>>> = Arc::default();
        let ctx = Ctx::new(super::super::paths::Paths::new(tmp.path()))
            .with_index(&format!("{index}/index.json"), FIXTURE_KEY)
            .with_github_api(&api);
        let ctx = {
            let (said, held) = (said.clone(), ctx.catalog.clone());
            ctx.with_catalog_listener(move |u| {
                // What Play and every set read would use at this moment.
                let revision = held
                    .0
                    .lock()
                    .unwrap()
                    .catalog
                    .as_ref()
                    .map_or(0, |c| c.revision);
                said.lock().unwrap().push((Instant::now(), u, revision));
            })
        };
        sources::save(&ctx.paths, &["someone/slow".into()]).unwrap();

        let started = Instant::now();
        let catalog = run(service::load_catalog(&ctx, true)).unwrap();
        let done = Instant::now();
        let said = said.lock().unwrap();
        let (at, first, held_revision) = &said[0];
        assert_eq!(
            first.pending,
            ["someone/slow"],
            "said while the source is still asked"
        );
        assert_eq!(first.catalog.index.freshness, Freshness::Fresh);
        assert_eq!(first.catalog.mods.len(), 1, "the index's mods are in");
        assert_eq!(
            *held_revision, first.catalog.revision,
            "and held, for Play and set reads"
        );
        // Said while the source was still being asked (it is in `pending`), however long the
        // index took to verify and save; the source itself took its second and a half.
        assert!(*at < done && done.duration_since(started) >= Duration::from_millis(1500));
        // Then the source, and the whole answer: nothing left waiting.
        assert!(said.iter().any(|(_, u, _)| u.pending.is_empty()));
        assert_eq!(catalog.sources.len(), 1);
        assert!(catalog.revision >= first.catalog.revision);
    }
}
