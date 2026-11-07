# Publishing a Weft mod

For mod authors: how to ship a mod the launcher can install, first from your own GitHub repo
(players see it as **Unreviewed**), then in the signed Weft mod index (**Reviewed**). The exact
rules are in [INDEX_FORMAT.md](INDEX_FORMAT.md); this page is the path through them.

## 1. The zip

One `<id>.zip` per build, where `<id>` is your mod id: `[a-z0-9_]{1,64}`, not `base`, and equal to
your crate name (the engine refuses a mismatch). Inside, nothing but:

```text
<id>.dll          Windows
lib<id>.so        Linux
lib<id>.dylib     macOS
assets/…          textures, lang files, and assets/textures/gui/icon.png
```

No other files at the top, no folders above these, no `..`, absolute paths or links. Ship the
libraries for the platforms you build, and list them in `platforms`. Limits: 512 MB, 20,000 entries
and 1 GB unpacked ([all limits](INDEX_FORMAT.md#size-limits)).

## 2. The release

- **Tag** each build `<id>-v<version>`, for example `lanterns-v1.2.0`, to keep several mods in one
  repo apart. Any tag works if it is 1–100 letters, digits, `.`, `_` or `-` and doesn't start with
  `.`.
- **Version** is semver (`1.2.0`, `1.3.0-beta.1`). A prerelease on GitHub is a prerelease in the
  launcher too.
- Make the release (not a draft) with `<id>.zip` and `<id>.mod.json` as its assets. GitHub records
  a SHA-256 digest for each asset; a zip without one is skipped.
- A new build is a new version and a new release, every time. If two releases share a version or
  a zip hash, the older one's copy is skipped.

## 3. `<id>.mod.json`

Describe the build exactly as GitHub has it: the example and every rule are in
[INDEX_FORMAT, `<id>.mod.json`](INDEX_FORMAT.md#idmodjson-for-unreviewed-sources), and
[`schema/mod.schema.json`](schema/mod.schema.json) checks the shape. The fields that trip people:

- `asset.url` is the zip's `browser_download_url`, character for character, and `asset.size` and
  `asset.sha256` are the zip's.
- `weft.abi` is the FNV-1a-64 hash of the raw bytes of `crates/abi/src/lib.rs` at the Weft commit
  you built against, as 16 lowercase hex digits. Players get your build only on Weft versions with
  the same ABI.
- `deps` lists every mod yours needs to load, by id.
- `provenance` from your own repo is shown as your claim, never as a record: leave it `null`, or
  describe your attestation (step 4).

Then add your repo in the launcher (Mods → Sources).

### When a source shows no mods

The Sources dialog shows one reason: that of the release that passed the most checks. The checks run in this order:

| Reason | Means |
| --- | --- |
| `noReleases` | The repo has no published releases. |
| `noModFiles` | No release has an `<id>.zip` together with its `<id>.mod.json`. |
| `unreadable` | An `<id>.mod.json` couldn't be read as JSON, or isn't a description. |
| `noDigest` | GitHub has no SHA-256 digest for the zip, so nothing could be checked. |
| `disagrees` | The description doesn't match GitHub's record of the release: tag, repo, asset name, URL, size or hash, or the id isn't the zip's. |
| `invalid` | It matches, but breaks a [rule every entry follows](INDEX_FORMAT.md#rules-the-launcher-enforces). |

## 4. Into the signed index

A build in the index is **Reviewed**: someone read it, and the index signature pins its bytes, so a
changed release can't change what players install.

1. Build in GitHub Actions and attest the zip with
   [`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance), from a
   workflow in `.github/workflows/`.
2. Open a pull request on `Weft-Rust/weft-mods-index` that adds the version to your mod's entry
   (the mod too, the first time): the same fields as your `<id>.mod.json`, with `source.commit`
   the full commit the release was built from.
3. A reviewer reads the source at that commit, runs `gh attestation verify` on the zip, and adds
   `reviewed` and `provenance`. The launcher shows a build record only when that record is complete
   ([INDEX_FORMAT, Provenance](INDEX_FORMAT.md#provenance)).
4. Once merged, CI signs the index and Pages serves it; players get it on their next refresh.

If a build turns out to be harmful or broken, ask for its `sha256` to be revoked, with a reason.
Launchers learn of it when they next read the index, and turn the build off the next time its
version's mods are read or before Play. A running game keeps it until it stops.
