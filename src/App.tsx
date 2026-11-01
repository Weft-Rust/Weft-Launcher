import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "./i18n/useI18n";
import { translateError } from "./i18n/errors";
import { useInstall } from "./hooks/useInstall";
import { Sidebar } from "./components/Sidebar";
import { Tabs } from "./components/Tabs";
import { Home } from "./pages/Home";
import { VersionsPage } from "./pages/Versions";
import { NotesPage } from "./pages/Notes";
import { getLatestTag, getNewTag } from "./utils/version";
import "./App.css";

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

type TabId = "home" | "versions" | "notes";

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
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("home");
  const [selectedTag, setSelectedTag] = useState<string | null>(lastPlayed);

  const latestTag = useMemo(() => getLatestTag(releases), [releases]);
  const newTag = useMemo(() => getNewTag(latestTag, installedVersions), [latestTag, installedVersions]);

  /** Resolves to whether the list came from the cache. */
  async function fetchReleases(forceRefresh = false): Promise<boolean> {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<Release[]>("list_versions", { forceRefresh: forceRefresh });
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

  // The cache shows something at once, then GitHub says what is new. An unchanged list costs no
  // API quota thanks to the ETag.
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
      case "notes":
        return <NotesPage releases={releases} />;
      default:
        return null;
    }
  };

  return (
    <div className="app-layout">
      <Sidebar />
      <div className="main-content">
        <Tabs activeTab={activeTab} onChange={setActiveTab} hasNewVersions={newTag !== null} />
        <div className="page-container" role="main">
          {renderPage()}
        </div>
      </div>
    </div>
  );
}

export default App;
