// What the install dialogs say was checked, decided from backend data only. No JSX and no
// translation: rows are message keys with arguments, rendered by components/mods/CheckList.

import { formatList, type MessageKey, type Msg } from "../i18n";
import type { AppErrorPayload, CatalogVersion, CopyPreview, FileInspection, InstallPlan, ModProgress, Trust } from "./types";
import { shortCommit, shortSha } from "./select";
import { unreachable } from "../utils/never";

/** "same": nothing to check, because nothing changes (a mod a copy leaves as it is). */
export type CheckState = "yes" | "no" | "unknown" | "same";

/** One argument of a message: text, a day, a shortened value whose full form stays reachable, an error or a tier name. */
export type Arg =
  | string
  | { day: string }
  | { code: string; short: string }
  | { error: AppErrorPayload }
  | { trust: Trust };

export interface RichMsg {
  key: MessageKey;
  args?: Arg[];
}

export interface CheckRow {
  /** Stable within one list. */
  id: string;
  state: CheckState;
  title: RichMsg;
  detail?: RichMsg;
  /** Shown as a badge after the title, e.g. the tier of a dependency that will be installed. */
  trust?: Trust;
  /** Something that couldn't be found out, which asking again may answer: the row offers Retry. */
  retry?: boolean;
  /**
   * What a screen reader says for the mark, when the state's own word would be wrong: a mod
   * nobody reviewed hasn't failed anything, it is Unreviewed.
   */
  said?: MessageKey;
  /**
   * The detail says again what the title, or the dialog's warning, already says: it folds with
   * the checks that passed, so what is new stays in view in a small window.
   */
  aside?: boolean;
}

const sha = (s: string) => ({ code: s, short: shortSha(s) });
const abi = (s: string) => ({ code: s, short: s.slice(0, 8) });
const commit = (s: string) => ({ code: s, short: shortCommit(s) });

/**
 * Review and provenance of one catalogue build, the same wherever a build is shown. `indexFrom` is
 * the day of the index the review comes from when that index isn't fresh, so an old review says so.
 */
export function buildChecks(v: CatalogVersion, indexFrom: string | null = null): CheckRow[] {
  const rows: CheckRow[] = [];
  if (v.trust === "reviewed" && v.reviewed) {
    rows.push({
      id: "review",
      state: "yes",
      title: { key: "mods.ckIndex" },
      detail: indexFrom
        ? { key: "mods.ckIndexDetailDated", args: [v.reviewed.by, { day: v.reviewed.at }, indexFrom] }
        : { key: "mods.ckIndexDetail", args: [v.reviewed.by, { day: v.reviewed.at }] },
    });
  } else {
    rows.push({
      id: "review",
      state: "no",
      said: "mods.badgeUnreviewed",
      title: { key: "mods.ckNotIndex" },
      detail: { key: "mods.ckNotIndexDetail", args: [v.sourceRepo] },
      // Every dialog showing this row warns, above it, whose repo it is and that nobody reviewed it.
      aside: true,
    });
  }
  // The file name shows; the whole path is a hover or a Tab away, so two workflows of the same name differ.
  const path = v.provenance?.workflow;
  const workflow: Arg = path ? { code: path, short: path.split("/").pop() ?? path } : "—";
  rows.push(buildRecordCheck(v, workflow));
  return rows;
}

/**
 * What is known of how a build was made. Only a whole record in the signed index is a yes, and it
 * says whose word it is: the index records a GitHub Actions build that its CI checked; the
 * launcher checks no attestation itself. Anything less is unknown, never yes.
 */
