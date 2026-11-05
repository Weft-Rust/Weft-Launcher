// What a mod's state means for the player and what fixes it. Pure: messages are keys with
// arguments, so this is testable without React. Lists of names are joined the way the current
// language joins them (formatList).

import { formatList, type Msg } from "../i18n";
import { fittingVersions, sameRepo } from "./select";
import type {
  BlockingReason,
  Catalog,
  CatalogMod,
  ChangeResult,
  CopyResult,
  FailureKind,
  InstalledMod,
  ModFailure,
  ModStatus,
  ProfileReport,
  ShadowedMod,
} from "./types";

function unreachable(x: never): never {
  throw new Error(`unhandled: ${String(x)}`);
}

export type NameOf = (id: string) => string;

const names = (ids: string[], name: NameOf) => formatList(ids.map(name));

/** Where a dependency that isn't on stands, and so what can be done about it. */
export type DepState =
  | { kind: "off"; mod: InstalledMod }
  | { kind: "revoked"; mod: InstalledMod }
  | { kind: "notInstalled"; build: { mod: CatalogMod; sha256: string; version: string } | null };

/**
 * The catalogue build that would install `dep` for a mod that needs it, as the backend's resolver
 * picks it: the index first, then the same source as the mod; no prerelease for a release.
 */
export function dependencyBuild(
  catalog: Catalog | null,
  dep: string,
  neededBy: Pick<InstalledMod, "origin" | "channel">,
  abi: string | null
): { mod: CatalogMod; sha256: string; version: string } | null {
  if (!catalog) return null;
  const candidates = catalog.mods.filter(
    (m) =>
      m.id === dep &&
      (m.origin.kind === "index" || (m.origin.kind === "source" && neededBy.origin.kind === "source" && sameRepo(m.origin.repo, neededBy.origin.repo)))
  );
  candidates.sort((a, b) => Number(a.origin.kind !== "index") - Number(b.origin.kind !== "index"));
  for (const mod of candidates) {
    const best = fittingVersions(catalog, mod, abi, (neededBy.channel ?? "release") !== "release")[0];
    if (best) return { mod, sha256: best.sha256, version: best.version };
  }
  return null;
}

/** Each dependency of `mod` that isn't on, and why. */
export function depStates(mod: InstalledMod, report: ProfileReport, catalog: Catalog | null): Map<string, DepState> {
  const out = new Map<string, DepState>();
  const notInstalled = new Set(mod.depsNotInstalled ?? []);
  for (const dep of mod.missingDeps) {
    const have = notInstalled.has(dep) ? undefined : report.mods.find((m) => m.id === dep);
    if (!have) out.set(dep, { kind: "notInstalled", build: dependencyBuild(catalog, dep, mod, report.versionAbi) });
    else out.set(dep, { kind: have.status === "revoked" ? "revoked" : "off", mod: have });
  }
  return out;
}

/** "Needs X, which is off." and the other cases, one message per case. */
export function missingDepsReasons(mod: InstalledMod, tag: string, name: NameOf, states?: Map<string, DepState>): Msg[] {
  if (!states) {
    // Without the report around it: what the backend's two lists alone say.
    const off = mod.missingDeps.filter((d) => !(mod.depsNotInstalled ?? []).includes(d));
    const gone = mod.depsNotInstalled ?? [];
    const out: Msg[] = [];
    if (off.length) out.push({ key: "mods.statusDepsOff", count: off.length, args: [names(off, name)] });
    if (gone.length) out.push({ key: "mods.statusDepsNotInstalled", count: gone.length, args: [names(gone, name)] });
    return out;
  }
  const by = (k: string, pred: (s: DepState) => boolean) => [...states].filter(([, s]) => s.kind === k && pred(s)).map(([id]) => id);
  const groups: [string[], Msg["key"]][] = [
    [by("off", () => true), "mods.statusDepsOff"],
    [by("revoked", () => true), "mods.statusDepsRevoked"],
    [by("notInstalled", (s) => s.kind === "notInstalled" && s.build !== null), "mods.statusDepsNotInstalled"],
    [by("notInstalled", (s) => s.kind === "notInstalled" && s.build === null), "mods.statusDepsNoBuild"],
  ];
  return groups
    .filter(([ids]) => ids.length)
    .map(([ids, key]) => ({ key, count: ids.length, args: [names(ids, name), tag] }) as Msg);
}

/** The line under a mod's name: what the launcher knows about it, or what is wrong. */
export function modMeta(
  mod: InstalledMod,
  tag: string,
  name: NameOf,
  states?: Map<string, DepState>,
  shadow?: ShadowedMod
): { parts: Msg[]; bad: boolean; shadowed: boolean } {
  const base = baseMeta(mod, tag, name, states);
  // Contract R4 §4: the engine loads the first copy of an id; the player's own copy wins whenever
  // this one is off or revoked.
  if (shadow && shadow.managed !== "on") {
    const revoked = shadow.managed === "revoked";
    return {
      parts: [...base.parts, { key: revoked ? "mods.shadowRevokedRow" : "mods.shadowOffRow", args: [shadow.file] }],
      bad: base.bad || revoked,
      shadowed: true,
    };
  }
  return { ...base, shadowed: false };
}

