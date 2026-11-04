import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n/useI18n";
import { translateError } from "../../i18n/errors";
import { useMods } from "../../hooks/useMods";
import { useGameState, type GameCrash } from "../../hooks/useGameState";
import { modsApi } from "../../mods/api";
import { COMMANDS } from "../../mods/ipc";
import { catalogModFor } from "../../mods/select";
import { blockers, failureTitle, type Fix } from "../../mods/status";
import type { CatalogMod, InstalledMod } from "../../mods/types";
import { InstallDialog } from "./InstallDialog";

/** An update to review in the install dialog, opened from a fix button. */
export interface UpdateRequest {
  mod: CatalogMod;
  sha256: string;
}

/** The install dialog for a fix's "Get <version>", wherever the fix was offered. */
export function useUpdateDialog(tag: string | null) {
  const { catalog } = useMods();
  const [request, setRequest] = useState<UpdateRequest | null>(null);
  const open = (mod: InstalledMod, sha256: string) => {
    const entry = catalogModFor(catalog, mod);
    if (entry) setRequest({ mod: entry, sha256 });
  };
  const canOpen = (mod: InstalledMod) => !!catalogModFor(catalog, mod);
  const dialog =
    request && tag ? (
      <InstallDialog tag={tag} mod={request.mod} initialSha={request.sha256} allowPrerelease onClose={() => setRequest(null)} />
    ) : null;
  return { open, canOpen, dialog };
}

function useFix(tag: string) {
  const { setEnabled } = useMods();
  const [error, setError] = useState<string | null>(null);
  const apply = async (fix: Fix) => {
    if (fix.kind === "update") return;
    setError(null);
    const r = await setEnabled(tag, fix.id, fix.kind === "turnOn");
    if (r.status === "failed") setError(r.message);
  };
  return { apply, error };
}

interface BlockerPanelProps {
  tag: string;
  locked: boolean;
  onUpdate: (mod: InstalledMod, sha256: string) => void;
  canUpdate: (mod: InstalledMod) => boolean;
  id?: string;
}

/** Each mod that stops this version, why, and the one-click fixes. */
export function BlockerPanel({ tag, locked, onUpdate, canUpdate, id }: BlockerPanelProps) {
  const { t, tn, tm } = useI18n();
  const { profile, nameIn, isBusy } = useMods();
  const { apply, error } = useFix(tag);
  const list = blockers(profile(tag), nameIn(tag));
  if (!list.length) return null;

  const label = (fix: Fix) => {
    switch (fix.kind) {
      case "turnOff":
        return t("mods.turnOff", fix.name);
      case "turnOn":
        return t("mods.turnOn", fix.name);
      case "update":
        return t("mods.getVersion", fix.version);
    }
  };

  return (
    <div className="launch-error blockers" role="alert" id={id}>
      <span className="blockers-title">{tn("mods.homeBlocked", list.length, tag)}</span>
      <ul className="blocker-list">
        {list.map(({ mod, reason, fixes }) => (
          <li key={mod.id} className="blocker">
            <span className="blocker-text">
              <strong>{mod.name}</strong> <span className="blocker-why">{tm(reason)}</span>
            </span>
            <span className="blocker-actions">
              {fixes.map((fix) => (
                <button
                  key={`${fix.kind}:${fix.id}`}
                  className={`btn-small ${fix.kind === "update" ? "btn-primary" : "btn-secondary"}`}
                  disabled={locked || isBusy(tag, fix.id) || (fix.kind === "update" && !canUpdate(mod))}
                  onClick={() => (fix.kind === "update" ? onUpdate(mod, fix.sha256) : apply(fix))}
                >
                  {label(fix)}
                </button>
              ))}
            </span>
          </li>
        ))}
      </ul>
      {error && <span className="blockers-error">{error}</span>}
    </div>
  );
}

interface ModFailureNoticeProps {
  crash: GameCrash;
  onUpdate: (mod: InstalledMod, sha256: string) => void;
  canUpdate: (mod: InstalledMod) => boolean;
  /** On Home: a way to the Mods tab. Left out on the Mods tab itself. */
  onGoToMods?: () => void;
}

/**
 * The game stopped. Says which mod the log blames and why, and offers the fix right there. It
 * stays until that mod is off, removed or replaced, or the player dismisses it.
 */
export function ModFailureNotice({ crash, onUpdate, canUpdate, onGoToMods }: ModFailureNoticeProps) {
  const { t, tm } = useI18n();
  const { profile, isBusy } = useMods();
  const { clearCrash } = useGameState();
  const { apply, error } = useFix(crash.tag);
  const [logError, setLogError] = useState<string | null>(null);
  const failure = crash.modFailure;
  const managed = failure?.modId ? profile(crash.tag)?.mods.find((m) => m.id === failure.modId) : undefined;

  const openLog = async () => {
    setLogError(null);
    try {
      await invoke(COMMANDS.openLog, { tag: crash.tag });
    } catch (err) {
      setLogError(translateError(err));
    }
  };

  const actions = (
    <span className="mod-failure-actions">
      {managed?.enabled && (
        <button
          className="btn-secondary btn-small"
          disabled={isBusy(crash.tag, managed.id)}
          onClick={() => apply({ kind: "turnOff", id: managed.id, name: managed.name })}
        >
          {t("mods.turnOff", managed.name)}
        </button>
      )}
      {managed?.update && canUpdate(managed) && (
        <button className="btn-primary btn-small" onClick={() => onUpdate(managed, managed.update!.sha256)}>
          {t("mods.findUpdate", managed.update.version)}
        </button>
      )}
      {managed && onGoToMods && (
        <button className="btn-secondary btn-small" onClick={onGoToMods}>
          {t("mods.homeFixInMods")}
        </button>
      )}
      {!managed && failure?.modId && (
        <button className="btn-secondary btn-small" onClick={() => modsApi.openPlayerModsFolder().catch(() => {})}>
          {t("mods.openModsFolder")}
        </button>
      )}
      <button className="btn-secondary btn-small" onClick={openLog}>
        {t("openLogButton")}
      </button>
      <button className="btn-secondary btn-small" onClick={clearCrash}>
        {t("mods.dismiss")}
      </button>
    </span>
  );

  if (!failure) {
    return (
      <div className="launch-error mod-failure" role="alert">
        <span className="mod-failure-title">{t("gameClosedError", String(crash.exitCode ?? "?"))}</span>
        {actions}
        {logError && <span className="blockers-error">{logError}</span>}
      </div>
    );
  }

  const name = managed?.name ?? failure.modId ?? "";
  return (
    <div className="launch-error mod-failure" role="alert">
      <span className="mod-failure-title">{tm(failureTitle(failure, name))}</span>
      <span className="mod-failure-line">{failure.line}</span>
      {!managed && failure.modId && <span className="mod-failure-why">{t("mods.failureOutside")}</span>}
      {actions}
      {(error || logError) && <span className="blockers-error">{error ?? logError}</span>}
    </div>
  );
}
