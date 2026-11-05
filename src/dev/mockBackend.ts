// A stand-in for the Rust side, so the UI runs in a plain browser: `npm run dev:mock`.
//
// Pick a state with `?scenario=<name>` and adjust it with URL flags, e.g.
// `?scenario=mods&index=cached&revoked=cogwork&slow=1`. SCENARIOS and FLAGS in ./scenarios are the
// one list of both; the README and the tests read them from there.
//
// The rules are src-tauri/src/mods' own, ported in ./mockRules and tested against the Rust table
// tests' cases; crashes are read out of engine log lines with ./diagnose, like the backend does.
// This file holds the state (catalogue, locks, what is running) and answers the commands.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { EVENTS } from "../mods/ipc";
import type { CommandSignatures } from "../mods/bindings/commands";
import { parseRepo, sameRepo } from "../mods/select";
import { SCENARIOS } from "./scenarios";
import { CRASH_LOGS } from "./crashes";
import { findFailure } from "./diagnose";
import * as R from "./mockRules";
import type { Entry, Fit, PlayerFile } from "./mockRules";
import type {
  AppErrorPayload,
  Catalog,
  CatalogMod,
  CatalogVersion,
  ChangeResult,
  CopyResult,
  ErrorCode,
  FailureKind,
  FileInspection,
  ModProgress,
  NoModsReason,
  ProgressStage,
} from "../mods/types";

export { SCENARIOS, FLAGS } from "./scenarios";

const params = new URLSearchParams(location.search);
const scenarioName = params.get("scenario") ?? "mods";
const scenario = SCENARIOS.find((s) => s.name === scenarioName) ?? SCENARIOS[0];
const flag = (name: string): string | null => params.get(name) ?? scenario.flags[name] ?? null;
const failures = new Set((flag("fail") ?? "").split(",").filter(Boolean));
const SLOW = flag("slow") === "1" ? 4 : 1;
const LONG = flag("long") === "1";
const NOW = "2026-11-04T18:00:00Z";

// ---------------------------------------------------------------------------------------------
// Catalogue

const NEW = "v26.11.1";
const OLD = "v26.10.4";
const ABI: Record<string, string> = { [NEW]: "f470b1cbb1f9ad91", [OLD]: "5f0569a6bea71b81" };
const PLATFORM = "linux-x64";
const LANTERN_REPO = LONG ? "an-unusually-long-organisation-name/an-even-longer-repository-of-lanterns" : "lantern-dev/lanterns";

