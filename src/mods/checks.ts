// What the install dialogs say was checked, decided from backend data only. No JSX and no
// translation: rows are message keys with arguments, rendered by components/mods/CheckList.

import type { MessageKey } from "../i18n";
import type { AppErrorPayload, CatalogVersion, FileInspection, InstallPlan, Trust } from "./types";
import { shortCommit, shortSha } from "./select";

export type CheckState = "yes" | "no" | "unknown";

/** One argument of a message: text, a shortened value whose full form stays reachable, an error or a tier name. */
export type Arg =
  | string
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
}

const sha = (s: string) => ({ code: s, short: shortSha(s) });
const abi = (s: string) => ({ code: s, short: s.slice(0, 8) });
const commit = (s: string) => ({ code: s, short: shortCommit(s) });

/** Review and provenance of one catalogue build, the same wherever a build is shown. */
export function buildChecks(v: CatalogVersion): CheckRow[] {
  const rows: CheckRow[] = [];
  if (v.trust === "reviewed" && v.reviewed) {
    rows.push({
      id: "review",
      state: "yes",
      title: { key: "mods.ckIndex" },
      detail: { key: "mods.ckIndexDetail", args: [v.reviewed.by, v.reviewed.at] },
    });
  } else {
    rows.push({
      id: "review",
      state: "no",
      title: { key: "mods.ckNotIndex" },
      detail: { key: "mods.ckNotIndexDetail", args: [v.sourceRepo] },
    });
  }
  const workflow = v.provenance?.workflow?.split("/").pop() ?? "—";
  if (v.provenance && v.provenanceVerified) {
    rows.push({
      id: "provenance",
      state: "yes",
      title: { key: "mods.ckBuilt" },
      detail: { key: "mods.ckBuiltDetail", args: [v.provenance.repo ?? v.sourceRepo, commit(v.sourceCommit), workflow] },
    });
  } else if (v.provenance) {
    // The repo's own <id>.mod.json says so. Nothing checked it, so it can't be a green check.
    rows.push({
      id: "provenance",
      state: "unknown",
      title: { key: "mods.ckBuiltClaimed" },
      detail: {
        key: "mods.ckBuiltClaimedDetail",
        args: [v.provenance.repo ?? v.sourceRepo, commit(v.sourceCommit), workflow],
      },
    });
  } else {
    rows.push({ id: "provenance", state: "unknown", title: { key: "mods.ckNoBuild" }, detail: { key: "mods.ckNoBuildDetail" } });
  }
  return rows;
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

export interface InstallCheckContext {
  tag: string;
  /** A mod's display name by id. */
  name: (id: string) => string;
  /** Ids of mods installed and on in this version. */
  enabled: Set<string>;
}

/** Everything the install and update dialogs show, from the backend's plan. */
export function installChecks(plan: InstallPlan, v: CatalogVersion, ctx: InstallCheckContext): CheckRow[] {
  const rows: CheckRow[] = [];
  if (plan.problem) {
    rows.push({ id: "problem", state: "no", title: { key: "mods.ckWontInstall", args: [{ error: plan.problem }] } });
  }
  rows.push(...buildChecks(v).slice(0, 1), pinCheck(v), ...buildChecks(v).slice(1));
  const incompatible = plan.problem?.code === "ModIncompatible";
  rows.push({
    id: "abi",
    state: incompatible ? "no" : "yes",
    title: { key: incompatible ? "mods.ckFileFitsNo" : "mods.ckFits", args: incompatible ? [ctx.tag] : [] },
    detail: { key: "mods.ckFitsDetail", args: [abi(v.abi)] },
  });

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
    rows.push({ id: `dep:${id}`, state: "yes", title: { key: "mods.ckDepEnable", args: [ctx.name(id)] } });
  }
  for (const id of plan.missing) {
    rows.push({ id: `dep:${id}`, state: "no", title: { key: "mods.ckDepMissing", args: [ctx.name(id), ctx.tag] } });
  }
  for (const id of v.deps) {
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

/** The lines under the checks that say what an update replaces, including a change of tier. */
export function replaceNotes(plan: InstallPlan): RichMsg[] {
  const r = plan.replaces;
  if (!r) return [];
  const notes: RichMsg[] = [];
  const old = r.version ?? shortSha(r.sha256);
  notes.push(
    r.trust !== plan.target.trust
      ? { key: "mods.ckReplacesTrust", args: [old, { trust: r.trust }, { trust: plan.target.trust }] }
      : { key: "mods.ckReplaces", args: [old] }
  );
  if (!r.enabled) notes.push({ key: "mods.ckReplacesOff" });
  return notes;
}

/** A zip from the player's computer. */
export function fileChecks(inspection: FileInspection, tag: string): CheckRow[] {
  const rows: CheckRow[] = [];
  const { archive, catalogMatch: known } = inspection;
  if (inspection.revokedReason) {
    rows.push({ id: "revoked", state: "no", title: { key: "mods.ckRevoked", args: [inspection.revokedReason] } });
  }
  if (known) {
    rows.push({ id: "known", state: "yes", title: { key: "mods.ckFileKnown", args: [known.name, known.build.version] } });
    rows.push(...buildChecks(known.build));
    rows.push(
      known.fitsVersion
        ? { id: "abi", state: "yes", title: { key: "mods.ckFits" }, detail: { key: "mods.ckFitsDetail", args: [abi(known.build.abi)] } }
        : { id: "abi", state: "no", title: { key: "mods.ckFileFitsNo", args: [tag] } }
    );
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
    const contents = `${archive.libraries.join(", ")}${archive.hasAssets ? ", assets/" : ""}`;
    rows.push(
      inspection.fitsSystem
        ? { id: "contents", state: "yes", title: { key: "mods.ckLooksLikeMod" }, detail: { key: "mods.ckLooksLikeModDetail", args: [contents] } }
        : {
            id: "contents",
            state: "no",
            title: { key: "mods.ckNotForSystem" },
            detail: { key: "mods.ckNotForSystemDetail", args: [archive.platforms.map(platformLabel).join(", ")] },
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
  const usable = !!archive && inspection.fitsSystem && !inspection.revokedReason && (known === null || known.fitsVersion);
  return { usable, needsTyping: usable && known === null };
}
