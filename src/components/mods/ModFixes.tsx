import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { showError, type Shown } from "../../i18n/errors";
import { useMods } from "../../hooks/useMods";
import { useGameState, type GameCrash } from "../../hooks/useGameState";
import { modsApi } from "../../mods/api";
import { catalogModFor } from "../../mods/select";
import { blockers, crashFixes, failureTitle, shadowOf, type Fix } from "../../mods/status";
import type { CatalogMod, InstalledMod } from "../../mods/types";
import { Announce } from "../Announce";
import { announce } from "../LiveRegion";
import { ErrorText } from "../ErrorText";
import { Truncate } from "../Truncate";
import { InstallDialog } from "./InstallDialog";

/** A build to review in the install dialog, opened from a fix button. */
export interface ReviewRequest {
  mod: CatalogMod;
  sha256: string;
}

/**
 * The install dialog for a fix's "Update to…" or "Install…", wherever the fix was offered. Every
 * install goes through the review, also one click away from a problem.
 */
export function useReviewDialog(tag: string | null) {
  const { catalog } = useMods();
  const [request, setRequest] = useState<ReviewRequest | null>(null);
  /** An update for an installed mod: its catalogue entry, if the catalogue still has it. */
  const openUpdate = (mod: InstalledMod, sha256: string) => {
    const entry = catalogModFor(catalog, mod);
    if (entry) setRequest({ mod: entry, sha256 });
  };
  const canUpdate = (mod: InstalledMod) => !!catalogModFor(catalog, mod);
  const dialog =
    request && tag ? (
      <InstallDialog tag={tag} mod={request.mod} initialSha={request.sha256} allowPrerelease onClose={() => setRequest(null)} />
    ) : null;
  return { openUpdate, canUpdate, openInstall: (mod: CatalogMod, sha256: string) => setRequest({ mod, sha256 }), dialog };
}

export type Review = ReturnType<typeof useReviewDialog>;

function useFix(tag: string, review: Review) {
  const { setEnabled, profile, loadProfile } = useMods();
  const [error, setError] = useState<Shown | null>(null);
  const apply = async (fix: Fix) => {
    setError(null);
    if (fix.kind === "install") return review.openInstall(fix.mod, fix.sha256);
    if (fix.kind === "update") {
      const mod = profile(tag)?.mods.find((m) => m.id === fix.id);
      return mod && review.openUpdate(mod, fix.sha256);
    }
    if (fix.kind === "showFolder") {
      // Only the player can remove their own file; the launcher looks again once they're back.
      try {
        await modsApi.openPlayerModsFolder();
      } catch (err) {
        setError(showError(err));
      }
      window.addEventListener("focus", () => loadProfile(tag), { once: true });
      return;
    }
    const r = await setEnabled(tag, fix.id, fix.kind === "turnOn");
    if (r.status === "failed") setError(r.shown);
  };
  return { apply, error };
}

/** The buttons for a list of fixes: turn off, turn on, install a dependency, update. */
function FixButtons({ tag, fixes, locked, review, apply, flat = false }: { tag: string; fixes: Fix[]; locked: boolean; review: Review; apply: (f: Fix) => void; flat?: boolean }) {
  const { t } = useI18n();
  const { isBusy, profile } = useMods();
  const label = (fix: Fix) => {
    switch (fix.kind) {
      case "turnOff":
        return t("mods.turnOff", fix.name);
      case "turnOn":
        return t("mods.turnOn", fix.name);
      case "install":
        return t("mods.installDep", fix.name);
      case "update":
        return t("mods.update", fix.version);
      case "showFolder":
        return t("mods.showFolderFix", fix.file);
    }
  };
  const disabled = (fix: Fix) => {
    if (locked || isBusy(tag, fix.id)) return true;
    if (fix.kind !== "update") return false;
    const mod = profile(tag)?.mods.find((m) => m.id === fix.id);
    return !mod || !review.canUpdate(mod);
  };
  const primary = (fix: Fix) => fix.kind === "update" || fix.kind === "install" || fix.kind === "showFolder";
  return (
    <>
      {fixes.map((fix) => (
        <button
          key={`${fix.kind}:${fix.id}`}
          className={flat ? `btn-flat${primary(fix) ? " primary" : ""}` : `btn-small ${primary(fix) ? "btn-primary" : "btn-secondary"}`}
          disabled={disabled(fix)}
          onClick={() => apply(fix)}
          data-fix={fix.kind}
        >
          {label(fix)}
        </button>
      ))}
    </>
  );
}

interface BlockerPanelProps {
  tag: string;
  locked: boolean;
  review: Review;
  id?: string;
  /**
   * In a banner on the Mods tab: one blocking mod at a time, whole, with all its fixes, and a
   * pager to the others. The list below keeps its rows in view however many mods block.
   */
  inBanner?: boolean;
}

/**
 * Each mod that stops this version, why, and the one-click fixes. The same on Home and on the
 * Mods tab. Rendered also while nothing blocks, so a problem that comes back is said again.
 */
