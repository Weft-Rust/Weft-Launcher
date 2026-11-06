# Mod index format, v1

This file is the contract between Weft Launcher and [`Zorro909/weft-mods-index`](https://github.com/Zorro909/weft-mods-index). The launcher accepts exactly this format. A change that breaks it needs a new `schema` number and a new URL path (`/v2/`). Mod authors: the publishing guide is [AUTHORING.md](AUTHORING.md).

The examples below are complete and valid; `src-tauri/src/mods/doc_tests.rs` checks them against the launcher's parser and the schemas.

## Where it lives

| File | URL |
|---|---|
| Index | `https://zorro909.github.io/weft-mods-index/v1/index.json` |
| Signature | `https://zorro909.github.io/weft-mods-index/v1/index.json.minisig` |

- The signature is a **prehashed** minisign signature of the exact bytes of `index.json` (`minisign -S -H`, the default of current minisign). Legacy signatures are refused.
- The launcher embeds the public key (`keys/index.pub` in the index repo; `INDEX_PUBLIC_KEY` in `src-tauri/src/mods/index/signature.rs`).
- An index whose signature doesn't verify is refused, and the launcher keeps its last verified copy.
- The trusted comment carries `timestamp:<unix seconds>`, as `minisign -S` writes by default (`timestamp:1793819114 file:index.json`). The launcher reports it as `signedAt`. Without it, staleness uses `generated`, and rollback follows the pair ordering in [Freshness and cache](#freshness-and-cache).
- The index repository re-signs the index weekly, even when nothing changed, so it never goes [stale](#freshness-and-cache).

### Key rotation

The launcher trusts exactly one built-in key. To rotate it: ship a launcher release that embeds the new key, keep signing with the old key until players run that release, then switch the index to the new key. An index signed with an unknown key is refused like any bad signature.

## `index.json`

JSON Schemas: [`schema/index.schema.json`](schema/index.schema.json) and [`schema/mod.schema.json`](schema/mod.schema.json). Rules that compare fields with each other or with GitHub are only in this file.

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

"Default" is what the launcher uses when the field is missing; a field marked required has none. "Value" is what the launcher accepts: anything else skips the entry, unless the row says what happens instead.

| Field | Default | Value |
|---|---|---|
| `schema` | required | `1`. |
| `generated` | required | RFC 3339 time the index was built. |
| `weft[]` | `[]` | ABI hash per Weft release, so the launcher doesn't compute it: `tag`, `commit` (full hash) and `abi`, all required. |
| `mods[]` | `[]` | The mods. |
| `mods[].id` | required | `[a-z0-9_]{1,64}`, not `base`. Equal to the crate name and the zip stem. |
| `mods[].name` | required | Display name. |
| `mods[].summary` | `""` | One line. The launcher shows the first line, cut to 140 characters. |
| `mods[].authors` | `[]` | Display names. |
| `mods[].license` | `null` | License, for display. |
| `mods[].homepage` | `null` | Absolute `https://` URL; anything else is dropped. |
| `mods[].icon` | `null` | PNG on a GitHub host; see [Icons](#icons). |
| `versions[]` | `[]` | Newest first (the launcher sorts again). A mod without a valid version is left out. |
| `version` | required | Semver: `MAJOR.MINOR.PATCH`, optional `-prerelease` and `+build`. |
| `channel` | required | `release`, `prerelease` or `experimental`. |
| `tag` | required | The GitHub release tag of this build. |
| `published` | `""` | RFC 3339 when not empty. |
| `source` | required | `repo` (`owner/name`) and `commit` (full hash) the build was made from, both required. |
| `weft` | required | `abi` (required), plus the Weft `tag` (default `null`) and `commit` (default `""`, else a full hash) it was built against. |
| `deps[]` | `[]` | `{ "id": … }` of every mod it needs, each a valid mod id. `base` ships with Weft. |
| `platforms[]` | `[]` | Which libraries the zip has ([Platforms](#platforms)). Unknown strings are ignored. |
| `asset` | required | `name`, `url`, `size` and `sha256` of the zip, all required. |
| `provenance` | `null` | The attestation the index CI checked. `kind` is required; `repo`, `workflow`, `ref` and `verified_at` default to `null`. See [Provenance](#provenance). |
| `reviewed` | required in the index | `by` (not empty) and `at`: who reviewed exactly these bytes, and when. Never read from sources. |
| `revoked[]` | `[]` | Builds that must never be used again. |
| `revoked[].sha256` | required | The build's hash, in any case. |
| `revoked[].reason` | none (`null`) | Why, for the player. Empty or not a string also means none; the launcher then says "No reason given". |
| `revoked[].at` | `null` | When. Not a string also means `null`. |

Unknown fields are ignored.

### Rules the launcher enforces

The whole index is refused, and the last verified copy kept, when `schema` isn't `1`, `generated` isn't RFC 3339, or `weft`, `mods` or `revoked` isn't a list.

Otherwise a mod, version or `weft[]` entry is skipped on its own when it fails to parse, breaks a value in the [Fields](#fields) table (such as `id`, `version`, `published` or `deps[].id`), or breaks one of these rules:

| Field | Form |
|---|---|
| Commits (`source.commit`, `weft.commit`, `weft[].commit`) | 40 lowercase hex characters, or 64 in a SHA-256 repository |
| `asset.sha256` | 64 lowercase hex characters |
| `weft.abi`, `weft[].abi` | 16 lowercase hex characters: the FNV-1a-64 hash of `crates/abi/src/lib.rs` at that commit |

- `tag`, `weft.tag` and `weft[].tag` are 1–100 of `A–Z a–z 0–9 . - _`, and don't start with `.`.
- `source.repo` is `owner/name`, each part 1–100 of `A–Z a–z 0–9 - _ .`, and neither `.` nor `..`.
- `asset.name` is `<id>.zip`.
- `asset.url` follows [the asset URL rule](#the-asset-url-rule).

**Revocations fail closed.** A `revoked[]` entry is dropped only when its `sha256` can't be a SHA-256 at all (64 hex characters, any case, after trimming), and that is logged. Every other problem leaves it in force: the hash is lowercased and compared without case, and `reason` and `at` take their defaults. What the launcher then does with a revoked build: [PROPOSAL, Revocation](PROPOSAL.md#revocation).

Not enforced: that `summary` is one short line, that `versions[]` is sorted, and that `published` is in the past.

### Icons

In the index and in `<id>.mod.json`, an `icon` must be an `https://` URL on `github.com`, `raw.githubusercontent.com`, `user-images.githubusercontent.com` or a `<name>.github.io` site, with no port or user name; any other is dropped. It must be a PNG of at most 512 KB, or it isn't shown. Redirects follow the [download rules](#downloads).

## `<id>.mod.json`, for Unreviewed sources

A GitHub repo the player adds as a source publishes `<id>.mod.json` next to `<id>.zip` in each release. It holds the mod-level fields plus one version's fields at the top level, with the same defaults; `schema` is required too:

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

The launcher reads the repo's releases (drafts are ignored) and accepts a `<id>.mod.json` only when it agrees with GitHub's record of the same release (`sources.rs`, `accept`):

1. `schema` is `1`.
2. The release also has an asset `<id>.zip`, `id` equals its stem, and `id` is a valid mod id.
3. `tag` equals the release's tag.
4. `source.repo` equals the source repo (compared without case).
5. `asset.name`, `asset.url` and `asset.size` equal the zip's name, `browser_download_url` and size.
6. GitHub reports a `digest` for the zip, and `asset.sha256` equals it.
7. Every [rule the launcher enforces](#rules-the-launcher-enforces) except `reviewed`.

Then:

- If GitHub marks the release a prerelease, a `channel` of `release` becomes `prerelease`.
- `published` comes from GitHub when it has one.
- `reviewed` is never read: source builds are always **Unreviewed**.
- `provenance` is the publisher's claim (`buildRecord: "claimed"`), never a record.

The launcher can't check `weft.abi`, `source.commit`, `deps` or `provenance` of a source; the UI shows them as claims. The game has the last word on the ABI when it loads the library.

A release may carry several mods: each `<id>.mod.json` with its `<id>.zip` is read on its own. Releases are read newest first:

- The mod-level fields (name, summary, icon …) come from the newest release that passes.
- A version string or zip `sha256` that a newer release already published is skipped in older releases.

A source mod is listed apart from an index mod with the same `id`. Dependencies resolve in the index first, then in the same source. A source build whose `sha256` is also in the index shows once, as Reviewed.

Publishing steps, and why a source shows no mods: [AUTHORING.md](AUTHORING.md#when-a-source-shows-no-mods).

## Provenance

The launcher never verifies an attestation. The index CI runs `gh attestation verify` when it adds a version and records the result in `provenance`; the index signature makes that record the index's word. The launcher shows it as the index's record, and only when it is complete:

| `buildRecord` | When | Shown as |
|---|---|---|
| `recorded` | In the signed index, `kind` is `github-attestation`, `repo` is `owner/name`, `workflow` is `.github/workflows/<name>.yml` (or `.yaml`), and `verified_at` is RFC 3339. `ref` is optional. | ✓, worded as the index's record |
| `incomplete` | In the signed index, but any of the above is missing or malformed, or `kind` is another one. | ? (unknown): "an incomplete build record" |
| `claimed` | From a source's `<id>.mod.json`, whatever it says. | ? (unknown): "the repo says" |
| `none` | No `provenance`. | ? (unknown): "No build record" |

An incomplete record doesn't drop the version: the review stands, and only the build row is unknown (`catalog::build_record`).

## Launcher behaviour

### Size limits

| What | Limit |
|---|---|
| `index.json`, `index.json.minisig` | 8 MB each |
| `<id>.mod.json` | 64 KB; a longer one is ignored |
| Icon | 512 KB, PNG |
| Mod zip | 512 MB, and at most `asset.size` + 1 KB |
| Zip entries | 20,000 |
| Zip unpacked | 1 GB |
| Compression ratio | 200:1 for any entry over 1 MB |

Before a zip is stored, the launcher inflates every entry once, without writing it to disk. It refuses the zip if an entry's real size or checksum differs from its header, if an entry won't inflate, or if it is encrypted.

### Downloads

- Redirects are followed only over `https`, to `github.com`, `githubusercontent.com`, `github.io` and their subdomains.
- Every file is hashed when it enters the store and must equal `asset.sha256`. Its zip contents and its library for this system are checked then too, even when the store already has that hash.
- A zip may hold only `<id>.dll`, `lib<id>.so`, `lib<id>.dylib` and files under `assets/`. Other folders, `..`, absolute paths, `\` in names and symbolic links are refused. The library for the player's system must be there.
- A download checks [the asset URL rule](#the-asset-url-rule) again right before it starts.

### Freshness and cache

- **Rollback refusal.** An index's age is the pair (`generated`, signing time), compared by `generated` first; with equal `generated`, the later signing time is newer, and a signature without a time is older than one with it. A fetched index older than the newest pair ever accepted is refused with `IndexRollback`, and the launcher keeps its copy. That pair is kept in `cache/mod-index.state.json`, so deleting the cached index doesn't reset it. The same index fetched again is accepted.
- **Dated in the future.** An index whose `generated` or signing time is more than a day ahead of the computer's clock is refused with `IndexInvalid`.
- **Stale.** An index signed more than 30 days ago (by `generated` when there is no signing time) has freshness `stale`. It is still used; the launcher says revocations since then may be missing.
- **Cache.** The launcher keeps the newest two verified generations and verifies the cached copy on every read; if the newest fails, the previous one is used. Offline, freshness is `cached` (or `stale`). The index is fetched only on a catalogue refresh, never by Play. If saving a fetched index fails, it is used for this session and reported as `cacheError`.

### Duplicates

The first entry wins. Two `mods[]` with the same `id` both stay listed, but lookups by id (dependencies, updates) use the first. Two versions with the same `asset.sha256` resolve to the first one. The index CI should refuse both.

### Sources

The newest 500 releases of a source are read. Each source's cached answer is checked again on every read. When GitHub can't be reached or refuses (rate limit, server error), the last good answer is shown with the error.

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
