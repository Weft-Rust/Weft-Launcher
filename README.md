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

Before a PR: `cargo fmt --check && cargo clippy && cargo test` in `src-tauri`, and `npm run build`. UI strings go through `src/i18n` - add keys to all four languages (en, pt-BR, es, ru); `npm run check:i18n` (also part of `npm run build`) lists missing keys, placeholder mismatches, missing plural forms (counted messages have `_one`, `_other` and, per language, `_few`/`_many` keys), message keys used in `src` that don't exist, and backend error codes without an `errors.*` message. `npm test` runs the unit tests (vitest) for the pure logic in `src/mods` and `src/i18n`.

### UI without Tauri

```bash
npm run dev:mock      # http://localhost:1420/?scenario=mods
```

Runs the UI in a browser against a fake backend (`src/dev/mockBackend.ts`) that follows the backend's rules: version fitting and order from `src/mods/select.ts`, dependency cascades, revocation, updates that keep a mod's on/off state, copy previews that merge. The mock is never part of a production build.

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
| `long` | Very long mod names, ids and repos, for overflow checks. | `long=1` |

| Flag | Values | Effect |
|---|---|---|
| `index` | `fresh`, `cached`, `unavailable`, `invalid`, `rollback` | State of the signed mod index. |
| `source` | `ok`, `notfound`, `ratelimited`, `offline` | State of the added GitHub source. |
| `revoked` | `<mod id>` | Revokes the installed builds of that mod. |
| `abi` | `error` | The game version's mod interface can't be found out. |
| `fail` | `install`, `network`, `toolarge`, `catalog`, `sources` | Comma-separated. Installs fail at the hash check, mid-download or before it; the catalogue or the source list fails to load. |
| `file` | `unverified`, `known`, `notamod`, `revoked`, `wrongplatform` | What From file picks. |
| `crash` | `wrongVersion`, `loadFailed`, `notAMod`, `wrongName`, `missingDep`, `initPanicked`, `exit` | Play starts the game and it stops with this failure; `exit` is a crash that names no mod. |
| `long` | `1` | Adds very long names, ids and repos. |
| `slow` | `1` | Everything takes four times as long. |

## Releasing

Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, then push a `vX.Y.Z` tag. CI builds all platforms into a draft release; publish it and running launchers will offer the update. Requires the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets.

## License

[MPL-2.0](LICENSE). Written by [Fernandes585](https://github.com/Fernandes585), built with Tauri, React and Vite. Not affiliated with Mojang or Microsoft. [Discord](https://discord.gg/aWECX7EPmV).