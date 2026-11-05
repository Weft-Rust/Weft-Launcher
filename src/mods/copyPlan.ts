// What a copy will do, for the consent the copy dialog asks: each mod it brings, and everything
// those bring along, all from the backend's copy preview. Pure, so it is tested without React.

import type { MessageKey } from "../i18n";
import type { CopyItem, CopyPreview, ProfileReport, Trust } from "./types";
import type { CheckState } from "./checks";

export const COPY_OUTCOME: Record<CopyItem["outcome"], { state: CheckState; key: MessageKey }> = {
  install: { state: "yes", key: "mods.copyWillInstall" },
  alreadyThere: { state: "same", key: "mods.copyAlreadyThere" },
  noBuild: { state: "no", key: "mods.copyNoBuild" },
  localFile: { state: "no", key: "mods.copyLocalFile" },
  revoked: { state: "no", key: "mods.copyRevoked" },
};

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

/** The consent for a copy: the preview's items, dependencies and turn-ons, with names and trust. */
export function copyConsent(preview: CopyPreview, target: ProfileReport | undefined): CopyConsent {
  const items = preview.items.filter((i) => i.outcome === "install");
  const deps = preview.deps.map((d) => ({ id: d.id, name: d.name, version: d.version, trust: d.trust, sha256: d.sha256 }));
  const enable = preview.enable.map((id) => {
    const mod = target?.mods.find((m) => m.id === id);
    return { id, name: mod?.name ?? id, trust: mod?.trust ?? ("unverified" as Trust) };
  });
  return {
    items,
    deps,
    enable,
    missing: preview.missing,
    installedOff: preview.installedOff,
    unreviewed: [
      ...items.filter((i) => i.trust !== "reviewed").map((i) => i.name),
      ...deps.filter((d) => d.trust !== "reviewed").map((d) => d.name),
      ...enable.filter((e) => e.trust !== "reviewed").map((e) => e.name),
    ],
    shas: [...items.flatMap((i) => (i.sha256 ? [i.sha256] : [])), ...deps.map((d) => d.sha256)],
  };
}
