import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { showError, type Shown } from "../../i18n/errors";
import { useMods } from "../../hooks/useMods";
import { modsApi } from "../../mods/api";
import { catalogModFor } from "../../mods/select";
import { blockers, type Fix } from "../../mods/status";
import type { CatalogMod, InstalledMod } from "../../mods/types";
import { Announce } from "../Announce";
import { useAnnounce } from "../LiveRegion";
import { ErrorText } from "../ErrorText";
import { InstallDialog } from "./InstallDialog";
import { FileInstallDialog } from "./FileInstallDialog";
import { pickModFile } from "./pickModFile";
import { unreachable } from "../../utils/never";

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
  const { t } = useI18n();
  const [request, setRequest] = useState<ReviewRequest | null>(null);
  /** A zip from the player's computer, in the From file dialog: what replaces a file mod. */
  const [filePath, setFilePath] = useState<string | null>(null);
  /** An update for an installed mod: its catalogue entry, if the catalogue still has it. */
  const openUpdate = (mod: InstalledMod, sha256: string) => {
    const entry = catalogModFor(catalog, mod);
    if (entry) setRequest({ mod: entry, sha256 });
  };
  const canUpdate = (mod: InstalledMod) => !!catalogModFor(catalog, mod);
  /** Asks for a zip and shows it in the From file dialog; throws what the picker threw. */
  const openFile = async () => {
    const path = await pickModFile(t("mods.fileFilter"));
    if (path) setFilePath(path);
  };
  const dialog =
    request && tag ? (
      <InstallDialog tag={tag} mod={request.mod} initialSha={request.sha256} allowPrerelease onClose={() => setRequest(null)} />
    ) : filePath && tag ? (
      <FileInstallDialog tag={tag} path={filePath} onClose={() => setFilePath(null)} />
    ) : null;
  return { openUpdate, canUpdate, openInstall: (mod: CatalogMod, sha256: string) => setRequest({ mod, sha256 }), openFile, dialog };
}

export type Review = ReturnType<typeof useReviewDialog>;

/**
 * Once the player's own folder was shown, the launcher looks at it again each time they come back
 * to the window: only they can remove a file there, and they may take more than one trip.
 */
function useLookAgainOnReturn(tag: string) {
  const { loadProfile } = useMods();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const again = () => loadProfile(tag, true);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [armed, tag, loadProfile]);
  return () => setArmed(true);
}

export function useFix(tag: string, review: Review) {
  const { setEnabled, profile } = useMods();
  const [error, setError] = useState<Shown | null>(null);
  const lookAgain = useLookAgainOnReturn(tag);
  const apply = async (fix: Fix) => {
    setError(null);
    if (fix.kind === "install") return review.openInstall(fix.mod, fix.sha256);
    if (fix.kind === "update") {
      const mod = profile(tag)?.mods.find((m) => m.id === fix.id);
      return mod && review.openUpdate(mod, fix.sha256);
    }
    if (fix.kind === "replaceFile") {
      try {
        await review.openFile();
      } catch (err) {
        setError(showError(err));
      }
      return;
    }
    if (fix.kind === "showFolder") {
      // Only the player can remove their own file; the launcher looks again when they're back.
      lookAgain();
      try {
        await modsApi.openPlayerModsFolder();
      } catch (err) {
        setError(showError(err));
      }
      return;
    }
    const r = await setEnabled(tag, fix.id, fix.kind === "turnOn");
    if (r.status === "failed") setError(r.shown);
  };
  /** Several turn-offs, one after the other; stops at the first that fails and says why. */
  const applyAll = async (fixes: Fix[]) => {
    setError(null);
    for (const fix of fixes) {
      if (fix.kind !== "turnOff") continue;
      const r = await setEnabled(tag, fix.id, false);
      if (r.status === "failed") return setError(r.shown);
    }
  };
  return { apply, applyAll, error, lookAgain };
}