// Stable fake SHA-256s: FNV-1a over the whole seed, once per 8 hex digits.
const sha = (seed: string) => {
  let out = "";
  for (let round = 0; out.length < 64; round++) {
    let h = 2166136261 ^ round;
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
};

function version(id: string, v: string, weftTag: string, extra: Partial<CatalogVersion> = {}): CatalogVersion {
  const repo = extra.sourceRepo ?? "Zorro909/weft-mods";
  return {
    version: v,
    channel: "release",
    tag: `${id}-v${v}`,
    published: "2026-11-04T02:39:03Z",
    sourceRepo: repo,
    sourceCommit: "cceea7805df5902d62017d2008d1bb29ed84e152",
    weftTag,
    abi: ABI[weftTag],
    deps: ["base"],
    platforms: ["windows-x64", "linux-x64", "macos-arm64"],
    sha256: sha(`${id}${v}${weftTag}`),
    size: 2_642_469,
    url: `https://github.com/${repo}/releases/download/${id}-v${v}/${id}.zip`,
    provenance: {
      repo,
      workflow: ".github/workflows/release.yml",
      gitRef: "refs/heads/main",
      verifiedAt: "2026-11-04T18:00:00Z",
    },
    provenanceVerified: true,
    reviewed: { by: "Zorro909", at: "2026-11-04" },
    trust: "reviewed",
    ...extra,
  };
}

/** A build from an added repo: nobody reviewed it, and its provenance, if any, is its own claim. */
const fromSource = (commit: string, claimsProvenance: boolean, extra: Partial<CatalogVersion> = {}): Partial<CatalogVersion> => ({
  trust: "unreviewed",
  reviewed: null,
  provenanceVerified: false,
  sourceRepo: LANTERN_REPO,
  sourceCommit: commit,
  provenance: claimsProvenance
    ? { repo: LANTERN_REPO, workflow: ".github/workflows/build.yml", gitRef: "refs/tags/glowmoss-v0.3.0", verifiedAt: null }
    : null,
  ...extra,
});

const indexMod = (id: string, name: string, summary: string, versions: CatalogVersion[], icon: string | null = null): CatalogMod => ({
  key: `index:${id}`,
  id,
  name,
  summary,
  authors: ["Zorro909"],
  license: "MPL-2.0",
  homepage: null,
  icon,
  origin: { kind: "index" },
  versions,
});

const sourceMod = (id: string, name: string, summary: string, versions: CatalogVersion[]): CatalogMod => ({
  key: `source:${LANTERN_REPO}:${id}`,
  id,
  name,
  summary,
  authors: ["lantern-dev"],
  license: "MIT",
  homepage: null,
  icon: null,
  origin: { kind: "source", repo: LANTERN_REPO },
  versions,
});

const LONG_ID = "extraordinarily-verbose-decorative-lighting-and-atmosphere-overhaul";
const revokedId = flag("revoked");

const allMods: CatalogMod[] = [
  {
    ...indexMod(
      "cogwork",
      "Cogwork",
      "Gears, item tubes and engines, an excavator, an assembly bench and a leveler.",
      [
        // The fix a revocation's reason points to.
        ...(revokedId === "cogwork" ? [version("cogwork", "0.2.1", NEW)] : []),
        version("cogwork", "0.2.1-rc.1", NEW, { channel: "prerelease" }),
        version("cogwork", "0.2.0", NEW),
        version("cogwork", "0.1.2", OLD),
      ],
      "mock://cogwork"
    ),
    homepage: "https://github.com/Zorro909/weft-mods/tree/main/cogwork",
  },
  indexMod(
    "structures",
    "Structures",
    "Overworld buildings and hamlets, a wand, and /structure.",
    [version("structures", "0.1.3", NEW), version("structures", "0.1.2", NEW), version("structures", "0.1.1", OLD)],
    "mock://structures"
  ),
  indexMod("showcase", "Showcase", "Developer tool: plays and records films that mods define in code.", [
    version("showcase", "0.1.1-rc.2", NEW, { channel: "prerelease", deps: [] }),
  ]),
  indexMod("hearth", "Hearth", "Stoves, chimneys and a kettle. Runs on Cogwork's engines.", [
    version("hearth", "0.4.0", NEW, { deps: ["base", "cogwork"] }),
    version("hearth", "0.3.2", OLD, { deps: ["base", "cogwork"] }),
  ]),
  indexMod("railways", "Railways", "Tracks, switches and minecarts that follow signals.", [
    version("railways", "0.2.0", NEW, { deps: ["base", "signals"] }),
  ]),
  indexMod("signals", "Signals", "Block signals and pressure plates for Railways.", [version("signals", "0.1.0", OLD)]),
  sourceMod("lanterns", "Lanterns", "Hanging lanterns in eight colours that sway in the wind and light up caves.", [
    // Glowmoss lights them; only the same source has it, as the backend's resolver allows.
    version("lanterns", "1.1.0", NEW, fromSource("2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e", false, { deps: ["base", "glowmoss"] })),
    version("lanterns", "1.0.0", OLD, fromSource("9a1b2c3d4e5f60718293a4b5c6d7e8f901234567", false)),
  ]),
  sourceMod("glowmoss", "Glowmoss", "A soft blue moss that spreads on damp stone and glows at night.", [
    version("glowmoss", "0.3.0", NEW, fromSource("1f2e3d4c5b6a79881726354a5b6c7d8e9f012345", true)),
  ]),
];
// `chain=1`: mods that need mods that need others (contract R4 §1).
if (flag("chain") === "1") {
  allMods.push(
    indexMod("chimneys", "Chimneys", "Tall brick chimneys for Hearth's stoves.", [version("chimneys", "0.1.0", NEW, { deps: ["base", "hearth"] })]),
    indexMod("junctions", "Junctions", "Switches and crossings for Railways.", [version("junctions", "0.1.0", NEW, { deps: ["base", "railways"] })])
  );
}
if (LONG) {
  allMods.push(
    indexMod(
      LONG_ID,
      "Extraordinarily Verbose Decorative Lighting and Atmosphere Overhaul",
      "A mod whose name, id and summary are far longer than any sensible mod would use, to see what the layout does with them when the window is at its smallest.",
      [version(LONG_ID, "12.34.56-experimental.4563878.917596d", NEW, { channel: "experimental" }), version(LONG_ID, "12.34.55", NEW)]
    )
  );
}

const indexFlag = flag("index") ?? "fresh";
const sourceFlag = flag("source") ?? "ok";
const INDEX_DATE = indexFlag === "fresh" ? "2026-11-04T18:00:00Z" : "2026-11-02T12:00:00Z";
const err = (code: ErrorCode, detail: string | null = null): AppErrorPayload => ({ code, detail });

const catalog: Catalog = {
  mods: allMods.filter((m) => !(indexFlag === "unavailable" && m.origin.kind === "index")),
  revoked: [],
  index:
    indexFlag === "stale"
      ? { freshness: "stale", generated: "2026-09-21T12:00:00Z", signedAt: "2026-09-21T12:00:00Z", error: null }
      : indexFlag === "cached"
        ? { freshness: "cached", generated: INDEX_DATE, signedAt: INDEX_DATE, error: err("Network", "offline") }
        : indexFlag === "unavailable"
          ? { freshness: "unavailable", generated: null, signedAt: null, error: err("Network", "offline") }
          : indexFlag === "invalid"
            ? { freshness: "cached", generated: INDEX_DATE, signedAt: INDEX_DATE, error: err("IndexSignatureInvalid", "signature by an unknown key") }
            : indexFlag === "rollback"
              ? { freshness: "cached", generated: INDEX_DATE, signedAt: INDEX_DATE, error: err("IndexRollback") }
              : { freshness: "fresh", generated: INDEX_DATE, signedAt: INDEX_DATE, error: null },
  sources: [
    {
      repo: LANTERN_REPO,
      mods: 2,
      freshness: sourceFlag === "ok" ? "fresh" : sourceFlag === "notfound" ? "unavailable" : "cached",
      checked: sourceFlag === "notfound" ? null : sourceFlag === "ok" ? "2026-11-04T18:05:00Z" : "2026-11-03T09:30:00Z",
      error:
        sourceFlag === "notfound"
          ? err("ModSourceNotFound", LANTERN_REPO)
          : sourceFlag === "ratelimited"
            ? err("ModSourceRateLimited", LANTERN_REPO)
            : sourceFlag === "offline"
              ? err("Network", "offline")
              : null,
      noMods: null,
    },
  ],
  weft: [
    { tag: NEW, commit: "ff9c7128511fc0dce7719b67c9a59274d70bdd5a", abi: ABI[NEW] },
    { tag: OLD, commit: "34fa22b0000000000000000000000000000000000", abi: ABI[OLD] },
  ],
  platform: PLATFORM,
  sourcesError: null,
};
if (sourceFlag === "notfound") {
  catalog.mods = catalog.mods.filter((m) => m.origin.kind !== "source");
  catalog.sources[0].mods = 0;
}

// ---------------------------------------------------------------------------------------------
// Mod sets

const modById = (id: string) => allMods.find((m) => m.id === id)!;
const pick = (id: string, v: string, enabled = true): Entry => {
  const m = modById(id);
  return R.entryFrom(m, m.versions.find((x) => x.version === v)!, enabled, "2026-11-04T12:00:00Z");
};

const fileEntry: Entry = {
  id: "mytweak",
  name: "My Tweak",
  summary: "",
  version: null,
  channel: null,
  sha256: sha("mytweak"),
  size: 1_153_433,
  enabled: true,
  trust: "unverified",
  origin: { kind: "file", name: "mytweak.zip" },
  abi: null,
  weftTag: null,
  deps: [],
  tag: null,
  sourceRepo: null,
  sourceCommit: null,
  icon: null,
  installedAt: "2026-11-04T12:00:00Z",
  revoked: null,
};

/** Which mods each scenario starts with. */
const SETS: Record<string, "full" | "quiet" | "donor" | "needs" | "late" | "chain" | "none"> = {
  mods: "full",
  revoked: "full",
  ratelimited: "full",
  offline: "full",
  indexdown: "full",
  stale: "full",
  long: "full",
  crash: "quiet",
  knownfile: "quiet",
  empty: "donor",
  missingdep: "needs",
  lateblock: "late",
  shadowed: "late",
  chain: "chain",
  fresh: "none",
};

const locks: Record<string, Entry[]> = { [NEW]: [], [OLD]: [] };
const set = SETS[scenario.name] ?? "full";
if (set === "full") {
  locks[NEW] = [pick("cogwork", "0.2.0"), pick("structures", "0.1.2"), pick("showcase", "0.1.1-rc.2", false), pick("lanterns", "1.0.0"), { ...fileEntry }];
  locks[OLD] = [pick("cogwork", "0.1.2"), pick("structures", "0.1.1")];
} else if (set === "quiet") {
  // A missing-dependency crash needs something the launcher couldn't see: Cogwork is off.
  locks[NEW] = [pick("cogwork", "0.2.0", flag("crash") !== "missingDep"), pick("structures", "0.1.2"), { ...fileEntry }];
} else if (set === "donor") {
  locks[OLD] = [
    pick("cogwork", "0.1.2"),
    pick("structures", "0.1.1"),
    pick("lanterns", "1.0.0"),
    pick("signals", "0.1.0"),
    pick("hearth", "0.3.2"),
    { ...fileEntry },
  ];
} else if (set === "needs") {
  locks[NEW] = [pick("cogwork", "0.2.0", false), pick("hearth", "0.4.0"), pick("lanterns", "1.1.0"), pick("railways", "0.2.0"), pick("structures", "0.1.3")];
  locks[OLD] = [pick("cogwork", "0.1.2")];
} else if (set === "late") {
  locks[NEW] = [pick("cogwork", "0.2.0"), pick("hearth", "0.4.0"), pick("structures", "0.1.3")];
} else if (set === "chain") {
  // Hearth needs Cogwork, both off; Railways needs Signals, which has no build for this version.
  locks[NEW] = [pick("cogwork", "0.2.0", false), pick("hearth", "0.4.0", false), pick("railways", "0.2.0", false), pick("structures", "0.1.3")];
}
if (LONG) locks[NEW].push(pick(LONG_ID, "12.34.55"));
for (const l of Object.values(locks)) l.sort((a, b) => (a.id < b.id ? -1 : 1));
/** The player's own mods folder. `shadow=<id>` puts a copy of that managed mod there (contract R4 §4). */
const playerFolder: PlayerFile[] = set === "full" ? [{ file: "oldtweak.zip", id: "oldtweak" }] : [];
const shadowId = flag("shadow");
if (shadowId) playerFolder.push({ file: `${shadowId}-old.zip`, id: shadowId });

const REASON = "Corrupts worlds that use its tubes. Get 0.2.1 or later.";
/**
 * Revokes the installed builds of `id`. The entries go through the index's own reading of
 * `revoked[]` (contract R4 §6); with `revocations=messy` they come uppercased, without a reason or
 * time, next to one that isn't a hash at all, and still revoke.
 */
function revoke(id: string) {
  const shas = new Set(Object.values(locks).flatMap((l) => l.filter((e) => e.id === id).map((e) => e.sha256)));
  const messy = flag("revocations") === "messy";
  const raw: R.RawRevocation[] = [...shas].map((s) =>
    messy ? { sha256: s.toUpperCase(), reason: null, at: null } : { sha256: s, reason: REASON, at: "2026-11-03T00:00:00Z" }
  );
  if (messy) raw.push({ sha256: "not-a-hash", reason: "a typo in the index", at: null });
  const { kept, dropped } = R.readRevocations(raw);
  if (dropped.length) console.warn("mock backend: dropped revocations that aren't SHA-256s", dropped);
  catalog.revoked.push(...kept.map(({ sha256, reason }) => ({ sha256, reason })));
  // The backend turns a revoked mod off and remembers why in the lock.
  Object.values(locks).forEach((l) => R.applyRevocations(l, catalog, NOW));
}
if (revokedId) revoke(revokedId);
// Without an index there is no revocation list; the lock still remembers.
if (indexFlag === "unavailable") catalog.revoked = [];

const versions = set === "none" ? [] : [NEW, OLD];
const running = new Set<string>();
/** The last removal per version, which `restore_mod` can undo until the next change. */
const removed: Record<string, Entry | undefined> = {};

// ---------------------------------------------------------------------------------------------
// The commands' work

const ABI_ERROR = flag("abi") === "error";
const abiOf = (tag: string): string | null => (ABI_ERROR ? null : (ABI[tag] ?? null));
const fitOf = (tag: string): Fit | null => {
  const abi = abiOf(tag);
  return abi === null ? null : { abi, platform: PLATFORM };
};

const fail = (code: ErrorCode, detail: string | null = null): never => {
  throw { code, detail } satisfies AppErrorPayload;
};

function lockOf(tag: string): Entry[] {
  return locks[tag] ?? fail("NotInstalled", tag);
}

const report = (tag: string) => R.report(tag, lockOf(tag), abiOf(tag), ABI_ERROR ? err("AbiUnavailable", tag) : null, catalog, playerFolder);

function findBuild(sha256: string) {
  return R.findBuild(catalog, sha256) ?? fail("ModNotInCatalog", sha256);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * SLOW));

