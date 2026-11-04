import { useEffect, useId, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../i18n/useI18n";
import { translateError } from "../../i18n/errors";
import { useMods } from "../../hooks/useMods";
import type { CatalogMod, InstallPlan } from "../../mods/types";
import { fittingVersions, installedFor, sourceUrl } from "../../mods/select";
import { installChecks, replaceNotes } from "../../mods/checks";
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

/**
 * Every install and update of a catalogue mod goes through here: what the launcher checked,
 * what else changes, and the plain warning that a mod is a program.
 */
export function InstallDialog({ tag, mod, initialSha, allowPrerelease = false, onClose }: InstallDialogProps) {
  const { t, formatSize, formatList } = useI18n();
  const mods = useMods();
  const { catalog, install, isBusy, progressFor, nameIn } = mods;
  const report = mods.profile(tag);
  const installed = report ? installedFor(mod, report.mods) : undefined;
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
  const enabled = new Set((report?.mods ?? []).filter((m) => m.enabled).map((m) => m.id));
  const checks = plan ? installChecks(plan, v, { tag, name: nameIn(tag), enabled }) : [];
  const notes = plan ? replaceNotes(plan) : [];
  const blocked = !plan || !!plan.problem;
  // Whatever is downloading right now: a dependency first, then the mod itself.
  const shas = [...(plan?.install.map((i) => i.sha256) ?? []), v.sha256];
  const entries = shas.map((s) => progressFor(s)).filter((p) => p !== undefined);
  const active = entries.find((p) => p.stage !== "installing") ?? entries[entries.length - 1];
  const activeName = active ? (plan?.install.find((i) => i.sha256 === active.sha256)?.name ?? mod.name) : mod.name;
  const unreviewedDeps = plan?.install.filter((i) => i.trust !== "reviewed").map((i) => i.name) ?? [];

  const confirm = async () => {
    if (working || blocked) return;
    setError(null);
    const result = await install(tag, v.sha256, mod.id);
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
            <ModProgressBar progress={active} name={activeName} />
          ) : (
            <>
              <button className="btn-primary" onClick={confirm} disabled={blocked}>
                {t(replacing ? "mods.updateButton" : "mods.install")}
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
      <p className={`dialog-warning ${v.trust === "reviewed" ? "amber" : "red"}`}>
        {v.trust === "reviewed" ? t("mods.warnNative", mod.name) : t("mods.warnUnreviewed", mod.name, v.sourceRepo)}
        {unreviewedDeps.length > 0 && v.trust === "reviewed" && <> {t("mods.warnDepsUnreviewed", unreviewedDeps.join(", "))}</>}
      </p>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  );
}