/** The buttons for a list of fixes: turn off, turn on, install a dependency, update. */
export function FixButtons({ tag, fixes, locked, review, apply, flat = false }: { tag: string; fixes: Fix[]; locked: boolean; review: Review; apply: (f: Fix) => void; flat?: boolean }) {
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
        return fix.tentative ? t("mods.tryUpdate", fix.version) : t("mods.update", fix.version);
      case "showFolder":
        return t("mods.showFolderFix", fix.file);
      case "replaceFile":
        return t("mods.replaceFromFile", fix.name);
      default:
        return unreachable(fix);
    }
  };
  const disabled = (fix: Fix) => {
    if (locked || isBusy(tag, fix.id)) return true;
    if (fix.kind !== "update") return false;
    const mod = profile(tag)?.mods.find((m) => m.id === fix.id);
    return !mod || !review.canUpdate(mod);
  };
  const primary = (fix: Fix) => fix.kind === "update" || fix.kind === "install" || fix.kind === "showFolder" || fix.kind === "replaceFile";
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
  const announce = useAnnounce();
  const { t, tn, tm } = useI18n();
  const { profile, nameIn, catalog, isBusy } = useMods();
  const { apply, applyAll, error } = useFix(tag, review);
  const list = blockers(profile(tag), nameIn(tag), catalog);
  const [page, setPage] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });
  const title = tn("mods.homeBlocked", list.length, tag);
  const sentences = (b: (typeof list)[number]) => b.reasons.map(tm);
  // Assertive, and only for what wasn't there a moment ago: a new mod, or a new reason for one.
  const said = (
    <Announce
      channel={`blockers:${tag}`}
      items={list.map((b) => ({ id: `${b.mod.id}|${b.reasons.map((r) => r.key).join(",")}`, text: [...sentences(b), ...(b.quote ? [tm(b.quote)] : [])].join(" ") }))}
      prefix={title}
    />
  );
  if (!list.length) return said;

  // One translated sentence per reason, each naming the mod (shown in its colour), never cut.
  const reasonLines = (b: (typeof list)[number], withQuote: boolean) => (
    <span className="blocker-text" data-must-fit>
      {sentences(b).map((text, i) => (
        <span key={i} className="blocker-line">
          <Named text={text} name={b.mod.name} />
        </span>
      ))}
      {withQuote && b.quote && <span className="blocker-line blocker-quote">{tm(b.quote)}</span>}
    </span>
  );

  if (inBanner) {
    // The mod on screen stays on screen while the list changes around it; a fixed one gives its
    // place to the next.
    const at = list.findIndex((b) => b.mod.id === page.id);
    const index = at >= 0 ? at : Math.min(page.index, list.length - 1);
    const shown = list[index];
    const go = (step: number) => {
      const next = (index + step + list.length) % list.length;
      setPage({ id: list[next].mod.id, index: next });
      announce(`blocker-page:${tag}:${next}:${Date.now()}`, t("mods.blockerPage", String(next + 1), String(list.length)));
    };
    const many = list.length > 1;
    // When every mod that blocks can simply be turned off, one press does them all.
    const offs = list.flatMap((b) => b.fixes.filter((f) => f.kind === "turnOff").slice(0, 1));
    const allOff = many && offs.length === list.length;
    return (
      <section className="blockers in-banner" id={id} aria-label={title}>
        {said}
        <div className="blocker" data-blocker={shown.mod.id}>
          <span className="blocker-head">
            {reasonLines(shown, false)}
            {allOff && (
              <button
                className="btn-flat blocker-all"
                data-fix="turnOffAll"
                disabled={locked || list.some((b) => isBusy(tag, b.mod.id))}
                onClick={() => applyAll(offs)}
              >
                {tn("mods.turnOffAll", list.length)}
              </button>
            )}
          </span>
          <span className="blocker-foot">
            <span className="blocker-actions" role="group" aria-label={t("mods.fixesFor", shown.mod.name)}>
              <FixButtons tag={tag} fixes={shown.fixes} locked={locked} review={review} apply={apply} flat />
            </span>
            {many && (
              <span className="blocker-pager" role="group" aria-label={t("mods.blockerPager")}>
                <button className="pager-btn" onClick={() => go(-1)} aria-label={t("mods.blockerPrev")}>
                  ‹
                </button>
                <span className="pager-at" data-must-fit>
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
      <ul className="blocker-list">
        {list.map((b) => (
          <li key={b.mod.id} className="blocker" data-blocker={b.mod.id}>
            {reasonLines(b, true)}
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

/** A sentence with the mod's name in it, the name drawn in the name colour. */
function Named({ text, name }: { text: string; name: string }) {
  const at = name ? text.indexOf(name) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <strong>{name}</strong>
      {text.slice(at + name.length)}
    </>
  );
}
