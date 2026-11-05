# Weft Launcher

Desktop launcher for [Weft](https://github.com/Weft-Rust/Weft), the Rust/Vulkan voxel sandbox engine. Lists releases, installs them side by side (SHA-256 verified), and starts the game. Never touches your worlds or settings.

> **Status:** 1.0. Windows is tested; Linux and macOS builds are experimental - reports welcome in [issues](../../issues).

## Install

Grab the file for your system from [**Releases**](../../releases):

| System | File |
|---|---|
| Windows 10/11 x64 | `Weft.Launcher_<version>_x64-setup.exe` |
| Linux x64 | `.AppImage` or `.deb` |
| macOS (Apple Silicon) | `.dmg` |

The builds aren't code-signed yet:
- **Windows:** on the SmartScreen warning click **More info -> Run anyway**.
- **macOS:** right-click the app -> **Open**, or `xattr -dr com.apple.quarantine "/Applications/Weft Launcher.app"`.
- **Linux:** the game needs Vulkan drivers (e.g. `mesa-vulkan-drivers`).

## Usage

**Versions** -> **Install** -> back to **Home** -> **Play**. Delete a version with a double click on **Delete** (blocked while the game is running).

**Mods** -> pick the game version -> **Browse** -> **Install**. Each game version keeps its own mods. Mods are native programs: Reviewed ones come from the signed [Weft mod index](https://github.com/Zorro909/weft-mods-index), and anything else (a GitHub repo you add under **Sources**, or a zip **From file**) is labelled as unreviewed or unverified. See [docs/mod-manager](docs/mod-manager/PROPOSAL.md).

## Data

- **Game data** (worlds, settings): `%APPDATA%\Weft` - the launcher never writes it, and only lists its `mods` folder to warn about mods it can't manage.
- **Launcher data**: `%APPDATA%\dev.weft.launcher` - `versions/`, `logs/<tag>.log`, `cache/`, `downloads/`, and for mods `mods/store/` (downloads by SHA-256) and `profiles/<tag>/` (each version's mod set).

Newer versions may write saves older ones can't open - back up `saves` before downgrading.

## Build

Requires Node.js LTS, stable Rust and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/).

```bash
npm ci
npm run tauri dev     # dev mode (plain `cargo run` won't work - UI is served by Vite)
npm run tauri build   # installer
```

Before a PR:

- `cargo fmt --check && cargo clippy && cargo test` in `src-tauri`.
- `npm run build`, which runs `npm run check:i18n` first. UI strings go through `src/i18n`: add keys to all four languages (en, pt-BR, es, ru). The check lists missing keys, placeholder mismatches, missing plural forms (counted messages have `_one`, `_other` and, per language, `_few`/`_many` keys), message keys used in `src` that don't exist, and backend error codes without an `errors.*` message. A message with `{0}` takes a name the backend sends (a mod, a version, a repo); any other backend detail is shown apart, behind "Details", never inside a translated sentence.
- `npm test`: the unit tests (vitest) for the pure logic in `src/mods` and `src/i18n`, and the mock's rules against the shared cases.
- `npm run test:ui`: the UI tests (Playwright, `e2e/`). Every mock scenario in all four languages at the minimum 960×565 window (layout, rows in view, the state the scenario is for), plus the install, cancel, re-plan, launch-safety, recovery and keyboard flows. Run `npx playwright install chromium` once first, or point `PW_CHROMIUM` at an installed Chromium.
  - Each run starts its own mock server on a free port, so parallel runs (or another checkout's server) never get mixed up.
  - `PW_PORT=<port>` fixes the port; the run fails if something already listens there.
  - `PW_REUSE=1` (with `PW_PORT`) tests a mock server you already started, e.g. `npx vite --mode mock --port 1441 --strictPort`.
- `cd src-tauri && cargo test export_bindings -- --ignored` regenerates `src/mods/bindings` after a change to an IPC type.

CI (`.github/workflows/ci.yml`) runs all of these on every pull request.

The pixel font (`src/fonts/weft.woff2`) has Latin, Cyrillic and the accented letters pt-BR and es use; `scripts/font-glyphs.py` draws those from the font's own letters.

### UI without Tauri

```bash
npm run dev:mock      # http://localhost:1420/?scenario=mods
```

Runs the UI in a browser against a fake backend (`src/dev/mockBackend.ts`). Its rules are the backend's, ported in `src/dev/mockRules.ts` (plans and their tokens, dependency resolution through installed mods, installs turned off for a missing dependency, cascades, revocations read fail-closed and kept in the lock, copies of managed mods in the player's own folder, copy previews, Remove and Undo) and checked by `npm test` against the shared cases in `src/dev/fixtures/rules.json`, which a Rust test runs against the real backend too. Operations have ids, report which file of how many they are on, and can be cancelled; the events of an install follow `src/dev/fixtures/trace.json`, which a Rust test and a Playwright test hold the backend and the mock to; crashes are engine log lines read by a port of `diagnose.rs`, tested against that file's own fixtures. The mock is never part of a production build.

Pick a state with `?scenario=` and adjust it with flags, which combine: `?scenario=mods&index=cached&revoked=cogwork&slow=1`. Flags in the URL override the ones a scenario sets. Both lists come from `src/dev/scenarios.ts`; `npm test` fails if this README misses one.

| Scenario | What it shows | Flags it sets |
|---|---|---|
| `mods` | The default. A mod built for another version (with a fitting update), an update, a prerelease that is off, a source, a local file and a file in the player's own folder. | — |
| `empty` | The newest version has no mods; the older one has mods to copy. | — |
| `fresh` | No game version installed. | — |
| `offline` | No network: the cached index and a source's cached mods. | `index=cached` `source=offline` |
| `crash` | Nothing blocks Play; the game then stops while loading Structures, which has an update. | `crash=loadFailed` |
| `knownfile` | From file picks a zip that is a catalogued build (Cogwork 0.2.0). | `file=known` |
| `revoked` | The installed Cogwork build has been pulled from the index. | `revoked=cogwork` |
| `ratelimited` | GitHub rate-limits the source; its last mods are shown. | `source=ratelimited` |
| `indexdown` | The index has never been reached, so there are no Reviewed mods. | `index=unavailable` |
| `stale` | The index verifies, but its signature is over 30 days old. | `index=stale` |
| `invalid` | The new index's signature doesn't verify; the last good one is shown. | `index=invalid` |
| `rollback` | The new index is older than one already accepted, so it is refused; the last good one is shown. | `index=rollback` |
| `missingdep` | Mods that need others: Hearth needs Cogwork, which is off; Lanterns needs Glowmoss, which isn't installed; Railways needs Signals, which has no build yet. | — |
| `lateblock` | Nothing blocks Play until Play itself finds Cogwork revoked; Hearth, which needs it, then blocks the start. | `prelaunch=revoke` |
| `long` | Very long mod names, ids and repos, for overflow checks. | `long=1` |
| `shadowed` | Cogwork is revoked, and the player's own mods folder has a copy of it, which would load in its place: Play is blocked until that file goes. | `revoked=cogwork` `shadow=cogwork` |
| `chain` | Mods that need mods that need others: Chimneys needs Hearth, which needs Cogwork, both installed and off; Junctions needs Railways, which needs Signals, which has no build. | `chain=1` |

| Flag | Values | Effect |
|---|---|---|
| `index` | `fresh`, `stale`, `cached`, `unavailable`, `invalid`, `rollback` | State of the signed mod index. |
| `source` | `ok`, `notfound`, `ratelimited`, `offline` | State of the added GitHub source. |
| `revoked` | `<mod id>` | Revokes the installed builds of that mod. |
| `abi` | `error` | The game version's mod interface can't be found out. |
| `fail` | `install`, `network`, `toolarge`, `dep`, `meanwhile`, `catalog`, `sources` | Comma-separated. Installs fail at the hash check, mid-download, before it, or while downloading a dependency; `meanwhile` publishes a newer Glowmoss after the first plan, so a plan with Glowmoss in it is refused as changed and planned again; the catalogue fails to load; `sources` finds the list of sources damaged (kept aside, `ModSourcesDamaged`). |
| `file` | `unverified`, `known`, `notamod`, `revoked`, `revokedlate`, `wrongplatform` | What From file picks; `revokedlate` is revoked by the index while it is being installed. |
| `shadow` | `<mod id>` | The player's own mods folder has a copy of that mod, which loads when the launcher's is off or revoked. Showing the folder only opens it; tests stand in for the player deleting the file with `window.mockPlayer.deleteFile(name)`. |
| `revocations` | `messy` | Revocations come with uppercase hashes, no reason or time, and one entry that isn't a hash: they still revoke, and only that one is dropped. |
| `chain` | `1` | Adds Chimneys and Junctions, which need mods that need others. |
| `crash` | `wrongVersion`, `loadFailed`, `notAMod`, `wrongName`, `missingDep`, `initPanicked`, `exit` | Play starts the game and it stops with this failure; `exit` is a crash that names no mod. |
| `prelaunch` | `revoke` | Play finds Cogwork revoked, as a fresh index would, before it starts the game. |
| `long` | `1` | Adds very long names, ids and repos. |
| `slow` | `1` | Everything takes four times as long: time enough to press Cancel. |

## Releasing

Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, then push a `vX.Y.Z` tag. CI builds all platforms into a draft release; publish it and running launchers will offer the update. Requires the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets.

## License

[MPL-2.0](LICENSE). Written by [Fernandes585](https://github.com/Fernandes585), built with Tauri, React and Vite. Not affiliated with Mojang or Microsoft. [Discord](https://discord.gg/aWECX7EPmV).