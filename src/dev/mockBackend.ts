// A stand-in for the Rust side, so the UI runs in a plain browser: `npm run dev:mock`.
// Pick a state with `?scenario=`: mods (default), empty, offline, crash, fresh, knownfile.
// It only imitates the answers; the real rules live in src-tauri/src/mods.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type {
  Catalog,
  CatalogMod,
  CatalogVersion,
  FileInspection,
  InstalledMod,
  ProfileReport,
} from "../mods/types";

const NEW = "v26.11.1";
const OLD = "v26.10.4";
const ABI: Record<string, string> = { [NEW]: "f470b1cbb1f9ad91", [OLD]: "5f0569a6bea71b81" };
const scenario = new URLSearchParams(location.search).get("scenario") ?? "mods";

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

function version(
  id: string,
  v: string,
  weftTag: string,
  extra: Partial<CatalogVersion> = {}
): CatalogVersion {
  return {
    version: v,
    channel: "release",
    tag: `${id}-v${v}`,
    published: "2026-11-04T02:39:03Z",
    sourceRepo: "Zorro909/weft-mods",
    sourceCommit: "cceea7805df5902d62017d2008d1bb29ed84e152",
    weftTag,
    abi: ABI[weftTag],
    deps: ["base"],
    platforms: ["windows-x64", "linux-x64", "macos-arm64"],
    sha256: sha(`${id}${v}${weftTag}`),
    size: 2_642_469,
    url: `https://github.com/Zorro909/weft-mods/releases/download/${id}-v${v}/${id}.zip`,
    provenance: {
      repo: "Zorro909/weft-mods",
      workflow: ".github/workflows/release.yml",
      gitRef: "refs/heads/main",
      verifiedAt: "2026-11-04T18:00:00Z",
    },
    reviewed: { by: "Zorro909", at: "2026-11-04" },
    trust: "reviewed",
    ...extra,
  };
}

const unreviewed = { trust: "unreviewed" as const, reviewed: null, provenance: null };

const catalogMods: CatalogMod[] = [
  {
    key: "index:cogwork",
    id: "cogwork",
    name: "Cogwork",
    summary: "Gears, item tubes and engines, an excavator, an assembly bench and a leveler.",
    authors: ["Zorro909"],
    license: "MPL-2.0",
    homepage: "https://github.com/Zorro909/weft-mods/tree/main/cogwork",
    icon: "mock://cogwork",
    origin: { kind: "index" },
    versions: [
      version("cogwork", "0.2.1-rc.1", NEW, { channel: "prerelease" }),
      version("cogwork", "0.2.0", NEW),
      version("cogwork", "0.1.2", OLD),
    ],
  },
  {
    key: "index:structures",
    id: "structures",
    name: "Structures",
    summary: "Overworld buildings and hamlets, a wand, and /structure.",
    authors: ["Zorro909"],
    license: "MPL-2.0",
    homepage: null,
    icon: "mock://structures",
    origin: { kind: "index" },
    versions: [version("structures", "0.1.3", NEW), version("structures", "0.1.2", NEW), version("structures", "0.1.1", OLD)],
  },
  {
    key: "index:showcase",
    id: "showcase",
    name: "Showcase",
    summary: "Developer tool: plays and records films that mods define in code.",
    authors: ["Zorro909"],
    license: "MPL-2.0",
    homepage: null,
    icon: null,
    origin: { kind: "index" },
    versions: [version("showcase", "0.1.1-rc.2", NEW, { channel: "prerelease", deps: [] })],
  },
  {
    key: "source:lantern-dev/lanterns:lanterns",
    id: "lanterns",
    name: "Lanterns",
    summary: "Hanging lanterns in eight colours that sway in the wind and light up caves.",
    authors: ["lantern-dev"],
    license: null,
    homepage: null,
    icon: null,
    origin: { kind: "source", repo: "lantern-dev/lanterns" },
    versions: [
      version("lanterns", "1.0.0", OLD, { ...unreviewed, sourceRepo: "lantern-dev/lanterns", sourceCommit: "9a1b2c3d4e5f60718293a4b5c6d7e8f901234567" }),
    ],
  },
  {
    key: "source:lantern-dev/lanterns:glowmoss",
    id: "glowmoss",
    name: "Glowmoss",
    summary: "A soft blue moss that spreads on damp stone and glows at night.",
    authors: ["lantern-dev"],
    license: "MIT",
    homepage: null,
    icon: null,
    origin: { kind: "source", repo: "lantern-dev/lanterns" },
    versions: [
      version("glowmoss", "0.3.0", NEW, { ...unreviewed, sourceRepo: "lantern-dev/lanterns", sourceCommit: "1f2e3d4c5b6a79881726354a5b6c7d8e9f012345" }),
    ],
  },
];

