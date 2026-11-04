// A stand-in for the Rust side, so the UI runs in a plain browser: `npm run dev:mock`.
//
// Pick a state with `?scenario=<name>` and adjust it with URL flags, e.g.
// `?scenario=mods&index=cached&revoked=cogwork&slow=1`. SCENARIOS and FLAGS below are the one
// list of both; the README and the tests read them from here.
//
// The rules follow src-tauri/src/mods: fitting and version order come from src/mods/select.ts,
// dependencies are turned on and off in cascades, revoked builds are refused, an update keeps a
// mod's on/off state, and copying merges into a set that already has mods.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { COMMANDS, EVENTS } from "../mods/ipc";
import { compareVersions, fittingVersions, parseRepo, sameRepo } from "../mods/select";
import { SCENARIOS } from "./scenarios";
import type {
  AppErrorPayload,
  Catalog,
  CatalogMod,
  CatalogVersion,
  ChangeResult,
  CopyItem,
  CopyPreview,
  CopyResult,
  ErrorCode,
  FailureKind,
  FileInspection,
  InstallPlan,
  InstalledMod,
  ModFailure,
  ModStatus,
  PlanItem,
  ProfileReport,
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
const fromSource = (commit: string, claimsProvenance: boolean): Partial<CatalogVersion> => ({
  trust: "unreviewed",
  reviewed: null,
  provenanceVerified: false,
  sourceRepo: LANTERN_REPO,
  sourceCommit: commit,
  provenance: claimsProvenance
    ? { repo: LANTERN_REPO, workflow: ".github/workflows/build.yml", gitRef: "refs/tags/glowmoss-v0.3.0", verifiedAt: null }
    : null,
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

const allMods: CatalogMod[] = [
  {
    ...indexMod(
      "cogwork",
      "Cogwork",
      "Gears, item tubes and engines, an excavator, an assembly bench and a leveler.",
      [version("cogwork", "0.2.1-rc.1", NEW, { channel: "prerelease" }), version("cogwork", "0.2.0", NEW), version("cogwork", "0.1.2", OLD)],
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
    version("lanterns", "1.1.0", NEW, fromSource("2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e", false)),
    version("lanterns", "1.0.0", OLD, fromSource("9a1b2c3d4e5f60718293a4b5c6d7e8f901234567", false)),
  ]),
  sourceMod("glowmoss", "Glowmoss", "A soft blue moss that spreads on damp stone and glows at night.", [
    version("glowmoss", "0.3.0", NEW, fromSource("1f2e3d4c5b6a79881726354a5b6c7d8e9f012345", true)),
  ]),
];
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
    indexFlag === "cached"
      ? { freshness: "cached", generated: INDEX_DATE, error: err("Network", "offline") }
      : indexFlag === "unavailable"
        ? { freshness: "unavailable", generated: null, error: err("Network", "offline") }
        : indexFlag === "invalid"
          ? { freshness: "cached", generated: INDEX_DATE, error: err("IndexSignatureInvalid", "signature by an unknown key") }
          : indexFlag === "rollback"
            ? { freshness: "cached", generated: INDEX_DATE, error: err("IndexRollback") }
            : { freshness: "fresh", generated: INDEX_DATE, error: null },
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
    },
  ],
  weft: [
    { tag: NEW, commit: "ff9c7128511fc0dce7719b67c9a59274d70bdd5a", abi: ABI[NEW] },
    { tag: OLD, commit: "34fa22b0000000000000000000000000000000000", abi: ABI[OLD] },
  ],
  platform: PLATFORM,
};
if (sourceFlag === "notfound") {
  catalog.mods = catalog.mods.filter((m) => m.origin.kind !== "source");
  catalog.sources[0].mods = 0;
}

// ---------------------------------------------------------------------------------------------
// Mod sets

type Entry = Omit<InstalledMod, "status" | "missingDeps" | "revokedReason" | "update">;

function entryFrom(mod: CatalogMod, v: CatalogVersion, enabled = true): Entry {
  return {
    id: mod.id,
    name: mod.name,
    summary: mod.summary,
    version: v.version,
    channel: v.channel,
    sha256: v.sha256,
    size: v.size,
    enabled,
    trust: v.trust,
    origin: mod.origin,
    abi: v.abi,
    weftTag: v.weftTag,
    deps: v.deps,
    tag: v.tag,
    sourceRepo: v.sourceRepo,
    sourceCommit: v.sourceCommit,
    icon: mod.icon,
    installedAt: "2026-11-04T12:00:00Z",
  };
}

