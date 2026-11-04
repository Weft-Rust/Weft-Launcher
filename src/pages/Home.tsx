import { useEffect, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../i18n/useI18n";
import { translateError } from "../i18n/errors";
import { useInstall } from "../hooks/useInstall";
import { useGameState } from "../hooks/useGameState";
import { useMods } from "../hooks/useMods";
import { modsApi } from "../mods/api";
import type { ModFailure } from "../mods/types";
import { StableLabel } from "../components/StableLabel";
import { VersionSelect } from "../components/VersionSelect";
import { compareTags } from "../utils/version";

interface HomeProps {
  onGoToVersions: () => void;
  onGoToMods: () => void;
  latestTag: string | null;
  selectedTag: string | null;
  onSelectTag: (tag: string | null) => void;
}

export function Home({ onGoToVersions, onGoToMods, latestTag, selectedTag, onSelectTag }: HomeProps) {
  const { t, locale } = useI18n();
  const { installedVersions, loaded } = useInstall();
  const { anyRunning, isRunning, launch, lastCrash, clearCrash } = useGameState();
  const { profiles, loadProfile, setEnabled } = useMods();

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
  const report = effectiveTag ? profiles[effectiveTag] : undefined;

  useEffect(() => {
    if (effectiveTag) loadProfile(effectiveTag);
  }, [effectiveTag, loadProfile]);

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
        <section className="hero empty clear">
          <h1 className="hero-title">WEFT</h1>
          <p className="empty-message">{t("noVersionsInstalled")}</p>
          <button className="btn-primary" onClick={onGoToVersions}>
            {t("goToVersionsTab")}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="page home-page">
      <section className="hero clear">
        <div className="hero-header">
          <h1 className="hero-title">WEFT</h1>
          <div className="hero-version-badge">
            {t(isSelectedRunning ? "heroBadgePlaying" : "heroBadge", effectiveTag || "—")}
          </div>
        </div>
        <div className="hero-play-area">
          <VersionSelect
            value={effectiveTag || ""}
            options={sortedVersions.map((v) => ({
              value: v.tag,
              label: latestTag && v.tag === latestTag ? `${v.tag} — ${t("latestBadge")}` : v.tag,
            }))}
            onChange={onSelectTag}
            disabled={anyRunning}
            label={t("selectVersionLabel")}
          />
          <button
              className="btn-play"
              onClick={() => effectiveTag && handleLaunch(effectiveTag)}
              disabled={!effectiveTag || playDisabled}
              aria-label={isSelectedRunning ? t("playing") : t("playButton")}
            >
            <StableLabel
              text={isSelectedRunning ? t("playing") : t("playButton")}
              widest={[t("playing"), t("playButton")]}
            />
          </button>
        </div>
        {launchError && (
          <div className="launch-error" role="alert">
            {launchError}
          </div>
        )}
        {report && (
          <ModsLine
            names={report.mods.filter((m) => m.enabled).map((m) => m.name)}
            onChange={onGoToMods}
          />
        )}
        {report && report.blocking.length > 0 && !lastCrash && (
          <div className="launch-error" role="alert">
            <span>
              {t(
                "mods.homeBlocked",
                effectiveTag ?? "",
                report.blocking.map((id) => report.mods.find((m) => m.id === id)?.name ?? id).join(", ")
              )}
            </span>
            <button className="btn-secondary" onClick={onGoToMods}>
              {t("mods.homeFixInMods")}
            </button>
          </div>
        )}
        {lastCrash && lastCrash.modFailure ? (
          <ModFailureNotice
            failure={lastCrash.modFailure}
            managed={profiles[lastCrash.tag]?.mods.find((m) => m.id === lastCrash.modFailure?.modId)}
            onTurnOff={async (id) => {
              clearCrash();
              const err = await setEnabled(lastCrash.tag, id, false);
              if (err) setLaunchError(err);
            }}
            onGoToMods={() => {
              clearCrash();
              onGoToMods();
            }}
            onOpenLog={() => handleOpenLog(lastCrash.tag)}
          />
        ) : (
          lastCrash && (
            <div className="launch-error" role="alert">
              <span>{t("gameClosedError", String(lastCrash.exitCode ?? "?"))}</span>
              <button className="btn-secondary" onClick={() => handleOpenLog(lastCrash.tag)}>
                {t("openLogButton")}
              </button>
            </div>
          )
        )}
      </section>

      <section className="card clear">
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
  <span className="detail-label">{t("gameFolderTitle")}</span>
  <button className="btn-secondary btn-open-folder" onClick={handleOpenFolder}>
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

function ModsLine({ names, onChange }: { names: string[]; onChange: () => void }) {
  const { t } = useI18n();
  return (
    <p className="mods-line">
      <span>{names.length ? t("mods.homeMods", names.join(", ")) : t("mods.homeModsNone")}</span>
      <button className="link-btn" onClick={onChange}>
        {names.length ? t("mods.homeChange") : t("mods.homeAdd")}
      </button>
    </p>
  );
}

const FAILURE_KEY: Record<ModFailure["kind"], string> = {
  wrongVersion: "mods.failureWrongVersion",
  missingDep: "mods.failureMissingDep",
  loadFailed: "mods.failureLoad",
  notAMod: "mods.failureNotAMod",
  wrongName: "mods.failureWrongName",
  initPanicked: "mods.failureInit",
};

interface ModFailureNoticeProps {
  failure: ModFailure;
  /** The installed mod the log names, when the launcher manages it. */
  managed: { id: string; name: string; enabled: boolean } | undefined;
  onTurnOff: (id: string) => void;
  onGoToMods: () => void;
  onOpenLog: () => void;
}

/** Says which mod stopped the game, and offers the fix right there. */
function ModFailureNotice({ failure, managed, onTurnOff, onGoToMods, onOpenLog }: ModFailureNoticeProps) {
  const { t } = useI18n();
  const name = managed?.name ?? failure.modId ?? "?";
  return (
    <div className="launch-error mod-failure" role="alert">
      <span className="mod-failure-title">{t(FAILURE_KEY[failure.kind], name, failure.other ?? "")}</span>
      <span className="mod-failure-line">{failure.line}</span>
      {!managed && failure.modId && <span className="mod-failure-why">{t("mods.failureOutside")}</span>}
      <span className="mod-failure-actions">
        {managed?.enabled && (
          <button className="btn-secondary btn-small" onClick={() => onTurnOff(managed.id)}>
            {t("mods.turnOff", managed.name)}
          </button>
        )}
        {managed ? (
          <button className="btn-secondary btn-small" onClick={onGoToMods}>
            {t("mods.homeFixInMods")}
          </button>
        ) : (
          <button className="btn-secondary btn-small" onClick={() => modsApi.openPlayerModsFolder().catch(() => {})}>
            {t("mods.openModsFolder")}
          </button>
        )}
        <button className="btn-secondary btn-small" onClick={onOpenLog}>
          {t("openLogButton")}
        </button>
      </span>
    </div>
  );
}
