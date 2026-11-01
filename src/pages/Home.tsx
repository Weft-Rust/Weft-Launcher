import { useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../i18n/useI18n";
import { translateError } from "../i18n/errors";
import { useInstall } from "../hooks/useInstall";
import { useGameState } from "../hooks/useGameState";
import { PixelBanner } from "../components/PixelBanner";
import { compareTags } from "../utils/version";

interface HomeProps {
  onGoToVersions: () => void;
  latestTag: string | null;
  selectedTag: string | null;
  onSelectTag: (tag: string | null) => void;
}

export function Home({ onGoToVersions, latestTag, selectedTag, onSelectTag }: HomeProps) {
  const { t, locale } = useI18n();
  const { installedVersions, loaded } = useInstall();
  const { anyRunning, isRunning, launch, lastCrash, clearCrash } = useGameState();

  const [launchError, setLaunchError] = useState<string | null>(null);

  const sortedVersions = useMemo(
  () => [...installedVersions].sort((a, b) => compareTags(b.tag, a.tag)),
  [installedVersions]
  );

  // The selection may be a version that has been deleted since.
  const selectedVersion = useMemo(
  () => sortedVersions.find((v) => v.tag === selectedTag) ?? sortedVersions[0] ?? null,
  [sortedVersions, selectedTag]
);

  const effectiveTag = selectedVersion?.tag ?? null;

  const handleLaunch = async (tag: string) => {
    setLaunchError(null);
    setLaunchError(await launch(tag));
  };

  const handleOpenLog = async (tag: string) => {
    clearCrash();
    try {
      await invoke("open_log", { tag });
    } catch (err) {
      setLaunchError(translateError(err));
    }
  };

  const handleOpenFolder = async () => {
    if (!effectiveTag) return;
    setLaunchError(null);
    try {
      await invoke("open_game_folder", { tag: effectiveTag });
    } catch (err) {
      setLaunchError(translateError(err));
    }
  };

  const isSelectedRunning = effectiveTag ? isRunning(effectiveTag) : false;
  const playDisabled = anyRunning || isSelectedRunning;

  if (!loaded) {
    return <main className="page home-page" />;
  }

  if (installedVersions.length === 0) {
    return (
      <main className="page home-page">
        <section className="hero empty">
          <PixelBanner />
          <h1 className="hero-title">Weft</h1>
          <p className="empty-message">{t("noVersionsInstalled")}</p>
          <button className="btn-flat btn-primary" onClick={onGoToVersions}>
            {t("goToVersionsTab")}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="page home-page">
      <section className="hero">
        <PixelBanner />
        <div className="hero-header">
          <h1 className="hero-title">Weft</h1>
          <div className="hero-version-badge">
            {t("heroBadge", effectiveTag || "—")}
          </div>
        </div>
        <div className="hero-play-area">
          <div className="version-selector">
            <label htmlFor="version-select" className="visually-hidden">
              {t("selectVersionLabel")}
            </label>
            <select
              id="version-select"
              value={effectiveTag || ""}
              onChange={(e) => onSelectTag(e.target.value || null)}
              disabled={anyRunning}
            >
              {sortedVersions.map((v) => (
              <option key={v.tag} value={v.tag}>
              {latestTag && v.tag === latestTag ? `${v.tag} — ${t("latestBadge")}` : v.tag}
              </option>
             ))}
            </select>
          </div>
          <button
              className="btn-play"
              onClick={() => effectiveTag && handleLaunch(effectiveTag)}
              disabled={!effectiveTag || playDisabled}
              aria-label={isSelectedRunning ? t("playing") : t("playButton")}
            >
            {isSelectedRunning ? t("playing") : t("playButton")}
          </button>
        </div>
        {launchError && (
          <div className="launch-error" role="alert">
            {launchError}
          </div>
        )}
        {lastCrash && (
          <div className="launch-error" role="alert">
            <span>{t("gameClosedError", String(lastCrash.exitCode ?? "?"))}</span>
            <button className="btn-flat btn-secondary" onClick={() => handleOpenLog(lastCrash.tag)}>
              {t("openLogButton")}
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">{t("instanceCardTitle")}</h2>
        </div>
        <div className="card-body">
          {selectedVersion ? (
            <>
              <div className="detail-row">
                <span className="detail-label">{t("versionLabel")}</span>
                <span className="detail-value">{selectedVersion.tag}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">{t("installedAtLabel")}</span>
                <span className="detail-value">
                  {new Date(selectedVersion.installed_at).toLocaleString(locale)}
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-label">{t("executableLabel")}</span>
                <span className="detail-value path">{selectedVersion.executable}</span>
              </div>
              <div className="detail-row">
  <span className="detail-label">{t("gameFolderTitle")}</span>
  <button className="btn-flat btn-secondary btn-open-folder" onClick={handleOpenFolder}>
  {t("openFolderButton")}
</button>
</div>
            </>
          ) : (
            <p className="select-version-hint">{t("selectVersionHint")}</p>
          )}
        </div>
      </section>
    </main>
  );
}