// ---------------------------------------------------------------------------------------------
// Operations (contract R4 §3): each has the client's id; its progress says which file of how many,
// and `cancel_mod_operation` aborts its downloads, leaving nothing behind.

const operations = new Map<string, { cancelled: boolean }>();

/** Runs `work` as operation `id`; a cancel makes it fail with `ModCancelled` at its next step. */
async function operation<T>(id: string, work: (op: Op) => Promise<T>): Promise<T> {
  const state = { cancelled: false };
  operations.set(id, state);
  try {
    return await work({
      id,
      check: () => {
        if (state.cancelled) fail("ModCancelled", id);
      },
    });
  } finally {
    operations.delete(id);
  }
}

interface Op {
  id: string;
  /** Throws `ModCancelled` once the operation has been cancelled. */
  check: () => void;
}

const progress = (op: Op, file: { sha256: string; id: string; index: number; count: number }, stage: ProgressStage, percent: number) =>
  emit(EVENTS.modProgress, {
    operationId: op.id,
    sha256: file.sha256,
    modId: file.id,
    stage,
    percent,
    index: file.index,
    count: file.count,
  } satisfies ModProgress);

/** Download and check one file, with the backend's stages and failures. */
async function fetchBuild(op: Op, file: { sha256: string; id: string; index: number; count: number }, isDep: boolean) {
  if (failures.has("toolarge")) fail("ModTooLarge", `${file.id}.zip is over 64 MB`);
  for (let p = 0; p <= 100; p += 10) {
    op.check();
    await progress(op, file, "downloading", p);
    if (p === 40 && failures.has("network")) fail("Network", "connection reset by peer");
    if (p === 60 && isDep && failures.has("dep")) fail("ModDownloadNotFound", `${file.id}.zip`);
    await sleep(140);
  }
  op.check();
  await progress(op, file, "verifying", 100);
  await sleep(450);
  if (failures.has("install")) fail("Sha256Mismatch", `expected ${file.sha256.slice(0, 12)}…, got 0b5e1c9d2a77…`);
}