const modById = (id: string) => allMods.find((m) => m.id === id)!;
const pick = (id: string, v: string, enabled = true) => {
  const m = modById(id);
  return entryFrom(m, m.versions.find((x) => x.version === v)!, enabled);
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
};

/** Which mods each scenario starts with. */
const SETS: Record<string, "full" | "quiet" | "donor" | "none"> = {
  mods: "full",
  revoked: "full",
  ratelimited: "full",
  offline: "full",
  indexdown: "full",
  long: "full",
  crash: "quiet",
  knownfile: "quiet",
  empty: "donor",
  fresh: "none",
};

const locks: Record<string, Entry[]> = { [NEW]: [], [OLD]: [] };
const set = SETS[scenario.name] ?? "full";
if (set === "full") {
  locks[NEW] = [pick("cogwork", "0.2.0"), pick("structures", "0.1.2"), pick("showcase", "0.1.1-rc.2", false), pick("lanterns", "1.0.0"), { ...fileEntry }];
  locks[OLD] = [pick("cogwork", "0.1.2"), pick("structures", "0.1.1")];
} else if (set === "quiet") {
  locks[NEW] = [pick("cogwork", "0.2.0"), pick("structures", "0.1.2"), { ...fileEntry }];
} else if (set === "donor") {
  locks[OLD] = [pick("cogwork", "0.1.2"), pick("structures", "0.1.1"), pick("lanterns", "1.0.0"), pick("signals", "0.1.0"), { ...fileEntry }];
}
if (LONG) locks[NEW].push(pick(LONG_ID, "12.34.55"));
const unmanaged = set === "full" ? ["oldtweak.zip"] : [];

const revokedId = flag("revoked");
if (revokedId) {
  const shas = new Set(Object.values(locks).flatMap((l) => l.filter((e) => e.id === revokedId).map((e) => e.sha256)));
  catalog.revoked = [...shas].map((s) => ({ sha256: s, reason: "Corrupts worlds that use its tubes. Get 0.2.1 or later." }));
  // The backend turns a revoked mod off and keeps it off.
  Object.values(locks).forEach((l) => l.forEach((e) => shas.has(e.sha256) && (e.enabled = false)));
}

const versions = set === "none" ? [] : [NEW, OLD];
const running = new Set<string>();

// ---------------------------------------------------------------------------------------------
// The rules

const ABI_ERROR = flag("abi") === "error";
const abiOf = (tag: string): string | null => (ABI_ERROR ? null : (ABI[tag] ?? null));
const revocation = (s: string) => catalog.revoked.find((r) => r.sha256 === s)?.reason ?? null;

const fail = (code: ErrorCode, detail: string | null = null): never => {
  throw { code, detail } satisfies AppErrorPayload;
};

function catalogEntryFor(e: Entry): CatalogMod | undefined {
  return catalog.mods.find(
    (m) =>
      m.id === e.id &&
      (e.origin.kind === "index"
        ? m.origin.kind === "index"
        : e.origin.kind === "source" && m.origin.kind === "source" && sameRepo(m.origin.repo, e.origin.repo))
  );
}

function lockOf(tag: string): Entry[] {
  return locks[tag] ?? fail("NotInstalled", tag);
}

function report(tag: string): ProfileReport {
  const abi = abiOf(tag);
  const lock = lockOf(tag);
  const on = new Set(lock.filter((m) => m.enabled).map((m) => m.id));
  const mods: InstalledMod[] = lock.map((e) => {
    const revokedReason = revocation(e.sha256);
    const missing = e.deps.filter((d) => d !== "base" && !on.has(d));
    const status: ModStatus = revokedReason
      ? "revoked"
      : !e.enabled
        ? "off"
        : abi === null || e.abi === null
          ? "unchecked"
          : e.abi !== abi
            ? "wrongVersion"
            : missing.length
              ? "missingDeps"
              : "ready";
    const m = catalogEntryFor(e);
    const best = m ? fittingVersions(catalog, m, abi, e.channel !== null && e.channel !== "release")[0] : undefined;
    const update =
      best &&
      best.sha256 !== e.sha256 &&
      (status === "wrongVersion" || status === "revoked" || compareVersions(best.version, e.version ?? "0") > 0)
        ? { version: best.version, sha256: best.sha256, channel: best.channel, trust: best.trust }
        : null;
    return { ...e, status, missingDeps: status === "missingDeps" ? missing : [], revokedReason, update };
  });
  return {
    tag,
    versionAbi: abi,
    abiError: ABI_ERROR ? err("AbiUnavailable", tag) : null,
    mods,
    blocking: mods.filter((m) => m.status === "wrongVersion" || m.status === "missingDeps").map((m) => m.id),
    unmanaged,
  };
}

