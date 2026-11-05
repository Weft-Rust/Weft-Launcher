// The mock backend's scenarios and URL flags, in one table: the README lists them and the tests
// check that list. Kept apart from mockBackend.ts so reading them pulls in nothing from Tauri.

export interface Scenario {
  name: string;
  description: string;
  /** Flags this scenario sets; flags in the URL win. */
  flags: Record<string, string>;
}

export const SCENARIOS: Scenario[] = [
  {
    name: "mods",
    description:
      "The default. A mod built for another version (with a fitting update), an update, a prerelease that is off, a source, a local file and a file in the player's own folder.",
    flags: {},
  },
  { name: "empty", description: "The newest version has no mods; the older one has mods to copy.", flags: {} },
  { name: "fresh", description: "No game version installed.", flags: {} },
  { name: "offline", description: "No network: the cached index and a source's cached mods.", flags: { index: "cached", source: "offline" } },
  {
    name: "crash",
    description: "Nothing blocks Play; the game then stops while loading Structures, which has an update.",
    flags: { crash: "loadFailed" },
  },
  { name: "knownfile", description: "From file picks a zip that is a catalogued build (Cogwork 0.2.0).", flags: { file: "known" } },
  { name: "revoked", description: "The installed Cogwork build has been pulled from the index.", flags: { revoked: "cogwork" } },
  { name: "ratelimited", description: "GitHub rate-limits the source; its last mods are shown.", flags: { source: "ratelimited" } },
  { name: "indexdown", description: "There is no index to fetch (the server answers 404) and none saved, so there are no Reviewed mods.", flags: { index: "unavailable" } },
  { name: "stale", description: "The index verifies, but its signature is over 30 days old.", flags: { index: "stale" } },
  { name: "invalid", description: "The new index's signature doesn't verify; the last good one is shown.", flags: { index: "invalid" } },
  { name: "rollback", description: "The new index is older than one already accepted, so it is refused; the last good one is shown.", flags: { index: "rollback" } },
  {
    name: "missingdep",
    description:
      "Mods that need others: Hearth needs Cogwork, which is off; Lanterns needs Glowmoss, which isn't installed; Railways needs Signals, which has no build yet.",
    flags: {},
  },
  {
    name: "lateblock",
    description: "Nothing blocks Play until Play itself finds Cogwork revoked; Hearth, which needs it, then blocks the start.",
    flags: { prelaunch: "revoke" },
  },
  { name: "long", description: "Very long mod names, ids and repos, for overflow checks.", flags: { long: "1" } },
  {
    name: "shadowed",
    description:
      "Cogwork is revoked, and the player's own mods folder has a copy of it, which would load in its place: Play is blocked until that file goes.",
    flags: { revoked: "cogwork", shadow: "cogwork" },
  },
  {
    name: "chain",
    description:
      "Mods that need mods that need others: Chimneys needs Hearth, which needs Cogwork, both installed and off; Junctions needs Railways, which needs Signals, which has no build.",
    flags: { chain: "1" },
  },
];

export interface Flag {
  name: string;
  values: string[];
  description: string;
}

export const FLAGS: Flag[] = [
  {
    name: "index",
    values: ["fresh", "stale", "cached", "unavailable", "unreachable", "invalid", "rollback", "unsaved"],
    description:
      "State of the signed mod index; `unavailable` is none saved and the server answers 404 (`HttpStatus`), `unreachable` none saved and no network to it; `unsaved` is fresh but couldn't be saved to disk (`cacheError`).",
  },
  { name: "source", values: ["ok", "notfound", "ratelimited", "offline"], description: "State of the added GitHub source." },
  {
    name: "nomods",
    values: ["noReleases", "noModFiles", "unreadable", "noDigest", "disagrees", "invalid"],
    description: "GitHub answers for the added source, but it has no usable mods, for this reason.",
  },
  {
    name: "race",
    values: ["stale", "error"],
    description: "The first catalogue refresh is slow and answers last: with an older catalogue (`stale`) or an error (`error`). The page keeps the newer answer.",
  },
  { name: "slowsource", values: ["<repo>"], description: "That source takes three seconds to answer a refresh of its own." },
  { name: "revoked", values: ["<mod id>"], description: "Revokes the installed builds of that mod." },
  { name: "abi", values: ["error"], description: "The game version's mod interface can't be found out." },
  {
    name: "fail",
    values: ["install", "network", "toolarge", "dep", "meanwhile", "catalog", "sources"],
    description:
      "Comma-separated. Installs fail at the hash check, mid-download, before it, or while downloading a dependency; `meanwhile` publishes a newer Glowmoss after the first plan, so a plan with Glowmoss in it is refused as changed and planned again; the catalogue fails to load; `sources` finds the list of sources damaged (kept aside, `ModSourcesDamaged`).",
  },
  {
    name: "file",
    values: ["unverified", "known", "notamod", "revoked", "revokedlate", "wrongplatform"],
    description: "What From file picks; `revokedlate` is revoked by the index while it is being installed.",
  },
  { name: "shadow", values: ["<mod id>"], description: "The player's own mods folder has a copy of that mod, which loads when the launcher's is off or revoked. Showing the folder only opens it; tests stand in for the player deleting the file with `window.mockPlayer.deleteFile(name)`." },
  {
    name: "revocations",
    values: ["messy"],
    description: "Revocations come with uppercase hashes, no reason or time, and one entry that isn't a hash: they still revoke, and only that one is dropped.",
  },
  { name: "chain", values: ["1"], description: "Adds Chimneys and Junctions, which need mods that need others." },
  {
    name: "crash",
    values: ["wrongVersion", "loadFailed", "notAMod", "wrongName", "missingDep", "initPanicked", "exit"],
    description: "Play starts the game and it stops with this failure; `exit` is a crash that names no mod.",
  },
  { name: "prelaunch", values: ["revoke"], description: "Play finds Cogwork revoked, as a fresh index would, before it starts the game." },
  { name: "long", values: ["1"], description: "Adds very long names, ids and repos." },
  { name: "slow", values: ["1"], description: "Everything takes four times as long: time enough to press Cancel." },
  {
    name: "profile",
    values: ["fail", "failafterplay"],
    description: "Reading a version's set fails (`Io`): always, or only the first read after Play is refused, so Retry gets through.",
  },
];