const catalog: Catalog = {
  mods: catalogMods,
  revoked: [],
  index: { freshness: "fresh", generated: "2026-11-04T18:00:00Z", error: null },
  sources: [{ repo: "lantern-dev/lanterns", mods: 2, error: null }],
  weft: [
    { tag: NEW, commit: "ff9c7128511fc0dce7719b67c9a59274d70bdd5a", abi: ABI[NEW] },
    { tag: OLD, commit: "34fa22b0000000000000000000000000000000000", abi: ABI[OLD] },
  ],
  platform: "linux-x64",
};
if (scenario === "offline") {
  catalog.index = { freshness: "cached", generated: "2026-11-02T12:00:00Z", error: { code: "Network", detail: "offline" } };
  catalog.sources[0].error = { code: "Network", detail: "offline" };
}

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

const find = (key: string) => catalogMods.find((m) => m.key === key)!;
const pick = (key: string, v: string) => {
  const m = find(key);
  return entryFrom(m, m.versions.find((x) => x.version === v)!);
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

const locks: Record<string, Entry[]> = { [NEW]: [], [OLD]: [] };
if (scenario === "mods" || scenario === "offline" || scenario === "crash") {
  locks[NEW] = [
    pick("index:cogwork", "0.2.0"),
    pick("index:structures", "0.1.2"),
    { ...pick("index:showcase", "0.1.1-rc.2"), enabled: false },
    pick("source:lantern-dev/lanterns:lanterns", "1.0.0"),
    fileEntry,
  ];
}
if (scenario === "empty" || scenario === "mods") {
  locks[OLD] = [pick("index:cogwork", "0.1.2"), pick("index:structures", "0.1.1")];
}
const unmanaged = scenario === "mods" ? ["oldtweak.zip"] : [];

function report(tag: string): ProfileReport {
  const abi = ABI[tag] ?? null;
  const lock = locks[tag] ?? [];
  const on = new Set(lock.filter((m) => m.enabled).map((m) => m.id));
  const mods: InstalledMod[] = lock.map((e) => {
    const missing = e.deps.filter((d) => d !== "base" && !on.has(d));
    const status: InstalledMod["status"] = !e.enabled
      ? "off"
      : e.abi && e.abi !== abi
        ? "wrongVersion"
        : missing.length
          ? "missingDeps"
          : e.abi
            ? "ready"
            : "unchecked";
    const key = e.origin.kind === "index" ? `index:${e.id}` : e.origin.kind === "source" ? `source:${e.origin.repo}:${e.id}` : null;
    const best = key
      ? catalogMods
          .find((m) => m.key === key)
          ?.versions.find((v) => v.abi === abi && (v.channel === "release" || e.channel !== "release"))
      : undefined;
    const update =
      best && best.sha256 !== e.sha256 && (status === "wrongVersion" || best.version > (e.version ?? ""))
        ? { version: best.version, sha256: best.sha256, channel: best.channel, trust: best.trust }
        : null;
    return { ...e, status, missingDeps: missing, revokedReason: null, update };
  });
  return {
    tag,
    versionAbi: abi,
    abiError: null,
    mods,
    blocking: mods.filter((m) => m.status === "wrongVersion" || m.status === "missingDeps").map((m) => m.id),
    unmanaged,
  };
}

const change = (tag: string, installed: string[] = [], alsoDisabled: string[] = []) => ({
  report: report(tag),
  installed,
  alsoEnabled: [],
  alsoDisabled,
  missing: [],
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fakeDownload(hash: string, modId: string) {
  for (let p = 0; p <= 100; p += 10) {
    await emit("mod-progress", { sha256: hash, modId, stage: "downloading", percent: p });
    await sleep(120);
  }
  await emit("mod-progress", { sha256: hash, modId, stage: "verifying", percent: 100 });
  await sleep(300);
}

function iconUrl(id: string): string {
  const art: Record<string, string[]> = {
    cogwork: ["...##...", ".#.##.#.", "########", ".##..##.", ".##..##.", "########", ".#.##.#.", "...##..."],
    structures: ["...##...", "..####..", ".######.", "########", ".##..##.", ".##..##.", ".##..##.", ".######."],
  };
  const rows = art[id];
  const c = document.createElement("canvas");
  c.width = c.height = 8;
  const g = c.getContext("2d")!;
  g.fillStyle = id === "cogwork" ? "#e09632" : "#8c97ad";
  rows.forEach((row, y) => [...row].forEach((ch, x) => ch === "#" && g.fillRect(x, y, 1, 1)));
  return c.toDataURL("image/png");
}

const versions = scenario === "fresh" ? [] : [NEW, OLD];

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
          return "/home/player/Downloads/mytweak.zip";
        case "plugin:opener|open_url":
        case "plugin:opener|open_path":
          return null;
        case "list_versions":
          return versions.map((tag, i) => ({
            tag,
            name: tag,
            published_at: i === 0 ? "2026-11-01T12:00:00Z" : "2026-10-20T12:00:00Z",
            body: "",
            prerelease: false,
            asset: { name: `Weft-${tag}-linux-x64.tar.gz`, url: "", size: 48_000_000, sha256: "a".repeat(64) },
            from_cache: false,
          }));
        case "get_installed_versions":
          return versions.map((tag) => ({ tag, path: `/versions/${tag}`, executable: "weft", installed_at: "2026-11-02T10:00:00Z" }));
        case "get_running_versions":
          return [];
        case "launch_version": {
          const r = report(args.tag);
          if (r.blocking.length && scenario !== "crash") {
            throw { code: "ModsBlocked", detail: r.blocking.join(", ") };
          }
          await emit("game-state", { tag: args.tag, state: "running", exitCode: null, crashed: false, modFailure: null });
          setTimeout(() => {
            emit("game-state", {
              tag: args.tag,
              state: "stopped",
              exitCode: 1,
              crashed: true,
              modFailure:
                scenario === "crash"
                  ? {
                      kind: "wrongVersion",
                      modId: "lanterns",
                      other: null,
                      line: "ERROR mod lanterns was built against another mod ABI (5f0569a6bea71b81, this engine has f470b1cbb1f9ad91)",
                    }
                  : null,
            });
          }, 1500);
          return null;
        }
        case "open_log":
        case "open_game_folder":
        case "open_player_mods_folder":
          return null;
        case "list_mod_catalog":
          await sleep(args.forceRefresh ? 400 : 0);
          return catalog;
        case "get_mod_sources":
          return catalog.sources.map((s) => s.repo);
        case "add_mod_source":
          catalog.sources.push({ repo: args.repo, mods: 0, error: null });
          return catalog.sources.map((s) => s.repo);
        case "remove_mod_source":
          catalog.sources = catalog.sources.filter((s) => s.repo !== args.repo);
          return catalog.sources.map((s) => s.repo);
        case "get_mod_profile":
          return report(args.tag);
        case "get_mod_icon":
          return iconUrl(String(args.url).replace("mock://", ""));
        case "install_mod": {
          const m = catalogMods.find((x) => x.versions.some((v) => v.sha256 === args.sha256))!;
          const v = m.versions.find((x) => x.sha256 === args.sha256)!;
          await fakeDownload(v.sha256, m.id);
          const lock = locks[args.tag];
          const at = lock.findIndex((e) => e.id === m.id);
          if (at >= 0) lock[at] = entryFrom(m, v);
          else lock.push(entryFrom(m, v));
          return change(args.tag, [m.id]);
        }
        case "inspect_mod_file": {
          const known =
            scenario === "knownfile"
              ? { key: "index:cogwork", name: "Cogwork", version: "0.2.0", trust: "reviewed" as const, fitsVersion: true }
              : null;
          const inspection: FileInspection = {
            fileName: "mytweak.zip",
            size: 1_153_433,
            sha256: sha("mytweak"),
            archive: { id: "mytweak", libraries: ["libmytweak.so", "mytweak.dll"], platforms: ["linux-x64", "windows-x64"], hasAssets: true, entries: 14 },
            problem: null,
            name: "My Tweak",
            summary: "Makes torches brighter.",
            fitsSystem: true,
            catalogMatch: known,
            revokedReason: null,
            replaces: locks[args.tag].some((e) => e.id === "mytweak") ? "My Tweak" : null,
          };
          await sleep(300);
          return inspection;
        }
        case "install_mod_file": {
          const lock = locks[args.tag];
          if (!lock.some((e) => e.id === "mytweak")) lock.push(fileEntry);
          return change(args.tag, ["mytweak"]);
        }
        case "set_mod_enabled": {
          const lock = locks[args.tag];
          const e = lock.find((x) => x.id === args.id)!;
          e.enabled = args.enabled;
          const off = args.enabled ? [] : lock.filter((x) => x.enabled && x.deps.includes(args.id)).map((x) => x.id);
          off.forEach((id) => (lock.find((x) => x.id === id)!.enabled = false));
          await sleep(150);
          return change(args.tag, [], off);
        }
        case "remove_mod":
          locks[args.tag] = locks[args.tag].filter((x) => x.id !== args.id);
          return change(args.tag);
        case "copy_mod_profile": {
          const from = locks[args.from].filter((e) => e.enabled);
          const moved: string[] = [];
          const left: string[] = [];
          for (const e of from) {
            const m = catalogMods.find((x) => x.id === e.id && x.origin.kind === e.origin.kind);
            const v = m?.versions.find((x) => x.abi === ABI[args.to] && x.channel === "release");
            if (m && v) {
              await fakeDownload(v.sha256, m.id);
              locks[args.to].push(entryFrom(m, v));
              moved.push(m.id);
            } else left.push(e.name);
          }
          return { ...change(args.to, moved), leftBehind: left };
        }
        default:
          console.warn("mock backend: unhandled", cmd, args);
          return null;
      }
    },
    { shouldMockEvents: true }
  );
}
