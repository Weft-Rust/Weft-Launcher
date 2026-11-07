# Mock backend

`npm run dev:mock` serves the UI at http://localhost:1420/?scenario=mods against a fake backend
(`src/dev/mockBackend.ts`). The mock never ships in a production build.

Its rules are ported from the Rust backend (`src/dev/mockRules.ts`), and both are checked against
the shared cases in `src/dev/fixtures/` (`npm test`, `cargo test`). File system and network failures
are only simulated as the error code they end in; Rust tests them against real files and a local
HTTP server.

Pick a state with `?scenario=` and adjust it with flags, which combine:
`?scenario=mods&index=cached&revoked=cogwork&slow=1`. Flags in the URL override the ones a scenario
sets. Both lists come from `src/dev/scenarios.ts`; `npm test` fails if this page misses one.

## Scenarios

| Scenario | What it shows | Flags it sets |
|---|---|---|
| `mods` | The default: a mod built for another version (with a fitting update), an update, an off prerelease, a source, a local file and a file in the player's own folder. | — |
| `empty` | The newest version has no mods; the older one has mods to copy. | — |
| `fresh` | No game version installed. | — |
| `offline` | No network: the cached index and a source's cached mods. | `index=cached` `source=offline` |
| `crash` | The game stops while loading Structures, which has an update. | `crash=loadFailed` |
| `knownfile` | From file picks a catalogued build (Cogwork 0.2.0). | `file=known` |
| `revoked` | The installed Cogwork build is revoked. | `revoked=cogwork` |
| `ratelimited` | GitHub rate-limits the source; its last mods are shown. | `source=ratelimited` |
| `indexdown` | No index on the server (404) and none saved: no Reviewed mods. | `index=unavailable` |
| `stale` | The index signature is over 30 days old. | `index=stale` |
| `invalid` | The new index's signature doesn't verify; the last good one is shown. | `index=invalid` |
| `rollback` | The new index is older than one already accepted; the last good one is shown. | `index=rollback` |
| `missingdep` | Hearth needs Cogwork (off); Lanterns needs Glowmoss (not installed); Railways needs Signals (no build). | — |
| `lateblock` | Play itself finds Cogwork revoked; Hearth, which needs it, blocks the start. | `prelaunch=revoke` |
| `long` | Very long mod names, ids and repos. | `long=1` |
| `shadowed` | Cogwork is revoked and the player's own folder has a copy: Play is blocked until that file goes. | `revoked=cogwork` `shadow=cogwork` |
| `slowrefresh` | A refresh revokes Cogwork at once while the source lantern-dev/lanterns takes three seconds. | `slowsource=lantern-dev/lanterns` `refreshrevokes=cogwork` |
| `chain` | Chimneys → Hearth → Cogwork, both installed and off; Junctions → Railways → Signals, which has no build. | `chain=1` |

## Flags

| Flag | Values | Effect |
|---|---|---|
| `index` | `fresh`, `stale`, `cached`, `unavailable`, `unreachable`, `invalid`, `rollback`, `unsaved` | State of the signed index. `unavailable`: none saved, server answers 404. `unreachable`: none saved, no network. `unsaved`: fresh but not saved (`cacheError`). |
| `source` | `ok`, `notfound`, `ratelimited`, `offline` | State of the added GitHub source. |
| `nomods` | `noReleases`, `noModFiles`, `unreadable`, `noDigest`, `disagrees`, `invalid` | The source has no usable mods, for this reason. |
| `race` | `stale`, `error` | The first refresh answers last, with an older catalogue or an error. The page keeps the newer answer. |
| `slowsource` | `<repo>` | That source takes three seconds; the index is shown before it answers. |
| `refreshrevokes` | `<mod id>` | The next refresh's index revokes that mod's installed builds, once. |
| `revoked` | `<mod id>` | Revokes that mod's installed builds. |
| `abi` | `error` | The version's ABI can't be found. |
| `fail` | `install`, `network`, `toolarge`, `dep`, `meanwhile`, `catalog`, `sources` | Comma-separated. `install`: the hash check fails. `network`: the download breaks off midway. `toolarge`: the zip is refused before downloading. `dep`: a dependency's download fails. `meanwhile`: a newer Glowmoss appears after the first plan, so that plan is refused and planned again. `catalog`: the catalogue fails to load. `sources`: the sources list is damaged. |
| `file` | `unverified`, `known`, `notamod`, `revoked`, `revokedlate`, `wrongplatform` | What From file picks; `revokedlate` is revoked during the install. |
| `shadow` | `<mod id>` | The player's own folder has a copy of that mod. Tests delete it with `window.mockPlayer.deleteFile(name)`. |
| `revocations` | `messy` | Uppercase hashes, no reason or time, and one entry that isn't a hash: only that one is dropped. |
| `chain` | `1` | Adds Chimneys and Junctions. |
| `crash` | `wrongVersion`, `loadFailed`, `notAMod`, `wrongName`, `missingDep`, `initPanicked`, `exit` | The game stops with this failure; `exit` names no mod. |
| `prelaunch` | `revoke`, `storemissing` | Play finds Cogwork revoked, or the store's copy of Structures gone (`ModStoreMissing`). |
| `long` | `1` | Adds very long names, ids and repos. |
| `slow` | `1` | Everything takes four times as long. |
| `fast` | `1` | Everything takes a quarter as long. |
| `profile` | `fail`, `failafterplay` | Reading a version's set fails: always, or only the first read after Play. |
