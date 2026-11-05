# Mod index format, v1

This file is the contract between Weft Launcher and [`Zorro909/weft-mods-index`](https://github.com/Zorro909/weft-mods-index). The launcher accepts exactly this format. A change that breaks it needs a new `schema` number and a new URL path (`/v2/`).

The JSON examples below are complete and valid: a test in the launcher (`src-tauri/src/mods/doc_tests.rs`) parses each one with the launcher's own code and fails if any entry would be dropped.

## Where it lives

| File | URL |
|---|---|
| Index | `https://zorro909.github.io/weft-mods-index/v1/index.json` |
| Signature | `https://zorro909.github.io/weft-mods-index/v1/index.json.minisig` |

- The signature is a minisign signature of the exact bytes of `index.json`, **prehashed** (`minisign -S -H`, the default of current minisign). Legacy, non-prehashed signatures are refused.
- The launcher embeds the public key (`keys/index.pub` in the index repo; `INDEX_PUBLIC_KEY` in `src-tauri/src/mods/index/signature.rs`).
- An index whose signature doesn't verify is rejected. The launcher then keeps using its last verified copy.
- The signature's trusted comment should carry `timestamp:<unix seconds>`, as `minisign -S` writes by default (for example `timestamp:1793819114 file:index.json`). The key signs the trusted comment too, so this is when the index was signed; the launcher reports it as `signedAt`. Without it, the launcher judges the index's age by `generated` alone.
- The index repository re-signs the index weekly, even when nothing changed, so that its signing time stays recent (see [Stale](#launcher-behaviour)).
- **Key rotation.** The launcher trusts exactly one key, built in. To rotate it: ship a launcher release that embeds the new key, keep signing with the old key until that release is the one players run, then switch the index to the new key. An index signed with a key the launcher doesn't have is refused like any bad signature, and the last verified copy stays in use; the rollback floor is kept across the switch.

## `index.json`

JSON Schemas for both files, for an editor or a publishing CI: [`schema/index.schema.json`](schema/index.schema.json) and [`schema/mod.schema.json`](schema/mod.schema.json). They say what a file must hold for every entry in it to be used; the launcher's tests hold the examples below to them, and each `pattern` to the check the launcher runs. Rules that compare one field with another, or with GitHub, are only in the text.

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

"Default" is what the launcher uses when the field is missing. A field without a default is required: an entry that lacks it is skipped (or, for `schema` and `generated`, the whole index is refused).

| Field | Default | Meaning |
|---|---|---|
| `schema` | required | Always `1`. |
| `generated` | required | RFC 3339 time the index was built. With the signing time, it decides whether an index is newer (see [Launcher behaviour](#launcher-behaviour)). |
| `weft[]` | `[]` | The ABI hash per Weft release, so the launcher doesn't have to compute it. Each entry needs `tag`, `commit` and `abi`. |
| `mods[]` | `[]` | The mods. |
| `mods[].id` | required | `[a-z0-9_]{1,64}`, equal to the crate name and the zip stem. `base` is reserved. |
| `mods[].name` | required | Display name. |
| `mods[].summary` | `""` | One line. The launcher shows the first line, cut to 140 characters. |
| `mods[].authors` | `[]` | Display names. |
| `mods[].license`, `homepage`, `icon` | `null` | `homepage` is an absolute `https://` URL, or it is dropped. `icon` is an `https://` URL on `github.com`, `raw.githubusercontent.com`, `user-images.githubusercontent.com` or a `<name>.github.io` Pages site, with no port or user name, or it is dropped: the launcher never asks another host for an icon, which would tell that host the player's address. Redirects are followed only to GitHub hosts. The icon is a PNG of at most 512 KB, or it isn't shown. The same rule holds for a source's `<id>.mod.json`. |
| `versions[]` | `[]` | Newest first (the launcher sorts again anyway). A mod without a valid version is left out. |
| `version` | required | Semver: `MAJOR.MINOR.PATCH`, optionally `-prerelease` and `+build`, e.g. `0.2.1-rc.1`. |
| `channel` | required | `release`, `prerelease` or `experimental`. |
| `tag` | required | The GitHub release tag of this build. |
| `published` | `""` | RFC 3339, when given. |
| `source` | required | `repo` (`owner/name`) and `commit` (the full hash) the build was made from. Both are required. |
| `weft` | required | `abi` (required, 16 hex), and the Weft `tag` (default `null`) and `commit` (default `""`, else a full hash) it was built against. |
| `deps[]` | `[]` | `{ "id": … }` of every mod it needs. `base` ships with Weft and is never installed. |
| `platforms[]` | `[]` | Which libraries the zip has (table below). An unknown platform string is ignored. |
| `asset` | required | `name`, `url`, `size` and `sha256` of the zip, all required. |
| `provenance` | `null` | The attestation the index CI checked with `gh attestation verify`. `kind` is required; `repo`, `workflow`, `ref` and `verified_at` default to `null`. See [Provenance](#provenance) for what the launcher shows. |
| `reviewed` | required in the index | `by` and `at`: who reviewed exactly these bytes, and when. Not read from sources. |
| `revoked[]` | `[]` | Builds that must never be used again. Must be a list: anything else refuses the whole index. |
| `revoked[].sha256` | required | The build's hash, in any case. |
| `revoked[].reason` | none (`null`) | Why, for the player. Also none when it is empty or not a string; the launcher then says "No reason given" in the player's language. |
| `revoked[].at` | `null` | When. Also `null` when it is not a string. |

### Rules the launcher enforces

A version that breaks any of these is left out. The rest of the index is still used.

- `id` matches `[a-z0-9_]{1,64}` and is not `base`.
- `version` is semver (see the table).
- `source.repo` is `owner/name`, each part 1–100 of `A–Z a–z 0–9 - _ .`, and neither `.` nor `..`.
- `source.commit` is a full commit hash: 40 lowercase hex characters, or 64 in a SHA-256 repository. So is `weft.commit` when it isn't empty, and every `weft[].commit` (an entry with any other commit is dropped).
- `published` is RFC 3339 when it isn't empty.
- `tag`, `weft.tag` and `weft[].tag` are 1–100 of `A–Z a–z 0–9 . - _`, and don't start with `.`.
- `asset.name` is `<id>.zip`.
- `asset.url` is exactly `https://github.com/<owner>/<repo>/releases/download/<tag>/<id>.zip`, where `<owner>/<repo>` is `source.repo` (compared without case, as GitHub does) and `<tag>` is `tag`. See [the URL rule](#the-asset-url-rule).
- `asset.sha256` is 64 lowercase hex characters.
- `weft.abi` and `weft[].abi` are 16 lowercase hex characters: the FNV-1a-64 hash of `crates/abi/src/lib.rs` at that commit.
- Every `deps[].id` is a valid mod id.
- `reviewed` is present, with a non-empty `by`. In the index, Reviewed means someone reviewed it.
- **Revocations fail closed.** A `revoked[]` entry is dropped only when its `sha256` can't be a SHA-256 at all (64 hex characters, in any case, after trimming), and that is logged. Everything else about it may be wrong or missing and it still revokes: the hash is lowercased and compared without case, and `reason` and `at` take their defaults.
- Unknown fields are ignored. Missing fields take the defaults in the table.
- A mod whose `sha256` appears in `revoked` is never installed. If it is already installed, it is turned off, and nothing that needs it can turn it back on. The launcher records the revocation, with its reason, in the version's `mods.lock.json`, so the mod stays revoked even if the index can't be loaded later, until the build is replaced or removed.

Not enforced: that `summary` is one short line (it is cut instead), that `versions[]` is sorted, and that `published` is in the past.

## `<id>.mod.json`, for Unreviewed sources

A GitHub repo the player adds as a source publishes `<id>.mod.json` next to `<id>.zip` in each release. It holds the mod-level fields plus one version's fields at the top level, with the same defaults as in the index; `schema` is required too:

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
2. The release also has an asset `<id>.zip`, `id` equals its stem, and `id` is a mod id (`[a-z0-9_]{1,64}`, not `base`).
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
- `provenance` is passed on as the publisher's claim (`buildRecord: "claimed"`), never as a record. Only provenance recorded in the signed index can be one (see [Provenance](#provenance)).
- The downloaded bytes must hash to `asset.sha256`, as for the index.
- Draft releases are ignored.

A release may carry several mods: each `<id>.mod.json` with its own `<id>.zip` is read on its own.

Some fields of a `.mod.json` are only the publisher's word, and the launcher can't check them: `weft.abi` (the build is matched on it; the game has the last word when it loads the library), `source.commit`, `deps`, and `provenance`. The UI shows them as claims.

When several releases publish the same mod:

- They are read newest release first, as GitHub lists them. The mod's name, summary, icon and other mod-level fields come from the newest release that passes.
- A version string, or a zip `sha256`, that a newer release already published is skipped in older releases.

A source mod is its own catalogue entry (`source:<owner/repo>:<id>`), even when the index has a mod with the same `id` (`index:<id>`). Dependencies are looked up in the index first, then in the same source. A source build whose `sha256` is also in the index shows once, as Reviewed.

## Provenance

The launcher never verifies an attestation itself. The index CI runs `gh attestation verify` when it adds a version, and records what it checked in `provenance`; the signature over the index is what makes that record the index's word. The launcher shows it as the index's record, in those words ("The signed index records: built by GitHub Actions in `repo` @ `commit`, checked by `reviewed.by` on `verified_at`"), and only when the record is whole:

| `buildRecord` | When | Shown as |
|---|---|---|
| `recorded` | In the signed index, `kind` is `github-attestation`, `repo` is `owner/name`, `workflow` is `.github/workflows/<name>.yml` (or `.yaml`), and `verified_at` is RFC 3339. `source.commit` is a full hash already (a rule above). `ref` is optional. | ✓, worded as the index's record |
| `incomplete` | In the signed index, but any of the above is missing or malformed, or `kind` is another one. | ? (unknown): "an incomplete build record" |
| `claimed` | From a source's `<id>.mod.json`, whatever it says. | ? (unknown): "the repo says" |
| `none` | No `provenance`. | ? (unknown): "No build record" |

An incomplete record doesn't drop the version: the review still stands, and only the build row is unknown. The rule is `catalog::build_record` in the backend, and the shared cases in `src/dev/fixtures/rules.json` (`buildRecords`) hold the dev mock to it.

## Publishing from your own repo

A player can add any GitHub repo as a source (Mods → Sources). Its mods show up as **Unreviewed**. To publish one:

1. Build the mod and zip it as `<id>.zip`, where `<id>` is the mod id (`[a-z0-9_]{1,64}`, not `base`).
2. Write `<id>.mod.json` as [above](#idmodjson-for-unreviewed-sources). `tag` is the release's tag, `source.repo` is your repo, and `asset` describes the zip exactly: its name, its `browser_download_url`, its size and its SHA-256.
3. Make a GitHub release (not a draft) with both files as assets. GitHub records a SHA-256 digest for each asset; the launcher compares `asset.sha256` with it, and skips a zip GitHub has no digest for.
4. Bump the version, and make a new release, for every new build. If two releases share a version or a zip hash, the newest release wins and the older release's copy is skipped.

When a source shows no mods, the Sources dialog says why. It names the reason that got furthest across all releases (`SourceStatus.noMods`):

| Reason | Means |
| --- | --- |
| `noReleases` | The repo has no published releases. |
| `noModFiles` | No release has an `<id>.zip` together with its `<id>.mod.json`. |
| `unreadable` | An `<id>.mod.json` couldn't be read as JSON, or isn't a description. |
| `noDigest` | GitHub has no SHA-256 digest for the zip, so nothing could be checked. |
| `disagrees` | The description doesn't match GitHub's record of the release: tag, repo, asset name, URL, size or hash, or the id isn't the zip's. |
| `invalid` | It matches, but breaks a [rule every entry follows](#rules-the-launcher-enforces). |

## Launcher behaviour

What the launcher does with all of this, beyond the field rules:

- **Size limits.** The index and its signature are at most 8 MB each. A `<id>.mod.json` is read up to 64 KB, and a longer one is ignored. An icon is read up to 512 KB and must be a PNG. A mod zip is at most 512 MB (and at most 1 KB more than its `asset.size`), at most 20,000 entries, at most 1 GB unpacked, and no entry over 1 MB may compress better than 200:1. These limits are first checked against the sizes the zip's central directory declares, a fast refusal. Then, before the zip enters the store, every entry is inflated once into nothing and counted (`archive.rs`, `inflate_all`): an entry that inflates to more than it declares, or to less, whose checksum fails, that doesn't inflate, or that is encrypted refuses the zip. So the declared sizes the limits were checked against are what the game unpacks too. Nothing is written to disk and no library is loaded.
- **Redirects.** Every download follows redirects only over `https`, and only to `github.com`, `githubusercontent.com`, `github.io` and their subdomains.
- **The bytes.** Every file is hashed again when it enters the launcher's store and must equal `asset.sha256`; its zip and its library for this system are checked then, also when the store already had a file with that hash.
- **The zip itself.** Only `<id>.dll`, `lib<id>.so`, `lib<id>.dylib` and files under `assets/` are allowed. Folders elsewhere, `..`, absolute paths, `\` in names and symbolic links are refused. The library for the player's system must be there.
- **Rollback refusal.** An index's age is the pair (`generated`, signing time). Pairs compare by `generated` first; with the same `generated`, the later signing time is newer, and a signature without a time is older than one with it. A fetched index older than the newest pair ever accepted is refused: the launcher keeps the copy it has and reports `IndexRollback`. That pair is kept in `cache/mod-index.state.json`, apart from the cached index, so deleting the cached index doesn't reset it. The same index fetched again is accepted.
- **Dated in the future.** An index whose `generated` or signing time is more than a day ahead of the computer's clock is refused with `IndexInvalid`, since it would lock out every honest index until then.
- **Stale.** An index that verified but was signed more than 30 days ago (by `generated`, without a signing time) has freshness `stale`. Its entries are still used; the launcher says revocations since then may be missing. A cached copy shown because a refresh failed keeps freshness `cached`, with the error.
- **The cache.** Each verified index and its signature are stored together as one generation, and the launcher keeps the newest two. The signature is checked again on every read. If the newest pair doesn't verify, for example after a crash while writing it, the previous generation is used. Offline, the cached index is used, with freshness `cached` (or `stale`). The launcher only fetches the index when the catalogue is refreshed; Play never waits on it. Generations are written and pruned under one lock, and an index that finishes fetching after a newer one was saved is not saved over it. If saving a fetched index fails (a full disk, say), it is still used until the launcher closes, and the index status carries the failure as `cacheError`: the Mods tab and Sources say it won't be there after a restart, when the previous saved copy, if any, is used instead.
- **Skipping bad entries.** A mod, version or `weft` entry that doesn't parse (for example an unknown `channel`), or that breaks a rule above, is skipped on its own. The rest of the index is used. An unknown platform string is ignored. `revoked` entries are the exception: see the rule above.
- **Duplicates.** The first entry wins. Two `mods[]` with the same `id` both stay in the list, but lookups by id (dependencies, updates) use the first; two versions with the same `asset.sha256` resolve to the first one listed. The index CI should refuse both.
- **Read again, every time.** The cached index is verified and parsed with these rules on every read, and so is each source's cached answer (`sources.rs`, `revalidate`), not only when they were fetched. A download checks [the URL rule](#the-asset-url-rule) once more right before it starts, whatever the catalogue says.
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
