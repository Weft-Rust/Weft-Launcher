import { useCallback, useEffect, useId, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../i18n/useI18n";
import { translateError } from "../../i18n/errors";
import { useMods } from "../../hooks/useMods";
import { modsApi } from "../../mods/api";
import { parseRepo, sameRepo } from "../../mods/select";
import { Dialog } from "../Dialog";
import { Truncate } from "../Truncate";
import { TrustBadge } from "./TrustBadge";
import { sourceProblem } from "./catalogBanners";

const INDEX_REPO = "https://github.com/Zorro909/weft-mods-index";

export function SourcesDialog({ onClose }: { onClose: () => void }) {
  const { t, tn, formatDay } = useI18n();
  const { catalog, refreshCatalog } = useMods();
  const [repos, setRepos] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ repo: string; message: string } | null>(null);
  const [changed, setChanged] = useState(false);
  const busy = useRef(false);
  const inputId = useId();

  const load = useCallback(() => {
    setLoadError(null);
    modsApi
      .sources()
      .then(setRepos)
      .catch((err) => setLoadError(translateError(err)));
  }, []);
  useEffect(load, [load]);

  const add = async () => {
    if (busy.current || !input.trim()) return;
    const repo = parseRepo(input);
    if (!repo) {
      setError(translateError({ code: "ModSourceInvalid", detail: input.trim() }));
      return;
    }
    busy.current = true;
    setAdding(true);
    setError(null);
    try {
      setRepos(await modsApi.addSource(repo));
      setInput("");
      setChanged(true);
    } catch (err) {
      setError(translateError(err));
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
      setRowError({ repo, message: translateError(err) });
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
          <TrustBadge trust="reviewed" />
          <span className="source-name">{t("mods.sourcesIndex")}</span>
          <span className={`source-meta${index?.error ? " bad" : ""}`}>
            {index?.freshness === "fresh"
              ? t("mods.sourcesIndexFresh", formatDay(index.generated))
              : index?.freshness === "cached"
                ? t("mods.sourcesIndexCached", formatDay(index.generated))
                : t("mods.sourcesIndexNone")}
          </span>
          <button className="link-btn" onClick={() => openUrl(INDEX_REPO)}>
            {t("mods.viewSource")}
          </button>
        </li>
        {repos?.map((repo) => {
          const s = status(repo);
          const asking = confirming !== null && sameRepo(confirming, repo);
          const working = removing !== null && sameRepo(removing, repo);
          return (
            <li className={`source-row${asking ? " confirming" : ""}`} key={repo}>
              <TrustBadge trust="unreviewed" />
              <Truncate className="source-name" text={repo} />
              <span className={`source-meta${s?.error ? " bad" : ""}`}>
                {s?.error
                  ? sourceProblem(s, t, formatDay)
                  : s
                    ? [tn("mods.sourcesMods", s.mods), s.checked ? t("mods.sourcesChecked", formatDay(s.checked)) : ""]
                        .filter(Boolean)
                        .join(" · ")
                    : t("mods.sourcesNotChecked")}
              </span>
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
                <span className="inline-error source-error" role="alert">
                  {rowError.message}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {repos === null &&
        (loadError ? (
          <div className="inline-error with-action" role="alert">
            <span>{t("mods.sourcesLoadFailed", loadError)}</span>
            <button className="btn-secondary btn-small" onClick={load}>
              {t("mods.retry")}
            </button>
          </div>
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
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  );
}
