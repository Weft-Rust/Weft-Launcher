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
  { name: "indexdown", description: "The index has never been reached, so there are no Reviewed mods.", flags: { index: "unavailable" } },
  { name: "long", description: "Very long mod names, ids and repos, for overflow checks.", flags: { long: "1" } },
];

export interface Flag {
  name: string;
  values: string[];
  description: string;
}

export const FLAGS: Flag[] = [
  { name: "index", values: ["fresh", "cached", "unavailable", "invalid", "rollback"], description: "State of the signed mod index." },
  { name: "source", values: ["ok", "notfound", "ratelimited", "offline"], description: "State of the added GitHub source." },
  { name: "revoked", values: ["<mod id>"], description: "Revokes the installed builds of that mod." },
  { name: "abi", values: ["error"], description: "The game version's mod interface can't be found out." },
  {
    name: "fail",
    values: ["install", "network", "toolarge", "catalog", "sources"],
    description:
      "Comma-separated. Installs fail at the hash check, mid-download or before it; the catalogue or the source list fails to load.",
  },
  { name: "file", values: ["unverified", "known", "notamod", "revoked", "wrongplatform"], description: "What From file picks." },
  {
    name: "crash",
    values: ["wrongVersion", "loadFailed", "notAMod", "wrongName", "missingDep", "initPanicked", "exit"],
    description: "Play starts the game and it stops with this failure; `exit` is a crash that names no mod.",
  },
  { name: "long", values: ["1"], description: "Adds very long names, ids and repos." },
  { name: "slow", values: ["1"], description: "Everything takes four times as long." },
];
