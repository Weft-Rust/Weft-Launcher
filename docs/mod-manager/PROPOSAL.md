# Mod manager for Weft Launcher: proposal

Status: Phases 1 and 2 are implemented on `feat/mod-manager` (see [What shipped](#what-shipped)); Phase 3 needs engine changes and is not started. Written 2026-11-04. Mockup (the first design; the app has moved on since): [`history/mockup.html`](history/mockup.html). Open it in a browser; it's drawn at 1:1 in the launcher's own pixel style.

Sources:
- Read-only research of the engine (`Weft` @ `7c69c9c`, `master`).
- Read-only research of `Zorro909/weft-mods` (engine pinned at `ff9c712` = `v26.11.1`).
- This repo.

Engine file references below are relative to the Weft repo.

---

## 1. What we're working with (facts, not proposals)

### A mod is native code
- A mod is a Rust `cdylib` that exports `weft_mod() -> *const ModDecl` (`crates/sdk/src/lib.rs:103-125`).
- It is distributed as one fat `<id>.zip` holding `<id>.dll`, `lib<id>.so`, `lib<id>.dylib` and `assets/`. The engine picks the library for its own OS (`crates/engine/src/modloader.rs:71-75`).
- It is loaded with `libloading`, so it runs with the player's full privileges (`modloader.rs:309`). There is no sandbox and no permission system. A WASM tier doesn't exist yet.
- **Turned-off mods still run code.** The engine `dlopen`s every library and calls `weft_mod()` before it applies `disabled_mods.txt` (`modloader.rs:305-332` vs `:346`).
- There is **no manifest file**:
  - `id`, `version` and `deps` are compiled into the library.
  - The display name, description and authors come from lang keys.
  - The icon is `assets/textures/gui/icon.png`.
  - The file name must equal the crate name (`modloader.rs:328-331`).
- Data-only mods are impossible today: a folder without a library is an error. Resource packs and shader packs are separate and data-only.

### Compatibility is exact, fragile, and failure is fatal
- `ABI_VERSION` is the FNV-1a-64 hash of the raw text of `crates/abi/src/lib.rs`. A mod loads only if its hash is equal (`modloader.rs:321`).
- Across v0.1.0 → v26.11.1 the hash changed in almost every release. Only 26.10.1 → 26.10.2 kept it.
- A mismatch, a missing symbol, a missing dependency or a panicking `init` **all abort startup**. The result is `exit(1)` with no dialog, and the text only appears in `latest.log` (`app.rs:319`, `main.rs:144-147`).
- One mismatched mod blocks every version it wasn't built for. That includes a turned-off mod (the ABI check runs before the off filter).

### Where the engine looks
The engine checks these folders in order; for each id, the first copy found wins (`modloader.rs:52-59`, `main.rs:61,118-135`):
1. Every `--mods <dir>` (repeatable).
2. `<data>/mods`, the player's folder. It is **shared by every installed version**.
3. `<install>/run/mods`, the shipped mods such as `base`.

`--run-dir <p>` moves data, config and cache under `<p>`. There is no flag to skip the player's folder. Unknown flags are passed through to mods and **start the game**, so `weft --version` can't be used as a probe (`main.rs:81-87`).

### How weft-mods releases today
- Tags have the form `<id>-v<version>`. Each GitHub release has exactly one asset, `<id>.zip`.
- RCs and experimental builds are marked `--prerelease`. Experimental tags look like `<id>-v<ver>-experimental.<weft7>.<mod7>`, and their binary reports the same version as the full release.
- The only integrity data is GitHub's own `digest: sha256:…` per asset. There is no checksums file, signature or attestation.
- Compatibility is recorded only as prose in the release notes: `Built against Weft <ver>, commit <sha7>`.
- There is no machine-readable index, and the repo has no LICENSE.

### What the launcher already does that we can reuse
- It reads the GitHub releases API with ETag caching (`releases.rs`).
- It requires a SHA-256 and verifies it (`install_version` in `install.rs`).
- It restricts download URLs to one repo (also `install_version`).
- It extracts archives safely and installs atomically.
- It enforces one running game at a time and captures logs per version.
- **`minisign-verify` 0.3 is already in `Cargo.lock`**, pulled in by the updater, so signature checking costs no new dependency.

---

## 2. Design principles

1. **Mod sets belong to a game version.** The ABI changes almost every release, so a shared mod folder is a trap. Each installed version gets its own set, passed with `--mods`.
2. **The launcher never writes into the player's Weft folder.** This keeps the README promise. Mods live under the launcher's data folder.
3. **"Off" means not passed to the game.** The engine runs code even from turned-off mods, so the launcher turns a mod off by leaving it out of the folder it hands over. It doesn't use `disabled_mods.txt`.
4. **Don't start a launch that is known to fail.** Check the ABI and dependencies before Play. If the game still dies during mod loading, name the mod.
5. **Be honest about trust.** Show what was actually verified. Never show a fake permission list. Always say that native mods can do anything.

---

## 3. Architecture (launcher side)

### On-disk layout (`%APPDATA%\dev.weft.launcher\…`)

As built (`src-tauri/src/mods/paths.rs`):

```
mods/
  store/<sha256>.zip              content-addressed; hashed when added, and again whenever reused
  sources.json                    the GitHub repos the player added, as GitHub spells them
  sources.damaged-<secs>.json     a sources.json that couldn't be read, set aside rather than lost
profiles/<weft-tag>/
  mods/<id>.zip                   only the turned-on mods, each its own copy (never a hard link)
  mods.lock.json                  every installed mod: id, version, sha256, origin, trust, enabled,
                                  ABI, deps, and the revocation once one applied
  removed.json                    the last removed mod, until the version's next change (Undo)
cache/
  mod-index/<n>/index.json        verified index generations, each with its index.json.minisig;
  mod-index/current               `current` names the newest; the newest two are kept
  mod-index.state.json            the newest (generated, signedAt) ever accepted, for rollback refusal
  mod-sources/<owner__repo>.json  the last good answer of each source, with when it was fetched
  mod-icons/<hash>.png            catalogue icons
  abi.json                        ABI hash per Weft tag, kept forever since tags don't change
downloads/mod-<sha256>-<unique>.part   a download in progress; never shared by two downloads
```

The index URL is built in (`index/fetch.rs`); `sources.json` holds only repos.

Launch becomes `weft --mods <profiles/<tag>/mods>`. Turning a mod on or off copies its build into that folder or removes it. When a version is deleted, its profile goes with it, and unused store entries are garbage-collected. Garbage collection skips any store object an install is still working on or a removal can still undo, and deletes nothing if any lock file can't be read. Lock files are checked when read: an id that isn't a mod id or a hash that isn't one is an error, never a path.

### Backend modules (`src-tauri/src/mods/`)

| Module | Job |
|---|---|
| `abi.rs` | ABI hash of a Weft tag: the index's `weft[]` table, else a cache, else FNV-1a-64 of `raw.githubusercontent.com/Weft-Rust/Weft/<tag>/crates/abi/src/lib.rs` (verified against v26.10.2 and v26.10.4). **Later:** read a `weft-abi.txt` release asset. |
| `index/` | The index contract. `format.rs` parses it entry by entry (a bad entry is skipped, not fatal); `signature.rs` verifies it (minisign) and reads the signing time; `cache.rs` keeps verified copies as generations for offline use, refuses an index older than the newest ever accepted, and calls one signed over 30 days ago stale; `fetch.rs` gets it. |
| `sources.rs` | GitHub repos the player added: read their releases (ETag-cached, up to 5 pages of 100) and accept a `<id>.mod.json` only where it agrees with GitHub (see [INDEX_FORMAT.md](INDEX_FORMAT.md)). Falls back to the last good answer and reports why. |
| `catalog.rs` | Merge the index and the sources into one list with a trust tier per version; a source build with a reviewed hash counts as Reviewed. |
| `archive.rs` | Check the zip structure (below) before anything is stored. |
| `profile.rs` | Rules on a mod set: the status of each mod, what blocks the game and why (`blockingReasons`), which files in the player's folder shadow it, which update fits, revocations. |
| `plan/` | Rules for changing a mod set. `resolution.rs`: what an install brings along (`plan_mod_install`), through the whole dependency graph, and whether a build is installable. `consent.rs`: the plan token (`Consent`) and whether a plan still holds. `copies.rs`: what a copy brings over. `mod.rs`: turning on and off, and removal. |
| `store.rs` | The store, lock files, the undo record, the per-version folders (`reconcile`, which copies), reservations for in-flight installs, garbage collection. `admit` is the one way into the store: it hashes the file and checks its zip and platform, also for a build the store already has. |
| `install.rs` | Download a build through the shared `download.rs`, cancellable, and hand it to `store::admit`. |
| `inspect.rs` | Describe a zip from the player's computer before it is installed. |
| `diagnose.rs` | Read the game log after a crash and name the mod that stopped it. |
| `context.rs` | `Ctx`: what the operations need from the app (folders, the mods lock, reservations, the catalogue the page last saw, the running game, the operations under way, progress events). Tests build one on a temporary folder. |
| `paths.rs` | Where everything lives under the launcher's data folder, and `write_atomic`. |
| `version.rs` | Comparing mod versions (semver order). |
| `error.rs` | `ModsError`, and the `ErrorCode` each one reports to the page. |
| `service/` | The operations, one per command. `mod.rs`: the ABI, reports, saving a set and reconciling its folder. `fetching.rs`: the catalogue (index and sources, held in parts), icons and the list of sources. `changes.rs`: plan, install from the catalogue or a file, on/off, removal and undo. `copying.rs`: "Copy mods from…". `launching.rs`: the pre-Play check. |
| `commands.rs` | The Tauri commands: each one is a single call into `service`. |

Pure rules (`plan/`, `profile.rs`, `catalog.rs`, `index/format.rs`, `diagnose.rs`) take plain data, and everything else takes a `Paths` root or a `Ctx`, so all of it is tested without the app (`service_tests.rs` runs installs against a local HTTP server). The TypeScript types for IPC are generated from the Rust types into `src/mods/bindings/`, with every command's arguments and result (`CommandSignatures`) and every event's payload (`EventPayloads`); `src/mods/api.ts` calls commands only through them. After changing a type or a command, regenerate them with `cargo test export_bindings -- --ignored` in `src-tauri`; `bindings_are_current` fails CI until that is committed. The mock's rule cases in `src/dev/fixtures/rules.json` run against both the mock (`mockRules.test.ts`) and these rules (`rules_fixture.rs`).

Tauri commands: `list_mod_catalog`, `refresh_mod_source`, `get_mod_sources`, `add_mod_source`, `remove_mod_source`, `get_mod_profile`, `plan_mod_install`, `install_mod`, `inspect_mod_file`, `install_mod_file`, `set_mod_enabled`, `remove_mod`, `restore_mod`, `preview_copy_mod_profile`, `copy_mod_profile`, `cancel_mod_operation`, `get_mod_icon`, `open_player_mods_folder`. (`doc_tests.rs` checks this list against `lib.rs`.) The pre-Play check runs inside `launch_version`, which holds the mod lock from that check until the game counts as running, so no mod change can land in between.

### Changing a mod set safely
- Every change to a profile or the store's contents happens under the mods lock. Downloads happen before taking it; their store files are reserved so garbage collection leaves them alone.
- **Dependencies resolve through the whole graph.** An install, a copy and turning a mod on walk every dependency, through builds the change picks and through installed mods alike. An installed dependency that fits and isn't revoked is used, turned on if it is off, and what *it* needs is resolved in turn. `InstallPlan.enable` lists everything that turns on.
- **The reviewed plan is binding.** `plan_mod_install`, `preview_copy_mod_profile` and `inspect_mod_file` return a `planToken`: a digest of everything the player agrees to, namely every build that will be installed (hash and trust), every mod that ends up on, what turns on, what is installed off or missing, and the version's ABI. `install_mod`, `copy_mod_profile` and `install_mod_file` take it back. The backend recomputes it from the current catalogue, profile and ABI before downloading anything, and again under the lock at commit. When it differs, the command fails with `ModChangedMeanwhile` and writes nothing; the page plans again and shows the new plan. At commit the version must also still be installed and not running, and no build may be revoked in the latest catalogue. A file install checks revocation again at commit by the file's hash, whether the catalogue knows the file or not.
- **Operations have ids and can be cancelled.** `install_mod`, `copy_mod_profile`, `install_mod_file` and `restore_mod` take an `operationId` the page chooses. Every `mod-progress` event carries it, with the file's place in the operation (`index` of `count`). `cancel_mod_operation(operationId)` stops the operation until it starts writing: its download is aborted, the command fails with `ModCancelled`, the lock file is untouched, and no partial file stays (builds it had already stored are collected). Once it writes, cancelling returns `false`.
- **A new install never breaks Play.** A mod is installed turned on when it is new or was on, and nothing it needs is missing at any depth (`InstallPlan.turnsOn`). Otherwise it is installed turned off and listed in `ChangeResult.installedOff`; the dependencies it brought come in off too, and nothing else is turned on. Copies follow the same rule per mod. A mod that is already on *can* block Play: when something it needs is later turned off, removed or revoked, or it doesn't fit the version. Home and Mods then name the cause and offer the fix.
- **Nothing changes under a running game.** While a version's game runs, nothing rewrites its lock file or its `mods/` folder. Changes are refused with `GameRunning`; a revocation that arrives is reported (`ProfileReport.revocationsPending`, reason `revoked` in `blockingReasons`) and applied when the game stops.
- **Each version's folder holds copies.** `reconcile` copies each turned-on build from the store (a reflink where the file system does that), never a hard link, so a write to one file can't reach the store or another version. It hashes what is there again on every run and replaces anything that changed.
- **Remove can be undone.** `remove_mod` keeps the removed entry in `removed.json`, and its store file, until the version's next change; `restore_mod` puts it back exactly as it was, and turns on again what the removal turned off.

### Checking the zip structure (before it is stored)
- Only `<id>.dll`, `lib<id>.so`, `lib<id>.dylib` and `assets/**` are allowed, for the expected `<id>`.
- No `..`, absolute paths or symlinks.
- Caps on entry count, uncompressed size and compression ratio (zip bombs).
- `<id>` is a mod id (`[a-z0-9_]{1,64}`). The store names the file `<sha256>.zip`; the version's folder names it `<id>.zip`, which the engine requires.

The launcher never unpacks the zip to run anything, and **never `dlopen`s a mod to read its metadata**: that would run its code.

### The pre-Play check
- Every turned-on mod's ABI must equal the version's ABI.
- Every dependency must be turned on, or be `base`.
- If either fails, Play is blocked with the reason and a fix (turn off / find update).
- It never touches the network: it uses the catalogue the page last loaded (or the cached one) and the cached ABI. With no ABI known, mods are only "unchecked" and Play isn't blocked for it; the game has the last word.
- Also list what is in the player's own `<data>/mods`. The path comes from the `game folder …` log line the launcher already parses. Warn: "these load in every version and can't be checked". This is the one place the launcher *reads* the game folder, and it's a listing only.

### The player's folder and precedence
The engine names a mod by its folder, or by the stem of `<id>.zip`, and loads the **first** copy of each id it finds, searching the `--mods` folder (the launcher's, for this version) before the player's `<data>/mods`, and that before the shipped mods. The player's folder loads even when the launcher passes no `--mods` at all.

So a file in the player's folder with the id of a mod in the set (`ProfileReport.shadowed`, with what the launcher's copy is: `on`, `off` or `revoked`):
- is ignored while the launcher's copy is on, since the launcher's loads first;
- **loads instead** while the launcher's copy is off: a warning, since "Turn off" doesn't turn it off;
- **blocks Play** when the launcher's copy is revoked, since the pulled mod would load anyway. It is listed in `blocking` with the reason `shadowedRevoked`, and Play is refused even with nothing on.

Names compare exactly, as the engine compares them: `Cogwork.zip` is another id than `cogwork`.

### Diagnosing a failure after Play
On `exit(1)`, scan the version's log for the engine's fixed messages. The engine's loader returns them as errors (`crates/engine/src/modloader.rs`, `content.rs`), and the `weft` binary logs them at ERROR, as `<time> ERROR [weft] <message>`. Only ERROR lines of the target `weft` count: a mod's own lines (`[mod:x]`) can say anything, so they never name the culprit (except the panic line below, which only names the panicking mod):
- `mod X was built against another mod ABI (…)`
- `loading mod X from <path>: <why>`
- `<path> is not a Weft mod`
- `mod X is the crate Y: name its folder or zip Y`
- `mod X requires missing mod Y`
- `X: init panicked`, after the mod's own `[mod:X] panicked at …` line. Without the `X:` prefix, the mod comes from that line.

Show "X stopped Weft from starting" with Turn off / Find update / Open log (mockup 4). This builds on the existing `lastCrash` UI in `Home.tsx`.

### Moving to a new Weft version
When a new version is installed, offer "Copy mods from v26.10.4". Each mod is resolved to the build for the new ABI, and the launcher lists the ones that have no build yet. Because the ABI breaks with nearly every release, this is the feature players will use most.

---

## 4. Trust model: better than "trust me bro"

What we can and can't promise:
- We **can** prove *where a file came from* and *that it hasn't changed*.
- We **cannot** prove *that it's harmless*. Every tier below still runs native code with the player's privileges, and the UI says so on every install.

### The trust tiers the UI shows

Each build has exactly one tier. As built:

| Badge | Meaning | What was checked |
|---|---|---|
| **Reviewed** (green) | In the signed Weft mod index, with a recorded review (`reviewed.by`) | Index signature ✔, SHA-256 equals the index pin ✔, zip structure ✔. Provenance is shown as the index's record only when the index records all of it (`buildRecord: "recorded"`). |
| **Unreviewed** (grey) | From a GitHub repo the player added as a source; nobody reviewed it | The `<id>.mod.json` agrees with GitHub's record of the release ✔, SHA-256 equals GitHub's `digest` (from the same server as the file) ✔, zip structure ✔. A provenance claim in the `.mod.json` is shown as the publisher's claim, not verified. |
| **Unverified** (red) | A file from the player's computer that isn't in the catalogue | Zip structure only. Typed confirmation needed (mockup 3). A local file whose hash is in the catalogue installs with that build's tier instead. |

**Revoked** is a status, not a tier. A build of any tier whose `sha256` the index lists in `revoked` is never installed, and can't be turned back on, not even by turning on something that needs it. The UI says why, and shows a Revoked badge instead of the tier.

When it applies:
- The launcher learns of a revocation whenever it reads the index: from its cache, or from the network when the catalogue is refreshed.
- An installed revoked build is turned off the next time its version's mods are read (`get_mod_profile`) or before Play, whichever comes first. The revocation is then recorded in `mods.lock.json` with its reason, and stays even if the index can't be loaded later, until the build is replaced or removed.
- An install already downloading when the revocation arrives checks the latest catalogue before it writes anything, and fails with `ModChangedMeanwhile`.

**Age.** The launcher reports when the index was signed (`signedAt`, from the signature's trusted comment). An index signed more than 30 days ago is `stale`: it is still used, and the UI says revocations since then may be missing. The index repository re-signs weekly. An index older than the newest one ever accepted is refused, even after the cached copy was deleted (see [INDEX_FORMAT.md](INDEX_FORMAT.md#launcher-behaviour)).

### The checks, from cheapest to strongest

1. **SHA-256 against GitHub `digest`.** Exists today. Proves only that the file wasn't corrupted in transit, because it comes over the same channel as the file.
2. **Checking the zip structure.** Launcher-only, described above.
3. **A curated, signed index** (e.g. a `Weft-Rust/weft-mod-index` repo).
   - Each mod version is added through a reviewed PR and pinned by sha256, source repo + commit, Weft tag and ABI.
   - CI signs `index.json` with minisign. The public key is embedded in the launcher; that's `minisign-verify`, already in the dependency tree.
   - The index also carries a `revoked` list.
   - This is the core of the "Reviewed" tier. A compromised mod repo or GitHub account can't change pinned bytes without the index key.
4. **Build provenance** via `actions/attest-build-provenance` in weft-mods CI (Sigstore, keyless). Proves "this zip was built by workflow W of repo R at commit C", which makes "the source is public" checkable.
   - Launcher verification options: the GitHub attestations API, or a `<id>.zip.sigstore.json` bundle asset checked with the `sigstore` crate. Bundle support in that crate still needs a maturity check.
   - Until then, the index reviewer runs `gh attestation verify` when reviewing, and the index pins the result.
5. **The engine re-checking the hash** (engine change). `--mod-hashes <file>` makes the engine hash *the copy it loads* (`modloader.rs:307`). That closes the gap between the launcher's check and the actual load, including tampering with the unpack cache.
6. **Later: real untrusted tiers.** Data-only mods (assets plus declarative content, no library), then possibly a WASM "script" tier with a smaller set of capabilities. These are the only options that actually *limit* what a mod can do.

The UI deliberately has **no permission list**. Native code has no permissions to list, and showing one would be the "trust me bro" we're trying to avoid.

---

## 5. Changes needed outside this repo

### weft-mods (small; you own it)
1. Publish `<id>.mod.json` next to `<id>.zip`, generated in `tools/ci/publish.sh`. It replaces the prose compatibility record. The format, with a complete example the launcher's tests accept, is in [INDEX_FORMAT.md](INDEX_FORMAT.md#idmodjson-for-unreviewed-sources): every hash and commit in full, `asset.url` included, and `icon` as an absolute `https://` URL.
2. Add `actions/attest-build-provenance` to the `publish` jobs. This needs `id-token: write` and `attestations: write`, packing into a known directory instead of `mktemp -d`, and optionally uploading `<id>.zip.sigstore.json`.
3. Add a LICENSE and `license` fields, and an icon for showcase.

### Weft engine (ranked by value to the launcher)
1. **Don't load turned-off mods, and make mod failures non-fatal.** Check the off list before `dlopen`, then skip and report instead of `Err`. This is a precondition for any trust model.
2. **`--no-user-mods`** (only the `--mods` folders count) and **`--disabled-mods <file>`**. With these, the launcher fully owns the mod set for each version.
3. **Publish `weft-abi.txt`** (or `release.json`) as a release asset, and/or add **`weft --info --json`** that exits before any window or mod loading.
4. **`weft-mod.toml` inside the zip, written by `--pack-mod`**: id, version, ABI, deps, SHA-256 of each library, so tools can read metadata without loading code.
5. **A machine-readable load report** (`logs/mods.json`) and a separate exit code for a mod load failure.
6. **`--mod-hashes <file>`**, the engine-side re-check (§4.5).
7. A less fragile ABI hash (declarations only, or a hand-bumped epoch), and an unpack cache keyed on content hash.

---

## 6. Phases

| Phase | Scope | Needs |
|---|---|---|
| **1. Mods tab** | Per-version profiles via `--mods`; GitHub repo sources (none added by default); ABI computed from source; pre-Play check; log diagnosis; local-file install with the Unverified flow; warning about the player's own folder | weft-mods change 1 (`mod.json`) |
| **2. Trust** | Signed curated index, Reviewed tier, revocation, provenance verification, "Copy mods from…" | Index repo + minisign key; weft-mods change 2 |
| **3. Engine integration** | `--no-user-mods`, `--disabled-mods`, `weft-abi.txt`, `mods.json` report, `--mod-hashes` | Engine changes 1–6 |
| **Later** | Data-only mods, WASM tier, server mod-set sync | Engine design work |

---

## 7. Decisions and open questions

Decided, as built:
1. **Isolation scope.** Per-version mod sets with shared saves. Full instances (`--run-dir`) are not planned.
2. **Index hosting.** `Zorro909/weft-mods-index`, served from GitHub Pages, signed in its CI. Who else reviews, and moving the key offline, are still to settle.
3. **The player's mods folder** is listed read-only, for the warning and for shadowing (above). The launcher never writes there.
4. **Third-party sources.** Any GitHub repo may be added, as Unreviewed. None is added by default.

Open:
5. **Upstream engine changes.** The launcher targets `Weft-Rust/Weft`. Engine changes 1–3 (§5) would make Phase 1 much more robust: `--no-user-mods` in particular would end shadowing.

---

## What shipped

Implemented on `feat/mod-manager`; names below are the ones in the code. §3 and §4 describe the
design; this is where the build differs from it, or settles what they left open.

### Shipped

- **Phases 1 and 2 together.** The signed index lives at `Zorro909/weft-mods-index` and is served from GitHub Pages; the launcher embeds its public key (`INDEX_PUBLIC_KEY` in `src-tauri/src/mods/index/signature.rs`). Sources (none added by default), local files, revocation and "Copy mods from…" (`copy_mod_profile`, with a preview, `preview_copy_mod_profile`, that merges into a set that already has mods) all work.
- **Consent is binding.** The plan the player reviewed is a token (`planToken`). At commit, under `ModsLock`, the builds are looked up again in the catalogue as it is *now*, revocations and installability are checked again, and the token is recomputed from the current mod interface: anything different is refused as `ModChangedMeanwhile` and planned again on screen. Dependencies resolve transitively, through installed mods too.
- **Operations** have the page's id, per-file progress held to a shared trace (`src/dev/fixtures/trace.json`) on the backend and the mock, and `cancel_mod_operation`. A cancel is accepted until the operation starts writing, never after (`ModCancelled`).
- **A new install turns on nothing the launcher knows would stop Play.** A mod that needs something no build provides, at any depth, is installed turned off (`turnsOn`, `installedOff`). A mod already on still blocks Play when what it needs goes away; the report tells a dependency that isn't installed (`depsNotInstalled`) from one that is off, and `blockingReasons` says why each blocker blocks. Updates keep a mod's on/off state.
- **Saving a set** writes in a fixed order: the old Undo is cleared, then the lock, then the removal's Undo (a failure there only loses Undo), then the version's folder is reconciled from the lock. Folders hold copies, never links, and nothing is rewritten while that version runs. **Remove has Undo** (`restore_mod`).
- **The player's own folder** is checked for shadowing: a copy there is named, and blocks Play when it is revoked, but the launcher never deletes it.
- **Revocations fail closed** and are remembered in `mods.lock.json`, so they outlive the index. One without a reason carries `reason: null` everywhere; the UI says "No reason given" in the player's language, and quotes a reason in the index's own words.
- **The index has an age**: `signedAt`, freshness `stale` after 30 days, and rollback refusal kept in its own state file. Cached data, the index's and each source's, is checked again on every read. Cache generations are written and pruned under one lock; a save that fails is reported as `cacheError` while the fetched index is still used.
- **The catalogue is kept in order.** Each part (the index, each source) carries the ticket of the refresh that fetched it, so a slow refresh finishing last can't replace newer answers, and every catalogue has a `revision` the page keeps the highest of. One source can be asked again on its own (`refresh_mod_source`).
- **Sources.** A source that shows no mods says why (`SourceStatus.noMods`: `noReleases`, `noModFiles`, `unreadable`, `noDigest`, `disagrees`, `invalid`). A damaged `sources.json` is never taken for an empty list or overwritten: it is renamed to `sources.damaged-<secs>.json` and reported (`ModSourcesDamaged`); adding a source then starts a new list. Icons come only from GitHub's hosts (INDEX_FORMAT, "icon").
- **Errors** carry codes, never English sentences: `GameFolderNotFound` carries the folder; a server that answered with an error is `HttpStatus`, never "offline".
- **In the UI:** one blocker at a time with all its fixes (a pager, and "Turn off all" when that is every blocker's fix), Play's reason next to Play, results as notices over the list, plans kept by content so a reload that brings the same plan doesn't flicker the button, and nothing that carries meaning cut off at the smallest window (960×565), which the UI tests check in every language.
- **Working on the UI without Tauri:** `npm run dev:mock` (see the README).

### Changed from the proposal

- **Renamed tier.** "CI-built" became **Unreviewed**: a source's release proves nothing about CI until it carries an attestation, so the name only claims what is known.
- **Provenance** is shown as a record (`buildRecord: "recorded"`) only when the signed index records all of it: the GitHub Actions repo, workflow and commit, and when its CI checked the attestation (`gh attestation verify`, run when a version is added). The row says it is the index's record, not the launcher's check. A record missing any of these is `incomplete` and shows as unknown; a source's own `provenance` claim is passed on as `claimed`, never a record; without either the UI says "No build record". The launcher doesn't verify attestations itself. See INDEX_FORMAT, Provenance.
- **Reviewed means reviewed.** An index version without a `reviewed` record is dropped.
- **Matching is by ABI, not tag**, and compares published metadata: the `abi` an entry declares against the version's. Builds from untagged Weft commits fit every release with the same ABI. The launcher doesn't read the compiled library (that would mean loading it), and `fitsVersion` is `null` when the version's ABI is unknown.
- **Zip sizes are counted, not only declared.** The archive limits are checked against the central directory's sizes, then every entry is inflated once into nothing and counted before the zip is stored; a zip that lies about its sizes, is damaged or is encrypted is refused. The launcher still never unpacks a mod to disk or loads its library (INDEX_FORMAT, "Size limits").

### Deferred

- Everything in Phase 3, and the open question in §7.
