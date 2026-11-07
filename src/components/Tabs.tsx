import { useI18n } from "../i18n/useI18n";
import { useRovingTabs } from "../hooks/useRovingTabs";
import { LanguageMenu } from "./LanguageMenu";
import { UpdateButton } from "./UpdateButton";

export const TAB_IDS = ["home", "versions", "mods", "notes"] as const;
export type TabId = (typeof TAB_IDS)[number];

interface TabsProps {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
  hasNewVersions: boolean;
  /** Something on the Mods tab wants a look: an update, or a mod that would stop the game. */
  modsAttention: boolean;
}

/** The roving tabindex and panel ids; App puts `panel` on the page container. */
export function useMainTabs(activeTab: TabId, onChange: (tab: TabId) => void) {
  return useRovingTabs("main", TAB_IDS, activeTab, onChange);
}

export function Tabs({ activeTab, onChange, hasNewVersions, modsAttention }: TabsProps) {
  const { t } = useI18n();
  const { tab } = useMainTabs(activeTab, onChange);

  const labels: Record<TabId, string> = {
    home: t("tabHome"),
    versions: t("tabVersions"),
    mods: t("tabMods"),
    notes: t("tabNotes"),
  };

  return (
    <nav className="tabs">
      <span className="bar-name" aria-hidden="true">
        WEFT
      </span>
      <div className="tab-list" role="tablist" aria-label={t("tabsLabel")}>
        {TAB_IDS.map((id) => (
          <button key={id} {...tab(id)} className={`tab-btn ${activeTab === id ? "active" : ""}`}>
            {labels[id]}
            {id === "versions" && hasNewVersions && (
              <>
                <span className="new-dot" aria-hidden="true" />
                <span className="sr-only">{t("newVersionsDot")}</span>
              </>
            )}
            {id === "mods" && modsAttention && (
              <>
                <span className="new-dot" aria-hidden="true" />
                <span className="sr-only">{t("mods.attentionDot")}</span>
              </>
            )}
          </button>
        ))}
      </div>
      <div className="tabs-right">
        <UpdateButton />
        <LanguageMenu />
      </div>
    </nav>
  );
}
