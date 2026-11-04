// What a mod's state means for the player and what fixes it. Pure: messages are keys with
// arguments, so this is testable without React or a language.

import type { Msg } from "../i18n";
import type { ChangeResult, CopyResult, FailureKind, InstalledMod, ModFailure, ModStatus, ProfileReport } from "./types";

function unreachable(x: never): never {
  throw new Error(`unhandled: ${String(x)}`);
}

export type NameOf = (id: string) => string;

/** The line under a mod's name: what the launcher knows about it, or what is wrong. */
export function modMeta(mod: InstalledMod, tag: string, name: NameOf): { parts: Msg[]; bad: boolean } {
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
      return {
        parts: [{ key: "mods.statusMissingDeps", count: mod.missingDeps.length, args: [mod.missingDeps.map(name).join(", ")] }],
        bad: true,
      };
    case "revoked":
      return { parts: [{ key: "mods.statusRevoked", args: [mod.revokedReason ?? ""] }], bad: true };
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
      if (deps.length) parts.push({ key: "mods.metaNeeds", args: [deps.map(name).join(", ")] });
      return { parts, bad: false };
    }
    default:
      return unreachable(status);
  }
}

/** A one-click fix for a mod that stops the game. */
export type Fix =
  | { kind: "turnOff"; id: string; name: string }
  | { kind: "turnOn"; id: string; name: string }
  | { kind: "update"; id: string; name: string; version: string; sha256: string };

export interface Blocker {
  mod: InstalledMod;
  reason: Msg;
  fixes: Fix[];
}

/** Each mod that stops this version from starting, why, and what fixes it. */
export function blockers(report: ProfileReport | undefined, name: NameOf): Blocker[] {
  if (!report) return [];
  const byId = new Map(report.mods.map((m) => [m.id, m]));
  return report.blocking.flatMap((id) => {
    const mod = byId.get(id);
    if (!mod) return [];
    const fixes: Fix[] = [];
    let reason: Msg;
    if (mod.status === "missingDeps") {
      reason = { key: "mods.statusMissingDeps", count: mod.missingDeps.length, args: [mod.missingDeps.map(name).join(", ")] };
      for (const dep of mod.missingDeps) {
        const installed = byId.get(dep);
        if (installed && !installed.enabled && installed.status !== "revoked") {
          fixes.push({ kind: "turnOn", id: dep, name: installed.name });
        }
      }
    } else {
      reason = mod.weftTag ? { key: "mods.statusWrongVersionTag", args: [mod.weftTag] } : { key: "mods.statusWrongVersion" };
    }
    if (mod.update) {
      fixes.push({ kind: "update", id: mod.id, name: mod.name, version: mod.update.version, sha256: mod.update.sha256 });
    }
    fixes.push({ kind: "turnOff", id: mod.id, name: mod.name });
    return [{ mod, reason, fixes }];
  });
}

export type HeroState = "ready" | "playing" | "blocked";

export function heroState(report: ProfileReport | undefined, running: boolean): HeroState {
  if (running) return "playing";
  return report && report.blocking.length > 0 ? "blocked" : "ready";
}

export function failureTitle(failure: ModFailure, name: string): Msg {
  const kind: FailureKind = failure.kind;
  const other = failure.other ?? "";
  switch (kind) {
    case "wrongVersion":
      return { key: "mods.failureWrongVersion", args: [name] };
    case "missingDep":
      return { key: "mods.failureMissingDep", args: [name, other] };
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

/** The mod a crash blames, as it was when the game stopped. */
export interface CrashSnapshot {
  id: string;
  sha256: string;
  enabled: boolean;
}

export function snapshotFor(failure: ModFailure | null, report: ProfileReport | undefined): CrashSnapshot | null {
  const mod = failure?.modId ? report?.mods.find((m) => m.id === failure.modId) : undefined;
  return mod ? { id: mod.id, sha256: mod.sha256, enabled: mod.enabled } : null;
}

/**
 * Whether the problem a crash named has been dealt with: the blamed mod is off, removed or
 * replaced by another build. A crash the launcher can't tie to a mod it manages only goes away
 * when the player dismisses it or starts the game again.
 */
export function crashResolved(snapshot: CrashSnapshot | null, report: ProfileReport | undefined): boolean {
  if (!snapshot || !report) return false;
  const now = report.mods.find((m) => m.id === snapshot.id);
  return !now || !now.enabled || now.sha256 !== snapshot.sha256;
}

export interface NoticeText {
  tone: "ok" | "warn";
  lines: Msg[];
}

/** What a change did, in names. `primary` is the mod the player acted on, if any. */
export function describeChange(result: ChangeResult, primary: string | null, name: NameOf): NoticeText | null {
  const names = (ids: string[]) => ids.map(name).join(", ");
  const lines: Msg[] = [];
  if (primary && result.installed.includes(primary)) {
    const after = result.report.mods.find((m) => m.id === primary);
    lines.push({ key: after && !after.enabled ? "mods.noticeInstalledOff" : "mods.noticeInstalled", args: [name(primary)] });
  }
  const deps = result.installed.filter((id) => id !== primary);
  if (deps.length && primary) lines.push({ key: "mods.noticeDepsInstalled", args: [names(deps)] });
  if (result.alsoEnabled.length) lines.push({ key: "mods.noticeAlsoEnabled", args: [names(result.alsoEnabled)] });
  if (result.alsoDisabled.length) lines.push({ key: "mods.noticeAlsoDisabled", args: [names(result.alsoDisabled)] });
  if (result.missing.length) {
    lines.push({ key: "mods.noticeMissing", count: result.missing.length, args: [names(result.missing)] });
  }
  if (!lines.length) return null;
  return { tone: result.missing.length ? "warn" : "ok", lines };
}

export function describeCopy(result: CopyResult, from: string, name: NameOf): NoticeText {
  const lines: Msg[] = [{ key: "mods.noticeCopied", count: result.installed.length, args: [from] }];
  if (result.leftBehind.length) {
    lines.push({
      key: "mods.noticeLeftBehind",
      count: result.leftBehind.length,
      args: [result.leftBehind.map((i) => i.name).join(", ")],
    });
  }
  if (result.missing.length) {
    lines.push({ key: "mods.noticeMissing", count: result.missing.length, args: [result.missing.map(name).join(", ")] });
  }
  return { tone: result.leftBehind.length || result.missing.length ? "warn" : "ok", lines };
}

/** Mods turned on in this version, for the line on Home. */
export function enabledNames(report: ProfileReport | undefined): string[] {
  return report?.mods.filter((m) => m.enabled).map((m) => m.name) ?? [];
}