function buildRecordCheck(v: CatalogVersion, workflow: Arg): CheckRow {
  const p = v.provenance;
  switch (v.buildRecord) {
    case "recorded":
      // `recorded` means the backend found every one of these (catalog.rs, `Provenance::is_complete`).
      return {
        id: "provenance",
        state: "yes",
        title: {
          key: "mods.ckBuilt",
          args: [p?.repo ?? v.sourceRepo, commit(v.sourceCommit), v.reviewed?.by ?? "—", p?.verifiedAt ? { day: p.verifiedAt } : "—"],
        },
        detail: { key: "mods.ckBuiltDetail", args: [workflow] },
      };
    case "incomplete":
      return { id: "provenance", state: "unknown", title: { key: "mods.ckBuiltIncomplete" }, detail: { key: "mods.ckBuiltIncompleteDetail" } };
    case "claimed":
      // The repo's own <id>.mod.json says so. Nothing checked it, so it can't be a green check.
      return {
        id: "provenance",
        state: "unknown",
        title: { key: "mods.ckBuiltClaimed" },
        detail: { key: "mods.ckBuiltClaimedDetail", args: [p?.repo ?? v.sourceRepo, commit(v.sourceCommit), workflow] },
      };
    case "none":
      return { id: "provenance", state: "unknown", title: { key: "mods.ckNoBuild" }, detail: { key: "mods.ckNoBuildDetail" }, aside: true };
    default:
      return unreachable(v.buildRecord);
  }
}

/** How the download is pinned. Only the signed index pins it independently of the file's server. */
export function pinCheck(v: CatalogVersion): CheckRow {
  return v.trust === "reviewed"
    ? { id: "pin", state: "yes", title: { key: "mods.ckPinned", args: [sha(v.sha256)] } }
    : {
        id: "pin",
        state: "unknown",
        title: { key: "mods.ckPinnedGithub", args: [sha(v.sha256)] },
        detail: { key: "mods.ckPinnedGithubDetail" },
      };
}

/**
 * What is known of one catalogue build wherever it is offered: its review, how its download is
 * pinned (with the hash) and its build record. The install dialog's first rows; a copy shows the
 * same for each build it installs.
 */
export function evidenceChecks(v: CatalogVersion, indexFrom: string | null = null): CheckRow[] {
  const build = buildChecks(v, indexFrom);
  return [...build.slice(0, 1), pinCheck(v), ...build.slice(1)];
}

export interface InstallCheckContext {
  tag: string;
  /** A mod's display name by id. */
  name: (id: string) => string;
  /** Ids of mods installed and on in this version. */
  enabled: Set<string>;
  /** The tier of an installed mod, by id. */
  trustOf: (id: string) => Trust | undefined;
  /** The version's mod interface, when it is known. */
  versionAbi: string | null;
  /** The day of the index reviews come from, when it isn't fresh. */
  indexFrom?: string | null;
}

/**
 * Whether a build fits the version (contract R4 §5): "yes" and "no" only when the backend knows;
 * unknown (null) is unknown, with Retry, never "no".
 */
export function fitCheck(fits: boolean | null, buildAbi: string, tag: string): CheckRow {
  const detail: RichMsg = { key: "mods.ckFitsDetail", args: [abi(buildAbi)] };
  if (fits === null) {
    return { id: "abi", state: "unknown", title: { key: "mods.ckFitUnchecked", args: [tag] }, detail: { key: "mods.ckFitUncheckedDetail" }, retry: true };
  }
  if (!fits) return { id: "abi", state: "no", title: { key: "mods.ckFileFitsNo", args: [tag] }, detail };
  return { id: "abi", state: "yes", title: { key: "mods.ckFits" }, detail };
}

function abiCheck(plan: InstallPlan, v: CatalogVersion, ctx: InstallCheckContext): CheckRow {
  // The backend's word on fit (null when the version's interface is unknown); never guessed here.
  return fitCheck(plan.fitsVersion, v.abi, ctx.tag);
}

