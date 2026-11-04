import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { translateError } from "../../i18n/errors";
import { useMods } from "../../hooks/useMods";
import { modsApi } from "../../mods/api";
import type { FileInspection } from "../../mods/types";
import { shortSha } from "../../mods/select";
import { Dialog } from "../Dialog";
import { Check, CheckList } from "./CheckList";
import { TrustBadge } from "./TrustBadge";

interface FileInstallDialogProps {
  tag: string;
  path: string;
  onClose: () => void;
}

const PLATFORM_LABEL: Record<string, string> = {
  "windows-x64": "Windows",
  "linux-x64": "Linux",
  "macos-arm64": "macOS",
};

/** A zip from the player's computer: what can be checked, and a typed "yes" when nothing could. */
export function FileInstallDialog({ tag, path, onClose }: FileInstallDialogProps) {
  const { t, formatSize } = useI18n();
  const { installFile, busy } = useMods();
  const [inspection, setInspection] = useState<FileInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const fileName = path.split(/[\\/]/).pop() ?? path;

  useEffect(() => {
    modsApi
      .inspectFile(tag, path)
      .then(setInspection)
      .catch((err) => setError(translateError(err)));
  }, [tag, path]);

  if (!inspection) {
    return (
      <Dialog onClose={onClose} title={t("mods.fileChecking", fileName)}>
        {error ? (
          <div className="inline-error" role="alert">
            {error}
          </div>
        ) : (
          <p className="dialog-sub" aria-live="polite">
            {t("loading")}
          </p>
        )}
        <div className="dialog-actions">
          <button className="btn-secondary" onClick={onClose}>
            {t("mods.cancel")}
          </button>
        </div>
      </Dialog>
    );
  }

  const { archive, catalogMatch: known } = inspection;
  const id = archive?.id ?? "";
  const working = !!busy[`${tag}:${id}`];
  const unusable =
    !archive || !inspection.fitsSystem || !!inspection.revokedReason || (known !== null && !known.fitsVersion);
  const needsTyping = !known && !unusable;
  const confirmed = !needsTyping || typed.trim() === id;
  const shownName = known?.name ?? inspection.name ?? id;

  const checks: Check[] = [];
  if (inspection.revokedReason) {
    checks.push({ state: "no", title: t("mods.ckRevoked", inspection.revokedReason) });
  }
  if (known) {
    checks.push({ state: "yes", title: t("mods.ckFileKnown", known.name, known.version) });
    checks.push(
      known.fitsVersion
        ? { state: "yes", title: t("mods.ckFits") }
        : { state: "no", title: t("mods.ckFileFitsNo", tag) }
    );
  } else if (archive) {
    checks.push({ state: "no", title: t("mods.ckFileNotKnown") });
    checks.push({ state: "no", title: t("mods.ckNoBuild"), detail: t("mods.ckNoBuildDetail") });
    checks.push({ state: "unknown", title: t("mods.ckFileFitUnknown"), detail: t("mods.ckFileFitUnknownDetail") });
  }
  if (archive) {
    checks.push(
      inspection.fitsSystem
        ? {
            state: "yes",
            title: t("mods.ckLooksLikeMod"),
            detail: `${archive.libraries.join(", ")}${archive.hasAssets ? ", assets/" : ""} · ${t("mods.ckNothingElse")}`,
          }
        : {
            state: "no",
            title: t("mods.ckNotForSystem"),
            detail: t("mods.ckNotForSystemDetail", archive.platforms.map((p) => PLATFORM_LABEL[p] ?? p).join(", ")),
          }
    );
  } else {
    checks.push({
      state: "no",
      title: t("mods.ckNotAMod"),
      detail: inspection.problem ? translateError(inspection.problem) : undefined,
    });
  }

  const confirm = async () => {
    setError(null);
    const err = await installFile(tag, path, inspection.sha256, id);
    if (err) setError(err);
    else onClose();
  };

  const title = !archive
    ? t("mods.fileNotAModTitle", fileName)
    : known
      ? t("mods.fileKnownTitle", fileName, known.name, known.version)
      : t("mods.fileUnverifiedTitle", fileName);

  return (
    <Dialog
      onClose={onClose}
      locked={working}
      title={title}
      subtitle={
        <>
          {archive && <TrustBadge trust={known?.trust ?? "unverified"} />}{" "}
          {t("mods.fileFrom", formatSize(inspection.size))} · SHA-256 <code>{shortSha(inspection.sha256)}</code>
        </>
      }
    >
      {archive && !known && inspection.name && (
        <p className="dialog-summary">
          {t("mods.fileSaysItIs", shownName)}
          {inspection.summary ? ` ${inspection.summary}` : ""}
        </p>
      )}
      <CheckList label={t("mods.checksLabel")} checks={checks} />
      {!unusable && <p className="dialog-warning red">{t("mods.warnFile")}</p>}
      {inspection.replaces && !unusable && <p className="dialog-note">{t("mods.ckReplaces", inspection.replaces)}</p>}
      {needsTyping && (
        <label className="typed-confirm">
          <span>
            {t("mods.typeToConfirmBefore")}
            <strong>{id}</strong>
            {t("mods.typeToConfirmAfter")}
          </span>
          <input
            className="text-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && confirmed && !working && confirm()}
            spellCheck={false}
            autoComplete="off"
            data-autofocus
            disabled={working}
          />
        </label>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-actions">
        {!unusable && (
          <button
            className={needsTyping ? "btn-danger" : "btn-primary"}
            onClick={confirm}
            disabled={!confirmed || working}
          >
            {working ? t("mods.progressInstalling") : t(needsTyping ? "mods.installAnyway" : "mods.install")}
          </button>
        )}
        <button className="btn-secondary" onClick={onClose} disabled={working}>
          {t(unusable ? "mods.close" : "mods.cancel")}
        </button>
      </div>
    </Dialog>
  );
}
