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

**Mods** -> pick the game version -> **Browse** -> **Install**. Each game version keeps its own mods. Mods are native programs that run with your privileges. Besides the signed [Weft mod index](https://github.com/Zorro909/weft-mods-index), you can add GitHub repos under **Sources** or install a zip **From file**. Builds pinned in the index are Reviewed; others are Unreviewed or Unverified. See the [mod manager design](docs/mod-manager/PROPOSAL.md).

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

- `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` in `src-tauri`.
- `npm run build`. It runs `npm run check:i18n` first.
- UI strings go through `src/i18n`: add every key to all four languages (en, pt-BR, es, ru), with the plural forms each needs. A key built from a prefix goes in the checker's `DYNAMIC` list.
- `npm test`: the unit tests (vitest).
- `npm run test:ui`: the UI tests (Playwright, `e2e/`). Run `npx playwright install chromium` once first, or point `PW_CHROMIUM` at an installed Chromium. Each run starts its own mock server on a free port; `PW_PORT=<port>` fixes the port, and `PW_REUSE=1` with it tests a server you already started.
- After changing an IPC type or command, regenerate `src/mods/bindings` with `cd src-tauri && cargo test export_bindings -- --ignored`. CI fails until it is committed.

CI (`.github/workflows/ci.yml`) runs all of these on every pull request.

### UI without Tauri

```bash
npm run dev:mock      # http://localhost:1420/?scenario=mods
```

Runs the UI in a browser against a fake backend that follows the real backend's rules. Scenarios and URL flags are in [docs/dev-mock.md](docs/dev-mock.md).

## Releasing

Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, then push a `vX.Y.Z` tag. CI builds all platforms into a draft release; publish it and running launchers will offer the update. Requires the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets.

## License

[MPL-2.0](LICENSE). Written by [Fernandes585](https://github.com/Fernandes585), built with Tauri, React and Vite. Not affiliated with Mojang or Microsoft. [Discord](https://discord.gg/aWECX7EPmV).