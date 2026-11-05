import { useI18n } from "../i18n/useI18n";
import type { Launch } from "../hooks/useLaunch";
import { ErrorText } from "./ErrorText";

/**
 * A refused start of `tag`, where the blocker panel can't say it: a refusal for another reason as
 * it is, or a refusal because of mods that couldn't be read again, with a way to check again.
 */
export function LaunchRefusal({ tag, launch }: { tag: string; launch: Launch }) {
  const { t } = useI18n();
  const { shownError, unread } = launch.refusalFor(tag);
  if (shownError) return <ErrorText error={shownError} className="launch-error" />;
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
