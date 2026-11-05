import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { showError, type Shown } from "../../i18n/errors";
import { useMods } from "../../hooks/useMods";
import { useGameState, type GameCrash } from "../../hooks/useGameState";
import { modsApi } from "../../mods/api";
import { crashFixes, failureTitle, shadowOf, shadowStillThere } from "../../mods/status";
import { announce } from "../LiveRegion";
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
  const { t, tm } = useI18n();
  const { profile, nameIn, catalog, crashSnapshot } = useMods();
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
      {/* The log's own line, folded: the sentence above says what it means. */}
      {failure?.line && <ErrorDetails detail={failure.line} label={t("mods.failureLogLine")} />}
      <span className="mod-failure-actions">
        <FixButtons tag={crash.tag} fixes={fixes} locked={false} review={review} apply={apply} />
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
          <button className="btn-flat" onClick={() => attempt(() => modsApi.openLog(crash.tag))}>
            {t("openLogButton")}
          </button>
          <button className="btn-flat" onClick={clearCrash}>
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
  useEffect(() => announce(`crash:${id}`, text), [id, text]);
  return null;
}
