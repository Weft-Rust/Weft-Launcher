import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "./i18n/useI18n";
import { translateError } from "./i18n/errors";
import { useInstall } from "./hooks/useInstall";
import { Sidebar } from "./components/Sidebar";
import { Tabs, TabId, useMainTabs } from "./components/Tabs";
import { VoxelField } from "./components/VoxelField";
import { Home } from "./pages/Home";
import { VersionsPage } from "./pages/Versions";
import { NotesPage } from "./pages/Notes";
import { ModsPage } from "./pages/Mods";
import { useMods } from "./hooks/useMods";
import { getLatestTag, getNewTag } from "./utils/version";
import { COMMANDS } from "./mods/ipc";

interface AssetInfo {
  name: string;
  url: string;
  size: number;
  sha256: string | null;
}

interface Release {
  tag: string;
  name: string;
  published_at: string;
  body: string;
  prerelease: boolean;
  asset: AssetInfo;
  from_cache: boolean;
}


function lastPlayed(): string | null {
  try {
    return localStorage.getItem("lastPlayed");
  } catch {
    return null;
  }
}

function App() {
  const { t, ready } = useI18n();
  const { installedVersions } = useInstall();
  const { profile } = useMods();
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("home");
  const [selectedTag, setSelectedTag] = useState<string | null>(lastPlayed);

  const latestTag = useMemo(() => getLatestTag(releases), [releases]);
  const newTag = useMemo(() => getNewTag(latestTag, installedVersions), [latestTag, installedVersions]);
  const { panel } = useMainTabs(activeTab, setActiveTab);
  const modsAttention = installedVersions.some((v) => {
    const p = profile(v.tag);
    return !!p && (p.blocking.length > 0 || p.mods.some((m) => m.update !== null && m.status !== "off"));
  });

  /** Resolves to whether the list came from the cache. */
  async function fetchReleases(forceRefresh = false): Promise<boolean> {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<Release[]>(COMMANDS.listVersions, { forceRefresh: forceRefresh });
      const cached = data.some((r) => r.from_cache);
      setReleases(data);
      setFromCache(cached);
      return cached;
    } catch (err) {
      setError(translateError(err));
      return false;
    } finally {
      setLoading(false);
    }
  }

  // The cache shows something at once, then GitHub says what is new.
  useEffect(() => {
    fetchReleases(false).then((cached) => {
      if (cached) fetchReleases(true);
    });
  }, []);

  if (!ready) {
    return <div className="loading-screen">{t('loading')}</div>;
  }

  const renderPage = () => {
    switch (activeTab) {
      case "home":
        return (
          <Home
            onGoToVersions={() => setActiveTab("versions")}
            onGoToMods={() => setActiveTab("mods")}
            latestTag={latestTag}
            selectedTag={selectedTag}
            onSelectTag={setSelectedTag}
          />
        );
      case "versions":
        return (
          <VersionsPage
            releases={releases}
            loading={loading}
            error={error}
            fromCache={fromCache}
            onRefresh={fetchReleases}
            newTag={newTag}
          />
        );
      case "mods":
        return (
          <ModsPage
            selectedTag={selectedTag}
            onSelectTag={setSelectedTag}
            onGoToVersions={() => setActiveTab("versions")}
          />
        );
      case "notes":
        return <NotesPage releases={releases} loading={loading} />;
      default:
        return null;
    }
  };

  return (
    <div className="app-layout">
      <VoxelField />
      <Sidebar />
      <div className="main-content">
        <Tabs
          activeTab={activeTab}
          onChange={setActiveTab}
          hasNewVersions={newTag !== null}
          modsAttention={modsAttention}
        />
        {/* Keyed so a page always opens at its top, not where the last one was scrolled to. */}
        <div className="page-container" {...panel} key={activeTab}>
          {renderPage()}
        </div>
      </div>
    </div>
  );
}

export default App;