/** Every change but a restore forgets the last removal: its file may go at the next clean-up. */
function changed(tag: string) {
  removed[tag] = undefined;
}

function result(tag: string, parts: Partial<Omit<ChangeResult, "report">> = {}): ChangeResult {
  return { report: report(tag), installed: [], alsoEnabled: [], alsoDisabled: [], missing: [], installedOff: [], undo: null, ...parts };
}

/**
 * `fail=meanwhile`: the first install, copy or file install finds that a newer Glowmoss was
 * published after the dialog planned it, so any plan with Glowmoss in it has changed.
 */
let meanwhileDone = false;
function somethingChangesMeanwhile() {
  if (!failures.has("meanwhile") || meanwhileDone) return;
  meanwhileDone = true;
  const glowmoss = catalog.mods.find((m) => m.id === "glowmoss");
  glowmoss?.versions.unshift(version("glowmoss", "0.3.1", NEW, fromSource("2f3e4d5c6b7a89901827364a5b6c7d8e9f012346", true)));
}

/**
 * `service::run_install`: re-plan, refuse a plan that isn't the one the player saw (contract R4
 * §2), download what is needed, check the plan again under the lock, then write the set.
 */
async function runInstall(
  op: Op,
  tag: string,
  wanted: { mod: CatalogMod; v: CatalogVersion }[],
  token: () => string,
  expected: string,
  skipFetch: string[] = []
): Promise<ChangeResult> {
  const fit = fitOf(tag) ?? fail("AbiUnavailable", tag);
  if (token() !== expected) fail("ModChangedMeanwhile", tag);
  const res = R.resolve(catalog, lockOf(tag), wanted, fit);
  // In the backend's order (`plan::resolve`): what was asked for first, then what it needs.
  const files = res.picks.map((p, i) => ({ sha256: p.v.sha256, id: p.mod.id, index: i + 1, count: res.picks.length }));
  for (const [i, p] of res.picks.entries()) {
    if (!skipFetch.includes(p.v.sha256)) await fetchBuild(op, files[i], !res.wanted.includes(p.mod.id));
  }
  op.check();
  // `installing` comes before the set is rewritten; past this, a cancel is too late.
  for (const f of files) await progress(op, f, "installing", 100);
  await sleep(350);
  if (!locks[tag] || token() !== expected) fail("ModChangedMeanwhile", tag);
  if (running.has(tag)) fail("GameRunning", tag);
  for (const p of res.picks) if (R.revocation(catalog, p.v.sha256)) fail("ModChangedMeanwhile", p.mod.name);
  const lock = lockOf(tag);
  const done = R.commit(lock, res, new Date().toISOString());
  changed(tag);
  return result(tag, { installed: done.installed, alsoEnabled: done.alsoEnabled, installedOff: done.installedOff, missing: res.missing });
}

