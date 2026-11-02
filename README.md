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

## Data

- **Game data** (worlds, settings): `%APPDATA%\Weft` - the launcher never reads or writes it.
- **Launcher data**: `%APPDATA%\dev.weft.launcher` - `versions/`, `logs/<tag>.log`, `cache/`, `downloads/`.

Newer versions may write saves older ones can't open - back up `saves` before downgrading.

## Build

Requires Node.js LTS, stable Rust and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/).

```bash
npm ci
npm run tauri dev     # dev mode (plain `cargo run` won't work - UI is served by Vite)
npm run tauri build   # installer
```

Before a PR: `cargo fmt --check && cargo clippy` in `src-tauri`, and `npm run build`. UI strings go through `src/i18n` - add keys to all four languages (en, pt-BR, es, ru).

## Releasing

Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, then push a `vX.Y.Z` tag. CI builds all platforms into a draft release; publish it and running launchers will offer the update. Requires the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets.

## License

[MPL-2.0](LICENSE). Written by [Fernandes585](https://github.com/Fernandes585), built with Tauri, React and Vite. Not affiliated with Mojang or Microsoft. [Discord](https://discord.gg/aWECX7EPmV).