function findBuild(sha256: string): { mod: CatalogMod; v: CatalogVersion } {
  for (const mod of catalog.mods) {
    const v = mod.versions.find((x) => x.sha256 === sha256);
    if (v) return { mod, v };
  }
  return fail("ModNotInCatalog", sha256);
}

const planItem = (mod: CatalogMod, v: CatalogVersion): PlanItem => ({
  id: mod.id,
  name: mod.name,
  version: v.version,
  sha256: v.sha256,
  trust: v.trust,
  channel: v.channel,
  size: v.size,
});

function plan(tag: string, sha256: string): InstallPlan {
  const lock = lockOf(tag);
  const abi = abiOf(tag);
  const { mod, v } = findBuild(sha256);
  const existing = lock.find((e) => e.id === mod.id);
  const out: InstallPlan = {
    target: planItem(mod, v),
    replaces: existing ? { version: existing.version, sha256: existing.sha256, trust: existing.trust, enabled: existing.enabled } : null,
    install: [],
    enable: [],
    missing: [],
    problem: null,
  };
  const reason = revocation(v.sha256);
  if (running.has(tag)) out.problem = err("GameRunning", tag);
  else if (abi === null) out.problem = err("AbiUnavailable", tag);
  else if (reason) out.problem = err("ModRevoked", `${mod.name}: ${reason}`);
  else if (v.abi !== abi) out.problem = err("ModIncompatible", mod.name);
  else if (!(v.platforms as string[]).includes(catalog.platform)) out.problem = err("ModNotForPlatform", mod.name);

  const seen = new Set([mod.id]);
  const walk = (deps: string[], allowPre: boolean) => {
    for (const dep of deps) {
      if (dep === "base" || seen.has(dep)) continue;
      seen.add(dep);
      const inst = lock.find((e) => e.id === dep);
      if (inst) {
        if (inst.enabled) continue;
        const r = revocation(inst.sha256);
        if (r) out.problem ??= err("ModRevoked", `${inst.name}: ${r}`);
        else out.enable.push(dep);
        walk(inst.deps, allowPre);
        continue;
      }
      // The index first, then sources, as the backend prefers them.
      const candidates = catalog.mods.filter((m) => m.id === dep).sort((a, b) => Number(a.origin.kind !== "index") - Number(b.origin.kind !== "index"));
      const best = candidates.map((m) => ({ m, b: fittingVersions(catalog, m, abi, allowPre)[0] })).find((x) => x.b);
      if (best) {
        out.install.push(planItem(best.m, best.b));
        walk(best.b.deps, allowPre);
      } else out.missing.push(dep);
    }
  };
  walk(v.deps, v.channel !== "release");
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * SLOW));
const progress = (sha256: string, modId: string, stage: ProgressStage, percent: number) =>
  emit(EVENTS.modProgress, { sha256, modId, stage, percent });

/** Download and check one file, with the backend's stages and failures. */
async function fetchBuild(item: { sha256: string; id: string }) {
  if (failures.has("toolarge")) fail("ModTooLarge", `${item.id}.zip is over 64 MB`);
  for (let p = 0; p <= 100; p += 10) {
    await progress(item.sha256, item.id, "downloading", p);
    if (p === 40 && failures.has("network")) fail("Network", "connection reset by peer");
    await sleep(140);
  }
  await progress(item.sha256, item.id, "verifying", 100);
  await sleep(450);
  if (failures.has("install")) fail("Sha256Mismatch", `expected ${item.sha256.slice(0, 12)}…, got 0b5e1c9d2a77…`);
}

function cascadeOn(lock: Entry[], id: string, turnedOn: string[]) {
  const e = lock.find((x) => x.id === id);
  if (!e) return;
  for (const dep of e.deps) {
    const d = lock.find((x) => x.id === dep);
    if (!d || d.enabled) continue;
    const r = revocation(d.sha256);
    if (r) fail("ModRevoked", `${d.name}: ${r}`);
    d.enabled = true;
    turnedOn.push(d.id);
    cascadeOn(lock, d.id, turnedOn);
  }
}