const planOf = (tag: string, sha256: string) => R.planInstall(catalog, lockOf(tag), tag, sha256, fitOf(tag), running.has(tag));

async function installMod(tag: string, sha256: string, planToken: string, operationId: string): Promise<ChangeResult> {
  somethingChangesMeanwhile();
  const plan = planOf(tag, sha256);
  if (plan.problem) throw plan.problem;
  return operation(operationId, (op) => runInstall(op, tag, [findBuild(sha256)], () => planOf(tag, sha256).planToken, planToken));
}

function previewCopy(from: string, to: string) {
  const fit = fitOf(to) ?? fail("AbiUnavailable", to);
  return R.copyPreview(catalog, [from, lockOf(from)], [to, lockOf(to)], fit);
}

async function copyProfile(from: string, to: string, planToken: string, operationId: string): Promise<CopyResult> {
  if (running.has(to)) fail("GameRunning", to);
  somethingChangesMeanwhile();
  const { preview, picks } = previewCopy(from, to);
  if (preview.planToken !== planToken) fail("ModChangedMeanwhile", to);
  const leftBehind = preview.items.filter((i) => i.outcome === "noBuild" || i.outcome === "localFile" || i.outcome === "revoked");
  const change = picks.length
    ? await operation(operationId, (op) => runInstall(op, to, picks, () => previewCopy(from, to).preview.planToken, planToken))
    : result(to);
  return { ...change, leftBehind };
}

function setEnabled(tag: string, id: string, enabled: boolean): ChangeResult {
  if (running.has(tag)) fail("GameRunning", tag);
  const out = R.setEnabled(lockOf(tag), catalog, id, enabled);
  changed(tag);
  return result(tag, out);
}

function removeMod(tag: string, id: string): ChangeResult {
  if (running.has(tag)) fail("GameRunning", tag);
  const out = R.remove(lockOf(tag), id);
  changed(tag);
  removed[tag] = out.removed;
  return result(tag, { alsoDisabled: out.alsoDisabled, undo: id });
}

/**
 * Contract R3 §6: the entry back exactly as it was, while its file is still in the store. Runs as
 * the page's operation, like `service::restore`: the stored file is checked (`verifying`), then
 * written (`installing`), and a cancel before that leaves it removed.
 */
