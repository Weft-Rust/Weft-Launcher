import { useMemo, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { useMods } from "../../hooks/useMods";
import type { CatalogMod, ProfileReport } from "../../mods/types";
import { fittingVersions, installedFor, matchesSearch } from "../../mods/select";
import { ModIcon } from "./ModIcon";
import { ModProgressBar } from "./ModProgressBar";
import { InstallDialog } from "./InstallDialog";
import { ChannelBadge, TrustBadge } from "./TrustBadge";

interface BrowseListProps {
  report: ProfileReport;
  locked: boolean;
}

export function BrowseList({ report, locked }: BrowseListProps) {
  const { t } = useI18n();
  const { catalog, catalogLoading, progress } = useMods();
  const [query, setQuery] = useState("");
  const [onlyFitting, setOnlyFitting] = useState(true);
  const [prereleases, setPrereleases] = useState(false);
  const [open, setOpen] = useState<CatalogMod | null>(null);
  const tag = report.tag;
  const abi = report.versionAbi;

  const rows = useMemo(() => {
    return (catalog?.mods ?? [])
      .filter((m) => matchesSearch(m, query))
      .map((m) => ({
        mod: m,
        best: fittingVersions(catalog, m, abi, prereleases)[0],
        installed: installedFor(m, report.mods),
      }))
      .filter((r) => !onlyFitting || r.best || r.installed)
      .filter((r) => prereleases || r.mod.versions.some((v) => v.channel === "release") || r.installed);
  }, [catalog, query, abi, prereleases, onlyFitting, report.mods]);

  const index = catalog?.index;
  const sourceErrors = catalog?.sources.filter((s) => s.error) ?? [];

  return (
    <>
      {index && index.freshness !== "fresh" && !catalogLoading && (
        <div className={`banner ${index.freshness === "cached" ? "info" : "warn"}`} role="status">
          <span>
            {index.error?.code === "IndexSignatureInvalid" || index.error?.code === "IndexInvalid"
              ? t("mods.indexInvalid")
              : index.error?.code === "IndexRollback"
                ? t("mods.indexRollback")
                : index.freshness === "cached"
                  ? t("mods.indexCached")
                  : t("mods.indexUnavailable")}
          </span>
        </div>
      )}
      {sourceErrors.map((s) => (
        <div className="banner warn" role="status" key={s.repo}>
          <span>{t("mods.sourceError", s.repo, s.error?.code === "ModSourceNotFound" ? t("mods.sourceGone") : t("mods.sourceUnreachable"))}</span>
        </div>
      ))}

      <div className="filters">
        <input
          className="text-input search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("mods.searchPlaceholder")}
          aria-label={t("mods.searchPlaceholder")}
          spellCheck={false}
        />
        <label className="checkbox">
          <input type="checkbox" checked={onlyFitting} onChange={(e) => setOnlyFitting(e.target.checked)} />
          <span className="box" aria-hidden="true" />
          {t("mods.filterFits", tag)}
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={prereleases} onChange={(e) => setPrereleases(e.target.checked)} />
          <span className="box" aria-hidden="true" />
          {t("mods.filterPrereleases")}
        </label>
      </div>

      {rows.length === 0 ? (
        <div className="empty-state">
          <p>
            {catalogLoading && !catalog
              ? t("loading")
              : query
                ? t("mods.browseEmpty")
                : onlyFitting
                  ? t("mods.browseEmptyFits", tag)
                  : t("mods.browseEmptyAll")}
          </p>
          {onlyFitting && !query && (catalog?.mods.length ?? 0) > 0 && (
            <button className="btn-secondary" onClick={() => setOnlyFitting(false)}>
              {t("mods.showAll")}
            </button>
          )}
        </div>
      ) : (
        <ul className="mod-grid" aria-label={t("mods.tabBrowse")}>
          {rows.map(({ mod, best, installed }) => {
            const shown = best ?? mod.versions[0];
            // Installed and nothing better to offer: say so instead of a button that can't work.
            const isCurrent = installed && (!best || installed.sha256 === best.sha256);
            const onlyPre = !best && fittingVersions(catalog, mod, abi, true).length > 0;
            const p = best ? progress[best.sha256] : undefined;
            return (
              <li key={mod.key} className="mod-card framed">
                <div className="mod-card-head">
                  <ModIcon id={mod.id} url={mod.icon} />
                  <div className="mod-card-title">
                    <span className="mod-name">{mod.name}</span>
                    <span className="mod-badges">
                      <TrustBadge trust={shown.trust} />
                      {best && <ChannelBadge channel={best.channel} />}
                    </span>
                  </div>
                </div>
                <p className="mod-summary">{mod.summary || t("mods.noSummary")}</p>
                <div className="mod-card-foot">
                  <span className="mod-source">
                    {best ? best.version : onlyPre ? t("mods.onlyPrerelease") : t("mods.notForVersion", tag)} ·{" "}
                    {mod.origin.kind === "source" ? mod.origin.repo : mod.authors.join(", ") || mod.id}
                  </span>
                  {p ? (
                    <ModProgressBar progress={p} />
                  ) : isCurrent ? (
                    <span className="installed-mark">{t("mods.installed")}</span>
                  ) : (
                    <button
                      className="btn-primary btn-small"
                      disabled={!best || locked}
                      onClick={() => setOpen(mod)}
                      aria-label={`${t(installed ? "mods.updateButton" : "mods.install")} ${mod.name}`}
                    >
                      {t(installed ? "mods.updateButton" : "mods.install")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {open && (
        <InstallDialog
          tag={tag}
          versionAbi={abi}
          mod={open}
          installed={installedFor(open, report.mods)}
          allowPrerelease={prereleases}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
