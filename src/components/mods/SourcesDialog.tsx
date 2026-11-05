import { useEffect, useId, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../i18n/useI18n";
import { showError, type Shown } from "../../i18n/errors";
import { ErrorDetails, ErrorText } from "../ErrorText";
import { useMods } from "../../hooks/useMods";
import { parseRepo, sameRepo } from "../../mods/select";
import { Dialog } from "../Dialog";
import { Truncate } from "../Truncate";
import { PixelIcon } from "../PixelIcon";
import { BANG, CHECK } from "./glyphs";
import { indexProblem, sourceProblem } from "./catalogBanners";
import type { Catalog, NoModsReason, SourceStatus } from "../../mods/types";
import type { MessageKey } from "../../i18n";

const INDEX_REPO = "https://github.com/Zorro909/weft-mods-index";
/** What a repo must publish to be a source. */
const SOURCE_FORMAT = "https://github.com/Zorro909/Weft-Launcher/blob/master/docs/mod-manager/INDEX_FORMAT.md#publishing-from-your-own-repo";

/** One whole sentence per reason, so each language words it in its own order. */
const NO_MODS: Record<NoModsReason, MessageKey> = {
  noReleases: "mods.sourceNoModsLineNoReleases",
  noModFiles: "mods.sourceNoModsLineNoFiles",
  unreadable: "mods.sourceNoModsLineUnreadable",
  noDigest: "mods.sourceNoModsLineNoDigest",
  disagrees: "mods.sourceNoModsLineDisagrees",
  invalid: "mods.sourceNoModsLineInvalid",
};

/**
 * The index's own state, not a mod's tier: a mod is Reviewed; the index is signed, and its
 * signature checked on a day. Amber when that signature is old, or only a saved copy is used.
 */
function IndexBadge({ index }: { index: Catalog["index"] | undefined }) {
  const { t, formatDay } = useI18n();
  if (!index || index.freshness === "unavailable" || !index.generated) {
    return (
      <span className="badge index-badge none" data-state="none">
        <PixelIcon rows={BANG} />
        {t("mods.indexBadgeNone")}
      </span>
    );
  }
  const day = formatDay(index.signedAt ?? index.generated);
  const ok = index.freshness === "fresh" && !index.error;
  return (
    <span className={`badge index-badge ${ok ? "ok" : "stale"}`} data-state={ok ? "ok" : index.freshness}>
      <PixelIcon rows={ok ? CHECK : BANG} />
      {t(ok ? "mods.indexBadgeSigned" : index.freshness === "stale" ? "mods.indexBadgeStale" : "mods.indexBadgeCopy", day)}
    </span>
  );
}

/** A source's line: how many mods, when checked, and when there are none, why. */
function sourceMeta(s: SourceStatus | undefined, checking: boolean, t: (k: MessageKey, ...a: string[]) => string, tn: (k: "mods.sourcesMods", n: number) => string, formatDay: (iso: string | null) => string) {
  if (!s || (!s.checked && !s.error)) return checking ? t("mods.sourcesChecking") : t("mods.sourcesNotChecked");
  if (s.mods === 0 && s.noMods) return t(NO_MODS[s.noMods]);
  return [tn("mods.sourcesMods", s.mods), s.checked ? t("mods.sourcesChecked", formatDay(s.checked)) : ""].filter(Boolean).join(" · ");
}

export function SourcesDialog({ onClose }: { onClose: () => void }) {
  const { t, tn, formatDay } = useI18n();
  const mods = useMods();
  const { catalog, catalogError, catalogLoading, refreshCatalog, refreshSource, sourceRefreshing, sourceList: repos, sourceChange } = mods;
  const loadError = mods.sourceListError ? showError(mods.sourceListError) : null;
  // The list couldn't be read and was kept aside: adding a source starts a new one.
  const damaged = mods.sourceListError?.code === "ModSourcesDamaged";
  const [input, setInput] = useState("");
  const [error, setError] = useState<Shown | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ repo: string; error: Shown } | null>(null);
  const [changed, setChanged] = useState(false);
  const inputId = useId();
  const errorId = useId();
  const adding = sourceChange?.kind === "add";
  const removing = sourceChange?.kind === "remove" ? sourceChange.repo : null;

  const load = mods.loadSources;
  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    if (sourceChange || !input.trim()) return;
    const repo = parseRepo(input);
    if (!repo) {
      setError(showError({ code: "ModSourceInvalid", detail: input.trim() }));
      return;
    }
    setError(null);
    const r = await mods.addSource(repo);
    if (r.status === "failed") return setError(r.shown);
    if (r.status !== "done") return;
    setInput("");
    // Asked at once, alone, so the dialog says what the new source has before it closes.
    retrySource(repo);
  };

  const remove = async (repo: string) => {
    if (sourceChange) return;
    setRowError(null);
    const r = await mods.removeSource(repo);
    if (r.status === "failed") return setRowError({ repo, error: r.shown });
    if (r.status !== "done") return;
    setConfirming(null);
    setChanged(true);
  };

  /** One source asked again; a failure to even ask is said on its row. */
  const retrySource = async (repo: string) => {
    setRowError(null);
    const failed = await refreshSource(repo);
    if (failed) setRowError({ repo, error: showError(failed) });
  };

  const close = () => {
    if (changed) refreshCatalog();
    onClose();
  };

  const locked = adding || removing !== null;
  const status = (repo: string) => catalog?.sources.find((s) => sameRepo(s.repo, repo));
  const index = catalog?.index;
  // The same words as the banner on the Mods tab: stale, cached and why, or never reached.
  const indexMeta = !index
    ? t("mods.sourcesIndexNone")
    : index.freshness === "fresh" && !index.error
      ? t("mods.sourcesIndexFresh")
      : index.freshness === "stale" && !index.error
        ? t("mods.sourcesIndexStale", formatDay(index.signedAt ?? index.generated))
        : (indexProblem(index, t, formatDay) ?? t("mods.sourcesIndexNone"));
  const retry = (
    <button className="btn-secondary btn-small" onClick={refreshCatalog} disabled={catalogLoading || locked}>
      {catalogLoading ? t("mods.retrying") : t("mods.sourcesRetry")}
    </button>
  );

  return (
    <Dialog
      onClose={close}
      locked={locked}
      title={t("mods.sourcesTitle")}
      footer={
        <button className="btn-secondary" onClick={close} disabled={locked} data-autofocus>
          {t("mods.close")}
        </button>
      }
    >
      <p className="dialog-summary">{t("mods.sourcesIntro")}</p>
      <ul className="source-list">
        <li className="source-row">
          <span className="source-title">
            <span className="source-name">{t("mods.sourcesIndex")}</span>
            <IndexBadge index={index} />
          </span>
          <span className={`source-meta${index?.error || index?.freshness === "stale" ? " bad" : ""}`} data-testid="index-meta">
            {indexMeta}
            {/* The backend's words, apart from ours, folded like every other error's. */}
            {index?.error && showError(index.error).detail && <ErrorDetails detail={showError(index.error).detail!} label={t("errors.details")} />}
            {index?.cacheError && (
              <span className="source-unsaved">
                {" "}
                {t("mods.sourcesIndexUnsaved")}
                {showError(index.cacheError).detail && <ErrorDetails detail={showError(index.cacheError).detail!} label={t("errors.details")} />}
              </span>
            )}
          </span>
          <span className="source-actions">
            {(index?.error || index?.freshness === "stale") && retry}
            <button className="link-btn" onClick={() => openUrl(INDEX_REPO)}>
              {t("mods.viewSource")}
            </button>
          </span>
        </li>
        {catalogError && catalog && (
          <li className="source-row source-refresh">
            <ErrorText error={showError(catalogError)} lead={t("mods.refreshFailed")} className="source-meta bad" speak={false} />
          </li>
        )}
        {repos?.map((repo) => {
          const s = status(repo);
          const asking = confirming !== null && sameRepo(confirming, repo);
          const working = removing !== null && sameRepo(removing, repo);
          const none = !!s && !s.error && s.mods === 0 && !!s.noMods;
          const asked = sourceRefreshing(repo);
          return (
            <li className={`source-row${asking ? " confirming" : ""}`} key={repo} data-repo={repo}>
              <span className="source-title">
                <Truncate focusable className="source-name" text={repo} />
                <span className="badge channel">{t("mods.sourceBadgeRepo")}</span>
              </span>
              <span className={`source-meta${s?.error ? " bad" : none ? " warn" : ""}`} data-testid="source-meta">
                {asked ? t("mods.sourcesChecking") : s?.error ? sourceProblem(s, t, formatDay) : sourceMeta(s, catalogLoading, t, tn, formatDay)}
                {none && (
                  <>
                    {" "}
                    <button className="link-btn" onClick={() => openUrl(SOURCE_FORMAT)}>
                      {t("mods.sourceFormatLink")}
                    </button>
                  </>
                )}
              </span>
              {(s?.error || asked) && !asking && (
                <span className="source-row-retry">
                  <button
                    className="btn-secondary btn-small"
                    onClick={() => retrySource(repo)}
                    disabled={asked || locked}
                    aria-label={t("mods.sourceRetryLabel", repo)}
                  >
                    {asked ? t("mods.retrying") : t("mods.sourcesRetry")}
                  </button>
                </span>
              )}
              {asking ? (
                <span className="source-confirm">
                  <span className="source-confirm-text">{t("mods.sourcesRemoveConfirm", repo)}</span>
                  <span className="source-confirm-actions">
                    <button className="btn-danger btn-small" onClick={() => remove(repo)} disabled={locked}>
                      {working ? t("mods.sourcesRemoving") : t("mods.sourcesRemove")}
                    </button>
                    <button className="btn-secondary btn-small" onClick={() => setConfirming(null)} disabled={locked} data-autofocus>
                      {t("mods.sourcesKeep")}
                    </button>
                  </span>
                </span>
              ) : (
                <button
                  className="btn-secondary btn-small"
                  onClick={() => {
                    setRowError(null);
                    setConfirming(repo);
                  }}
                  disabled={locked}
                  aria-label={t("mods.sourcesRemoveLabel", repo)}
                >
                  {t("mods.sourcesRemove")}
                </button>
              )}
              {rowError && sameRepo(rowError.repo, repo) && (
                <ErrorText error={rowError.error} className="inline-error source-error" />
              )}
            </li>
          );
        })}
      </ul>
      {repos === null &&
        (loadError ? (
          <ErrorText error={loadError} lead={damaged ? undefined : t("mods.sourcesLoadFailedLead")}>
            <button className="btn-secondary btn-small" onClick={load}>
              {t("mods.retry")}
            </button>
          </ErrorText>
        ) : (
          <p className="dialog-note" role="status">
            {t("loading")}
          </p>
        ))}
      <div className="dialog-field">
        <label className="dialog-field-label" htmlFor={inputId}>
          {t("mods.sourcesAddLabel")}
        </label>
        <input
          id={inputId}
          className="text-input"
          value={input}
          placeholder={t("mods.sourcesAddPlaceholder")}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.repeat) add();
          }}
          spellCheck={false}
          autoComplete="off"
          readOnly={adding}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? errorId : undefined}
        />
        <button className="btn-secondary" onClick={add} disabled={locked || !input.trim()}>
          {adding ? t("mods.sourcesAdding") : t("mods.sourcesAdd")}
        </button>
      </div>
      <p className="dialog-note">{t("mods.sourcesWarning")}</p>
      {error && <ErrorText error={error} id={errorId} />}
    </Dialog>
  );
}