async function restoreMod(tag: string, id: string, operationId: string): Promise<ChangeResult> {
  if (running.has(tag)) fail("GameRunning", tag);
  const entry = removed[tag];
  if (!entry || entry.id !== id) fail("ModNotInstalled", id);
  return operation(operationId, async (op) => {
    const file = { sha256: entry!.sha256, id, index: 1, count: 1 };
    await progress(op, file, "verifying", 0);
    await sleep(150);
    op.check();
    await progress(op, file, "installing", 100);
    R.put(lockOf(tag), { ...entry! });
    removed[tag] = undefined;
    return result(tag);
  });
}

// ---------------------------------------------------------------------------------------------
// Local files

/** The `known` file is Cogwork 0.2.0: same id, hash and libraries as the catalogue build. */
const knownBuild = () => findBuild(modById("cogwork").versions.find((v) => v.version === "0.2.0")!.sha256);

/** What a file asks the player to agree to: its own hash and tier, or a catalogued build's plan. */
function fileToken(tag: string, info: Omit<FileInspection, "planToken">): string {
  if (info.catalogMatch) return planOf(tag, info.catalogMatch.build.sha256).planToken;
  return R.planToken({ builds: [{ sha256: info.sha256, trust: "unverified" }], on: info.archive ? [info.archive.id] : [], turnsOn: true, installedOff: [], abi: abiOf(tag) });
}

function inspect(tag: string): FileInspection {
  const info = inspectBare(tag);
  return { ...info, planToken: fileToken(tag, info) };
}

function inspectBare(tag: string): Omit<FileInspection, "planToken"> {
  const kind = flag("file") ?? "unverified";
  const lock = lockOf(tag);
  if (kind === "known") {
    const { mod, v } = knownBuild();
    const abi = abiOf(tag);
    return {
      fileName: "cogwork.zip",
      size: v.size,
      sha256: v.sha256,
      archive: { id: "cogwork", libraries: ["libcogwork.so", "cogwork.dll", "libcogwork.dylib"], platforms: v.platforms, hasAssets: true, entries: 31 },
      problem: null,
      name: mod.name,
      summary: mod.summary,
      fitsSystem: true,
      // Contract R4 §5: unknown when the version's interface is.
      catalogMatch: { key: mod.key, name: mod.name, fitsVersion: abi === null ? null : v.abi === abi, build: v },
      revoked: R.revocation(catalog, v.sha256) !== null,
      revokedReason: R.revocation(catalog, v.sha256)?.reason ?? null,
      replaces: lock.find((e) => e.id === "cogwork")?.name ?? null,
    };
  }
  const base: Omit<FileInspection, "planToken"> = {
    fileName: "mytweak.zip",
    size: 1_153_433,
    sha256: sha("mytweak"),
    archive: { id: "mytweak", libraries: ["libmytweak.so", "mytweak.dll"], platforms: ["linux-x64", "windows-x64"], hasAssets: true, entries: 14 },
    problem: null,
    name: "My Tweak",
    summary: "Makes torches brighter.",
    fitsSystem: true,
    catalogMatch: null,
    revoked: false,
    revokedReason: null,
    replaces: lock.find((e) => e.id === "mytweak")?.name ?? null,
  };
  if (kind === "notamod") {
    return {
      ...base,
      fileName: "screenshots.zip",
      archive: null,
      name: null,
      summary: null,
      fitsSystem: false,
      problem: err("ModArchiveInvalid", "no mod library at the top of the zip"),
      replaces: null,
    };
  }
  if (kind === "wrongplatform") {
    return { ...base, fitsSystem: false, archive: { ...base.archive!, libraries: ["mytweak.dll"], platforms: ["windows-x64"] } };
  }
  if (kind === "revoked") return { ...base, revoked: true, revokedReason: "Steals saved logins. Removed on 2026-11-03." };
  return base;
}

/** `file=revokedlate`: the index revokes the file's hash while it is being copied in. */
const REVOKED_LATE = "Steals saved logins. Revoked while you were installing it.";

async function installFile(tag: string, sha256: string, planToken: string, operationId: string): Promise<ChangeResult> {
  somethingChangesMeanwhile();
  const info = inspect(tag);
  if (info.sha256 !== sha256) fail("ModFileChanged");
  if (!info.archive) throw info.problem;
  if (info.revoked) fail("ModRevoked", info.revokedReason ?? "no reason given");
  if (running.has(tag)) fail("GameRunning", tag);
  if (info.planToken !== planToken) fail("ModChangedMeanwhile", tag);
  return operation(operationId, async (op) => {
    const self = { sha256, id: info.archive!.id, index: 1, count: 1 };
    await progress(op, self, "verifying", 100);
    await sleep(300);
    op.check();
    // A catalogued file installs from these bytes, recorded with the catalogue's metadata and
    // tier, and brings what it needs like any install.
    if (info.catalogMatch) {
      return runInstall(op, tag, [knownBuild()], () => inspect(tag).planToken, planToken, [sha256]);
    }
    if (flag("file") === "revokedlate") catalog.revoked.push({ sha256, reason: REVOKED_LATE });
    await progress(op, self, "installing", 100);
    await sleep(300);
    // Contract R4 §2: revocation is checked again at commit, for an unknown file by its hash.
    const late = R.revocation(catalog, sha256);
    if (late) fail("ModRevoked", late.reason ?? "no reason given");
    const lock = lockOf(tag);
    const existing = lock.find((e) => e.id === fileEntry.id);
    R.put(lock, { ...fileEntry, enabled: existing?.enabled ?? true, installedAt: new Date().toISOString() });
    changed(tag);
    return result(tag, { installed: [fileEntry.id] });
  });
}

