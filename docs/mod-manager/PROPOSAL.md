# Mod manager for Weft Launcher: proposal

Status: Phases 1 and 2 are implemented on `feat/mod-manager` (see [What shipped](#what-shipped)); Phase 3 needs engine changes and is not started. Written 2026-11-04. Mockup (the first design; the app has moved on since): [`mockup.html`](mockup.html). Open it in a browser; it's drawn at 1:1 in the launcher's own pixel style.

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
- It requires a SHA-256 and verifies it (`install.rs:181-186, 323-341`).
- It restricts download URLs to one repo (`install.rs:187-190`).
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
  store/<sha256>.zip              content-addressed, each one verified once
  sources.json                    the GitHub repos the player added, as GitHub spells them
profiles/<weft-tag>/
  mods/<id>.zip                   only the turned-on mods (hardlink, or a copy if that fails)
  mods.lock.json                  every installed mod: id, version, sha256, origin, trust, enabled, ABI, deps
cache/
  mod-index/<n>/index.json        verified index generations, each with its index.json.minisig;
  mod-index/current               `current` names the newest; the newest two are kept
  mod-sources/<owner__repo>.json  the last good answer of each source, with when it was fetched
  mod-icons/<hash>.png            catalogue icons
  abi.json                        ABI hash per Weft tag, kept forever since tags don't change
downloads/mod-<sha256>-<unique>.part   a download in progress; never shared by two downloads
```

The index URL is built in (`index.rs`); `sources.json` holds only repos.

Launch becomes `weft --mods <profiles/<tag>/mods>`. Turning a mod on or off just adds or removes the link. When a version is deleted, its profile goes with it, and unused store entries are garbage-collected. Garbage collection skips any store object an install is still working on, and deletes nothing if any lock file can't be read.

### Backend modules (`src-tauri/src/mods/`)

| Module | Job |
|---|---|
| `abi.rs` | ABI hash of a Weft tag: the index's `weft[]` table, else a cache, else FNV-1a-64 of `raw.githubusercontent.com/Weft-Rust/Weft/<tag>/crates/abi/src/lib.rs` (verified against v26.10.2 and v26.10.4). **Later:** read a `weft-abi.txt` release asset. |
| `index.rs` | The index contract: parse it entry by entry (a bad entry is skipped, not fatal), verify it (minisign), refuse an older one than the last verified copy, and keep verified copies as cache generations for offline use. |
| `sources.rs` | GitHub repos the player added: read their releases (ETag-cached, up to 5 pages of 100) and accept a `<id>.mod.json` only where it agrees with GitHub (see [INDEX_FORMAT.md](INDEX_FORMAT.md)). Falls back to the last good answer and reports why. |
| `catalog.rs` | Merge the index and the sources into one list with a trust tier per version; a source build with a reviewed hash counts as Reviewed. |
| `archive.rs` | Check the zip structure (below) before anything is stored. |
| `profile.rs` | Rules on a mod set: the status of each mod, what blocks the game, which update fits, revocations. |
| `plan.rs` | Rules for changing a mod set: what an install brings along (`plan_mod_install`), what a copy brings over, turning on and off, removal. |
| `store.rs` | The store, lock files, the per-version folders (`reconcile`), reservations for in-flight installs, garbage collection. |
| `install.rs` | Download a build through the shared `download.rs`, check its SHA-256 and zip, move it into the store. |
| `inspect.rs` | Describe a zip from the player's computer before it is installed. |
| `diagnose.rs` | Read the game log after a crash and name the mod that stopped it. |
| `service.rs` | The steps that need the running app: catalogue loading, the ABI, reports, the install flow, progress events. |
| `commands.rs` | The Tauri commands: argument checks and locking. |

Pure rules (`plan.rs`, `profile.rs`, `catalog.rs`, `index.rs`, `diagnose.rs`) take plain data, and everything on disk takes a `Paths` root, so all of it is tested without the app. The TypeScript types for IPC are generated from the Rust types into `src/mods/bindings/`.

Tauri commands: `list_mod_catalog`, `get_mod_sources`, `add_mod_source`, `remove_mod_source`, `get_mod_profile`, `plan_mod_install`, `install_mod`, `inspect_mod_file`, `install_mod_file`, `set_mod_enabled`, `remove_mod`, `preview_copy_mod_profile`, `copy_mod_profile`, `get_mod_icon`, `open_player_mods_folder`. The pre-Play check runs inside `launch_version`, which holds the mod lock from that check until the game counts as running, so no mod change can land in between.

### Checking the zip structure (before it is stored)
- Only `<id>.dll`, `lib<id>.so`, `lib<id>.dylib` and `assets/**` are allowed.
- No `..`, absolute paths or symlinks.
- Caps on entry count, uncompressed size and compression ratio (zip bombs).
- The file name is exactly `<id>.zip`, and `<id>` passes `validate_name`.

The launcher never unpacks the zip to run anything, and **never `dlopen`s a mod to read its metadata**: that would run its code.

### The pre-Play check
- Every turned-on mod's ABI must equal the version's ABI.
- Every dependency must be turned on, or be `base`.
- If either fails, Play is blocked with the reason and a fix (turn off / find update).
- Also list what is in the player's own `<data>/mods`. The path comes from the `game folder …` log line the launcher already parses. Warn: "these load in every version and can't be checked". This is the one place the launcher *reads* the game folder, and it's a listing only.

### Diagnosing a failure after Play
On `exit(1)`, scan the version's log for the engine's fixed messages:
- `mod X was built against another mod ABI`
- `loading mod X from`
- `is not a Weft mod`
- `missing dependency`

Show "X stopped Weft from starting" with Turn off / Find update / Open log (mockup 4). This builds on the existing `lastCrash` UI in `Home.tsx`.

As built, `diagnose.rs` also recognises `mod X is the crate Y` (wrong name) and `init panicked`. For the latter, the mod comes from the lines before it: the mod's own `[mod:X] panicked at …` line.

### Moving to a new Weft version
When a new version is installed, offer "Copy mod set from v26.10.4". Each mod is resolved to the build for the new ABI, and the launcher lists the ones that have no build yet. Because the ABI breaks with nearly every release, this is the feature players will use most.

---

## 4. Trust model: better than "trust me bro"

What we can and can't promise:
- We **can** prove *where a file came from* and *that it hasn't changed*.
- We **cannot** prove *that it's harmless*. Every tier below still runs native code with the player's privileges, and the UI says so on every install.

### The trust tiers the UI shows

Each build has exactly one tier. As built:

| Badge | Meaning | What was checked |
|---|---|---|
| **Reviewed** (green) | In the signed Weft mod index, with a recorded review (`reviewed.by`) | Index signature ✔, SHA-256 equals the index pin ✔, zip structure ✔. Provenance is shown as verified only when the index records it (`provenanceVerified`). |
| **Unreviewed** (grey) | From a GitHub repo the player added as a source; nobody reviewed it | The `<id>.mod.json` agrees with GitHub's record of the release ✔, SHA-256 equals GitHub's `digest` (from the same server as the file) ✔, zip structure ✔. A provenance claim in the `.mod.json` is shown as the publisher's claim, not verified. |
| **Unverified** (red) | A file from the player's computer that isn't in the catalogue | Zip structure only. Typed confirmation needed (mockup 3). A local file whose hash is in the catalogue installs with that build's tier instead. |

**Revoked** is a status, not a tier. A build of any tier whose `sha256` the index lists in `revoked` is turned off on the next refresh, never installed, and can't be turned back on, not even by turning on something that needs it. The UI says why.

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
1. Publish `<id>.mod.json` next to `<id>.zip`, generated in `tools/ci/publish.sh`. It replaces the prose compatibility record:
   ```json
   {
     "schema": 1, "id": "cogwork", "name": "Cogwork", "summary": "…", "authors": ["Zorro909"],
     "license": "MPL-2.0", "version": "0.2.0", "channel": "release", "tag": "cogwork-v0.2.0",
     "source": { "repo": "Zorro909/weft-mods", "commit": "cceea78…" },
     "weft":   { "tag": "v26.11.1", "commit": "ff9c712…", "abi": "f470b1cbb1f9ad91" },
     "deps": [{ "id": "base" }],
     "platforms": ["windows-x64", "linux-x64", "macos-arm64"],
     "asset": { "name": "cogwork.zip", "size": 2642469, "sha256": "989b2191…" },
     "icon": "assets/textures/gui/icon.png"
   }
   ```
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
| **1. Mods tab** | Per-version profiles via `--mods`; GitHub repo sources (weft-mods by default); ABI computed from source; pre-Play check; log diagnosis; local-file install with the Unverified flow; warning about the player's own folder | weft-mods change 1 (`mod.json`) |
| **2. Trust** | Signed curated index, Reviewed tier, revocation, provenance verification, "copy mod set to new version" | Index repo + minisign key; weft-mods change 2 |
| **3. Engine integration** | `--no-user-mods`, `--disabled-mods`, `weft-abi.txt`, `mods.json` report, `--mod-hashes` | Engine changes 1–6 |
| **Later** | Data-only mods, WASM tier, server mod-set sync | Engine design work |

---

## 7. Open questions

1. **Isolation scope.** Per-version mod sets with **shared** saves (proposed), or full "instances" with `--run-dir` (separate saves and config per profile, like MultiMC)? Shared saves are friendlier. The engine already asks when a world's mods are missing.
2. **Index ownership.** Who hosts the curated index (the `Weft-Rust` org?), who reviews, and where does the signing key live: offline, or a CI secret with required reviews?
3. **Reading the player's mods folder.** Is a read-only listing for the warning acceptable, given the README says the launcher never reads game data?
4. **Third-party sources.** Should users be able to add any GitHub repo (Unreviewed tier), or only use the index plus local files?
5. **Upstream engine changes.** The launcher targets `Weft-Rust/Weft`. Engine changes 1–3 would make Phase 1 much more robust. Are they something you can push upstream?

---

## What shipped

Implemented on `feat/mod-manager`; names below are the ones in the code.

- **Phase 1 and 2 together.** The signed index lives at `Zorro909/weft-mods-index` and is served from GitHub Pages; the launcher embeds its public key (`INDEX_PUBLIC_KEY` in `index.rs`). Sources, local files, revocation and "Bring mods from vX" (`copy_mod_profile`) all work.
- **Renamed tier.** "CI-built" became **Unreviewed**: a source's release proves nothing about CI until it carries an attestation, so the name only claims what is known.
- **Provenance** counts as verified (`provenanceVerified`) only when the signed index records it; the index CI runs `gh attestation verify` when a version is added. A source's own `provenance` claim is passed on but never verified, and without either the UI says "No build record". The launcher doesn't verify attestations itself.
- **Reviewed means reviewed.** An index version without a `reviewed` record is dropped.
- **ABI matching compares published metadata.** The launcher compares the `abi` an entry declares with the version's ABI; it doesn't read the compiled library (that would mean loading it).
- **Copying a mod set** ("Bring mods from vX") has a preview (`preview_copy_mod_profile`) and merges into a set that already has mods, skipping the ones it has.
- **Updates keep the on/off state.** A mod that is off stays off after an update.
- **Matching is by ABI, not tag.** Builds made from untagged Weft commits fit every release with the same ABI.
- **Deferred:** everything in Phase 3, and the open questions above. The player's own `mods` folder is listed read-only for the warning (question 3) and never written to.
- **Working on the UI without Tauri:** `npm run dev:mock` (see the README).
