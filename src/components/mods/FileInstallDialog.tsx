import { useId, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import type { Shown } from "../../i18n/errors";
import { useMods } from "../../hooks/useMods";
import { useCheckContext } from "../../hooks/useCheckContext";
import { usePlan } from "../../hooks/usePlan";
import type { FileInspection, InstallPlan } from "../../mods/types";
import { networkDown, shortSha } from "../../mods/select";
import {
  activeStep,
  consentChanges,
  fileChecks,
  fileReplaceNotes,
  fileVerdict,
  installOutcome,
  planConsent,
  planDepChecks,
  weakerDeps,
  withProblem,
  type ConsentView,
} from "../../mods/checks";
import { Dialog } from "../Dialog";
import { ErrorText } from "../ErrorText";
import { Code } from "../Truncate";
import { CheckList } from "./CheckList";
import { ModProgressBar } from "./ModProgressBar";
import { PlanChanges, useOutcomeNote } from "./PlanChanges";
import { RichText } from "./RichText";
import { TrustBadge } from "./TrustBadge";

interface FileInstallDialogProps {
  tag: string;
  path: string;
  onClose: () => void;
}

/** What installing a file asks the player to agree to, for telling a change to it. */
function fileConsent(inspection: FileInspection, plan: InstallPlan | null): ConsentView {
  if (plan) return planConsent(plan);
  const id = inspection.archive?.id ?? "";
  return { builds: [{ id, name: inspection.name ?? id, version: null, trust: "unverified" }], enable: [], off: [] };
}

/**
 * A zip from the player's computer: the warning, what can be checked, and for a file the
 * catalogue knows, everything that install brings along. A typed "yes" when nothing could be
 * checked, in the footer beside the button it unlocks. Title and button say the same thing:
 * install, update, or replace; a replace says when the tier changes.
 */
export function FileInstallDialog({ tag, path, onClose }: FileInstallDialogProps) {
  const { t, tm, tr, formatSize, formatList } = useI18n();
  const mods = useMods();
  const { installFile, isBusy, progressOf, cancel, isCancelling, profile, catalog, catalogError, loadProfile, nameIn } = mods;
  const report = profile(tag);
  const ctx = useCheckContext(tag);
  const [error, setError] = useState<Shown | null>(null);
  const [typed, setTyped] = useState("");
  const [changedFrom, setChangedFrom] = useState<ConsentView | null>(null);
  const outcomeNote = useOutcomeNote();
  const inputId = useId();
  const whyId = useId();
  const fileName = path.split(/[\\/]/).pop() ?? path;

  const inspected = usePlan<FileInspection>(`${tag}|${path}`, [report, catalog], () => mods.inspectFile(tag, path));
  const inspection = inspected.value;
  // A catalogued file installs like that build: with what it needs, by the same plan.
  const knownSha = inspection?.catalogMatch?.build.sha256 ?? null;
  const planned = usePlan<InstallPlan>(knownSha ? `${tag}|${knownSha}` : null, [report, catalog], knownSha ? () => mods.plan(tag, knownSha) : null);

  if (!inspection) {
    return (
      <Dialog
        onClose={onClose}
        title={t("mods.fileChecking", fileName, tag)}
        footer={
          <button className="btn-secondary" onClick={onClose} data-autofocus>
            {t(inspected.error ? "mods.close" : "mods.cancel")}
          </button>
        }
      >
        {inspected.error ? (
          <ErrorText error={inspected.error} />
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
  const op = { kind: "mod", tag, id } as const;
  const working = isBusy(tag, id);
  const plan = known ? planned.value : null;
  const { usable, needsTyping } = fileVerdict(inspection);
  const confirmed = !needsTyping || typed.trim() === id;
  // Contract R4 §2: the inspection (and for a known file, its plan) on screen must be the
  // answer for this set and catalogue, and nothing in it may say no.
  const ready = inspected.ready && (!known || (planned.ready && !!plan));
  const problem = plan?.problem ?? null;
  const replacing = !!inspection.replaces;
  const trust = known?.build.trust ?? "unverified";
  const name = known?.name ?? inspection.name ?? id;
  const outcome = plan ? installOutcome(plan, replacing, name, ctx) : null;
  const weaker = plan ? weakerDeps(plan, ctx) : [];
  const step = activeStep(progressOf(op));
  const stepName = step ? (plan ? [plan.target, ...plan.install].find((i) => i.sha256 === step.sha256)?.name : undefined) ?? (step.modId === id ? name : nameIn(tag)(step.modId)) : name;
  const checks = withProblem(problem, [...fileChecks(inspection, tag, ctx.indexFrom ?? null), ...(plan && known ? planDepChecks(plan, known.build.deps, ctx) : [])]);
  const notes = usable ? fileReplaceNotes(inspection, report?.mods.find((m) => m.id === id)?.trust) : [];
  const changes = changedFrom && ready ? consentChanges(changedFrom, fileConsent(inspection, plan), nameIn(tag)) : null;
  const offline = !!plan && plan.install.length > 0 && networkDown(catalog, catalogError);
  const blocked = !ready || !!problem || !usable;

  const confirm = async () => {
    if (!confirmed || working || blocked) return;
    setError(null);
    outcomeNote.clear();
    const result = await installFile(tag, path, inspection, plan);
    if (result.status === "done") onClose();
    else if (result.status === "cancelled") outcomeNote.cancelled();
    else if (result.status === "failed") {
      if (result.error.code === "ModChangedMeanwhile") {
        setChangedFrom(fileConsent(inspection, plan));
        inspected.reload();
        planned.reload();
      }
      setError(result.shown);
    }
  };

  const retry = async () => {
    await loadProfile(tag);
    inspected.reload();
    planned.reload();
  };

  const title = !archive
    ? t("mods.fileNotAModTitle", fileName, tag)
    : !usable
      ? t("mods.fileUnusableTitle", fileName, tag)
      : known
        ? replacing
          ? t("mods.fileKnownUpdateTitle", known.name, known.build.version, tag)
          : t("mods.fileKnownTitle", known.name, known.build.version, tag)
        : replacing
          ? t("mods.fileReplaceTitle", inspection.replaces ?? id, fileName, tag)
          : t("mods.fileUnverifiedTitle", fileName, tag);
  const button = needsTyping ? (replacing ? "mods.replaceAnyway" : "mods.installAnyway") : (outcome?.button ?? (replacing ? "mods.updateButton" : "mods.install"));
  const label = t(button);

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
          <ModProgressBar progress={step} name={stepName} onCancel={() => cancel(op)} cancelling={isCancelling(op)} />
        ) : (
          <>
            {needsTyping && (
              <span className="typed-confirm">
                <label htmlFor={inputId} id={whyId}>
                  {tr(replacing ? "mods.typeToReplace" : "mods.typeToConfirm", <strong key="id">{id}</strong>)}
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
                disabled={!confirmed || blocked}
                aria-describedby={needsTyping && !confirmed ? whyId : undefined}
                title={needsTyping && !confirmed ? t("mods.installAnywayWhy", id) : undefined}
              >
                {offline ? t("mods.needsNetworkButton", label) : label}
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
      {changes && <PlanChanges changes={changes} />}
      {notes.map((n, i) => (
        <p key={i} className={`dialog-note${n.key === "mods.fileReplacesTrust" ? " trust-change" : ""}`}>
          <RichText msg={n} />
        </p>
      ))}
      {offline && <p className="dialog-note trust-change">{t("mods.needsNetworkNote")}</p>}
      {outcome?.explain && <p className="dialog-note trust-change">{tm(outcome.explain)}</p>}
      {archive && !known && inspection.name && (
        <p className="dialog-summary">
          {t("mods.fileSaysItIs", inspection.name)}
          {inspection.summary ? ` ${inspection.summary}` : ""}
        </p>
      )}
      <CheckList label={t("mods.checksLabel")} checks={checks} onRetry={retry} />
      {known && !plan && !planned.error && (
        <p className="dialog-note" role="status">
          {t("mods.planning")}
        </p>
      )}
      {planned.error && <ErrorText error={planned.error} />}
      {outcomeNote.node}
      {error && !changes && <ErrorText error={error} />}
    </Dialog>
  );
}
