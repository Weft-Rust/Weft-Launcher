import { useEffect, useId, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { translateError } from "../../i18n/errors";
import { useMods } from "../../hooks/useMods";
import { modsApi } from "../../mods/api";
import type { FileInspection, InstallPlan } from "../../mods/types";
import { shortSha } from "../../mods/select";
import { activeStep, fileChecks, fileVerdict, installOutcome, planDepChecks, weakerDeps } from "../../mods/checks";
import { Dialog } from "../Dialog";
import { Code } from "../Truncate";
import { CheckList } from "./CheckList";
import { ModProgressBar } from "./ModProgressBar";
import { TrustBadge } from "./TrustBadge";
import { useCheckContext } from "./InstallDialog";

interface FileInstallDialogProps {
  tag: string;
  path: string;
  onClose: () => void;
}

/**
 * A zip from the player's computer: the warning, what can be checked, and for a file the
 * catalogue knows, everything that install brings along. A typed "yes" when nothing could be
 * checked, in the footer beside the button it unlocks.
 */
export function FileInstallDialog({ tag, path, onClose }: FileInstallDialogProps) {
  const { t, tm, tr, formatSize, formatList } = useI18n();
  const { installFile, isBusy, progressOf } = useMods();
  const ctx = useCheckContext(tag);
  const [inspection, setInspection] = useState<FileInspection | null>(null);
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const whyId = useId();
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

  // A catalogued file installs like that build: with what it needs, by the same plan.
  const knownSha = inspection?.catalogMatch?.build.sha256;
  useEffect(() => {
    if (!knownSha) return;
    let live = true;
    modsApi
      .plan(tag, knownSha)
      .then((p) => live && setPlan(p))
      .catch((err) => live && setError(translateError(err)));
    return () => {
      live = false;
    };
  }, [tag, knownSha]);

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
  const waitingForPlan = !!known && !plan;
  const trust = known?.build.trust ?? "unverified";
  const name = known?.name ?? inspection.name ?? id;
  const outcome = plan ? installOutcome(plan, !!inspection.replaces, name, ctx) : null;
  const weaker = plan ? weakerDeps(plan, ctx) : [];
  const step = activeStep(progressOf({ kind: "mod", tag, id }), plan, name);
  const checks = [...fileChecks(inspection, tag), ...(plan && known ? planDepChecks(plan, known.build.deps, ctx) : [])];

  const confirm = async () => {
    if (!confirmed || working || !usable || waitingForPlan) return;
    setError(null);
    const result = await installFile(tag, path, inspection.sha256, id, plan?.install.map((i) => i.sha256));
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
          <ModProgressBar progress={step.progress} name={step.name} />
        ) : (
          <>
            {needsTyping && (
              <span className="typed-confirm">
                <label htmlFor={inputId} id={whyId}>
                  {tr("mods.typeToConfirm", <strong key="id">{id}</strong>)}
                </label>
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
                  data-autofocus
                />
              </span>
            )}
            {usable && (
              <button
                className={needsTyping ? "btn-danger" : "btn-primary"}
                onClick={confirm}
                disabled={!confirmed || waitingForPlan}
                aria-describedby={needsTyping && !confirmed ? whyId : undefined}
                title={needsTyping && !confirmed ? t("mods.installAnywayWhy", id) : undefined}
              >
                {t(needsTyping ? "mods.installAnyway" : (outcome?.button ?? "mods.install"))}
              </button>
            )}
            <button className="btn-secondary" onClick={onClose} data-autofocus={needsTyping ? undefined : true}>
              {t(usable ? "mods.cancel" : "mods.close")}
            </button>
          </>
        )
      }
    >
      {usable && (
        <p className={`dialog-warning ${trust === "reviewed" && !weaker.length ? "amber" : "red"}`}>
          {trust === "reviewed" ? t("mods.warnNative", name) : t("mods.warnFile")}
          {weaker.length > 0 && <> {t("mods.warnDepsUnreviewed", formatList(weaker.map((w) => w.name)))}</>}
        </p>
      )}
      {outcome?.explain && <p className="dialog-note trust-change">{tm(outcome.explain)}</p>}
      {archive && !known && inspection.name && (
        <p className="dialog-summary">
          {t("mods.fileSaysItIs", inspection.name)}
          {inspection.summary ? ` ${inspection.summary}` : ""}
        </p>
      )}
      <CheckList label={t("mods.checksLabel")} checks={checks} />
      {waitingForPlan && !error && (
        <p className="dialog-note" role="status">
          {t("mods.planning")}
        </p>
      )}
      {inspection.replaces && usable && <p className="dialog-note">{t("mods.fileReplaces", inspection.replaces)}</p>}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  );
}
