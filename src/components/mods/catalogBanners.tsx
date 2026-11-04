import type { MessageKey } from "../../i18n";
import { useI18n } from "../../i18n/useI18n";
import { useMods } from "../../hooks/useMods";
import type { Catalog, SourceStatus } from "../../mods/types";
import type { BannerItem } from "./BannerStack";

type T = (key: MessageKey, ...args: string[]) => string;

/** Why a source couldn't be refreshed and what is shown instead, as whole sentences. */
export function sourceProblem(s: SourceStatus, t: T, formatDay: (iso: string | null) => string): string {
  const code = s.error?.code;
  const cause =
    code === "ModSourceRateLimited" || code === "RateLimited"
      ? t("mods.sourceErrRate", s.repo)
      : code === "ModSourceNotFound"
        ? t("mods.sourceErrGone", s.repo)
        : t("mods.sourceErrNetwork", s.repo);
  const shown =
    s.freshness === "unavailable" || !s.checked ? t("mods.sourceShowingNone") : t("mods.sourceShowingFrom", formatDay(s.checked));
  return `${cause} ${shown}`;
}

function indexProblem(index: Catalog["index"], t: T, formatDay: (iso: string | null) => string): string | null {
  if (index.freshness === "fresh" && !index.error) return null;
  const code = index.error?.code;
  const cause =
    code === "IndexSignatureInvalid" || code === "IndexInvalid"
      ? t("mods.indexInvalid")
      : code === "IndexRollback"
        ? t("mods.indexRollback")
        : t("mods.indexUnreachable");
  return index.freshness === "unavailable" || !index.generated
    ? `${cause} ${t("mods.indexNone")}`
    : `${t("mods.indexShowingFrom", formatDay(index.generated))} ${cause}`;
}

/** The catalogue's quiet notices for Browse: a stale index, sources that failed, each with a way forward. */
export function useCatalogBanners(onManageSources: () => void): BannerItem[] {
  const { t, formatDay } = useI18n();
  const { catalog, catalogLoading, refreshCatalog } = useMods();
  if (!catalog) return [];
  const retry = (
    <button className="btn-secondary btn-small" onClick={refreshCatalog} disabled={catalogLoading}>
      {catalogLoading ? t("mods.retrying") : t("mods.retry")}
    </button>
  );
  const items: BannerItem[] = [];
  const index = indexProblem(catalog.index, t, formatDay);
  if (index) {
    items.push({
      id: "index",
      tone: catalog.index.freshness === "cached" ? "info" : "warn",
      text: index,
      summary: index,
      actions: retry,
    });
  }
  for (const s of catalog.sources.filter((x) => x.error)) {
    const text = sourceProblem(s, t, formatDay);
    items.push({
      id: `source:${s.repo}`,
      tone: "warn",
      text,
      summary: text,
      actions: (
        <>
          {retry}
          <button className="btn-secondary btn-small" onClick={onManageSources}>
            {t("mods.manageSources")}
          </button>
        </>
      ),
    });
  }
  return items;
}
