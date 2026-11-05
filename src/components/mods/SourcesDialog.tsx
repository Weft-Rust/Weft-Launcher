import { useCallback, useEffect, useId, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../i18n/useI18n";
import { showError, type Shown } from "../../i18n/errors";
import { ErrorText } from "../ErrorText";
import { useMods } from "../../hooks/useMods";
import { asAppError, modsApi } from "../../mods/api";
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

const NO_MODS: Record<NoModsReason, MessageKey> = {
  noReleases: "mods.sourceNoModsNoReleases",
  noModFiles: "mods.sourceNoModsNoFiles",
  unreadable: "mods.sourceNoModsUnreadable",
  noDigest: "mods.sourceNoModsNoDigest",
  disagrees: "mods.sourceNoModsDisagrees",
  invalid: "mods.sourceNoModsInvalid",
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
  if (s.mods === 0 && s.noMods) return `${t("mods.sourceNoMods")} ${t(NO_MODS[s.noMods])}`;
  return [tn("mods.sourcesMods", s.mods), s.checked ? t("mods.sourcesChecked", formatDay(s.checked)) : ""].filter(Boolean).join(" · ");
}

export function SourcesDialog({ onClose }: { onClose: () => void }) {
  const { t, tn, formatDay } = useI18n();
  const { catalog, catalogError, catalogLoading, refreshCatalog } = useMods();
  const [repos, setRepos] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<Shown | null>(null);
  // The list couldn't be read and was kept aside: adding a source starts a new one.
  const [damaged, setDamaged] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<Shown | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ repo: string; error: Shown } | null>(null);
  const [changed, setChanged] = useState(false);
  const busy = useRef(false);
  const inputId = useId();

  const load = useCallback(() => {
    setLoadError(null);
    modsApi
      .sources()
      .then((r) => {
        setRepos(r);
        setDamaged(false);
      })
      .catch((err) => {
        setLoadError(showError(err));
        setDamaged(asAppError(err).code === "ModSourcesDamaged");
      });
  }, []);
  useEffect(load, [load]);

  const add = async () => {
    if (busy.current || !input.trim()) return;
    const repo = parseRepo(input);
    if (!repo) {
      setError(showError({ code: "ModSourceInvalid", detail: input.trim() }));
      return;
    }
    busy.current = true;
    setAdding(true);
    setError(null);
    try {
      setRepos(await modsApi.addSource(repo));
      setLoadError(null);
      setDamaged(false);
      setInput("");
      // Asked at once, so the dialog says what the new source has before it closes.
      refreshCatalog();
    } catch (err) {
      setError(showError(err));
    } finally {
      busy.current = false;
      setAdding(false);
    }
  };

  const remove = async (repo: string) => {
    if (busy.current) return;
    busy.current = true;
    setRemoving(repo);
    setRowError(null);
    try {
      setRepos(await modsApi.removeSource(repo));
      setConfirming(null);
      setChanged(true);
    } catch (err) {
      setRowError({ repo, error: showError(err) });
    } finally {
      busy.current = false;
      setRemoving(null);
    }
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
      ? t("mods.sourcesIndexFresh", formatDay(index.generated))
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
            {index?.error && showError(index.error).detail && (
              <> {/* The backend's words, apart from ours. */}
                <code className="source-detail">{showError(index.error).detail}</code>
              </>
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
          return (
            <li className={`source-row${asking ? " confirming" : ""}`} key={repo} data-repo={repo}>
              <span className="source-title">
                <Truncate className="source-name" text={repo} />
                <span className="badge channel">{t("mods.sourceBadgeRepo")}</span>
              </span>
              <span className={`source-meta${s?.error ? " bad" : none ? " warn" : ""}`} data-testid="source-meta">
                {s?.error ? sourceProblem(s, t, formatDay) : sourceMeta(s, catalogLoading, t, tn, formatDay)}
                {none && (
                  <>
                    {" "}
                    <button className="link-btn" onClick={() => openUrl(SOURCE_FORMAT)}>
                      {t("mods.sourceFormatLink")}
                    </button>
                  </>
                )}
              </span>
              {s?.error && !asking && <span className="source-row-retry">{retry}</span>}
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
        />
        <button className="btn-secondary" onClick={add} disabled={locked || !input.trim()}>
          {adding ? t("mods.sourcesAdding") : t("mods.sourcesAdd")}
        </button>
      </div>
      <p className="dialog-note">{t("mods.sourcesWarning")}</p>
      {error && <ErrorText error={error} />}
    </Dialog>
  );
}