function baseMeta(mod: InstalledMod, tag: string, name: NameOf, states?: Map<string, DepState>): { parts: Msg[]; bad: boolean } {
  const status: ModStatus = mod.status;
  switch (status) {
    case "off":
      return { parts: [{ key: "mods.statusOff" }], bad: false };
    case "wrongVersion":
      return {
        parts: [mod.weftTag ? { key: "mods.statusWrongVersionTag", args: [mod.weftTag] } : { key: "mods.statusWrongVersion" }],
        bad: true,
      };
    case "missingDeps":
      return { parts: missingDepsReasons(mod, tag, name, states), bad: true };
    case "revoked":
      // The index's reason is its own sentence; ours stands apart from it.
      return { parts: [{ key: "mods.statusRevoked", args: [(mod.revokedReason ?? "").trim()] }], bad: true };
    case "unchecked":
      return {
        parts: [
          mod.origin.kind === "file"
            ? { key: "mods.statusUncheckedFile", args: [mod.origin.name] }
            : { key: "mods.statusUnchecked" },
        ],
        bad: false,
      };
    case "ready": {
      const parts: Msg[] = [mod.weftTag ? { key: "mods.metaBuiltFor", args: [mod.weftTag] } : { key: "mods.metaBuiltForThis", args: [tag] }];
      if (mod.origin.kind === "source") parts.push({ key: "mods.metaFromSource", args: [mod.origin.repo] });
      const deps = mod.deps.filter((d) => d !== "base");
      if (deps.length) parts.push({ key: "mods.metaNeeds", args: [names(deps, name)] });
      return { parts, bad: false };
    }
    default:
      return unreachable(status);
  }
}

/** A one-click fix for a mod that stops the game. `install` and `update` open the review dialog. */
export type Fix =
  | { kind: "turnOff"; id: string; name: string }
  /** A copy in the player's own folder loads instead of a revoked mod: only the player can remove it. */
  | { kind: "showFolder"; id: string; name: string; file: string }
  | { kind: "turnOn"; id: string; name: string }
  | { kind: "install"; id: string; name: string; mod: CatalogMod; sha256: string }
  | { kind: "update"; id: string; name: string; version: string; sha256: string };

/** What gets each dependency that isn't on back on, where something can. */
function depFixes(states: Map<string, DepState>): Fix[] {
  const fixes: Fix[] = [];
  for (const [id, s] of states) {
    if (s.kind === "off") fixes.push({ kind: "turnOn", id, name: s.mod.name });
    else if (s.kind === "notInstalled" && s.build) fixes.push({ kind: "install", id, name: s.build.mod.name, mod: s.build.mod, sha256: s.build.sha256 });
  }
  return fixes;
}

export interface Blocker {
  mod: InstalledMod;
  reasons: Msg[];
  fixes: Fix[];
}

/**
 * Why a blocking mod blocks: the backend says (contract R4 §4); a report without a reason for it
 * falls back to the mod's status.
 */
export function blockingReason(report: ProfileReport, mod: InstalledMod): BlockingReason {
  const given = report.blockingReasons?.[mod.id];
  if (given) return given;
  if (mod.status === "missingDeps" || mod.status === "wrongVersion" || mod.status === "revoked") return mod.status;
  return "wrongVersion";
}

/** The copy of a mod in the player's own folder that the engine would load, if there is one. */
export function shadowOf(report: ProfileReport | undefined, id: string): ShadowedMod | undefined {
  return report?.shadowed?.find((s) => s.id === id);
}

