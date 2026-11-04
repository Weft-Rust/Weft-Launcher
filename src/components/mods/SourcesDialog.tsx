import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../i18n/useI18n";
import { translateError } from "../../i18n/errors";
import { useMods } from "../../hooks/useMods";
import { modsApi } from "../../mods/api";
import { Dialog } from "../Dialog";
import { TrustBadge } from "./TrustBadge";

const INDEX_REPO = "https://github.com/Zorro909/weft-mods-index";

export function SourcesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { catalog, refreshCatalog } = useMods();
  const [repos, setRepos] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    modsApi.sources().then(setRepos).catch(() => {});
  }, []);

  const add = async () => {
    if (!input.trim()) return;
    setAdding(true);
    setError(null);
    try {
      setRepos(await modsApi.addSource(input));
      setInput("");
      setChanged(true);
    } catch (err) {
      setError(translateError(err));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (repo: string) => {
    setRepos(await modsApi.removeSource(repo));
    setChanged(true);
  };

  const close = () => {
    if (changed) refreshCatalog();
    onClose();
  };

  const status = (repo: string) => catalog?.sources.find((s) => s.repo === repo);
  const index = catalog?.index;

  return (
    <Dialog onClose={close} locked={adding} title={t("mods.sourcesTitle")}>
      <p className="dialog-summary">{t("mods.sourcesIntro")}</p>
      <ul className="source-list">
        <li className="source-row">
          <TrustBadge trust="reviewed" />
          <span className="source-name">{t("mods.sourcesIndex")}</span>
          <span className="source-meta">
            {index?.freshness === "fresh"
              ? t("mods.sourcesIndexFresh", index.generated?.slice(0, 10) ?? "")
              : index?.freshness === "cached"
                ? t("mods.sourcesIndexCached", index.generated?.slice(0, 10) ?? "")
                : t("mods.sourcesIndexNone")}
          </span>
          <button className="link-btn" onClick={() => openUrl(INDEX_REPO)}>
            {t("mods.viewSource")}
          </button>
        </li>
        {repos.map((repo) => {
          const s = status(repo);
          return (
            <li className="source-row" key={repo}>
              <TrustBadge trust="unreviewed" />
              <span className="source-name">{repo}</span>
              <span className={`source-meta${s?.error ? " bad" : ""}`}>
                {s?.error ? translateError(s.error) : s ? t("mods.sourcesMods", String(s.mods)) : ""}
              </span>
              <button className="btn-secondary btn-small" onClick={() => remove(repo)}>
                {t("mods.sourcesRemove")}
              </button>
            </li>
          );
        })}
      </ul>
      <label className="dialog-field">
        <span className="dialog-field-label">{t("mods.sourcesAddLabel")}</span>
        <input
          className="text-input"
          value={input}
          placeholder={t("mods.sourcesAddPlaceholder")}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          spellCheck={false}
          autoComplete="off"
          disabled={adding}
          data-autofocus
        />
        <button className="btn-secondary" onClick={add} disabled={adding || !input.trim()}>
          {t("mods.sourcesAdd")}
        </button>
      </label>
      <p className="dialog-note">{t("mods.sourcesWarning")}</p>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-actions">
        <button className="btn-secondary" onClick={close} disabled={adding}>
          {t("mods.close")}
        </button>
      </div>
    </Dialog>
  );
}
