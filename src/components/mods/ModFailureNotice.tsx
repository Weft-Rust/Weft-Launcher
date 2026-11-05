import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { showError, type Shown } from "../../i18n/errors";
import { useMods } from "../../hooks/useMods";
import { useGameState, type GameCrash } from "../../hooks/useGameState";
import { modsApi } from "../../mods/api";
import { crashFixes, failureTitle, shadowOf, shadowStillThere } from "../../mods/status";
import { useAnnounce } from "../LiveRegion";
import { ErrorDetails, ErrorText } from "../ErrorText";
import { FixButtons, useFix, type Review } from "./ModFixes";

const crashIds = new WeakMap<GameCrash, number>();
let crashCount = 0;
const crashId = (c: GameCrash) => {
  if (!crashIds.has(c)) crashIds.set(c, ++crashCount);
  return String(crashIds.get(c));
};

interface ModFailureNoticeProps {
  crash: GameCrash;
  review: Review;
  /** On Home: a way to the Mods tab. Left out on the Mods tab itself. */
  onGoToMods?: () => void;
}

/**
 * The game stopped. Says which mod the log blames and why, in names, and offers the fix right
 * there. It stays until that mod is off, removed or replaced, or the player dismisses it.
 */
export function ModFailureNotice({ crash, review, onGoToMods }: ModFailureNoticeProps) {
  const announce = useAnnounce();
  const { t, tn, tm } = useI18n();
  const { profile, nameIn, catalog, crashSnapshot, setEnabledMany } = useMods();
  const { clearCrash } = useGameState();
  const { apply, error, lookAgain } = useFix(crash.tag, review);
  const [actionError, setActionError] = useState<Shown | null>(null);
  const failure = crash.modFailure;
  const report = profile(crash.tag);
  const managed = failure?.modId ? report?.mods.find((m) => m.id === failure.modId) : undefined;
  const fixes = crashFixes(failure, report, catalog);
  // A copy in the player's own folder may be what the game loaded, so turning this one off may not
  // help: it loads instead. Named for as long as it is there, also once the launcher's is gone.
  const shadow = failure?.modId ? shadowOf(report, failure.modId) : undefined;
  const leftover = shadowStillThere(crashSnapshot, report);
  const shadowFile = shadow?.file ?? leftover;
  const loadsInstead = !!shadowFile && !managed?.enabled;
  const outside = !!failure?.modId && (!managed || !!shadowFile);

  const attempt = async (work: () => Promise<void>) => {
    setActionError(null);
    try {
      await work();
    } catch (err) {
      setActionError(showError(err));
    }
  };

  // A crash that names no mod, with mods on: the next step is trying without them, with Undo.
  const [turnedOff, setTurnedOff] = useState<string[] | null>(null);
  const [working, setWorking] = useState(false);
  const enabledIds = (report?.mods ?? []).filter((m) => m.enabled).map((m) => m.id);
  const unnamed = !failure && (enabledIds.length > 0 || !!turnedOff);
  const allOff = async () => {
    setActionError(null);
    setWorking(true);
    const r = await setEnabledMany(crash.tag, enabledIds, false);
    setWorking(false);
    if (r.status === "failed") return setActionError(r.shown);
    if (r.status !== "done") return;
    setTurnedOff(r.result);
    announce(`crash-all-off:${crashId(crash)}:${Date.now()}`, tn("mods.crashAllOff", r.result.length, crash.tag));
  };
  const undoAllOff = async () => {
    if (!turnedOff) return;
    setActionError(null);
    setWorking(true);
    const r = await setEnabledMany(crash.tag, turnedOff, true);
    setWorking(false);
    if (r.status === "failed") return setActionError(r.shown);
    setTurnedOff(null);
    announce(`crash-all-on:${crashId(crash)}:${Date.now()}`, tn("mods.crashAllOn", turnedOff.length, crash.tag));
  };

  const title = failure
    ? tm(failureTitle(failure, managed?.name ?? failure.modId ?? "", nameIn(crash.tag)))
    : t("gameClosedError", String(crash.exitCode ?? "?"));

  return (
    <section className="launch-error mod-failure" aria-label={title}>
      <CrashSaid id={crashId(crash)} text={title} />
      <span className="mod-failure-title" data-must-fit>
        {title}
      </span>
      {failure && !managed && failure.modId && !shadowFile && <span className="mod-failure-why">{t("mods.failureOutside")}</span>}
      {shadowFile && (
        <span className="mod-failure-why" data-testid="crash-shadow">
          {t(loadsInstead ? "mods.failureShadowedStill" : "mods.failureShadowed", shadowFile)}
        </span>
      )}
      {unnamed && (
        <span className="mod-failure-why" data-testid="crash-unnamed">
          {turnedOff ? tn("mods.crashAllOff", turnedOff.length, crash.tag) : t("mods.crashNoneNamed")}
        </span>
      )}
      {/* The log's own line, folded: the sentence above says what it means. */}
      {failure?.line && <ErrorDetails detail={failure.line} label={t("mods.failureLogLine")} />}
      <span className="mod-failure-actions">
        <FixButtons tag={crash.tag} fixes={fixes} locked={false} review={review} apply={apply} />
        {unnamed && !turnedOff && (
          <button className="btn-primary btn-small" data-fix="turnOffAll" disabled={working} onClick={allOff}>
            {t("mods.crashTurnOffAll", crash.tag)}
          </button>
        )}
        {unnamed && turnedOff && (
          <button className="btn-secondary btn-small" data-fix="undoTurnOffAll" disabled={working} onClick={undoAllOff}>
            {t("mods.undo")}
          </button>
        )}
        {managed && onGoToMods && (
          <button className="btn-secondary btn-small" onClick={onGoToMods}>
            {t("mods.homeFixInMods")}
          </button>
        )}
        {outside && (
          <button
            className="btn-secondary btn-small"
            onClick={() => {
              lookAgain();
              attempt(modsApi.openPlayerModsFolder);
            }}
          >
            {t("mods.openModsFolder")}
          </button>
        )}
        {/* Quieter than the fixes: looking at the log and putting the notice away. */}
        <span className="mod-failure-quiet">
          <button className="link-btn" onClick={() => attempt(() => modsApi.openLog(crash.tag))}>
            {t("openLogButton")}
          </button>
          <span aria-hidden="true">·</span>
          <button className="link-btn" onClick={clearCrash}>
            {t("mods.dismiss")}
          </button>
        </span>
      </span>
      {(error || actionError) && <ErrorText error={(error ?? actionError)!} className="blockers-error" />}
    </section>
  );
}

/** A crash is a result of Play: said once, politely. */
function CrashSaid({ id, text }: { id: string; text: string }) {
  const announce = useAnnounce();
  useEffect(() => announce(`crash:${id}`, text), [id, text, announce]);
  return null;
}
