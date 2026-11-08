import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../i18n/useI18n";
import { translateError } from "../i18n/errors";
import { useInstall } from "../hooks/useInstall";
import { useGameState } from "../hooks/useGameState";
import { VersionSelect } from "../components/VersionSelect";
import { PixelIcon } from "../components/PixelIcon";
import { compareTags } from "../utils/version";

const REFRESH_ICON = [".###.#", "#...##", "#..###", "#.....", "#...#.", ".###.."];

interface Build {
  version: string;
  abi: string;
  sha256: string;
  deps: string[];
  verified: boolean;
  weft: string;
  auto: boolean;
}

interface IndexMod {
  id: string;
  name: string;
  summary: string;
  author: string;
  source: string;
  builds: Build[];
}

interface Installed {
  id: string;
  name: string | null;
  version: string | null;
  verified: boolean;
  on: boolean;
}

interface FileMod {
  id: string;
  name: string | null;
  version: string | null;
  verified: boolean;
}

type Dialog =
  | { kind: "install"; mod: IndexMod; build: Build }
  | { kind: "file"; path: string; file: FileMod }
  | { kind: "about"; mod: IndexMod; version: string };

interface ModsPageProps {
  selectedTag: string | null;
  onSelectTag: (tag: string | null) => void;
}

function Badge({ verified }: { verified: boolean }) {
  const { t } = useI18n();
  return <span className={verified ? "mod-verified" : "mod-unverified"}>{t(verified ? "modVerified" : "modUnverified")}</span>;
}

