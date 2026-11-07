import { useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { Build, Index, IndexMod, InstalledMod, newestBuild, owner } from "../../mods/api";

interface Props {
  index: Index;
  abi: string;
  tag: string;
  installed: InstalledMod[];
  readOnly: boolean;
  onInstall: (mod: IndexMod, build: Build) => void;
}

// Only mods with a build for this version's ABI, each at its newest such build.
export function BrowseList({ index, abi, tag, installed, readOnly, onInstall }: Props) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");

  const query = search.trim().toLowerCase();
  const cards = index.mods
    .map((mod) => ({ mod, build: newestBuild(index, mod, abi) }))
    .filter((c): c is { mod: IndexMod; build: Build } => c.build !== null)
    .filter(({ mod }) => `${mod.name}\n${mod.summary}`.toLowerCase().includes(query));

  return (
    <>
      <input
        className="mods-search"
        type="search"
        placeholder={t("mods.search")}
        aria-label={t("mods.search")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {cards.length === 0 ? (
        <p className="empty-state">{query ? t("mods.noMatch") : t("mods.empty", tag)}</p>
      ) : (
        <ul className="mod-cards">
          {cards.map(({ mod, build }) => {
            const have = installed.find((m) => m.id === mod.id);
            return (
              <li key={mod.id} className="mod-card framed">
                <div className="mod-title">
                  <span className="mod-name">{mod.name}</span>
                  <span className="mod-version">{build.version}</span>
                </div>
                <p className="mod-summary" title={mod.summary}>
                  {mod.summary}
                </p>
                <div className="mod-card-foot">
                  <span className="mod-by">{t("mods.by", owner(mod.repo))}</span>
                  {have && !have.update ? (
                    <span className="mod-installed">{t("mods.installed")}</span>
                  ) : (
                    <button className="btn-primary" disabled={readOnly} onClick={() => onInstall(mod, build)}>
                      {have ? t("mods.update") : t("mods.install")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
