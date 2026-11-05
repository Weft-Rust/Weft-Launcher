import { ReactNode, useEffect, useId } from "react";
import { useI18n } from "../i18n/useI18n";
import type { Shown } from "../i18n/errors";
import { announce } from "./LiveRegion";

interface ErrorTextProps {
  error: Shown;
  className?: string;
  /** Buttons beside the message, e.g. Retry. */
  children?: ReactNode;
  /** Words before the message, e.g. "Couldn't read your sources:". */
  lead?: string;
  /** Said once, politely, as it appears. On by default; off where the same text is said elsewhere. */
  speak?: boolean;
}

/**
 * A failure: the translated sentence, and the backend's own words behind "Details" when there
 * are any. Said once in the polite live region, not as an alert.
 */
export function ErrorText({ error, className = "inline-error", children, lead, speak = true }: ErrorTextProps) {
  const { t } = useI18n();
  const id = useId();
  const text = lead ? `${lead} ${error.message}` : error.message;
  useEffect(() => {
    if (speak && text) announce(`error:${id}:${text}`, text);
  }, [speak, text, id]);
  return (
    <div className={`${className} error-text${children ? " with-action" : ""}`}>
      <span className="error-message" data-must-fit>
        {text}
        {error.detail && <ErrorDetails detail={error.detail} label={t("errors.details")} />}
      </span>
      {children}
    </div>
  );
}

/** The backend's words, folded away. */
export function ErrorDetails({ detail, label }: { detail: string; label: string }) {
  return (
    <details className="error-details">
      <summary>{label}</summary>
      <code>{detail}</code>
    </details>
  );
}
