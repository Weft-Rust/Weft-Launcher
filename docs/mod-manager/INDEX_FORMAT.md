# Mod index format, v1

This file is the contract between Weft Launcher and [`Zorro909/weft-mods-index`](https://github.com/Zorro909/weft-mods-index). The launcher accepts exactly this format. A change that breaks it needs a new `schema` number and a new URL path (`/v2/`).

## Where it lives

| File | URL |
|---|---|
| Index | `https://zorro909.github.io/weft-mods-index/v1/index.json` |
| Signature | `https://zorro909.github.io/weft-mods-index/v1/index.json.minisig` |

- The signature is a minisign signature of the exact bytes of `index.json`.
- The launcher embeds the public key (`keys/index.pub` in the index repo).
- An index whose signature doesn't verify is rejected. The launcher then keeps using its last verified copy.

## `index.json`

```jsonc
{
  "schema": 1,
  "generated": "2026-11-04T18:00:00Z",       // RFC 3339, UTC

  // Optional. ABI hash per Weft release, so the launcher doesn't have to compute it.
  "weft": [
    { "tag": "v26.11.1", "commit": "<40 hex>", "abi": "f470b1cbb1f9ad91" }
  ],

  "mods": [
    {
      "id": "cogwork",                       // [a-z0-9_]+, equal to the crate name and the zip stem
      "name": "Cogwork",
      "summary": "Gears, item tubes and engines…",   // one line, <= 140 chars
      "authors": ["Zorro909"],
      "license": "MPL-2.0",                  // SPDX id, or null
      "homepage": "https://github.com/Zorro909/weft-mods/tree/main/cogwork",
      "icon": "https://raw.githubusercontent.com/…/icon.png",   // PNG, or null
      "versions": [                          // newest first
        {
          "version": "0.2.0",
          "channel": "release",              // "release" | "prerelease" | "experimental"
          "tag": "cogwork-v0.2.0",
          "published": "2026-11-04T12:00:00Z",
          "source": { "repo": "Zorro909/weft-mods", "commit": "<40 hex>" },
          "weft": { "tag": "v26.11.1", "commit": "<40 hex>", "abi": "f470b1cbb1f9ad91" },
          "deps": [{ "id": "base" }],
          "platforms": ["windows-x64", "linux-x64", "macos-arm64"],
          "asset": {
            "name": "cogwork.zip",           // always "<id>.zip"
            "url": "https://github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip",
            "size": 2642469,
            "sha256": "<64 hex, lowercase>"
          },
          "provenance": {                    // or null when no attestation exists
            "kind": "github-attestation",
            "repo": "Zorro909/weft-mods",
            "workflow": ".github/workflows/release.yml",
            "ref": "refs/heads/main",
            "verified_at": "2026-11-04T18:00:00Z"   // when index CI ran `gh attestation verify`
          },
          "reviewed": { "by": "Zorro909", "at": "2026-11-04" }
        }
      ]
    }
  ],

  "revoked": [
    { "sha256": "<64 hex>", "reason": "Shipped a debug build that deletes saves", "at": "2026-11-05" }
  ]
}
```

### Rules the launcher enforces

- `weft[].tag` matches `v[0-9A-Za-z.\-]+`; `id` matches `^[a-z0-9_]+$`.
- `asset.name == id + ".zip"`.
- `asset.url` must start with `https://github.com/<source.repo>/releases/download/`.
- `abi` is 16 lowercase hex characters: the FNV-1a-64 hash of `crates/abi/src/lib.rs` at `weft.commit`.
- Unknown fields are ignored. Missing optional fields mean `null`.
- A mod whose `sha256` appears in `revoked` is never installed. If it is already installed, it is turned off.

## `<id>.mod.json` (one per mod release, for "CI-built" sources)

A GitHub repo the user adds as a source publishes `<id>.mod.json` next to `<id>.zip` in each release.

- It holds the mod-level fields (`id`, `name`, `summary`, `authors`, `license`, `homepage`, `icon`) plus a single version's fields at the top level, with `"schema": 1`.
- Its `asset.sha256` must equal both the zip's GitHub `digest` and the sha256 of the downloaded bytes.
- `reviewed` is absent.

## Platforms

| Platform | OS and architecture |
|---|---|
| `windows-x64` | Windows x86_64 |
| `linux-x64` | Linux x86_64, glibc |
| `macos-arm64` | macOS on Apple Silicon |