/** Each mod that stops this version from starting, why, and what fixes it. */
export function blockers(report: ProfileReport | undefined, name: NameOf, catalog: Catalog | null = null): Blocker[] {
  if (!report) return [];
  const byId = new Map(report.mods.map((m) => [m.id, m]));
  return report.blocking.flatMap((id) => {
    const mod = byId.get(id);
    if (!mod) return [];
    const fixes: Fix[] = [];
    let reasons: Msg[];
    const why: BlockingReason = blockingReason(report, mod);
    switch (why) {
      case "missingDeps": {
        const states = depStates(mod, report, catalog);
        reasons = missingDepsReasons(mod, report.tag, name, states);
        fixes.push(...depFixes(states));
        break;
      }
      case "shadowedRevoked": {
        // Turning it off can't help: it is off. The player's own copy has to go.
        const shadow = shadowOf(report, mod.id);
        reasons = [{ key: "mods.blockShadowedRevoked", args: [shadow?.file ?? mod.id, mod.name, (mod.revokedReason ?? "").trim()] }];
        if (mod.update) fixes.push({ kind: "update", id: mod.id, name: mod.name, version: mod.update.version, sha256: mod.update.sha256 });
        fixes.push({ kind: "showFolder", id: mod.id, name: mod.name, file: shadow?.file ?? "" });
        return [{ mod, reasons, fixes }];
      }
      case "revoked":
        reasons = [{ key: "mods.statusRevoked", args: [(mod.revokedReason ?? "").trim()] }];
        break;
      case "wrongVersion":
        reasons = [mod.weftTag ? { key: "mods.statusWrongVersionTag", args: [mod.weftTag] } : { key: "mods.statusWrongVersion" }];
        break;
      default:
        return unreachable(why);
    }
    if (mod.update) {
      fixes.push({ kind: "update", id: mod.id, name: mod.name, version: mod.update.version, sha256: mod.update.sha256 });
    }
    fixes.push({ kind: "turnOff", id: mod.id, name: mod.name });
    return [{ mod, reasons, fixes }];
  });
}

/** The fixes a crash notice offers, beside Open log and Dismiss. */
export function crashFixes(failure: ModFailure | null, report: ProfileReport | undefined, catalog: Catalog | null): Fix[] {
  const mod = failure?.modId ? report?.mods.find((m) => m.id === failure.modId) : undefined;
  if (!failure || !report) return [];
  const fixes: Fix[] = [];
  if (failure.kind === "missingDep" && failure.other) {
    const dep = report.mods.find((m) => m.id === failure.other);
    if (dep && !dep.enabled && dep.status !== "revoked") fixes.push({ kind: "turnOn", id: dep.id, name: dep.name });
    if (!dep) {
      const build = dependencyBuild(catalog, failure.other, mod ?? { origin: { kind: "index" }, channel: "release" }, report.versionAbi);
      if (build) fixes.push({ kind: "install", id: failure.other, name: build.mod.name, mod: build.mod, sha256: build.sha256 });
    }
  }
  // A newer build can fix a build that doesn't load; it can't fix a missing dependency or a file.
  const updatable: FailureKind[] = ["wrongVersion", "loadFailed", "initPanicked"];
  if (mod?.update && updatable.includes(failure.kind)) {
    fixes.push({ kind: "update", id: mod.id, name: mod.name, version: mod.update.version, sha256: mod.update.sha256 });
  }
  if (mod?.enabled) fixes.push({ kind: "turnOff", id: mod.id, name: mod.name });
  return fixes;
}

export type HeroState = "ready" | "playing" | "blocked";

export function heroState(report: ProfileReport | undefined, running: boolean): HeroState {
  if (running) return "playing";
  return report && report.blocking.length > 0 ? "blocked" : "ready";
}

/** What stopped the game, in display names. `name` is the blamed mod's; `nameOf` names the others. */
export function failureTitle(failure: ModFailure, name: string, nameOf: NameOf): Msg {
  const kind: FailureKind = failure.kind;
  switch (kind) {
    case "wrongVersion":
      return { key: "mods.failureWrongVersion", args: [name] };
    case "missingDep":
      return { key: "mods.failureMissingDep", args: [name, failure.other ? nameOf(failure.other) : ""] };
    case "loadFailed":
      return { key: "mods.failureLoad", args: [name] };
    case "notAMod":
      return { key: "mods.failureNotAMod", args: [name] };
    case "wrongName":
      return { key: "mods.failureWrongName", args: [name] };
    case "initPanicked":
      return failure.modId ? { key: "mods.failureInitNamed", args: [name] } : { key: "mods.failureInit" };
    default:
      return unreachable(kind);
  }
}

/** The mod a crash blames, as it was when the game stopped, and what kind of failure it was. */
export interface CrashSnapshot {
  id: string;
  sha256: string;
  enabled: boolean;
  kind: FailureKind;
  /** For `missingDep`: the mod it lacked. */
  dependency: string | null;
}

export function snapshotFor(failure: ModFailure | null, report: ProfileReport | undefined): CrashSnapshot | null {
  const mod = failure?.modId ? report?.mods.find((m) => m.id === failure.modId) : undefined;
  if (!mod || !failure) return null;
  return {
    id: mod.id,
    sha256: mod.sha256,
    enabled: mod.enabled,
    kind: failure.kind,
    dependency: failure.kind === "missingDep" ? failure.other : null,
  };
}

/**
 * Whether the problem a crash named has been dealt with: the blamed mod is off, removed or
 * replaced by another build, or, for a missing dependency, that dependency is now on and usable.
 * A crash the launcher can't tie to a mod it manages only goes away when the player dismisses it
 * or starts the game again.
 */