function cascadeOff(lock: Entry[], id: string, turnedOff: string[]) {
  for (const e of lock) {
    if (e.enabled && e.deps.includes(id)) {
      e.enabled = false;
      turnedOff.push(e.id);
      cascadeOff(lock, e.id, turnedOff);
    }
  }
}

function change(tag: string, parts: Partial<Omit<ChangeResult, "report">> = {}): ChangeResult {
  return { report: report(tag), installed: [], alsoEnabled: [], alsoDisabled: [], missing: [], ...parts };
}

function put(lock: Entry[], entry: Entry) {
  const at = lock.findIndex((e) => e.id === entry.id);
  // An update keeps the mod's on/off state; a new install is on.
  if (at >= 0) lock[at] = { ...entry, enabled: lock[at].enabled };
  else lock.push(entry);
}

async function installMod(tag: string, sha256: string): Promise<ChangeResult> {
  const p = plan(tag, sha256);
  if (p.problem) throw p.problem;
  const items = [...p.install, p.target];
  for (const item of items) await fetchBuild(item);
  // `installing` comes before the set is rewritten.
  for (const item of items) await progress(item.sha256, item.id, "installing", 100);
  await sleep(350);
  const lock = lockOf(tag);
  for (const item of items) {
    const { mod, v } = findBuild(item.sha256);
    put(lock, entryFrom(mod, v));
  }
  for (const id of p.enable) lock.find((x) => x.id === id)!.enabled = true;
  return change(tag, { installed: items.map((i) => i.id), alsoEnabled: p.enable, missing: p.missing });
}

function previewCopy(from: string, to: string): CopyPreview {
  const target = lockOf(to);
  const abi = abiOf(to);
  const items: CopyItem[] = lockOf(from).map((e): CopyItem => {
    const base = { id: e.id, name: e.name, version: null, trust: null };
    if (target.some((x) => x.id === e.id)) return { ...base, outcome: "alreadyThere" };
    if (e.origin.kind === "file") return { ...base, outcome: "localFile" };
    const m = catalogEntryFor(e);
    const best = m ? fittingVersions(catalog, m, abi, e.channel !== "release")[0] : undefined;
    if (best) return { ...base, outcome: "install", version: best.version, trust: best.trust };
    const revoked = m?.versions.some((v) => v.abi === abi && revocation(v.sha256)) || !!revocation(e.sha256);
    return { ...base, outcome: revoked ? "revoked" : "noBuild" };
  });
  return { from, to, items };
}

async function copyProfile(from: string, to: string): Promise<CopyResult> {
  const preview = previewCopy(from, to);
  const source = lockOf(from);
  const target = lockOf(to);
  const abi = abiOf(to);
  const builds = preview.items
    .filter((i) => i.outcome === "install")
    .map((i) => {
      const e = source.find((x) => x.id === i.id)!;
      const m = catalogEntryFor(e)!;
      return { e, m, v: fittingVersions(catalog, m, abi, e.channel !== "release")[0] };
    });
  for (const b of builds) await fetchBuild({ sha256: b.v.sha256, id: b.m.id });
  for (const b of builds) await progress(b.v.sha256, b.m.id, "installing", 100);
  await sleep(350);
  for (const b of builds) target.push(entryFrom(b.m, b.v, b.e.enabled));
  const have = new Set(target.map((e) => e.id));
  const missing = [...new Set(builds.flatMap((b) => b.v.deps.filter((d) => d !== "base" && !have.has(d))))];
  return {
    ...change(to, { installed: builds.map((b) => b.m.id), missing }),
    leftBehind: preview.items.filter((i) => i.outcome === "noBuild" || i.outcome === "localFile" || i.outcome === "revoked"),
  };
}

// ---------------------------------------------------------------------------------------------
// Local files

/** The `known` file is Cogwork 0.2.0: same id, hash and libraries as the catalogue build. */
const knownBuild = () => findBuild(modById("cogwork").versions.find((v) => v.version === "0.2.0")!.sha256);

