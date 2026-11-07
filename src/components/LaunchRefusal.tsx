import { useI18n } from "../i18n/useI18n";
import type { Launch } from "../hooks/useLaunch";
import { useModProfiles } from "../hooks/useMods";
import { ErrorText } from "./ErrorText";
import type { Review } from "./mods/ModFixes";

/**
 * A refused start of `tag`, where the blocker panel can't say it: a refusal for another reason as
 * it is, or a refusal because of mods that couldn't be read again, with a way to check again.
 */
export function LaunchRefusal({ tag, launch, review }: { tag: string; launch: Launch; review: Review }) {
  const { t } = useI18n();
  const { profile } = useModProfiles();
  const { shownError, unread, storeMissing } = launch.refusalFor(tag);
  // A mod whose stored copy is gone: the same build installed again brings it back, through its
  // install dialog; a file from the player's computer, through From file.
  const missing = storeMissing ? profile(tag)?.mods.find((m) => m.id === storeMissing) : undefined;
  if (shownError)
    return (
      <ErrorText error={shownError} className="launch-error">
        {missing && review.canUpdate(missing) && (
          <button className="btn-primary btn-small" data-fix="reinstall" onClick={() => review.openUpdate(missing, missing.sha256)}>
            {t("mods.reinstall", missing.name)}
          </button>
        )}
        {missing && !review.canUpdate(missing) && missing.origin.kind === "file" && (
          <button className="btn-primary btn-small" data-fix="replaceFile" onClick={() => review.openFile().catch(() => {})}>
            {t("mods.replaceFromFile", missing.name)}
          </button>
        )}
      </ErrorText>
    );
  if (!unread) return null;
  const why = unread.unread ?? unread.shown;
  return (
    <ErrorText error={{ ...why, message: t("mods.refusedUnread", why.message) }} className="launch-error refused-unread">
      <button className="btn-secondary btn-small" disabled={launch.rereading} onClick={launch.checkAgain}>
        {launch.rereading ? t("mods.retrying") : t("mods.refusedRetry")}
      </button>
    </ErrorText>
  );
}
