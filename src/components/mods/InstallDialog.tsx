import { useId, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../i18n/useI18n";
import type { Shown } from "../../i18n/errors";
import { useMods } from "../../hooks/useMods";
import { useCheckContext } from "../../hooks/useCheckContext";
import { usePlan } from "../../hooks/usePlan";
import type { CatalogMod, InstallPlan } from "../../mods/types";
import { fittingVersions, installedFor, networkDown, sourceUrl } from "../../mods/select";
import {
  activeStep,
  consentChanges,
  installChecks,
  installOutcome,
  planConsent,
  replaceNotes,
  weakerDeps,
  type ConsentView,
} from "../../mods/checks";
import { Dialog } from "../Dialog";
import { ErrorText } from "../ErrorText";
import { VersionSelect } from "../VersionSelect";
import { Truncate } from "../Truncate";
import { CheckList, useRetry } from "./CheckList";
import { ModProgressBar } from "./ModProgressBar";
import { PlanChanges, useOutcomeNote } from "./PlanChanges";
import { RichText } from "./RichText";
import { ChannelBadge, TrustBadge } from "./TrustBadge";

interface InstallDialogProps {
  tag: string;
  mod: CatalogMod;
  /** The build to show first, e.g. the update an installed row offers. */
  initialSha?: string;
  allowPrerelease?: boolean;
  onClose: () => void;
}

/**
 * Every install and update of a catalogue mod goes through here: the plain warning that a mod
 * is a program first, then what the launcher checked and what else changes. The button installs
 * exactly the plan on screen (contract R4 §2); when the backend says it changed meanwhile, the
 * new plan shows with what changed, and the player confirms again.
 */
export function InstallDialog({ tag, mod, initialSha, allowPrerelease = false, onClose }: InstallDialogProps) {
  const { t, tm, formatSize, formatList } = useI18n();
  const mods = useMods();
  const { catalog, catalogError, install, isBusy, progressOf, cancel, isCancelling, loadProfile, nameIn } = mods;
  const report = mods.profile(tag);
  const installed = report ? installedFor(mod, report.mods) : undefined;
  const ctx = useCheckContext(tag);
  const versionLabelId = useId();

  // An offered update, or the build asked for, stays pickable even when prereleases are hidden.
  const versions = useMemo(
    () =>
      fittingVersions(catalog, mod, report?.versionAbi ?? null, true).filter(
        (x) => allowPrerelease || x.channel === "release" || x.sha256 === initialSha || x.sha256 === installed?.update?.sha256
      ),
    [catalog, mod, report?.versionAbi, allowPrerelease, initialSha, installed?.update?.sha256]
  );
  const [sha, setSha] = useState(initialSha ?? installed?.update?.sha256 ?? versions[0]?.sha256 ?? "");
  const v = versions.find((x) => x.sha256 === sha) ?? versions[0];
  const [error, setError] = useState<Shown | null>(null);
  const [changedFrom, setChangedFrom] = useState<ConsentView | null>(null);
  const outcomeNote = useOutcomeNote();
  const op = { kind: "mod", tag, id: mod.id } as const;
  const working = isBusy(tag, mod.id);

  // Asked again whenever the set or the catalogue changes; the answer counts only for both.
  const request = usePlan<InstallPlan>(v ? `${tag}|${v.sha256}` : null, [report, catalog], v ? () => mods.plan(tag, v.sha256) : null);

  if (!v) {
    return (
      <Dialog
        onClose={onClose}
        title={t("mods.dlgNoBuildTitle", mod.name, tag)}
        footer={
          <button className="btn-secondary" onClick={onClose} data-autofocus>
            {t("mods.close")}
          </button>
        }
      >
        {mod.summary && <p className="dialog-summary">{mod.summary}</p>}
        <p className="dialog-summary">{t("mods.dlgNoBuild", mod.name, tag)}</p>
      </Dialog>
    );
  }

  const plan = request.value;
  const replacing = !!installed && installed.sha256 !== v.sha256;
  const authors = formatList(mod.authors) || v.sourceRepo;
  const link = mod.homepage ?? sourceUrl(v);
  const checks = plan ? installChecks(plan, v, ctx) : [];
  const notes = plan ? replaceNotes(plan) : [];
  const outcome = plan ? installOutcome(plan, replacing, mod.name, ctx) : null;
  const weaker = plan ? weakerDeps(plan, ctx) : [];
  const blocked = !request.ready || !plan || !!plan.problem;
  const changes = changedFrom && plan && request.ready ? consentChanges(changedFrom, planConsent(plan), nameIn(tag)) : null;
  const step = activeStep(progressOf(op));
  const stepName = step ? (plan ? [plan.target, ...plan.install].find((i) => i.sha256 === step.sha256)?.name : undefined) ?? nameIn(tag)(step.modId) : mod.name;
  const offline = networkDown(catalog, catalogError);
  const label = t(outcome?.button ?? (replacing ? "mods.updateButton" : "mods.install"));

  const confirm = async () => {
    if (working || blocked || !plan) return;
    setError(null);
    outcomeNote.clear();
    const result = await install(tag, plan);
    if (result.status === "done") onClose();
    else if (result.status === "cancelled") outcomeNote.cancelled();
    else if (result.status === "failed") {
      if (result.error.code === "ModChangedMeanwhile") {
        // Show the new plan, and what is different from the one the player agreed to.
        setChangedFrom(planConsent(plan));
        request.reload();
      }
      setError(result.shown);
    }
  };

  const [retry, retrying] = useRetry(async () => {
    await loadProfile(tag);
    request.reload();
  });

  return (
    <Dialog
      onClose={onClose}
      locked={working}
      title={t(replacing ? "mods.dlgUpdateTitle" : "mods.dlgInstallTitle", mod.name, v.version, tag)}
      subtitle={
        <>
          <TrustBadge trust={v.trust} /> <ChannelBadge channel={v.channel} />
          <span>{formatSize(v.size)}</span>
          <span>·</span>
          <Truncate className="dialog-sub-by" text={t("mods.by", authors)} />
        </>
      }
      footer={
        <>
          {working ? (
            <ModProgressBar progress={step} name={stepName} onCancel={() => cancel(op)} cancelling={isCancelling(op)} />
          ) : (
            <>
              <button className="btn-primary" onClick={confirm} disabled={blocked}>
                {offline ? t("mods.needsNetworkButton", label) : label}
              </button>
              <button className="btn-secondary" onClick={onClose} data-autofocus>
                {t("mods.cancel")}
              </button>
            </>
          )}
          <span className="spacer" />
          {link && (
            <button className="link-btn" onClick={() => openUrl(link)}>
              {t("mods.viewSource")}
            </button>
          )}
        </>
      }
    >
      {versions.length > 1 && (
        <div className="dialog-field">
          <span className="dialog-field-label" id={versionLabelId}>
            {t("mods.dlgVersion")}
          </span>
          <VersionSelect
            value={v.sha256}
            options={versions.map((x) => ({
              value: x.sha256,
              label:
                x.channel === "release"
                  ? x.version
                  : `${x.version} · ${t(x.channel === "experimental" ? "mods.badgeExperimental" : "mods.badgePrerelease")}`,
            }))}
            onChange={(s) => {
              setSha(s);
              setChangedFrom(null);
              setError(null);
            }}
            disabled={working}
            labelledBy={versionLabelId}
            compact
          />
        </div>
      )}
      <p className={`dialog-warning ${v.trust === "reviewed" && !weaker.length ? "amber" : "red"}`}>
        {v.trust === "reviewed" ? t("mods.warnNative", mod.name) : t("mods.warnUnreviewed", mod.name, v.sourceRepo)}
        {weaker.length > 0 && <> {t("mods.warnDepsUnreviewed", formatList(weaker.map((w) => w.name)))}</>}
      </p>
      {changes && <PlanChanges changes={changes} />}
      {offline && <p className="dialog-note trust-change">{t("mods.needsNetworkNote")}</p>}
      {outcome?.explain && <p className="dialog-note trust-change">{tm(outcome.explain)}</p>}
      {request.error ? (
        <ErrorText error={request.error} />
      ) : plan ? (
        <CheckList label={t("mods.checksLabel")} checks={checks} onRetry={retry} retrying={retrying} />
      ) : (
        <p className="dialog-note" role="status">
          {t("mods.planning")}
        </p>
      )}
      {notes.map((n, i) => (
        <p key={i} className={`dialog-note${i === 0 && n.key === "mods.ckReplacesTrust" ? " trust-change" : ""}`}>
          <RichText msg={n} />
        </p>
      ))}
      {outcomeNote.node}
      {error && !changes && <ErrorText error={error} />}
      {/* What the mod is, whole: the card shows only the start of it. */}
      {mod.summary && <p className="dialog-summary mod-details-summary">{mod.summary}</p>}
    </Dialog>
  );
}
