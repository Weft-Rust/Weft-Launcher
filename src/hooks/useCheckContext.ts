import { useMemo } from "react";
import { useI18n } from "../i18n/useI18n";
import type { InstallCheckContext } from "../mods/checks";
import { useMods } from "./useMods";

/** What the plan checks need from a version's set and the catalogue. */
export function useCheckContext(tag: string): InstallCheckContext {
  const { profile, nameIn, catalog } = useMods();
  const { formatDay } = useI18n();
  const report = profile(tag);
  const index = catalog?.index;
  const indexFrom = index && index.freshness !== "fresh" ? formatDay(index.signedAt ?? index.generated) || null : null;
  return useMemo(() => {
    const mods = report?.mods ?? [];
    return {
      tag,
      name: nameIn(tag),
      enabled: new Set(mods.filter((m) => m.enabled).map((m) => m.id)),
      trustOf: (id: string) => mods.find((m) => m.id === id)?.trust,
      versionAbi: report?.versionAbi ?? null,
      indexFrom,
    };
  }, [tag, report, nameIn, indexFrom]);
}
