import { useEffect, useId, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { translateError } from "../../i18n/errors";
import { useMods } from "../../hooks/useMods";
import { modsApi } from "../../mods/api";
import type { FileInspection } from "../../mods/types";
import { shortSha } from "../../mods/select";
import { fileChecks, fileVerdict } from "../../mods/checks";
import { Dialog } from "../Dialog";
import { Code } from "../Truncate";
import { CheckList } from "./CheckList";
import { ModProgressBar } from "./ModProgressBar";
import { TrustBadge } from "./TrustBadge";

interface FileInstallDialogProps {
  tag: string;
  path: string;
  onClose: () => void;
}

/** A zip from the player's computer: what can be checked, and a typed "yes" when nothing could. */
export function FileInstallDialog({ tag, path, onClose }: FileInstallDialogProps) {
  const { t, tr, formatSize } = useI18n();
  const { installFile, isBusy, progressFor } = useMods();
  const [inspection, setInspection] = useState<FileInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const fileName = path.split(/[\\/]/).pop() ?? path;

  useEffect(() => {
    let live = true;
    modsApi
      .inspectFile(tag, path)
      .then((i) => live && setInspection(i))
      .catch((err) => live && setError(translateError(err)));
    return () => {
      live = false;
    };
  }, [tag, path]);

  if (!inspection) {
    return (
      <Dialog
        onClose={onClose}
        title={t("mods.fileChecking", fileName, tag)}
        footer={
          <button className="btn-secondary" onClick={onClose} data-autofocus>
            {t(error ? "mods.close" : "mods.cancel")}
          </button>
        }
      >
        {error ? (
          <div className="inline-error" role="alert">
            {error}
          </div>
        ) : (
          <p className="dialog-note" role="status">
            {t("loading")}
          </p>
        )}
      </Dialog>
    );
  }

  const { archive, catalogMatch: known } = inspection;
  const id = archive?.id ?? "";
  const working = isBusy(tag, id);
  const { usable, needsTyping } = fileVerdict(inspection);
  const confirmed = !needsTyping || typed.trim() === id;
  const trust = known?.build.trust ?? "unverified";

  const confirm = async () => {
    if (!confirmed || working || !usable) return;
    setError(null);
    const result = await installFile(tag, path, inspection.sha256, id);
    if (result.status === "done") onClose();
    else if (result.status === "failed") setError(result.message);
  };

  const title = !archive
    ? t("mods.fileNotAModTitle", fileName, tag)
    : !usable
      ? t("mods.fileUnusableTitle", fileName, tag)
      : known
        ? t("mods.fileKnownTitle", known.name, known.build.version, tag)
        : t("mods.fileUnverifiedTitle", fileName, tag);

  return (
    <Dialog
      onClose={onClose}
      locked={working}
      title={title}
      subtitle={
        <>
          {archive && <TrustBadge trust={trust} />}
          <span>{t("mods.fileFrom", fileName, formatSize(inspection.size))}</span>
          <span>
            SHA-256 <Code full={inspection.sha256} short={shortSha(inspection.sha256)} />
          </span>
        </>
      }
      footer={
        working ? (
          <ModProgressBar progress={progressFor(inspection.sha256)} name={known?.name ?? inspection.name ?? id} />
        ) : (
          <>
            {usable && (
              <button className={needsTyping ? "btn-danger" : "btn-primary"} onClick={confirm} disabled={!confirmed}>
                {t(needsTyping ? "mods.installAnyway" : "mods.install")}
              </button>
            )}
            <button className="btn-secondary" onClick={onClose} data-autofocus={needsTyping ? undefined : true}>
              {t(usable ? "mods.cancel" : "mods.close")}
            </button>
          </>
        )
      }
    >
      {archive && !known && inspection.name && (
        <p className="dialog-summary">
          {t("mods.fileSaysItIs", inspection.name)}
          {inspection.summary ? ` ${inspection.summary}` : ""}
        </p>
      )}
      <CheckList label={t("mods.checksLabel")} checks={fileChecks(inspection, tag)} />
      {inspection.replaces && usable && <p className="dialog-note">{t("mods.fileReplaces", inspection.replaces)}</p>}
      {usable && (
        <p className={`dialog-warning ${trust === "reviewed" ? "amber" : "red"}`}>
          {trust === "reviewed" ? t("mods.warnNative", known?.name ?? id) : t("mods.warnFile")}
        </p>
      )}
      {needsTyping && (
        <div className="typed-confirm">
          <label htmlFor={inputId}>{tr("mods.typeToConfirm", <strong key="id">{id}</strong>)}</label>
          <input
            id={inputId}
            className="text-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.repeat) confirm();
            }}
            spellCheck={false}
            autoComplete="off"
            disabled={working}
          />
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  );
}
