# Mods

How the launcher's **Mods** tab works, and what a mod release needs so the launcher can install it.

## For players

Each installed game version has its own mods. The launcher passes them to the game with `--mods`
and never touches the game's own `<data>/mods` folder.

- **Browse** lists the mods in the [Weft mod index](https://github.com/Weft-Rust/weft-mods-index)
  that have a build for the selected game version's mod ABI. The launcher works that ABI out the
  way the engine does, from the version's `crates/abi/src/lib.rs` on GitHub, so a new Weft release
  works with mods as soon as it's published.
- **From file** installs a `.zip` from your computer. Unless the index lists that exact file, it
  shows as **Unverified**: nobody checked it.
- Turning a mod on also turns on the mods it needs. Turning one off, or removing it, also turns
  off the mods that need it.
- A build that the index **revokes** is turned off, also while you're offline. You can update or
  remove it.
- While a version runs, its mods can't change.
- A zip you put in the folder yourself is listed too. Without a `weft-mod.toml` it shows under its
  file name, with no version, and the launcher can't tell what it needs. A file in `mods/` that
  isn't a zip is moved to `mods-off/<name>.old`.

A mod is native code. It can do anything you can do on your computer. The checks below show where
a mod came from, not that it's harmless.

## What the launcher checks

Before an install from the index, for the mod and each dependency it brings:

1. The zip's SHA-256 is the one the index pins.
2. The zip's [build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations)
   verifies against the Sigstore public-good root built into the launcher. It was issued to GitHub
   Actions, for the repository the index names, and its subject is the zip.
3. The zip holds only `weft-mod.toml`, the mod's libraries and `assets/`, with no links or paths
   outside it, and has the library for this system. Limits: 512 MB, 20,000 entries, 1 GB unpacked.
4. `weft-mod.toml` says the same id, version, ABI and dependencies as the index.

If any check fails, nothing is installed. The details go to `logs/launcher.log` in the launcher's
data folder.

## Files

In the launcher's data folder:

```
profiles/<tag>/mods/<id>.zip       on: passed to the game
profiles/<tag>/mods-off/<id>.zip   off
profiles/<tag>/mod-abi             the version's mod ABI, worked out once
cache/mod-index.json               the last index that loaded
logs/launcher.log                  why an install failed
```

The folders are the whole state. Deleting a game version deletes its `profiles/<tag>/`.

## For mod authors

A release (tag `<id>-v<version>`) has two assets:

| Asset | Content |
|---|---|
| `<id>.zip` | `weft-mod.toml`, `<id>.dll`, `lib<id>.so` and `lib<id>.dylib` at the root, and `assets/` |
| `<id>.mod.json` | `{ "attestation": <bundle> }`: the Sigstore bundle `actions/attest-build-provenance` made for the zip |

```toml
# weft-mod.toml
id = "cogwork"            # [a-z0-9_]{1,64}, the zip's and the library's name
name = "Cogwork"
version = "0.2.0"         # SemVer
abi = "f470b1cbb1f9ad91"  # the mod ABI of the Weft it was built against
deps = ["base"]           # ids of the mods it needs; "base" ships with the game
```

[weft-mod-action](https://github.com/Zorro909/weft-mod-action) builds, packs, attests and
releases mods in this layout, and opens the pull request that adds a release to the index. The
repository must be public, and the attestation must come from a workflow in it.

The index lists a build once its pull request is merged. Its CI checks the attestation and copies
`abi` and `deps` from the zip, so the launcher knows them before it downloads anything.