/** What else an install brings: dependencies it downloads, turns on, or can't find. */
export function planDepChecks(plan: InstallPlan, deps: string[], ctx: InstallCheckContext): CheckRow[] {
  const rows: CheckRow[] = [];
  const planned = new Set([...plan.install.map((i) => i.id), ...plan.enable, ...plan.missing]);
  for (const item of plan.install) {
    rows.push({
      id: `dep:${item.id}`,
      state: "yes",
      title: { key: "mods.ckDepInstall", args: [item.name, item.version] },
      trust: item.trust,
    });
  }
  for (const id of plan.enable) {
    rows.push({ id: `dep:${id}`, state: "yes", title: { key: "mods.ckDepEnable", args: [ctx.name(id)] }, trust: ctx.trustOf(id) });
  }
  for (const id of plan.missing) {
    rows.push({ id: `dep:${id}`, state: "no", title: { key: "mods.ckDepMissing", args: [ctx.name(id), ctx.tag] } });
  }
  for (const id of deps) {
    if (id === "base" || planned.has(id)) continue;
    rows.push(
      ctx.enabled.has(id)
        ? { id: `dep:${id}`, state: "yes", title: { key: "mods.ckDepHave", args: [ctx.name(id)] } }
        : // Not in the plan and not on: the backend didn't say. Say that, not "fine".
          { id: `dep:${id}`, state: "unknown", title: { key: "mods.ckDepUnknown", args: [ctx.name(id)] } }
    );
  }
  return rows;
}

/**
 * The plan's problem as the first row, so the reason the button is off is the first thing read.
 * Not knowing the version's interface is not a "no" (contract R4 §5): then the fit row, unknown
 * with Retry, goes first instead and says it.
 */
export function withProblem(problem: AppErrorPayload | null, rows: CheckRow[]): CheckRow[] {
  if (!problem) return rows;
  if (problem.code === "AbiUnavailable") {
    const fit = rows.find((r) => r.id === "abi" && r.state === "unknown");
    if (fit) return [fit, ...rows.filter((r) => r !== fit)];
  }
  return [{ id: "problem", state: "no", title: { key: "mods.ckWontInstall", args: [{ error: problem }] } }, ...rows];
}

const TIER_RANK: Record<Trust, number> = { reviewed: 2, unreviewed: 1, unverified: 0 };

/**
 * An update to a build of a lower tier than the one installed (Reviewed → Unreviewed): the first
 * row, so the drop is said in words above everything else, not only by the badge.
 */
export function tierDropCheck(plan: InstallPlan): CheckRow | null {
  const r = plan.replaces;
  if (!r || TIER_RANK[plan.target.trust] >= TIER_RANK[r.trust]) return null;
  return {
    id: "tierDrop",
    state: "no",
    said: "mods.ckTierDropSaid",
    title: { key: "mods.ckTierDrop", args: [{ trust: r.trust }, { trust: plan.target.trust }] },
  };
}

/** Everything the install and update dialogs show, from the backend's plan. */
export function installChecks(plan: InstallPlan, v: CatalogVersion, ctx: InstallCheckContext): CheckRow[] {
  const rows: CheckRow[] = [];
  const drop = tierDropCheck(plan);
  if (drop) rows.push(drop);
  rows.push(...evidenceChecks(v, ctx.indexFrom ?? null));
  rows.push(abiCheck(plan, v, ctx));
  rows.push(...planDepChecks(plan, v.deps, ctx));
  return withProblem(plan.problem, rows);
}

/**
 * What the primary button does and the line that explains it. A plan with a missing dependency
 * installs the mod turned off (contract R3 §1), so Play keeps working.
 */
export function installOutcome(
  plan: InstallPlan,
  replacing: boolean,
  modName: string,
  ctx: Pick<InstallCheckContext, "tag" | "name">
): { button: MessageKey; explain: Msg | null } {
  const missingOff = !plan.turnsOn && plan.missing.length > 0 && (plan.replaces === null || plan.replaces.enabled);
  if (missingOff) {
    return {
      button: replacing ? "mods.updateTurnedOff" : "mods.installTurnedOff",
      explain: {
        key: "mods.installsOff",
        count: plan.missing.length,
        args: [formatList(plan.missing.map(ctx.name)), ctx.tag, modName],
      },
    };
  }
  return { button: replacing ? "mods.updateButton" : "mods.install", explain: null };
}

/**
 * Mods this install brings that nobody reviewed: dependencies it downloads or turns on, with
 * their tier. The warning names them, also when the mod itself is Reviewed.
 */