export function BlockerPanel({ tag, locked, review, id, inBanner = false }: BlockerPanelProps) {
  const { t, tn, tm } = useI18n();
  const { profile, nameIn, catalog } = useMods();
  const { apply, error } = useFix(tag, review);
  const list = blockers(profile(tag), nameIn(tag), catalog);
  const [page, setPage] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });
  const title = tn("mods.homeBlocked", list.length, tag);
  // Assertive, and only for what wasn't there a moment ago: a new mod, or a new reason for one.
  const said = (
    <Announce
      channel={`blockers:${tag}`}
      items={list.map((b) => ({ id: `${b.mod.id}|${b.reasons.map((r) => r.key).join(",")}`, text: `${b.mod.name}: ${b.reasons.map(tm).join(" ")}` }))}
      prefix={title}
    />
  );
  if (!list.length) return said;

  const reasonsOf = (b: (typeof list)[number]) => b.reasons.map(tm).join(" ");

  if (inBanner) {
    // The mod on screen stays on screen while the list changes around it; a fixed one gives its
    // place to the next.
    const at = list.findIndex((b) => b.mod.id === page.id);
    const index = at >= 0 ? at : Math.min(page.index, list.length - 1);
    const shown = list[index];
    const go = (step: number) => {
      const next = (index + step + list.length) % list.length;
      setPage({ id: list[next].mod.id, index: next });
    };
    const many = list.length > 1;
    return (
      <section className="blockers in-banner" id={id} aria-label={title}>
        {said}
        <div className="blocker" data-blocker={shown.mod.id}>
          {/* Two lines at most, so the banner keeps its height; the whole text is a hover or a
              Tab away, said in full to a screen reader, and stated again on the mod's row. */}
          <Truncate className="blocker-text" lines={2} text={`${t("mods.blockerLead")} ${shown.mod.name} ${reasonsOf(shown)}`}>
            <span className="blocker-lead">{t("mods.blockerLead")}</span> <strong>{shown.mod.name}</strong>{" "}
            <span className="blocker-why">{reasonsOf(shown)}</span>
          </Truncate>
          <span className="blocker-foot">
            <span className="blocker-actions" role="group" aria-label={t("mods.fixesFor", shown.mod.name)}>
              <FixButtons tag={tag} fixes={shown.fixes} locked={locked} review={review} apply={apply} flat />
            </span>
            {many && (
              <span className="blocker-pager" role="group" aria-label={t("mods.blockerPager")}>
                <button className="pager-btn" onClick={() => go(-1)} aria-label={t("mods.blockerPrev")}>
                  ‹
                </button>
                <span className="pager-at" aria-live="polite">
                  {t("mods.blockerPage", String(index + 1), String(list.length))}
                </span>
                <button className="pager-btn" onClick={() => go(1)} aria-label={t("mods.blockerNext")}>
                  ›
                </button>
              </span>
            )}
          </span>
        </div>
        {error && <ErrorText error={error} className="blockers-error" />}
      </section>
    );
  }

  return (
    <section className="blockers play-blocked" id={id} aria-label={title}>
      {said}
      {/* What Play's own description says: why it is off, in a few words. */}
      <span className="play-off" id={id ? `${id}-why` : undefined}>
        {list.length === 1 ? t("mods.playOffOne", list[0].mod.name) : tn("mods.playOffMany", list.length)}
      </span>
      <span className="blockers-title">{title}</span>
      <ul className="blocker-list">
        {list.map((b) => (
          <li key={b.mod.id} className="blocker" data-blocker={b.mod.id}>
            <span className="blocker-text">
              <strong>{b.mod.name}</strong> <span className="blocker-why">{reasonsOf(b)}</span>
            </span>
            <span className="blocker-actions" role="group" aria-label={t("mods.fixesFor", b.mod.name)}>
              <FixButtons tag={tag} fixes={b.fixes} locked={locked} review={review} apply={apply} />
            </span>
          </li>
        ))}
      </ul>
      {error && <ErrorText error={error} className="blockers-error" />}
    </section>
  );
}

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
  const { profile, nameIn, catalog } = useMods();
  const { clearCrash } = useGameState();
  const { apply, error } = useFix(crash.tag, review);
  const [actionError, setActionError] = useState<Shown | null>(null);
  const failure = crash.modFailure;
  const report = profile(crash.tag);
  const managed = failure?.modId ? report?.mods.find((m) => m.id === failure.modId) : undefined;
  const fixes = crashFixes(failure, report, catalog);
  // A copy in the player's own folder may be what the game loaded, so turning this one off may not help.
  const shadow = failure?.modId ? shadowOf(report, failure.modId) : undefined;
  const outside = !!failure?.modId && (!managed || !!shadow);

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
      <span className="mod-failure-title">{title}</span>
      {failure && <span className="mod-failure-line">{failure.line}</span>}
      {failure && !managed && failure.modId && <span className="mod-failure-why">{t("mods.failureOutside")}</span>}
      {shadow && <span className="mod-failure-why">{t("mods.failureShadowed", shadow.file)}</span>}
      <span className="mod-failure-actions">
        <FixButtons tag={crash.tag} fixes={fixes} locked={false} review={review} apply={apply} />
        {managed && onGoToMods && (
          <button className="btn-secondary btn-small" onClick={onGoToMods}>
            {t("mods.homeFixInMods")}
          </button>
        )}
        {outside && (
          <button className="btn-secondary btn-small" onClick={() => attempt(modsApi.openPlayerModsFolder)}>
            {t("mods.openModsFolder")}
          </button>
        )}
        <button className="btn-secondary btn-small" onClick={() => attempt(() => modsApi.openLog(crash.tag))}>
          {t("openLogButton")}
        </button>
        <button className="btn-secondary btn-small" onClick={clearCrash}>
          {t("mods.dismiss")}
        </button>
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