// ---------------------------------------------------------------------------------------------
// Launch and crashes

async function launch(tag: string) {
  if (running.size) fail("AnotherGameRunning", [...running][0]);
  // `prepare_launch` applies what the catalogue says before anything starts.
  if (flag("prelaunch") === "revoke" && !catalog.revoked.length) revoke("cogwork");
  const r = report(tag);
  if (r.blocking.length) {
    fail("ModsBlocked", r.blocking.map((id) => r.mods.find((m) => m.id === id)?.name ?? id).join(", "));
  }
  running.add(tag);
  await emit(EVENTS.gameState, { tag, state: "running", exitCode: null, crashed: false, modFailure: null });
  const kind = flag("crash");
  setTimeout(
    () => {
      running.delete(tag);
      const log = kind && kind in CRASH_LOGS ? CRASH_LOGS[kind as FailureKind] : "";
      emit(EVENTS.gameState, {
        tag,
        state: "stopped",
        exitCode: kind ? 1 : 0,
        crashed: !!kind,
        modFailure: findFailure(log),
      });
    },
    (kind ? 1500 : 4000) * SLOW
  );
}

// ---------------------------------------------------------------------------------------------
// Icons

function iconUrl(id: string): string {
  const art: Record<string, string[]> = {
    cogwork: ["...##...", ".#.##.#.", "########", ".##..##.", ".##..##.", "########", ".#.##.#.", "...##..."],
    structures: ["...##...", "..####..", ".######.", "########", ".##..##.", ".##..##.", ".##..##.", ".######."],
  };
  const rows = art[id] ?? fail("ModNotInCatalog", id);
  const c = document.createElement("canvas");
  c.width = c.height = 8;
  const g = c.getContext("2d")!;
  g.fillStyle = id === "cogwork" ? "#e09632" : "#8c97ad";
  rows.forEach((row, y) => [...row].forEach((ch, x) => ch === "#" && g.fillRect(x, y, 1, 1)));
  return c.toDataURL("image/png");
}

// ---------------------------------------------------------------------------------------------
// Commands

/** Repos that exist, as GitHub spells them. `add_mod_source` asks GitHub; anything else is a 404. */
const KNOWN_REPOS = [LANTERN_REPO, "Zorro909/weft-mods", "glow-team/fireflies"];
/** What GitHub has in repos added here: `glow-team/fireflies` publishes releases without mods. */
const EMPTY_REPOS: Record<string, NoModsReason> = { "glow-team/fireflies": "noModFiles" };

/** The mock's own file of sources, which `fail=sources` damages. */
const DAMAGED_SOURCES = "/home/player/.local/share/weft-launcher/mods/sources.damaged-1762300800.json";
let sourcesDamaged = failures.has("sources");
if (sourcesDamaged) {
  catalog.sources = [];
  catalog.mods = catalog.mods.filter((m) => m.origin.kind !== "source");
  catalog.sourcesError = err("ModSourcesDamaged", DAMAGED_SOURCES);
}

type Handlers = {
  [K in keyof CommandSignatures]: (args: CommandSignatures[K]["args"]) => Promise<CommandSignatures[K]["result"]> | CommandSignatures[K]["result"];
};

/**
 * Every backend command, typed by the generated `CommandSignatures`: a command added, renamed or
 * changed in Rust fails `tsc` here until the mock follows.
 */