export function weakerDeps(plan: InstallPlan, ctx: Pick<InstallCheckContext, "name" | "trustOf">): { name: string; trust: Trust }[] {
  const out: { name: string; trust: Trust }[] = [];
  for (const i of plan.install) if (i.trust !== "reviewed") out.push({ name: i.name, trust: i.trust });
  for (const id of plan.enable) {
    const trust = ctx.trustOf(id);
    if (trust && trust !== "reviewed") out.push({ name: ctx.name(id), trust });
  }
  return out;
}

/**
 * The step to show while an operation runs: the file its newest event is about (contract R4 §3).
 * Events come in the order the backend works, so a file that finished checking and waits for
 * the final install never hides the one now downloading.
 */
export function activeStep<P extends Pick<ModProgress, "sha256">>(entries: P[]): P | undefined {
  return entries[entries.length - 1];
}

/**
 * The lines under the checks that say what an update replaces, including a rise in tier (a drop
 * is the first check row instead: tierDropCheck).
 */
export function replaceNotes(plan: InstallPlan): RichMsg[] {
  const r = plan.replaces;
  if (!r) return [];
  const notes: RichMsg[] = [];
  const old = r.version ?? shortSha(r.sha256);
  notes.push(
    r.trust !== plan.target.trust && !tierDropCheck(plan)
      ? { key: "mods.ckReplacesTrust", args: [old, { trust: r.trust }, { trust: plan.target.trust }] }
      : { key: "mods.ckReplaces", args: [old] }
  );
  if (!r.enabled) notes.push({ key: "mods.ckReplacesOff" });
  return notes;
}

/** A zip from the player's computer. */
export function fileChecks(inspection: FileInspection, tag: string, indexFrom: string | null = null): CheckRow[] {
  const rows: CheckRow[] = [];
  const { archive, catalogMatch: known } = inspection;
  if (inspection.revoked) {
    const why = (inspection.revokedReason ?? "").trim();
    rows.push({ id: "revoked", state: "no", title: why ? { key: "mods.ckRevoked", args: [why] } : { key: "mods.ckRevokedNoReason" } });
  }
  if (known) {
    rows.push({ id: "known", state: "yes", title: { key: "mods.ckFileKnown", args: [known.name, known.build.version] } });
    rows.push(...buildChecks(known.build, indexFrom));
    rows.push(fitCheck(known.fitsVersion, known.build.abi, tag));
  } else if (archive) {
    rows.push({ id: "known", state: "no", title: { key: "mods.ckFileNotKnown" } });
    rows.push({ id: "provenance", state: "unknown", title: { key: "mods.ckNoBuild" }, detail: { key: "mods.ckNoBuildDetail" } });
    rows.push({
      id: "abi",
      state: "unknown",
      title: { key: "mods.ckFileFitUnknown" },
      detail: { key: "mods.ckFileFitUnknownDetail" },
    });
  }
  if (archive) {
    const contents = formatList([...archive.libraries, ...(archive.hasAssets ? ["assets/"] : [])]);
    rows.push(
      inspection.fitsSystem
        ? { id: "contents", state: "yes", title: { key: "mods.ckLooksLikeMod" }, detail: { key: "mods.ckLooksLikeModDetail", args: [contents] } }
        : {
            id: "contents",
            state: "no",
            title: { key: "mods.ckNotForSystem" },
            detail: { key: "mods.ckNotForSystemDetail", args: [formatList(archive.platforms.map(platformLabel))] },
          }
    );
  } else {
    rows.push({
      id: "contents",
      state: "no",
      title: { key: "mods.ckNotAMod" },
      detail: inspection.problem ? { key: "mods.ckNotAModDetail", args: [{ error: inspection.problem }] } : undefined,
    });
  }
  return rows;
}

const PLATFORM_LABEL: Record<string, string> = {
  "windows-x64": "Windows",
  "linux-x64": "Linux",
  "macos-arm64": "macOS",
};

export function platformLabel(p: string): string {
  return PLATFORM_LABEL[p] ?? p;
}

