import type { MessageKey } from "../../i18n";
import { useI18n } from "../../i18n/useI18n";
import { useMods } from "../../hooks/useMods";
import type { Catalog, ErrorCode, SourceStatus } from "../../mods/types";
import type { BannerItem } from "./BannerStack";
import { showError } from "../../i18n/errors";
import { ErrorDetails } from "../ErrorText";

type T = (key: MessageKey, ...args: string[]) => string;

/** Why a refresh failed, by what the player can do about it. */
function cause(code: ErrorCode | undefined): "rate" | "gone" | "invalid" | "disk" | "server" | "network" {
  switch (code) {
    case "ModSourceRateLimited":
    case "RateLimited":
      return "rate";
    case "ModSourceNotFound":
      return "gone";
    case "ModSourceInvalid":
    case "IndexInvalid":
    case "Serde":
      return "invalid";
    case "DiskFull":
    case "Io":
    case "CreateDir":
      return "disk";
    // It answered: never said as offline.
    case "HttpStatus":
      return "server";
    default:
      return "network";
  }
}

/** The cause in a few words, for the folded row; the repo follows it. */
const SOURCE_SHORT: Record<ReturnType<typeof cause>, MessageKey> = {
  rate: "mods.sourceCauseRate",
  gone: "mods.sourceCauseGone",
  invalid: "mods.sourceCauseInvalid",
  disk: "mods.sourceCauseDisk",
  server: "mods.sourceCauseServer",
  network: "mods.sourceCauseNetwork",
};

const SOURCE_CAUSE: Record<ReturnType<typeof cause>, MessageKey> = {
  rate: "mods.sourceErrRate",
  gone: "mods.sourceErrGone",
  invalid: "mods.sourceErrInvalid",
  disk: "mods.sourceErrDisk",
  server: "mods.sourceErrServer",
  network: "mods.sourceErrNetwork",
};

/** Why a source couldn't be refreshed and what is shown instead, as whole sentences. */
export function sourceProblem(s: SourceStatus, t: T, formatDay: (iso: string | null) => string): string {
  const shown =
    s.freshness === "unavailable" || !s.checked ? t("mods.sourceShowingNone") : t("mods.sourceShowingFrom", formatDay(s.checked));
  return `${t(SOURCE_CAUSE[cause(s.error?.code)], s.repo)} ${shown}`;
}

/** A new index arrived and was refused (bad signature, malformed, older than one accepted). */
const refused = (code: ErrorCode | undefined) => code === "IndexSignatureInvalid" || code === "IndexInvalid" || code === "IndexRollback";

/** The index's state as a sentence, or null when it is fresh. */
export function indexProblem(index: Catalog["index"], t: T, formatDay: (iso: string | null) => string): string | null {
  if (index.freshness === "fresh" && !index.error) return null;
  if (index.freshness === "stale" && !index.error) return t("mods.indexStale", formatDay(index.signedAt ?? index.generated));
  const code = index.error?.code;
  const why =
    code === "IndexSignatureInvalid" || code === "IndexInvalid"
      ? t("mods.indexInvalid")
      : code === "IndexRollback"
        ? t("mods.indexRollback")
        : cause(code) === "disk"
          ? t("mods.indexDisk")
          : cause(code) === "server"
            ? t("mods.indexServerError")
            : t("mods.indexUnreachable");
  // Say why, also when there is nothing saved to show instead.
  if (index.freshness === "unavailable" || !index.generated) return `${t("mods.indexUnavailable")} ${why}`;
  return `${t("mods.indexShowingFrom", formatDay(index.generated))} ${why}`;
}

/** The index's state in a few words, for the folded row. */
export function indexSummary(index: Catalog["index"], t: T, formatDay: (iso: string | null) => string): string | null {
  if (index.freshness === "fresh" && !index.error) return null;
  if (index.freshness === "unavailable" || !index.generated) {
    return index.error && cause(index.error.code) === "network" && !refused(index.error.code) ? t("mods.indexUnreachableShort") : t("mods.indexUnavailableShort");
  }
  const day = formatDay(index.signedAt ?? index.generated);
  if (index.freshness === "stale" && !index.error) return t("mods.indexStaleShort", day);
  // A refused index is never "offline": the network worked, and what came was not accepted.
  if (refused(index.error?.code)) return t("mods.indexRefusedShort", day);
  return cause(index.error?.code) === "network" ? t("mods.indexOfflineShort", day) : t("mods.indexCachedShort", day);
}