const handlers: Handlers = {
  list_versions: () =>
    versions.map((tag, i) => ({
      tag,
      name: tag,
      published_at: i === 0 ? "2026-11-01T12:00:00Z" : "2026-10-20T12:00:00Z",
      body: i === 0 ? "## What's new\n- A **mod manager** in the launcher\n- Faster world loading" : "",
      prerelease: false,
      asset: { name: `Weft-${tag}-linux-x64.tar.gz`, url: "", size: 48_000_000, sha256: "a".repeat(64) },
      from_cache: false,
    })),
  install_version: () => fail("AlreadyInstalled"),
  get_installed_versions: () => versions.map((tag) => ({ tag, path: `/versions/${tag}`, executable: "weft", installed_at: "2026-11-02T10:00:00Z" })),
  remove_version: async ({ tag }) => {
    await sleep(300);
    versions.splice(versions.indexOf(tag), 1);
    delete locks[tag];
  },
  launch_version: ({ tag }) => launch(tag),
  get_running_versions: () => [...running],
  open_game_folder: () => undefined,
  open_log: () => undefined,
  // Opening the folder only opens it; the player deleting a file there is `mockPlayer.deleteFile`.
  open_player_mods_folder: () => undefined,
  list_mod_catalog: async ({ forceRefresh }) => {
    await sleep(forceRefresh ? 400 : 0);
    if (failures.has("catalog")) fail("Network", "the catalogue request timed out");
    return structuredClone(catalog);
  },
  get_mod_sources: async () => {
    await sleep(150);
    if (sourcesDamaged) fail("ModSourcesDamaged", DAMAGED_SOURCES);
    return catalog.sources.map((s) => s.repo);
  },
  add_mod_source: async ({ repo: input }) => {
    await sleep(500);
    const repo = parseRepo(input) ?? fail("ModSourceInvalid", input);
    if (sourceFlag === "ratelimited") fail("ModSourceRateLimited", repo);
    const canonical = KNOWN_REPOS.find((k) => sameRepo(k, repo)) ?? fail("ModSourceNotFound", repo);
    // A damaged list stays where it was set aside; this starts a new one.
    if (sourcesDamaged) {
      sourcesDamaged = false;
      catalog.sourcesError = null;
    }
    if (!catalog.sources.some((s) => sameRepo(s.repo, canonical))) {
      catalog.sources.push({ repo: canonical, mods: 0, freshness: "unavailable", checked: null, error: null, noMods: null });
      addedSources.add(canonical);
    }
    return catalog.sources.map((s) => s.repo);
  },
  remove_mod_source: async ({ repo }) => {
    await sleep(400);
    if (sourcesDamaged) fail("ModSourcesDamaged", DAMAGED_SOURCES);
    // Mods installed from it stay installed; they just stop getting updates.
    catalog.sources = catalog.sources.filter((s) => !sameRepo(s.repo, repo));
    catalog.mods = catalog.mods.filter((m) => m.origin.kind !== "source" || !sameRepo(m.origin.repo, repo));
    return catalog.sources.map((s) => s.repo);
  },
  get_mod_profile: ({ tag }) => report(tag),
  get_mod_icon: ({ url }) => iconUrl(url.replace("mock://", "")),
  plan_mod_install: async ({ tag, sha256 }) => {
    await sleep(120);
    return R.planInstall(catalog, lockOf(tag), tag, sha256, fitOf(tag), running.has(tag));
  },
  install_mod: ({ tag, sha256, planToken, operationId }) => installMod(tag, sha256, planToken, operationId),
  inspect_mod_file: async ({ tag }) => {
    await sleep(300);
    return inspect(tag);
  },
  install_mod_file: ({ tag, sha256, planToken, operationId }) => installFile(tag, sha256, planToken, operationId),
  set_mod_enabled: async ({ tag, id, enabled }) => {
    await sleep(150);
    return setEnabled(tag, id, enabled);
  },
  remove_mod: async ({ tag, id }) => {
    await sleep(150);
    return removeMod(tag, id);
  },
  restore_mod: ({ tag, id, operationId }) => restoreMod(tag, id, operationId),
  preview_copy_mod_profile: async ({ from, to }) => {
    await sleep(200);
    return previewCopy(from, to).preview;
  },
  copy_mod_profile: ({ from, to, planToken, operationId }) => copyProfile(from, to, planToken, operationId),
  cancel_mod_operation: ({ operationId }) => {
    const op = operations.get(operationId);
    if (op) op.cancelled = true;
    return !!op;
  },
};

/** Sources added in this session: refreshing the catalogue fetches them, as GitHub would answer. */
const addedSources = new Set<string>();
function refreshAddedSources() {
  for (const s of catalog.sources) {
    if (!addedSources.has(s.repo)) continue;
    s.freshness = "fresh";
    s.checked = new Date().toISOString();
    s.noMods = EMPTY_REPOS[s.repo] ?? null;
  }
}

/** What the player does outside the launcher, for tests: `window.mockPlayer.deleteFile(name)`. */
const mockPlayer = {
  /** Deletes a file from the player's own mods folder, as they would after Show folder. */
  deleteFile(file: string) {
    const at = playerFolder.findIndex((f) => f.file === file);
    if (at >= 0) playerFolder.splice(at, 1);
  },
};

/** The plugin commands the page calls, which aren't the backend's own. */
const plugins: Record<string, () => unknown> = {
  "plugin:app|version": () => "1.2.0",
  "plugin:updater|check": () => null,
  "plugin:dialog|open": () => (flag("file") === "known" ? "/home/player/Downloads/cogwork.zip" : "/home/player/Downloads/mytweak.zip"),
  "plugin:opener|open_url": () => null,
  "plugin:opener|open_path": () => null,
};

export function installMockBackend() {
  mockWindows("main");
  (window as unknown as { mockPlayer: typeof mockPlayer }).mockPlayer = mockPlayer;
  mockIPC(
    async (cmd, raw) => {
      if (cmd in plugins) return plugins[cmd]();
      if (cmd === "list_mod_catalog" && (raw as { forceRefresh?: boolean } | undefined)?.forceRefresh) refreshAddedSources();
      const handler = handlers[cmd as keyof Handlers] as ((args: unknown) => unknown) | undefined;
      // A command this mock doesn't know is a bug in the mock, never a silent null.
      if (!handler) throw new Error(`mock backend: no command ${cmd}`);
      return handler(raw ?? {});
    },
    { shouldMockEvents: true }
  );
}
