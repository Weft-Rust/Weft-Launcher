//! The operations in `service.rs`, run as the app runs them but without Tauri: a [`Ctx`] on a
//! temporary folder, a catalogue held as if the page had loaded it, and a local HTTP server
//! standing in for GitHub.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use super::archive::tests::make_zip;
use super::catalog::{Catalog, CatalogVersion, Origin, RevokedView};
use super::context::{Ctx, tests::with_version};
use super::error::ModsError;
use super::index::{Channel, WeftAbi};
use super::install::ProgressStage;
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
            let mut head = format!("HTTP/1.1 {status} X\r\nConnection: close\r\n");
            if !headers.iter().any(|(k, _)| *k == "no-length") {
                head.push_str(&format!("Content-Length: {}\r\n", body.len()));
            }
            for (k, v) in headers.iter().filter(|(k, _)| *k != "no-length") {
                head.push_str(&format!("{k}: {v}\r\n"));
            }
            head.push_str("\r\n");
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&body);
        }
    });
    base
}

fn ok(body: Vec<u8>) -> Answer {
    (200, Vec::new(), body)
}

/// A mod zip with a Linux library; `salt` makes builds of one mod differ.
fn zip_of(id: &str, salt: &str) -> Vec<u8> {
    let lib = format!("lib{id}.so");
    make_zip(&[(lib.as_str(), salt.as_bytes())])
}

/// A catalogue build of `id` whose bytes are `zip`, downloaded from `base`.
fn build_of(id: &str, version: &str, zip: &[u8], deps: &[&str], base: &str) -> CatalogVersion {
    let mut v = build(id, version, ABI, Channel::Release, deps);
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

    let done = run(service::install(&ctx, TAG, &world.sha("cogwork"))).unwrap();
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

    let err = run(service::install(&ctx, TAG, &world.sha("showcase"))).unwrap_err();
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
        let err = run(service::install(&ctx, TAG, &world.sha("showcase"))).unwrap_err();
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

    let err = run(service::install(&ctx, TAG, &sha)).unwrap_err();
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

    let done = run(service::install(&ctx, TAG, &world.sha("railways"))).unwrap();
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
        run(service::install(&ctx, TAG, &world.sha("showcase"))).unwrap();
        let before = std::fs::read(ctx.paths.lock_file(TAG).unwrap()).unwrap();

        let (m, v) = world.catalog.find(&world.sha("cogwork")).unwrap();
        let staged = service::stage(
            &ctx,
            TAG,
            world.catalog.clone(),
            ABI.into(),
            vec![(m.clone(), v.clone())],
            Vec::new(),
        )
        .unwrap();
        run(service::fetch(&ctx, &staged)).unwrap();
        change(&ctx, &world);
        let err = run(service::commit(&ctx, staged)).unwrap_err();
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
                reason: "deletes saves".into(),
            });
            ctx.hold_catalog(c);
        }));
        assert!(why.contains("deletes saves"), "{why}");
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

    #[test]
    fn nothing_changed() {
        let tmp = tempfile::tempdir().unwrap();
        let (ctx, world) = setup(&tmp);
        let (m, v) = world.catalog.find(&world.sha("cogwork")).unwrap();
        let wanted = vec![(m.clone(), v.clone())];
        let staged = service::stage(
            &ctx,
            TAG,
            world.catalog.clone(),
            ABI.into(),
            wanted,
            Vec::new(),
        )
        .unwrap();
        run(service::fetch(&ctx, &staged)).unwrap();
        let done = run(service::commit(&ctx, staged)).unwrap();
        assert_eq!(done.installed, ["cogwork", "showcase"]);
    }
}

#[test]
fn remove_can_be_undone_until_the_next_change() {
    let tmp = tempfile::tempdir().unwrap();
    let (ctx, world) = setup(&tmp);
    let world = world.stored(&ctx);
    run(service::install(&ctx, TAG, &world.sha("cogwork"))).unwrap();
    let showcase_before = lock_of(&ctx).get("showcase").unwrap().clone();

    let done = run(service::remove(&ctx, TAG, "showcase")).unwrap();
    assert_eq!(done.undo.as_deref(), Some("showcase"));
    assert_eq!(done.also_disabled, ["cogwork"]);
    assert!(
        ctx.paths.store_object(&world.sha("showcase")).exists(),
        "its file is kept for Undo"
    );
    assert_eq!(handed_to_game(&ctx), Vec::<String>::new());

    let done = run(service::restore(&ctx, TAG, "showcase")).unwrap();
    assert!(done.undo.is_none());
    assert_eq!(done.also_enabled, ["cogwork"]);
    let lock = lock_of(&ctx);
    let showcase = lock.get("showcase").unwrap();
    assert_eq!(showcase.sha256, showcase_before.sha256);
    assert_eq!(showcase.enabled, showcase_before.enabled);
    assert_eq!(showcase.installed_at, showcase_before.installed_at);
    assert_eq!(handed_to_game(&ctx), ["cogwork.zip", "showcase.zip"]);
    assert!(matches!(
        run(service::restore(&ctx, TAG, "showcase")),
        Err(ModsError::NotInstalled(_))
    ));

    // Any other change ends the undo, and the file goes with the next collection.
    run(service::remove(&ctx, TAG, "showcase")).unwrap();
    run(service::set_enabled(&ctx, TAG, "cogwork", false)).unwrap();
    assert!(matches!(
        run(service::restore(&ctx, TAG, "showcase")),
        Err(ModsError::NotInstalled(_))
    ));
    assert!(!ctx.paths.store_object(&world.sha("showcase")).exists());
}

#[test]
fn undo_needs_the_same_bytes() {
    let tmp = tempfile::tempdir().unwrap();
    let (ctx, world) = setup(&tmp);
    let world = world.stored(&ctx);
    run(service::install(&ctx, TAG, &world.sha("showcase"))).unwrap();
    run(service::set_enabled(&ctx, TAG, "showcase", false)).unwrap();
    run(service::remove(&ctx, TAG, "showcase")).unwrap();
    assert!(matches!(
        run(service::restore(&ctx, TAG, "cogwork")),
        Err(ModsError::NotInstalled(_))
    ));
    std::fs::write(ctx.paths.store_object(&world.sha("showcase")), b"changed").unwrap();
    assert!(matches!(
        run(service::restore(&ctx, TAG, "showcase")),
        Err(ModsError::NotInstalled(_))
    ));
    std::fs::write(
        ctx.paths.store_object(&world.sha("showcase")),
        &world.showcase,
    )
    .unwrap();
    run(service::restore(&ctx, TAG, "showcase")).unwrap();
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
    run(service::install(&installer, TAG, &world.sha("cogwork"))).unwrap();
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
        reason: "deletes saves".into(),
        at: String::new(),
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
        reason: "x".into(),
        at: String::new(),
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
    run(service::install(&ctx, TAG, &world.sha("showcase"))).unwrap();
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
        for bad in ["/big.png", "/big-unannounced.png", "/not.png"] {
            assert!(matches!(get(bad), Err(ModsError::TooLarge(_))), "{bad}");
        }
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
