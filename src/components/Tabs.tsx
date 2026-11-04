import { useI18n } from "../i18n/useI18n";
import { LanguageMenu } from "./LanguageMenu";
import { UpdateButton } from "./UpdateButton";

export type TabId = "home" | "versions" | "mods" | "notes";

interface TabsProps {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
  hasNewVersions: boolean;
  /** Something on the Mods tab wants a look: an update, or a mod that would stop the game. */
  modsAttention: boolean;
}

export function Tabs({ activeTab, onChange, hasNewVersions, modsAttention }: TabsProps) {
  const { t } = useI18n();

  const tabs: { id: TabId; label: string }[] = [
    { id: "home", label: t("tabHome") },
    { id: "versions", label: t("tabVersions") },
    { id: "mods", label: t("tabMods") },
    { id: "notes", label: t("tabNotes") },
  ];

  return (
    <nav className="tabs" role="tablist" aria-label={t("tabsLabel")}>
      <span className="bar-name">WEFT</span>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-controls={`panel-${tab.id}`}
          id={`tab-${tab.id}`}
          className={`tab-btn ${activeTab === tab.id ? "active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.id === "versions" && hasNewVersions && <span className="new-dot" aria-label={t("newVersionsDot")} />}
          {tab.id === "mods" && modsAttention && <span className="new-dot" aria-label={t("mods.attentionDot")} />}
        </button>
      ))}
      <div className="tabs-right">
        <UpdateButton />
        <LanguageMenu />
      </div>
    </nav>
  );
}
