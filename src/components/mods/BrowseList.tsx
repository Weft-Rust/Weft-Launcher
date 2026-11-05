import { useId, useMemo, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { showError } from "../../i18n/errors";
import { activeStep } from "../../mods/checks";
import { ErrorText } from "../ErrorText";
import { useMods } from "../../hooks/useMods";
import type { CatalogMod, ProfileReport } from "../../mods/types";
import { fittingVersions, installedFor, matchesSearch, networkDown } from "../../mods/select";
import { Truncate } from "../Truncate";
import { ModIcon } from "./ModIcon";
import { ModProgressBar } from "./ModProgressBar";
import { InstallDialog } from "./InstallDialog";
import { ChannelBadge, TrustBadge } from "./TrustBadge";

interface BrowseListProps {
  report: ProfileReport;
  locked: boolean;
}

export function BrowseList({ report, locked }: BrowseListProps) {
  const { t, formatList } = useI18n();
  const { catalog, catalogLoading, catalogError, refreshCatalog, progressOf, nameIn } = useMods();
  const [query, setQuery] = useState("");
  const [onlyFitting, setOnlyFitting] = useState(true);
  const [prereleases, setPrereleases] = useState(false);
  const [open, setOpen] = useState<CatalogMod | null>(null);
  const searchId = useId();
  const listId = useId().replace(/:/g, "");
  const tag = report.tag;
  const offline = networkDown(catalog, catalogError);
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

  // No catalogue at all: say why and offer to try again, never "no mods fit".
  if (!catalog) {
    return catalogError && !catalogLoading ? (
      <div className="empty-state framed-empty">
        <p>{t("mods.catalogFailed")}</p>
        <ErrorText error={showError(catalogError)} className="hint" />
        <div className="empty-actions">
          <button className="btn-primary" onClick={refreshCatalog}>
            {t("mods.retry")}
          </button>
        </div>
      </div>
    ) : (
      <div className="empty-state" role="status">
        {t("loading")}
      </div>
    );
  }

  return (
    <>
      <div className="filters">
        <label className="sr-only" htmlFor={searchId}>
          {t("mods.searchPlaceholder")}
        </label>
        <input
          id={searchId}
          className="text-input search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("mods.searchPlaceholder")}
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
            {query
              ? t("mods.browseEmpty")
              : onlyFitting
                ? t("mods.browseEmptyFits", tag)
                : t("mods.browseEmptyAll")}
          </p>
          <div className="empty-actions">
            {query && (
              <button className="btn-secondary" onClick={() => setQuery("")}>
                {t("mods.clearSearch")}
              </button>
            )}
            {onlyFitting && catalog.mods.length > 0 && (
              <button className="btn-secondary" onClick={() => setOnlyFitting(false)}>
                {t("mods.showAll")}
              </button>
            )}
          </div>
        </div>
      ) : (
        <ul className="mod-grid" aria-label={t("mods.tabBrowse")}>
          {rows.map(({ mod, best, installed }) => {
            const shown = best ?? mod.versions[0];
            // Installed and nothing better to offer: say so instead of a button that can't work.
            const isCurrent = installed && (!best || installed.sha256 === best.sha256);
            const onlyPre = !best && fittingVersions(catalog, mod, abi, true).length > 0;
            const events = progressOf({ kind: "mod", tag, id: mod.id });
            const p = events.length ? activeStep(events) : undefined;
            const who = mod.origin.kind === "source" ? mod.origin.repo : formatList(mod.authors) || mod.id;
            const cardId = `${listId}-${mod.key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
            const needsNet = offline && !!best && !p && !isCurrent;
            const what = best ? best.version : onlyPre ? t("mods.onlyPrerelease") : t("mods.notForVersion", tag);
            return (
              <li key={mod.key} className={`mod-card framed${needsNet ? " needs-net-card" : ""}`} data-key={mod.key}>
                <div className="mod-card-head">
                  <ModIcon id={mod.id} url={mod.icon} />
                  {/* The name has the whole width; the tier sits on the line under it. */}
                  {/* The name opens the mod's details: its whole summary, authors, versions and
                      checks, in one place rather than a tooltip per field. */}
                  <div className="mod-card-title">
                    <button className="mod-name-btn" onClick={() => setOpen(mod)} aria-label={t("mods.detailsLabel", mod.name)}>
                      <Truncate className="mod-name" text={mod.name} />
                    </button>
                  </div>
                  <div className="mod-badges">
                    {shown && <TrustBadge trust={shown.trust} />}
                    {best && <ChannelBadge channel={best.channel} />}
                    <span className="mod-card-version" data-must-fit>
                      {what}
                    </span>
                    <Truncate className="mod-source" text={who} />
                  </div>
                </div>
                {/* Offline, the network note takes a line, so the summary gives one up: two rows of cards still fit. */}
                <Truncate className="mod-summary" text={mod.summary || t("mods.noSummary")} lines={needsNet ? 1 : 2} />
                <div className="mod-card-foot">
                  {p ? (
                    <ModProgressBar progress={p} nameOf={(x) => (x.modId === mod.id ? mod.name : nameIn(tag)(x.modId))} compact />
                  ) : isCurrent ? (
                    <span className="installed-mark">{t("mods.installed")}</span>
                  ) : (
                    <>
                      <button
                        className="btn-primary btn-small"
                        disabled={!best || locked}
                        onClick={() => setOpen(mod)}
                        aria-label={t(installed ? "mods.updateLabel" : "mods.installLabel", mod.name, tag)}
                        aria-describedby={needsNet ? `${cardId}-net` : undefined}
                      >
                        {t(installed ? "mods.updateButton" : "mods.install")}
                      </button>
                      {/* A download needs the network, and it was down at the last try. */}
                      {needsNet && (
                        <small className="needs-net" id={`${cardId}-net`}>
                          {t("mods.needsNetworkShort")}
                        </small>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {open && <InstallDialog tag={tag} mod={open} allowPrerelease={prereleases} onClose={() => setOpen(null)} />}
    </>
  );
}
