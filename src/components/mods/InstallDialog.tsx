import { useEffect, useId, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../i18n/useI18n";
import { translateError } from "../../i18n/errors";
import { useMods } from "../../hooks/useMods";
import type { CatalogMod, InstallPlan } from "../../mods/types";
import { fittingVersions, installedFor, sourceUrl } from "../../mods/select";
import { activeStep, installChecks, installOutcome, replaceNotes, weakerDeps, type InstallCheckContext } from "../../mods/checks";
import { Dialog } from "../Dialog";
import { VersionSelect } from "../VersionSelect";
import { Truncate } from "../Truncate";
import { CheckList } from "./CheckList";
import { ModProgressBar } from "./ModProgressBar";
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

type PlanState = { sha: string; plan: InstallPlan | null; error: string | null };

/** What the plan and checks need from the version's set. */
export function useCheckContext(tag: string): InstallCheckContext {
  const { profile, nameIn } = useMods();
  const report = profile(tag);
  return useMemo(() => {
    const mods = report?.mods ?? [];
    return {
      tag,
      name: nameIn(tag),
      enabled: new Set(mods.filter((m) => m.enabled).map((m) => m.id)),
      trustOf: (id: string) => mods.find((m) => m.id === id)?.trust,
      versionAbi: report?.versionAbi ?? null,
    };
  }, [tag, report, nameIn]);
}

/**
 * Every install and update of a catalogue mod goes through here: the plain warning that a mod
 * is a program first, then what the launcher checked and what else changes.
 */
export function InstallDialog({ tag, mod, initialSha, allowPrerelease = false, onClose }: InstallDialogProps) {
  const { t, tm, formatSize, formatList } = useI18n();
  const mods = useMods();
  const { catalog, install, isBusy, progressOf } = mods;
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
  const [planned, setPlanned] = useState<PlanState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const working = isBusy(tag, mod.id);

  useEffect(() => {
    if (!v) return;
    let live = true;
    mods
      .plan(tag, v.sha256)
      .then((plan) => live && setPlanned({ sha: v.sha256, plan, error: null }))
      .catch((err) => live && setPlanned({ sha: v.sha256, plan: null, error: translateError(err) }));
    return () => {
      live = false;
    };
    // Re-planned when the build or the set changes; `mods.plan` itself never changes.
  }, [tag, v?.sha256, report]);

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
        <p className="dialog-summary">{t("mods.dlgNoBuild", mod.name, tag)}</p>
      </Dialog>
    );
  }

  const plan = planned?.sha === v.sha256 ? planned.plan : null;
  const replacing = !!installed && installed.sha256 !== v.sha256;
  const authors = formatList(mod.authors) || v.sourceRepo;
  const link = mod.homepage ?? sourceUrl(v);
  const checks = plan ? installChecks(plan, v, ctx) : [];
  const notes = plan ? replaceNotes(plan) : [];
  const outcome = plan ? installOutcome(plan, replacing, mod.name, ctx) : null;
  const weaker = plan ? weakerDeps(plan, ctx) : [];
  const blocked = !plan || !!plan.problem;
  const step = activeStep(progressOf({ kind: "mod", tag, id: mod.id }), plan, mod.name);

  const confirm = async () => {
    if (working || blocked) return;
    setError(null);
    const result = await install(tag, v.sha256, mod.id, plan?.install.map((i) => i.sha256));
    if (result.status === "done") onClose();
    else if (result.status === "failed") setError(result.message);
  };

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
            <ModProgressBar progress={step.progress} name={step.name} />
          ) : (
            <>
              <button className="btn-primary" onClick={confirm} disabled={blocked}>
                {t(outcome?.button ?? (replacing ? "mods.updateButton" : "mods.install"))}
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
            onChange={setSha}
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
      {outcome?.explain && <p className="dialog-note trust-change">{tm(outcome.explain)}</p>}
      {planned?.error ? (
        <div className="inline-error" role="alert">
          {planned.error}
        </div>
      ) : plan ? (
        <CheckList label={t("mods.checksLabel")} checks={checks} />
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
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  );
}