/**
 * The catalogue's notes, by the ids `bannerPlan` places: a refresh that failed while an older
 * catalogue still shows, the index's state, and sources that failed, each with its cause in
 * words, the backend's own words behind Details, and a way forward.
 */
export function useCatalogBanners(onManageSources: () => void): Record<string, BannerItem> {
  const { t, formatDay } = useI18n();
  const { catalog, catalogLoading, catalogError, refreshCatalog, refreshSource, sourceRefreshing } = useMods();
  if (!catalog) return {};
  const retry = (
    <button className="btn-flat" onClick={refreshCatalog} disabled={catalogLoading}>
      {catalogLoading ? t("mods.retrying") : t("mods.retry")}
    </button>
  );
  const retryOne = (repo: string) => (
    <button className="btn-flat" onClick={() => refreshSource(repo)} disabled={sourceRefreshing(repo)} aria-label={t("mods.sourceRetryLabel", repo)}>
      {sourceRefreshing(repo) ? t("mods.retrying") : t("mods.retry")}
    </button>
  );
  const out: Record<string, BannerItem> = {};
  if (catalogError) {
    const shown = showError(catalogError);
    out.refresh = {
      id: "refresh",
      tone: "warn",
      text: (
        <>
          {t("mods.refreshFailed")} {shown.message}
          {shown.detail && <ErrorDetails detail={shown.detail} label={t("errors.details")} />}
        </>
      ),
      cause: t("mods.refreshFailedShort"),
      actions: retry,
    };
  }
  const index = indexProblem(catalog.index, t, formatDay);
  if (index) {
    const e = catalog.index.error;
    const detail = e ? showError(e).detail : null;
    out.index = {
      id: "index",
      tone: catalog.index.freshness === "cached" && !refused(catalog.index.error?.code) ? "info" : "warn",
      text: (
        <>
          {index}
          {detail && <ErrorDetails detail={detail} label={t("errors.details")} />}
        </>
      ),
      cause: indexSummary(catalog.index, t, formatDay) ?? index,
      actions: retry,
    };
  }
  if (!index && catalog.index.cacheError) {
    // Fresh and in use, but not saved: said, since offline after a restart it won't be there.
    const detail = showError(catalog.index.cacheError).detail;
    out.index = {
      id: "index",
      tone: "info",
      text: (
        <>
          {t("mods.indexUnsaved")}
          {detail && <ErrorDetails detail={detail} label={t("errors.details")} />}
        </>
      ),
      cause: t("mods.indexUnsavedShort"),
    };
  }
  if (catalog.sourcesError) {
    // Kept aside, never read as "no sources": where it is, behind Details.
    out.sourcesDamaged = {
      id: "sourcesDamaged",
      tone: "warn",
      text: (
        <>
          {t("mods.sourcesDamaged")}
          {catalog.sourcesError.detail && <ErrorDetails detail={catalog.sourcesError.detail} label={t("errors.details")} />}
        </>
      ),
      cause: t("mods.sourcesDamagedShort"),
      actions: (
        <button className="btn-flat" onClick={onManageSources}>
          {t("mods.manageSources")}
        </button>
      ),
    };
  }
  for (const s of catalog.sources.filter((x) => x.error)) {
    const text = sourceProblem(s, t, formatDay);
    out[`source:${s.repo}`] = {
      id: `source:${s.repo}`,
      tone: "warn",
      text,
      cause: t(SOURCE_SHORT[cause(s.error?.code)]),
      subject: s.repo,
      // This source alone, asked again: the others keep their answers and nothing waits on them.
      foldActions: retryOne(s.repo),
      actions: (
        <>
          {retryOne(s.repo)}
          <button className="btn-flat" onClick={onManageSources}>
            {t("mods.manageSources")}
          </button>
        </>
      ),
    };
  }
  return out;
}
