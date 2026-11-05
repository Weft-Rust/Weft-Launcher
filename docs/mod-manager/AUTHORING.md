# Publishing a Weft mod

For mod authors: how to ship a mod the launcher can install, first from your own GitHub repo
(players see it as **Unreviewed**), then in the signed Weft mod index (**Reviewed**). The exact
rules are in [INDEX_FORMAT.md](INDEX_FORMAT.md); this page is the path through them.

## 1. The zip

One `<id>.zip` per build, where `<id>` is your mod id: `[a-z0-9_]{1,64}`, not `base`, and the
crate name the engine expects (the engine refuses a library whose crate isn't named like its zip).
Inside, nothing but:

```text
<id>.dll          Windows
lib<id>.so        Linux
lib<id>.dylib     macOS
assets/…          textures, lang files, and assets/textures/gui/icon.png
```

No other files at the top, no folders above these, no `..`, absolute paths or links. Ship the
libraries for the platforms you build, and list them in `platforms`. The launcher checks the zip
before it stores it, inflating every entry once to count it (INDEX_FORMAT, "Size limits"): at most
512 MB, 20,000 entries and 1 GB unpacked.

## 2. The release

- **Tag** each build `<id>-v<version>`, for example `lanterns-v1.2.0`. Any tag of
  `[A-Za-z0-9._-]` works; that one keeps several mods in one repo apart.
- **Version** is semver (`1.2.0`, `1.3.0-beta.1`). A prerelease on GitHub is a prerelease in the
  launcher too.
- Make the release (not a draft) with `<id>.zip` and `<id>.mod.json` as its assets. GitHub records
  a SHA-256 digest for each asset; a zip without one is skipped.
- A new build is a new version and a new release, every time.

## 3. `<id>.mod.json`

Describe the build exactly as GitHub has it: the example and every rule are in
[INDEX_FORMAT, `<id>.mod.json`](INDEX_FORMAT.md#idmodjson-for-unreviewed-sources), and
[`schema/mod.schema.json`](schema/mod.schema.json) checks the shape. The fields that trip people:

- `asset.url` is the zip's `browser_download_url`, character for character, and `asset.size` and
  `asset.sha256` are the zip's.
- `weft.abi` is the mod interface of the Weft version you built against: 16 hex digits, the hash
  of that version's `crates/abi/src/lib.rs`. Players get your build only on Weft versions with the
  same ABI.
- `deps` lists every mod yours needs to load, by id.
- `provenance` from your own repo is shown as your claim, never as a record: leave it `null`, or
  describe your attestation (step 4).

Then add your repo in the launcher (Mods → Sources). When a source shows no mods, the Sources dialog
says why (INDEX_FORMAT, "Publishing from your own repo").

## 4. Into the signed index

A build in the index is **Reviewed**: someone read it, and its bytes are pinned by the index's
signature, so a changed release can't change what players install.

1. Build in GitHub Actions and attest the zip with
   [`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance), from a
   workflow in `.github/workflows/`.
2. Open a pull request on `Zorro909/weft-mods-index` that adds the version to your mod's entry
   (the mod too, the first time): the same fields as your `<id>.mod.json`, with `source.commit`
   the full commit the release was built from.
3. A reviewer reads the source at that commit, runs `gh attestation verify` on the zip, and adds
   `reviewed` (who, when) and `provenance` (`kind: "github-attestation"`, your repo, the workflow
   path and when it was checked). The launcher shows the build record only when all of these are
   there ([INDEX_FORMAT, Provenance](INDEX_FORMAT.md#provenance)).
4. Once merged, CI signs the index and Pages serves it; players get it on their next refresh.

If a build turns out to be harmful or broken, ask for it to be revoked: the index lists its
`sha256` in `revoked`, with a reason, and every launcher turns it off.