function inspect(tag: string): FileInspection {
  const kind = flag("file") ?? "unverified";
  const lock = lockOf(tag);
  if (kind === "known") {
    const { mod, v } = knownBuild();
    return {
      fileName: "cogwork.zip",
      size: v.size,
      sha256: v.sha256,
      archive: { id: "cogwork", libraries: ["libcogwork.so", "cogwork.dll", "libcogwork.dylib"], platforms: v.platforms, hasAssets: true, entries: 31 },
      problem: null,
      name: mod.name,
      summary: mod.summary,
      fitsSystem: true,
      catalogMatch: { key: mod.key, name: mod.name, fitsVersion: v.abi === abiOf(tag), build: v },
      revokedReason: revocation(v.sha256),
      replaces: lock.find((e) => e.id === "cogwork")?.name ?? null,
    };
  }
  const base: FileInspection = {
    fileName: "mytweak.zip",
    size: 1_153_433,
    sha256: sha("mytweak"),
    archive: { id: "mytweak", libraries: ["libmytweak.so", "mytweak.dll"], platforms: ["linux-x64", "windows-x64"], hasAssets: true, entries: 14 },
    problem: null,
    name: "My Tweak",
    summary: "Makes torches brighter.",
    fitsSystem: true,
    catalogMatch: null,
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
  if (kind === "revoked") return { ...base, revokedReason: "Steals saved logins. Removed on 2026-11-03." };
  return base;
}

async function installFile(tag: string, sha256: string): Promise<ChangeResult> {
  const info = inspect(tag);
  if (info.sha256 !== sha256) fail("ModFileChanged");
  if (!info.archive) throw info.problem;
  if (info.revokedReason) fail("ModRevoked", info.revokedReason);
  const lock = lockOf(tag);
  // A catalogued file installs from these bytes, recorded with the catalogue's metadata and tier.
  await progress(sha256, info.archive.id, "verifying", 100);
  await sleep(300);
  await progress(sha256, info.archive.id, "installing", 100);
  await sleep(300);
  if (info.catalogMatch) {
    const { mod, v } = knownBuild();
    put(lock, entryFrom(mod, v));
    return change(tag, { installed: [mod.id] });
  }
  put(lock, { ...fileEntry, installedAt: new Date().toISOString() });
  return change(tag, { installed: [fileEntry.id] });
}

// ---------------------------------------------------------------------------------------------
// Crashes

const CRASHES: Record<FailureKind, ModFailure> = {
  wrongVersion: {
    kind: "wrongVersion",
    modId: "mytweak",
    other: null,
    line: `ERROR mod mytweak was built against another mod ABI (5f0569a6bea71b81, this engine has ${ABI[NEW]})`,
  },
  missingDep: { kind: "missingDep", modId: "structures", other: "cogwork", line: "ERROR mod structures needs mod cogwork, which is not loaded" },
  loadFailed: {
    kind: "loadFailed",
    modId: "structures",
    other: null,
    line: "ERROR failed to load mod structures: libstructures.so: undefined symbol: weft_world_spawn_v3",
  },
  notAMod: { kind: "notAMod", modId: "oldtweak", other: null, line: "ERROR mods/oldtweak.zip: not a Weft mod (no weft_mod_init)" },
  wrongName: { kind: "wrongName", modId: "mytweak", other: null, line: "ERROR mod library mytweak-1.2.so must be named libmytweak.so" },
  initPanicked: {
    kind: "initPanicked",
    modId: "cogwork",
    other: null,
    line: "thread 'main' panicked at cogwork/src/tubes.rs:88:14: index out of bounds",
  },
};

async function launch(tag: string) {
  if (running.size) fail("AnotherGameRunning", [...running][0]);
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
      emit(EVENTS.gameState, {
        tag,
        state: "stopped",
        exitCode: kind ? 1 : 0,
        crashed: !!kind,
        modFailure: kind && kind in CRASHES ? CRASHES[kind as FailureKind] : null,
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

const KNOWN_REPOS = [LANTERN_REPO, "Zorro909/weft-mods"];

export function installMockBackend() {
  mockWindows("main");
  mockIPC(
    async (cmd, raw) => {
      const args = (raw ?? {}) as Record<string, any>;
      switch (cmd) {
        case "plugin:app|version":
          return "1.2.0";
        case "plugin:updater|check":
          return null;
        case "plugin:dialog|open":
          return flag("file") === "known" ? "/home/player/Downloads/cogwork.zip" : "/home/player/Downloads/mytweak.zip";
        case "plugin:opener|open_url":
        case "plugin:opener|open_path":
          return null;
        case COMMANDS.listVersions:
          return versions.map((tag, i) => ({
            tag,
            name: tag,
            published_at: i === 0 ? "2026-11-01T12:00:00Z" : "2026-10-20T12:00:00Z",
            body: i === 0 ? "## What's new\n- A **mod manager** in the launcher\n- Faster world loading" : "",
            prerelease: false,
            asset: { name: `Weft-${tag}-linux-x64.tar.gz`, url: "", size: 48_000_000, sha256: "a".repeat(64) },
            from_cache: false,
          }));
        case COMMANDS.getInstalledVersions:
          return versions.map((tag) => ({ tag, path: `/versions/${tag}`, executable: "weft", installed_at: "2026-11-02T10:00:00Z" }));
        case COMMANDS.removeVersion:
          await sleep(300);
          versions.splice(versions.indexOf(args.tag), 1);
          delete locks[args.tag];
          return null;
        case COMMANDS.getRunningVersions:
          return [...running];
        case COMMANDS.launchVersion:
          await launch(args.tag);
          return null;
        case COMMANDS.openLog:
        case COMMANDS.openGameFolder:
        case COMMANDS.openPlayerModsFolder:
          return null;
        case COMMANDS.listModCatalog:
          await sleep(args.forceRefresh ? 400 : 0);
          if (failures.has("catalog")) fail("Network", "the catalogue request timed out");
          return catalog;
        case COMMANDS.getModSources:
          await sleep(150);
          if (failures.has("sources")) fail("Io", "mod-sources.json: permission denied");
          return catalog.sources.map((s) => s.repo);
        case COMMANDS.addModSource: {
          await sleep(500);
          const repo = parseRepo(String(args.repo)) ?? fail("ModSourceInvalid", String(args.repo));
          const canonical = KNOWN_REPOS.find((k) => sameRepo(k, repo)) ?? repo;
          if (!catalog.sources.some((s) => sameRepo(s.repo, canonical))) {
            catalog.sources.push({ repo: canonical, mods: 0, freshness: "fresh", checked: new Date().toISOString(), error: null });
          }
          return catalog.sources.map((s) => s.repo);
        }
        case COMMANDS.removeModSource:
          await sleep(400);
          // Mods installed from it stay installed; they just stop getting updates.
          catalog.sources = catalog.sources.filter((s) => !sameRepo(s.repo, args.repo));
          catalog.mods = catalog.mods.filter((m) => m.origin.kind !== "source" || !sameRepo(m.origin.repo, args.repo));
          return catalog.sources.map((s) => s.repo);
        case COMMANDS.getModProfile:
          return report(args.tag);
        case COMMANDS.getModIcon:
          return iconUrl(String(args.url).replace("mock://", ""));
        case COMMANDS.planModInstall:
          await sleep(120);
          return plan(args.tag, args.sha256);
        case COMMANDS.installMod:
          return installMod(args.tag, args.sha256);
        case COMMANDS.inspectModFile:
          await sleep(300);
          return inspect(args.tag);
        case COMMANDS.installModFile:
          return installFile(args.tag, args.sha256);
        case COMMANDS.setModEnabled: {
          const lock = lockOf(args.tag);
          const e = lock.find((x) => x.id === args.id) ?? fail("ModNotInstalled", args.id);
          await sleep(150);
          const alsoEnabled: string[] = [];
          const alsoDisabled: string[] = [];
          if (args.enabled) {
            const r = revocation(e.sha256);
            if (r) fail("ModRevoked", `${e.name}: ${r}`);
            cascadeOn(lock, e.id, alsoEnabled);
            e.enabled = true;
          } else {
            e.enabled = false;
            cascadeOff(lock, e.id, alsoDisabled);
          }
          return change(args.tag, { alsoEnabled, alsoDisabled });
        }
        case COMMANDS.removeMod:
          await sleep(150);
          locks[args.tag] = lockOf(args.tag).filter((x) => x.id !== args.id);
          return change(args.tag);
        case COMMANDS.previewCopyModProfile:
          await sleep(200);
          return previewCopy(args.from, args.to);
        case COMMANDS.copyModProfile:
          return copyProfile(args.from, args.to);
        default:
          console.warn("mock backend: unhandled", cmd, args);
          return null;
      }
    },
    { shouldMockEvents: true }
  );
}