export function ModsPage({ selectedTag, onSelectTag }: ModsPageProps) {
  const { t } = useI18n();
  const { installedVersions } = useInstall();
  const { isRunning } = useGameState();
  const [index, setIndex] = useState<IndexMod[]>([]);
  const [abi, setAbi] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [listed, setListed] = useState(false);
  const [tab, setTab] = useState<"installed" | "browse">("installed");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // A click while something runs is ignored, not shown: disabling every button for the moment a
  // list takes would make the page blink. Only an install shows it waits.
  const busy = useRef(false);
  const [installing, setInstalling] = useState(false);
  const [unverifiedShown, setUnverifiedShown] = useState(() => localStorage.getItem("modsUnverified") === "1");
  const showUnverified = (on: boolean) => {
    setUnverifiedShown(on);
    localStorage.setItem("modsUnverified", on ? "1" : "0");
  };
  const [error, setError] = useState<string | null>(null);

  const versions = useMemo(
    () => [...installedVersions].sort((a, b) => compareTags(b.tag, a.tag)),
    [installedVersions]
  );
  const tag = versions.find((v) => v.tag === selectedTag)?.tag ?? versions[0]?.tag ?? null;
  const locked = tag !== null && isRunning(tag);

  async function run(f: () => Promise<unknown>) {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      await f();
    } catch (err) {
      setError(translateError(err));
    } finally {
      busy.current = false;
    }
  }

  async function relist() {
    if (!tag) return;
    const list = await invoke<{ abi: string | null; mods: Installed[] }>("mods_list", { tag });
    setAbi(list.abi);
    setInstalled(list.mods);
    setListed(true);
  }

  const reload = (refresh: boolean) =>
    run(async () => {
      setIndex((await invoke<{ mods: IndexMod[] }>("mods_index", { refresh })).mods);
      await relist();
    });

  useEffect(() => {
    reload(false);
  }, [tag]);

  const act = (command: string, args: Record<string, unknown>) =>
    run(async () => {
      await invoke(command, { tag, ...args });
      await relist();
    });

  // The dialog stays until its download is done, or shows why it failed.
  const install = (command: string, args: Record<string, unknown>) =>
    run(async () => {
      setInstalling(true);
      try {
        await invoke(command, { tag, ...args });
        setDialog(null);
        await relist();
      } finally {
        setInstalling(false);
      }
    });

  const pickFile = () =>
    run(async () => {
      const path = await open({ multiple: false, filters: [{ name: "Mod", extensions: ["zip"] }] });
      if (typeof path !== "string") return;
      setDialog({ kind: "file", path, file: await invoke<FileMod>("mods_inspect_file", { path }) });
    });

  if (!tag) {
    return (
      <main className="page mods-page">
        <div className="empty-state">{t("noVersionsInstalled")}</div>
      </main>
    );
  }

  const buildOf = (m: IndexMod) => m.builds.find((b) => b.abi === abi);
  const known = (id: string) => index.find((m) => m.id === id);
  const available = index.filter((m) => buildOf(m));
  const verified = available.filter((m) => buildOf(m)!.verified);
  const unverified = available.filter((m) => !buildOf(m)!.verified);

  const card = (m: IndexMod) => {
    const build = buildOf(m)!;
    return (
      <div className="card clear mod-card" key={m.id}>
        <div className="mod-title">
          <span className="mod-name">{m.name}</span>
          <span className="mod-version">{build.version}</span>
        </div>
        <div className="mod-meta">
          <Badge verified={build.verified} />
          {m.author && <span className="mod-version">{t("modBy", m.author)}</span>}
          {build.auto && <span className="mod-version">{t("modBuiltAgain", build.weft)}</span>}
        </div>
        <div className="mod-actions">
          <button className="btn-secondary" onClick={() => setDialog({ kind: "about", mod: m, version: build.version })}>
            {t("modDescription")}
          </button>
          {installButton(m, build)}
        </div>
      </div>
    );
  };
  const nameOf = (id: string) => known(id)?.name ?? id;

  const installButton = (m: IndexMod, build: Build) => {
    const have = installed.find((i) => i.id === m.id);
    if (have && have.version === build.version) return <span className="mod-state">{t("installedBadge")}</span>;
    return (
      <button className="install-btn" disabled={locked} onClick={() => setDialog({ kind: "install", mod: m, build })}>
        {t(have ? "modUpdate" : "installButton")}
      </button>
    );
  };

  return (
    <main className="page mods-page">
      <header className="page-header clear">
        <h1>{t("tabMods")}</h1>
        <div className="header-actions">
          <VersionSelect
            value={tag}
            options={versions.map((v) => ({ value: v.tag, label: v.tag }))}
            onChange={onSelectTag}
            disabled={false}
            label={t("selectVersionLabel")}
          />
          <button className="btn-refresh" onClick={() => reload(true)} title={t("refreshButton")} aria-label={t("refreshButton")}>
            <PixelIcon rows={REFRESH_ICON} scale={4} />
          </button>
        </div>
      </header>

      <div className="mods-bar">
        <div className="mods-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "installed"} className={`mods-tab${tab === "installed" ? " active" : ""}`} onClick={() => setTab("installed")}>
            {t("modsInstalled")} <span className="mods-count">{installed.length}</span>
          </button>
          <button role="tab" aria-selected={tab === "browse"} className={`mods-tab${tab === "browse" ? " active" : ""}`} onClick={() => setTab("browse")}>
            {t("modsBrowse")}
          </button>
        </div>
        <button className="btn-secondary" disabled={locked || !abi} onClick={pickFile}>
          {t("modFromFile")}
        </button>
      </div>

      {error && <div className="error-banner" role="alert">{t("errorPrefix")}{error}</div>}
      {listed && !abi && <div className="card clear mod-empty">{t("modsUnsupported")}</div>}

      {abi && tab === "installed" && (
        <div className="mods-list">
          {installed.length === 0 && <div className="card clear mod-empty">{t("modsNoneInstalled")}</div>}
          {installed.map((m) => {
            const indexed = known(m.id);
            const newer = indexed && buildOf(indexed);
            return (
              <div className="card clear mod-row" key={m.id}>
                <button
                  className={`led${m.on ? " on" : ""}`}
                  disabled={locked}
                  onClick={() => act("mods_set_on", { id: m.id, on: !m.on })}
                  title={t(m.on ? "modOn" : "modOff")}
                  aria-label={t(m.on ? "modOn" : "modOff")}
                  aria-pressed={m.on}
                />
                <span className="mod-name">{m.name ?? m.id}</span>
                {m.version && <span className="mod-version">{m.version}</span>}
                <Badge verified={m.verified} />
                <span className="mod-actions">
                  {indexed?.summary && (
                    <button className="btn-secondary" onClick={() => setDialog({ kind: "about", mod: indexed, version: m.version ?? "" })}>
                      {t("modDescription")}
                    </button>
                  )}
                  {newer && newer.version !== m.version && (
                    <button className="install-btn" disabled={locked} onClick={() => setDialog({ kind: "install", mod: indexed, build: newer })}>
                      {t("modUpdate")}
                    </button>
                  )}
                  <button className="delete-btn" disabled={locked} onClick={() => act("mods_remove", { id: m.id })}>
                    {t("deleteButton")}
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {abi && tab === "browse" && (
        <>
          <div className="mods-grid">
            {verified.length === 0 && <div className="card clear mod-empty">{t("modsNoneAvailable")}</div>}
            {verified.map(card)}
          </div>
          {unverified.length > 0 && (
            <div className="mods-unverified">
              <button className="btn-secondary" onClick={() => showUnverified(!unverifiedShown)}>
                {t(unverifiedShown ? "modsHideUnverified" : "modsShowUnverified", String(unverified.length))}
              </button>
              {unverifiedShown && (
                <>
                  <p className="mod-warning danger">{t("modsUnverifiedNote")}</p>
                  <div className="mods-grid">{unverified.map(card)}</div>
                </>
              )}
            </div>
          )}
        </>
      )}

      {dialog && (
        <div className="modal-backdrop" onClick={() => !installing && setDialog(null)}>
          <div className="card modal" role="dialog" onClick={(e) => e.stopPropagation()}>
            {dialog.kind === "about" && (
              <>
                <h2 className="modal-title">{dialog.mod.name} {dialog.version}</h2>
                {dialog.mod.author && <p className="mod-version">{t("modBy", dialog.mod.author)}</p>}
                <p className="modal-text">{dialog.mod.summary}</p>
                <div className="modal-buttons">
                  <button className="btn-secondary" onClick={() => setDialog(null)}>{t("modClose")}</button>
                  {dialog.mod.source && <button className="link-btn" onClick={() => openUrl(dialog.mod.source)}>{t("modSource")}</button>}
                </div>
              </>
            )}
            {dialog.kind === "install" && (() => {
              const { mod, build } = dialog;
              const missing = build.deps.filter((d) => known(d) && !installed.some((i) => i.id === d)).map(nameOf);
              const have = installed.find((i) => i.id === mod.id);
              return (
                <>
                  <h2 className="modal-title">{t(have ? "modUpdateTitle" : "modInstallTitle", mod.name, build.version, tag)}</h2>
                  <Badge verified={build.verified} />
                  <p className={build.verified ? "mod-warning" : "mod-warning danger"}>
                    {t(build.verified ? "modWarnVerified" : "modWarnUnverified", mod.name)}
                  </p>
                  {missing.length > 0 && <p className="modal-text">{t("modAlsoInstalls", missing.join(", "))}</p>}
                  {mod.summary && <p className="modal-text">{mod.summary}</p>}
                  <div className="modal-buttons">
                    <button className={build.verified ? "install-btn" : "delete-btn confirming"} disabled={locked || installing} onClick={() => install("mods_install", { id: mod.id })}>
                      {t(build.verified ? (have ? "modUpdate" : "installButton") : "modInstallAnyway")}
                    </button>
                    <button className="btn-secondary" onClick={() => setDialog(null)}>{t("modCancel")}</button>
                    {mod.source && <button className="link-btn" onClick={() => openUrl(mod.source)}>{t("modSource")}</button>}
                  </div>
                </>
              );
            })()}
            {dialog.kind === "file" && (() => {
              const { path, file } = dialog;
              const fileName = path.split(/[\\/]/).pop() ?? path;
              return (
                <>
                  <h2 className="modal-title">{t("modInstallFile", file.name ?? file.id, fileName)}</h2>
                  <Badge verified={file.verified} />
                  <p className={file.verified ? "mod-warning" : "mod-warning danger"}>
                    {t(file.verified ? "modWarnVerified" : "modWarnFile", file.name ?? file.id)}
                  </p>
                  {installed.some((i) => i.id === file.id) && <p className="modal-text">{t("modReplaces", nameOf(file.id))}</p>}
                  <div className="modal-buttons">
                    <button className={file.verified ? "install-btn" : "delete-btn confirming"} disabled={locked || installing} onClick={() => install("mods_install_file", { path })}>
                      {t(file.verified ? "installButton" : "modInstallAnyway")}
                    </button>
                    <button className="btn-secondary" onClick={() => setDialog(null)}>{t("modCancel")}</button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </main>
  );
}
