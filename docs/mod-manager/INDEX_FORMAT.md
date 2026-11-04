# Mod index format, v1

This file is the contract between Weft Launcher and [`Zorro909/weft-mods-index`](https://github.com/Zorro909/weft-mods-index). The launcher accepts exactly this format. A change that breaks it needs a new `schema` number and a new URL path (`/v2/`).

The JSON examples below are complete and valid: a test in the launcher (`src-tauri/src/mods/doc_tests.rs`) parses each one with the launcher's own code and fails if any entry would be dropped.

## Where it lives

| File | URL |
|---|---|
| Index | `https://zorro909.github.io/weft-mods-index/v1/index.json` |
| Signature | `https://zorro909.github.io/weft-mods-index/v1/index.json.minisig` |

- The signature is a minisign signature of the exact bytes of `index.json`.
- The launcher embeds the public key (`keys/index.pub` in the index repo).
- An index whose signature doesn't verify is rejected. The launcher then keeps using its last verified copy.

## `index.json`

```json
{
  "schema": 1,
  "generated": "2026-11-04T18:00:00Z",
  "weft": [
    { "tag": "v26.11.1", "commit": "ff9c7128511fc0dce7719b67c9a59274d70bdd5a", "abi": "f470b1cbb1f9ad91" }
  ],
  "mods": [
    {
      "id": "cogwork",
      "name": "Cogwork",
      "summary": "Gears, item tubes and engines.",
      "authors": ["Zorro909"],
      "license": "MPL-2.0",
      "homepage": "https://github.com/Zorro909/weft-mods/tree/main/cogwork",
      "icon": "https://raw.githubusercontent.com/Zorro909/weft-mods/main/cogwork/assets/textures/gui/icon.png",
      "versions": [
        {
          "version": "0.2.0",
          "channel": "release",
          "tag": "cogwork-v0.2.0",
          "published": "2026-11-04T12:00:00Z",
          "source": { "repo": "Zorro909/weft-mods", "commit": "cceea7805df5902d62017d2008d1bb29ed84e152" },
          "weft": { "tag": "v26.11.1", "commit": "ff9c7128511fc0dce7719b67c9a59274d70bdd5a", "abi": "f470b1cbb1f9ad91" },
          "deps": [{ "id": "base" }],
          "platforms": ["windows-x64", "linux-x64", "macos-arm64"],
          "asset": {
            "name": "cogwork.zip",
            "url": "https://github.com/Zorro909/weft-mods/releases/download/cogwork-v0.2.0/cogwork.zip",
            "size": 2642469,
            "sha256": "989b2191c0ffee00989b2191c0ffee00989b2191c0ffee00989b2191c0ffee00"
          },
          "provenance": {
            "kind": "github-attestation",
            "repo": "Zorro909/weft-mods",
            "workflow": ".github/workflows/release.yml",
            "ref": "refs/heads/main",
            "verified_at": "2026-11-04T18:00:00Z"
          },
          "reviewed": { "by": "Zorro909", "at": "2026-11-04" }
        }
      ]
    }
  ],
  "revoked": [
    { "sha256": "5f0569a6bea71b815f0569a6bea71b815f0569a6bea71b815f0569a6bea71b81", "reason": "Shipped a debug build that deletes saves", "at": "2026-11-05" }
  ]
}
```

### Fields

| Field | Required | Meaning |
|---|---|---|
| `schema` | yes | Always `1`. |
| `generated` | yes | RFC 3339 time the index was built. Used to refuse an older index (see [Launcher behaviour](#launcher-behaviour)). |
| `weft[]` | no | The ABI hash per Weft release (`tag`, `commit`, `abi`), so the launcher doesn't have to compute it. |
| `mods[].id` | yes | `[a-z0-9_]{1,64}`, equal to the crate name and the zip stem. `base` is reserved. |
| `mods[].name`, `summary`, `authors`, `license`, `homepage`, `icon` | `name` only | Display fields. `summary` is one line, at most 140 characters. `homepage` and `icon` are absolute `https://` URLs, or they are dropped. `icon` is a PNG. |
| `versions[]` | yes | Newest first (the launcher sorts again anyway). |
| `version` | yes | Semver, e.g. `0.2.1-rc.1`. |
| `channel` | yes | `release`, `prerelease` or `experimental`. |
| `tag` | yes | The GitHub release tag of this build. |
| `published` | no | RFC 3339. |
| `source` | yes | The repo (`owner/name`) and full commit the build was made from. |
| `weft` | yes | The Weft `tag` (optional) and `commit` it was built against, and the 16-hex `abi`. |
| `deps[]` | no | `{ "id": … }` of every mod it needs. `base` ships with Weft and is never installed. |
| `platforms[]` | no | Which libraries the zip has (table below). |
| `asset` | yes | `name`, `url`, `size` and lowercase `sha256` of the zip. |
| `provenance` | no | The attestation the index CI checked with `gh attestation verify`, or `null`. |
| `reviewed` | yes | Who reviewed exactly these bytes, and when. |
| `revoked[]` | no | Builds that must never be used again, by `sha256`, with a `reason`. |

### Rules the launcher enforces

A version that breaks any of these is left out. The rest of the index is still used.

- `id` matches `[a-z0-9_]{1,64}` and is not `base`.
- `source.repo` is `owner/name`, each part 1–100 of `A–Z a–z 0–9 - _ .`, and neither `.` nor `..`.
- `tag`, `weft.tag` and `weft[].tag` are 1–100 of `A–Z a–z 0–9 . - _`, and don't start with `.`.
- `asset.name` is `<id>.zip`.
- `asset.url` is exactly `https://github.com/<owner>/<repo>/releases/download/<tag>/<id>.zip`, where `<owner>/<repo>` is `source.repo` (compared without case, as GitHub does) and `<tag>` is `tag`. See [the URL rule](#the-asset-url-rule).
- `asset.sha256` is 64 lowercase hex characters.
- `weft.abi` and `weft[].abi` are 16 lowercase hex characters: the FNV-1a-64 hash of `crates/abi/src/lib.rs` at that commit.
- Every `deps[].id` is a valid mod id.
- `reviewed` is present, with a non-empty `by`. In the index, Reviewed means someone reviewed it.
- `revoked[].sha256` is 64 lowercase hex characters; other entries are dropped.
- Unknown fields are ignored. Missing optional fields mean `null`.
- A mod whose `sha256` appears in `revoked` is never installed. If it is already installed, it is turned off, and nothing that needs it can turn it back on.

## `<id>.mod.json`, for Unreviewed sources

A GitHub repo the player adds as a source publishes `<id>.mod.json` next to `<id>.zip` in each release. It holds the mod-level fields plus one version's fields at the top level:

```json
{
  "schema": 1,
  "id": "lanterns",
  "name": "Lanterns",
  "summary": "Hanging lanterns in six colours.",
  "authors": ["Someone"],
  "license": "MIT",
  "homepage": "https://github.com/Someone/lanterns",
  "icon": "https://raw.githubusercontent.com/Someone/lanterns/main/assets/textures/gui/icon.png",
  "version": "1.2.0",
  "channel": "release",
  "tag": "lanterns-v1.2.0",
  "published": "2026-11-03T09:30:00Z",
  "source": { "repo": "Someone/lanterns", "commit": "0123456789abcdef0123456789abcdef01234567" },
  "weft": { "tag": "v26.11.1", "commit": "ff9c7128511fc0dce7719b67c9a59274d70bdd5a", "abi": "f470b1cbb1f9ad91" },
  "deps": [{ "id": "base" }],
  "platforms": ["windows-x64", "linux-x64", "macos-arm64"],
  "asset": {
    "name": "lanterns.zip",
    "url": "https://github.com/Someone/lanterns/releases/download/lanterns-v1.2.0/lanterns.zip",
    "size": 1048576,
    "sha256": "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44"
  },
  "provenance": null
}
```

The launcher reads the repo's releases and accepts a `<id>.mod.json` only when all of these agree with GitHub's own record of the same release (`sources.rs`, `accept`):

1. `schema` is `1`.
2. The release also has an asset `<id>.zip`, and `id` equals its stem.
3. `tag` equals the release's tag.
4. `source.repo` equals the source repo (compared without case).
5. `asset.name` equals the zip's name.
6. `asset.url` equals the zip's `browser_download_url`.
7. `asset.size` equals the zip's size.
8. GitHub reports a `digest` for the zip, and `asset.sha256` equals it. A release without a digest is skipped.
9. Every [rule an index entry must follow](#rules-the-launcher-enforces) except `reviewed`.

Then:
- If GitHub marks the release a prerelease, a `channel` of `release` becomes `prerelease`.
- The `published` time comes from GitHub when it has one.
- `reviewed` is never taken from a source: such builds are always **Unreviewed**.
- `provenance` is passed on as the publisher's claim, with `provenanceVerified: false`. Only provenance recorded in the signed index counts as verified.
- The downloaded bytes must hash to `asset.sha256`, as for the index.
- Draft releases are ignored.

A source build whose `sha256` is also in the index shows once, as Reviewed.

## Launcher behaviour

What the launcher does with all of this, beyond the field rules:

- **Size limits.** The index and its signature are at most 8 MB each. A `<id>.mod.json` is read up to 64 KB, and a longer one is ignored. A mod zip is at most 512 MB, at most 20,000 entries, at most 1 GB unpacked, and no entry over 1 MB may compress better than 200:1.
- **The zip itself.** Only `<id>.dll`, `lib<id>.so`, `lib<id>.dylib` and files under `assets/` are allowed. Folders elsewhere, `..`, absolute paths, `\` in names and symbolic links are refused. The library for the player's system must be there.
- **Rollback refusal.** An index whose `generated` is older than the last verified one is refused. The launcher keeps the copy it has and reports `IndexRollback`.
- **The cache.** Each verified index and its signature are stored together as one generation, and the launcher keeps the newest two. The signature is checked again on every read. If the newest pair doesn't verify, for example after a crash while writing it, the previous generation is used. Offline, the cached index is used, with freshness `cached`.
- **Skipping bad entries.** A mod, version, `weft` or `revoked` entry that doesn't parse (for example an unknown `channel`), or that breaks a rule above, is skipped on its own. The rest of the index is used. An unknown platform string is ignored.
- **The URL rule.** See below.
- **Reviewed needs a review.** An index version without `reviewed` is dropped.
- **Sources.** The newest 500 releases of a source are read, in 5 pages of 100. When GitHub can't be reached or refuses (rate limit, server error), the last good answer is shown with the error. The catalogue reports both.

### The asset URL rule

The launcher parses `asset.url` and requires exactly:

- scheme `https`, host `github.com`, no port, user, query or fragment;
- the path segments `[owner, repo, "releases", "download", tag, "<id>.zip"]`, with `owner/repo` equal to `source.repo` without case, and `tag` equal to the version's `tag`;
- the URL exactly as a URL parser would write it back: no `.` or `..` segments, and nothing it would rewrite;
- no `\` and no percent-encoding anywhere.

So `…/releases/download/%2e%2e/…`, `…/download/x/..` and `…\..\evil\…` are all refused.

## Platforms

| Platform | OS and architecture |
|---|---|
| `windows-x64` | Windows x86_64 |
| `linux-x64` | Linux x86_64, glibc |
| `macos-arm64` | macOS on Apple Silicon |