export function crashResolved(snapshot: CrashSnapshot | null, report: ProfileReport | undefined): boolean {
  if (!snapshot || !report) return false;
  const now = report.mods.find((m) => m.id === snapshot.id);
  if (!now || !now.enabled || now.sha256 !== snapshot.sha256) return true;
  if (snapshot.kind === "missingDep" && snapshot.dependency) {
    const dep = report.mods.find((m) => m.id === snapshot.dependency);
    return !!dep && dep.enabled && (dep.status === "ready" || dep.status === "unchecked");
  }
  return false;
}

export interface NoticeText {
  tone: "ok" | "warn" | "info";
  lines: Msg[];
}

/** What else a change did: dependencies turned on or off, and what has no build. */
function sideEffects(result: ChangeResult, tag: string, name: NameOf, lines: Msg[]) {
  if (result.alsoEnabled.length) lines.push({ key: "mods.noticeAlsoEnabled", args: [names(result.alsoEnabled, name)] });
  if (result.alsoDisabled.length) lines.push({ key: "mods.noticeAlsoDisabled", args: [names(result.alsoDisabled, name)] });
  // A mod installed turned off already says which dependency has no build.
  if (result.missing.length && !result.installedOff.length) {
    lines.push({ key: "mods.noticeMissing", count: result.missing.length, args: [names(result.missing, name), tag] });
  }
}

/** What a change did, in names. `primary` is the mod the player acted on, if any. */
export function describeChange(result: ChangeResult, primary: string | null, tag: string, name: NameOf): NoticeText | null {
  const lines: Msg[] = [];
  if (primary && result.installed.includes(primary)) {
    const after = result.report.mods.find((m) => m.id === primary);
    if (result.installedOff.includes(primary)) {
      lines.push({
        key: "mods.noticeInstalledOffMissing",
        count: result.missing.length,
        args: [name(primary), names(result.missing, name), tag],
      });
    } else {
      lines.push({ key: after && !after.enabled ? "mods.noticeInstalledOff" : "mods.noticeInstalled", args: [name(primary), tag] });
    }
  }
  const deps = result.installed.filter((id) => id !== primary);
  if (deps.length && primary) lines.push({ key: "mods.noticeDepsInstalled", args: [names(deps, name)] });
  sideEffects(result, tag, name, lines);
  if (!lines.length) return null;
  return { tone: result.missing.length ? "warn" : "ok", lines };
}

/**
 * A toggle that changed other mods too: what the player did, then what else. A plain toggle says
 * nothing; its switch already does.
 */
export function describeToggle(result: ChangeResult, id: string, enabled: boolean, tag: string, name: NameOf): NoticeText | null {
  const lines: Msg[] = [];
  sideEffects(result, tag, name, lines);
  // Off, but a copy in the player's own folder loads in its place (contract R4 §4): say so now,
  // not only in a note the player may not open.
  const shadow = enabled ? undefined : shadowOf(result.report, id);
  if (shadow && shadow.managed !== "on") lines.push({ key: "mods.noticeShadowLoads", args: [name(id), shadow.file] });
  if (!lines.length) return null;
  return { tone: shadow ? "warn" : "ok", lines: [{ key: enabled ? "mods.noticeTurnedOn" : "mods.noticeTurnedOff", args: [name(id)] }, ...lines] };
}

export function describeRemove(result: ChangeResult, id: string, tag: string, name: NameOf): NoticeText {
  const lines: Msg[] = [{ key: "mods.noticeRemoved", args: [name(id), tag] }];
  sideEffects(result, tag, name, lines);
  return { tone: "ok", lines };
}

export function describeRestore(result: ChangeResult, id: string, tag: string, name: NameOf): NoticeText {
  const after = result.report.mods.find((m) => m.id === id);
  return { tone: "ok", lines: [{ key: after?.enabled ? "mods.noticeRestored" : "mods.noticeRestoredOff", args: [name(id), tag] }] };
}

export function describeCopy(result: CopyResult, from: string, tag: string, name: NameOf): NoticeText {
  const lines: Msg[] = [{ key: "mods.noticeCopied", count: result.installed.length, args: [from] }];
  if (result.installedOff.length) {
    lines.push({ key: "mods.noticeCopiedOff", count: result.installedOff.length, args: [names(result.installedOff, name), tag] });
  }
  if (result.leftBehind.length) {
    lines.push({
      key: "mods.noticeLeftBehind",
      count: result.leftBehind.length,
      args: [formatList(result.leftBehind.map((i) => i.name))],
    });
  }
  sideEffects({ ...result, installedOff: [] }, tag, name, lines);
  return { tone: result.leftBehind.length || result.missing.length ? "warn" : "ok", lines };
}

/** Mods turned on in this version, for the line on Home. */
export function enabledNames(report: ProfileReport | undefined): string[] {
  return report?.mods.filter((m) => m.enabled).map((m) => m.name) ?? [];
}
