# Mod manager design

The launcher keeps a separate mod set for each installed Weft version. It installs mods from a
signed index, from GitHub repos the player adds, and from local zips; it checks the set before Play
and names the mod when the game fails to load one.

Status: the launcher side is built. Engine-side changes are still needed; see
[Remaining work](#5-remaining-work). The index contract is [INDEX_FORMAT.md](INDEX_FORMAT.md); the
path for mod authors is [AUTHORING.md](AUTHORING.md).

## 1. Engine constraints

These facts explain the design. They are from `Weft-Rust/Weft` @ `7c69c9c`; paths are relative to
that repo.

- **A mod is native code.** It is a Rust `cdylib` exporting `weft_mod()`
  (`crates/sdk/src/lib.rs`), shipped as one `<id>.zip` with `<id>.dll`, `lib<id>.so`,
  `lib<id>.dylib` and `assets/`. The engine loads the library for its OS with `libloading`, so it
  runs with the player's privileges. There is no sandbox and no permission system.
- **Turned-off mods still run code.** The engine `dlopen`s every library and calls `weft_mod()`
  before it applies `disabled_mods.txt` (`crates/engine/src/modloader.rs`).
- **No manifest.** `id`, `version` and `deps` are compiled into the library; reading them means
  loading it. The zip's stem must equal the crate name. A mod without a library is an error.
- **Compatibility is exact.** `ABI_VERSION` is the FNV-1a-64 hash of the raw text of
  `crates/abi/src/lib.rs`, and a mod loads only if its hash is equal. It changes in almost every
  release.
- **Failure is fatal.** An ABI mismatch, a missing symbol, a missing dependency or a panicking
  `init` aborts startup with `exit(1)` and no dialog; the reason is only in `latest.log`. The ABI
  check runs before the off filter, so one mismatched mod, even a turned-off one, blocks the
  version.
- **Search order.** For each id the first copy found wins: every `--mods <dir>`, then the player's
  `<data>/mods` (shared by every version), then `<install>/run/mods` (shipped mods such as `base`).
  There is no flag to skip the player's folder.
- **No safe probe.** Unknown flags are passed to mods and start the game, so `weft --version`
  can't be used to ask a build for its ABI.

## 2. Design principles

1. **Mod sets belong to a game version.** The ABI changes almost every release, so a shared mod
   folder is a trap. Each installed version gets its own set, passed with `--mods`.
2. **The launcher never writes into the player's Weft folder.** Mods live under the launcher's
   data folder.
3. **"Off" means not passed to the game.** The engine runs code even from turned-off mods, so the
   launcher leaves an off mod out of the folder it hands over. It doesn't use `disabled_mods.txt`.
4. **Don't start a launch that is known to fail.** Check the ABI and dependencies before Play. If
   the game still dies during mod loading, name the mod.
5. **Be honest about trust.** Show what was actually verified. Never show a permission list.
   Always say that native mods can do anything.

## 3. Architecture

### On-disk layout

Under the launcher's data folder (`src-tauri/src/mods/paths.rs`):

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

The index URL is built in (`index/fetch.rs`); `sources.json` holds only repos. A damaged
`sources.json` is reported as `ModSourcesDamaged`, and adding a source starts a new list.

Launch is `weft --mods <profiles/<tag>/mods>`. Turning a mod on or off copies its build into that
folder or removes it. Deleting a version deletes its profile, and unused store entries are
garbage-collected. Garbage collection never deletes an object an install has reserved or a removal
can still undo, and deletes nothing if a lock file can't be read. Lock files are validated on read:
an id or hash of the wrong form is an error, never a path.

### Backend (`src-tauri/src/mods/`)

| Part | Modules | Boundary |
|---|---|---|
| Rules | `plan/`, `profile.rs`, `catalog.rs`, `index/format.rs`, `diagnose.rs`, `version.rs` | Plain data in and out; no I/O. |
| Store | `store.rs`, `paths.rs` | `store::admit` is the only way into the store: it hashes the file and checks its zip and platform, also when the store already has that hash. |
| Fetching | `index/`, `sources.rs`, `abi.rs`, `install.rs` | Network and caches. `install.rs` downloads through the shared `download.rs`. |
| Files | `archive.rs`, `inspect.rs` | Zip checks and local-file inspection. Never unpack to disk, never load a library. |
| Operations | `service/`, `context.rs` | One operation per command; `Ctx` holds the folders, locks and running game. |
| IPC | `commands.rs`, `error.rs` | Each command is one call into `service/`. Errors reach the page as an `ErrorCode`, never an English sentence. |

Everything outside `service/` takes plain data, a `Paths` root or a `Ctx`, so it is tested without
the app; `service_tests.rs` runs the operations against a local HTTP server. The IPC types are
generated into `src/mods/bindings/`, and `src/mods/api.ts` calls commands only through them (the
README says how to regenerate them).

The catalogue merges the index and every source. Each part carries the ticket of the refresh that
fetched it, so a slow refresh that finishes last can't replace newer answers; the page keeps the
catalogue with the highest `revision`.

### Changing a mod set safely

- **One lock.** Every change to a profile or to the store's contents happens under the mods lock.
  Downloads happen before it is taken; their store files are reserved so garbage collection leaves
  them alone.
- **Dependencies resolve through the whole graph.** An install, a copy and turning a mod on walk
  every dependency, through new builds and installed mods alike. An installed dependency that fits
  and isn't revoked is used, and turned on if it is off. `InstallPlan.enable` lists everything that
  turns on.
- **The reviewed plan is binding.** What the player approves is what gets committed. Install,
  copy and file-install previews return a `planToken` covering the builds (hash and trust), what
  ends up on, what is installed off or missing, and the version's ABI. The backend checks it before
  downloading and again under the lock at commit. A changed plan fails with `ModChangedMeanwhile`,
  writes nothing, and the page plans again. At commit the version must still be installed and not
  running, and no build may be revoked; a file install re-checks revocation by the file's hash.
- **Operations can be cancelled.** Installs, copies and restores carry an `operationId` that every
  progress event repeats. Until the operation starts writing, cancelling aborts it with
  `ModCancelled` and leaves nothing behind; after that, cancelling returns `false`.
- **A new install never breaks Play.** A mod is installed on when it is new or was on, and nothing
  it needs is missing at any depth (`InstallPlan.turnsOn`). Otherwise it and the dependencies it
  brought are installed off (`ChangeResult.installedOff`). Copies follow the same rule per mod.
  Updates keep a mod's on/off state. A mod already on can still block Play when something it needs
  is turned off, removed or revoked; the report says which (`depsNotInstalled`, `blockingReasons`),
  and Home and Mods offer the fix.
- **Nothing changes under a running game.** While a version's game runs, its lock file and `mods/`
  folder are not rewritten. Changes fail with `GameRunning`. A revocation that arrives is reported
  (`ProfileReport.revocationsPending`) and applied when the game stops.
- **Saving writes in a fixed order:** clear the old Undo, write the lock, write the removal's Undo
  (a failure there only loses Undo), then reconcile the version's folder from the lock.
- **Folders hold copies.** `reconcile` copies each turned-on build from the store (a reflink where
  possible, never a hard link), so a write to one file can't reach the store or another version. On
  every save and launch it hashes each file again and replaces any that changed: the folder is the
  player's to touch, and size and time say nothing about the bytes.
- **Remove can be undone.** `remove_mod` keeps the entry in `removed.json`, and its store file,
  until the version's next change. `restore_mod` puts it back and turns on again what the removal
  turned off.

### Checking the zip

Before a zip is stored, `archive.rs` checks its contents and limits and inflates every entry once
without writing it to disk ([contents](INDEX_FORMAT.md#downloads),
[limits](INDEX_FORMAT.md#size-limits)). The store names the file `<sha256>.zip`; the version's
folder names it `<id>.zip`, as the engine requires. The launcher never unpacks a mod to run it, and
never loads a library to read its metadata: that would run its code.

### The pre-Play check

- Every turned-on mod's ABI must equal the version's ABI. ABIs come from published metadata
  (`weft.abi`), never the library, and a build fits every release with that ABI, tagged or not.
  With the version's ABI unknown, `fitsVersion` is `null`, mods are "unchecked", and Play isn't
  blocked for it.
- Every dependency must be turned on, or be `base`.
- If either fails, Play is blocked with the reason and a fix (turn off, find update).
- It never touches the network: it uses the catalogue the page last loaded (or the cached one) and
  the cached ABI.
- It runs inside `launch_version`, which holds the mods lock until the game counts as running, so
  no mod change lands in between.
- It lists the player's own `<data>/mods` (path from the `game folder …` log line) and warns that
  those load in every version and can't be checked. This is the only place the launcher reads the
  game folder, and it only lists it.

### The player's folder and precedence

The engine loads the first copy of each id it finds: the launcher's `--mods` folder, then the
player's `<data>/mods`, then the shipped mods. A file in the player's folder with the id of a mod
in the set (`ProfileReport.shadowed`):

- is ignored while the launcher's copy is on;
- **loads instead** while the launcher's copy is off: a warning, since "Turn off" doesn't turn it
  off;
- **blocks Play** when the launcher's copy is revoked, since the pulled mod would load anyway
  (reason `shadowedRevoked`), even with nothing on.

Names compare exactly, as the engine compares them: `Cogwork.zip` is another id than `cogwork`. The
launcher never deletes the player's file.

### Diagnosing a failure after Play

On `exit(1)`, `diagnose.rs` looks for the engine's mod-loading failures in the version's log. Only
ERROR lines of target `weft` establish a failure; a mod's own lines (`[mod:x]`) can say anything.
The one exception: when the engine reports an init panic without naming the mod, the mod's own
panic line before it, else the nearest "loading mod" line, names it. The messages it matches are
listed in `diagnose.rs`.

Home shows "X stopped Weft from starting" with Turn off, Find update and Open log. A crash that
names no mod offers turning off all the version's mods, with Undo; a crash of a file-installed mod
offers picking another file.

### Copying mods to a new version

"Copy mods from…" (`preview_copy_mod_profile`, `copy_mod_profile`) resolves each mod of another
version to the build for this version's ABI, lists the ones with no build yet, and merges into a
set that already has mods.

## 4. Trust and revocation

The launcher can prove where a file came from and that it hasn't changed. It cannot prove that the
file is harmless: every tier runs native code with the player's privileges, and the UI says so on
every install.

### Tiers

Each build has exactly one tier.

| Badge | Meaning | What was checked |
|---|---|---|
| **Reviewed** (green) | In the signed index, with a recorded review (`reviewed.by`) | Index signature, SHA-256 equals the index pin, zip structure. A compromised mod repo or GitHub account can't change pinned bytes without the index key. |
| **Unreviewed** (grey) | From a GitHub repo the player added as a source | The `<id>.mod.json` agrees with GitHub's record of the release, SHA-256 equals GitHub's `digest`, zip structure. |
| **Unverified** (red) | A local file that isn't in the catalogue | Zip structure only. The player types the mod id to confirm. |

GitHub serves both a source's file and its digest, so their agreement only proves the download
wasn't corrupted.

A source build whose hash is in the index is Reviewed. A local file whose hash is in the catalogue
installs with that build's tier. An index version without a `reviewed` record is dropped.

**Provenance:** the launcher doesn't verify attestations. For index builds it shows the result of
the index CI's `gh attestation verify` as the index's record; for source builds it shows
`provenance` as the publisher's claim. See [INDEX_FORMAT.md](INDEX_FORMAT.md#provenance).

The UI has **no permission list**: native code has no permissions to list.

### Revocation

**Revoked** is a status, not a tier. A build of any tier whose `sha256` the index lists in
`revoked` is never installed and can't be turned back on, not even by turning on something that
needs it. The UI shows a Revoked badge and the reason.

- The launcher learns of a revocation whenever it reads the index: from its cache, or from the
  network when the catalogue is refreshed.
- An installed revoked build is turned off the next time its version's mods are read
  (`get_mod_profile`) or before Play, whichever comes first, unless that version's game is running.
  The revocation is then recorded in `mods.lock.json` and stays even if the index can't be loaded
  later, until the build is replaced or removed.
- An install already downloading when a revocation arrives fails at commit with
  `ModChangedMeanwhile`.

**Age.** The launcher reports when the index was signed (`signedAt`). A stale index is still used,
with a note that revocations since then may be missing; an index older than one already accepted is
refused ([Freshness and cache](INDEX_FORMAT.md#freshness-and-cache)).

## 5. Remaining work

**Engine** (`Weft-Rust/Weft`), by value to the launcher:

1. Don't load turned-off mods, and make mod failures non-fatal: check the off list before `dlopen`,
   then skip and report instead of `Err`.
2. `--no-user-mods` (only `--mods` folders count) and `--disabled-mods <file>`. These end
   shadowing and give the launcher the whole mod set.
3. Publish `weft-abi.txt` (or `release.json`) as a release asset, and/or `weft --info --json` that
   exits before any window or mod loading. `abi.rs` would read it instead of hashing the source.
4. `weft-mod.toml` inside the zip, written by `--pack-mod`: id, version, ABI, deps and each
   library's SHA-256, readable without loading code.
5. A machine-readable load report (`logs/mods.json`) and a separate exit code for a mod load
   failure.
6. `--mod-hashes <file>`: the engine hashes the copy it loads, closing the gap between the
   launcher's check and the load.
7. A less fragile ABI hash (declarations only, or a hand-bumped epoch), and an unpack cache keyed on
   content hash.

**weft-mods** (`Zorro909/weft-mods`): publish `<id>.mod.json` next to each `<id>.zip`
([format](INDEX_FORMAT.md#idmodjson-for-unreviewed-sources)); attest builds with
`actions/attest-build-provenance`; add a LICENSE, `license` fields and icons.

**Later:** data-only mods and a WASM tier (the only options that limit what a mod can do), and
server mod-set sync. All need engine design work.

**Open questions:** who else reviews for the index, and moving its signing key offline.
