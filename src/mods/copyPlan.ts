// What a copy will do, for the consent the copy dialog asks: each mod it brings, and everything
// those bring along. The preview says what each copied mod gets; the backend's install plan for
// each of them (plan_mod_install) says what it needs. Pure, so it is tested without React.

import type { MessageKey } from "../i18n";
import type { Catalog, CopyItem, CopyPreview, InstallPlan, ProfileReport, Trust } from "./types";
import type { CheckState } from "./checks";
import { catalogModFor, fittingVersions } from "./select";

export const COPY_OUTCOME: Record<CopyItem["outcome"], { state: CheckState; key: MessageKey }> = {
  install: { state: "yes", key: "mods.copyWillInstall" },
  alreadyThere: { state: "unknown", key: "mods.copyAlreadyThere" },
  noBuild: { state: "no", key: "mods.copyNoBuild" },
  localFile: { state: "no", key: "mods.copyLocalFile" },
  revoked: { state: "no", key: "mods.copyRevoked" },
};

/** The catalogue build a copied mod installs: the one the preview names, for the target version. */
export function copyItemSha(item: CopyItem, from: ProfileReport | undefined, catalog: Catalog | null, abi: string | null): string | null {
  if (item.outcome !== "install" || !item.version) return null;
  const entry = from?.mods.find((m) => m.id === item.id);
  const mod = entry ? catalogModFor(catalog, entry) : undefined;
  if (!mod) return null;
  return fittingVersions(catalog, mod, abi, true).find((v) => v.version === item.version)?.sha256 ?? null;
}

export interface CopyConsent {
  /** The copied mods that will be installed. */
  items: CopyItem[];
  /** What they need that isn't in the target or in the copy: downloaded too. */
  deps: { id: string; name: string; version: string; trust: Trust; sha256: string }[];
  /** Mods of the target, now off, that the copied mods turn on. */
  enable: { id: string; name: string; trust: Trust }[];
  /** What nothing provides for the target version. */
  missing: string[];
  /** Copied mods that are installed turned off because of that. */
  installedOff: string[];
  /** Everything this brings that nobody reviewed, by name. */
  unreviewed: string[];
  /** Every hash the copy downloads, in plan order: what its progress will show. */
  shas: string[];
}

/** Puts the preview and the per-mod plans together, each dependency once. */
export function copyConsent(preview: CopyPreview, plans: Map<string, InstallPlan>, target: ProfileReport | undefined): CopyConsent {
  const items = preview.items.filter((i) => i.outcome === "install");
  const copied = new Set(items.map((i) => i.id));
  const out: CopyConsent = { items, deps: [], enable: [], missing: [], installedOff: [], unreviewed: [], shas: [] };
  for (const item of items) {
    const plan = plans.get(item.id);
    if (!plan) continue;
    out.shas.push(plan.target.sha256);
    if (!plan.turnsOn && plan.missing.length) out.installedOff.push(item.id);
    for (const d of plan.install) {
      if (copied.has(d.id) || out.deps.some((x) => x.id === d.id)) continue;
      out.deps.push({ id: d.id, name: d.name, version: d.version, trust: d.trust, sha256: d.sha256 });
      out.shas.push(d.sha256);
    }
    for (const id of plan.enable) {
      if (out.enable.some((x) => x.id === id)) continue;
      const mod = target?.mods.find((m) => m.id === id);
      out.enable.push({ id, name: mod?.name ?? id, trust: mod?.trust ?? "unverified" });
    }
    for (const id of plan.missing) if (!out.missing.includes(id)) out.missing.push(id);
  }
  out.unreviewed = [
    ...items.filter((i) => i.trust !== "reviewed").map((i) => i.name),
    ...out.deps.filter((d) => d.trust !== "reviewed").map((d) => d.name),
    ...out.enable.filter((e) => e.trust !== "reviewed").map((e) => e.name),
  ];
  return out;
}