/** Whether a file can be installed, and whether it needs the typed confirmation. */
export function fileVerdict(inspection: FileInspection): { usable: boolean; needsTyping: boolean } {
  const { archive, catalogMatch: known } = inspection;
  // Unknown fit isn't "no": the plan's own problem (if any) says whether it can install.
  const usable = !!archive && inspection.fitsSystem && !inspection.revoked && (known === null || known.fitsVersion !== false);
  return { usable, needsTyping: usable && known === null };
}

/**
 * What replacing an installed mod with a file means: the version it replaces, and a change of
 * tier when there is one, e.g. a Reviewed build replaced by an Unverified file.
 */
export function fileReplaceNotes(inspection: FileInspection, installedTrust: Trust | undefined): RichMsg[] {
  if (!inspection.replaces) return [];
  const now: Trust = inspection.catalogMatch?.build.trust ?? "unverified";
  if (installedTrust && installedTrust !== now) {
    return [{ key: "mods.fileReplacesTrust", args: [inspection.replaces, { trust: installedTrust }, { trust: now }] }];
  }
  return [{ key: "mods.fileReplaces", args: [inspection.replaces] }];
}

/** What a player agreed to, in the terms a change to it is told in. */
export interface ConsentView {
  /** Builds that will be installed. */
  builds: { id: string; name: string; version: string | null; trust: Trust | null }[];
  /** Installed mods that will be turned on. */
  enable: string[];
  /** Mods that will be installed turned off. */
  off: string[];
}

export function planConsent(plan: InstallPlan): ConsentView {
  return {
    builds: [plan.target, ...plan.install].map((i) => ({ id: i.id, name: i.name, version: i.version, trust: i.trust })),
    enable: plan.enable,
    off: plan.turnsOn || (plan.replaces && !plan.replaces.enabled) ? [] : [plan.target.id],
  };
}

export function copyConsentView(preview: CopyPreview): ConsentView {
  return {
    builds: [
      ...preview.items.filter((i) => i.outcome === "install").map((i) => ({ id: i.id, name: i.name, version: i.version, trust: i.trust })),
      ...preview.deps.map((d) => ({ id: d.id, name: d.name, version: d.version, trust: d.trust })),
    ],
    enable: preview.enable,
    off: preview.installedOff,
  };
}

/**
 * What changed between the plan the player saw and the one there is now, after the backend
 * refused the old one (`ModChangedMeanwhile`). One line per change; when the difference isn't one
 * the player can see (the version's interface, say), one line that says it changed.
 */
export function consentChanges(before: ConsentView, after: ConsentView, name: (id: string) => string): RichMsg[] {
  const out: RichMsg[] = [];
  const old = new Map(before.builds.map((b) => [b.id, b]));
  const now = new Map(after.builds.map((b) => [b.id, b]));
  for (const b of after.builds) {
    const was = old.get(b.id);
    if (!was) out.push({ key: "mods.changedAdded", args: [b.name, b.version ?? ""] });
    else if (was.version !== b.version) out.push({ key: "mods.changedVersion", args: [b.name, b.version ?? "", was.version ?? ""] });
    if (was && b.trust && was.trust && was.trust !== b.trust) out.push({ key: "mods.changedTrust", args: [b.name, { trust: b.trust }] });
  }
  for (const b of before.builds) if (!now.has(b.id)) out.push({ key: "mods.changedDropped", args: [b.name] });
  for (const id of after.enable) if (!before.enable.includes(id)) out.push({ key: "mods.changedEnables", args: [name(id)] });
  for (const id of before.enable) if (!after.enable.includes(id)) out.push({ key: "mods.changedNoEnable", args: [name(id)] });
  for (const id of after.off) if (!before.off.includes(id)) out.push({ key: "mods.changedOff", args: [name(id)] });
  for (const id of before.off) if (!after.off.includes(id)) out.push({ key: "mods.changedOn", args: [name(id)] });
  return out.length ? out : [{ key: "mods.changedOther" }];
}
