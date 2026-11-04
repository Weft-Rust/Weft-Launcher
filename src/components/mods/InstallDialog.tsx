import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../i18n/useI18n";
import { useMods } from "../../hooks/useMods";
import type { CatalogMod, CatalogVersion, InstalledMod } from "../../mods/types";
import { fittingVersions, shortCommit, shortSha, sourceUrl } from "../../mods/select";
import { Dialog } from "../Dialog";
import { VersionSelect } from "../VersionSelect";
import { Check, CheckList } from "./CheckList";
import { ModProgressBar } from "./ModProgressBar";
import { ChannelBadge, TrustBadge } from "./TrustBadge";

interface InstallDialogProps {
  tag: string;
  versionAbi: string | null;
  mod: CatalogMod;
  installed: InstalledMod | undefined;
  allowPrerelease: boolean;
  onClose: () => void;
}

function buildChecks(
  t: (k: string, ...a: string[]) => string,
  v: CatalogVersion,
  installedIds: Set<string>
): Check[] {
  const checks: Check[] = [];
  if (v.trust === "reviewed" && v.reviewed) {
    checks.push({
      state: "yes",
      title: t("mods.ckIndex"),
      detail: t("mods.ckIndexDetail", v.reviewed.by, v.reviewed.at),
    });
  } else {
    checks.push({
      state: "no",
      title: t("mods.ckNotIndex"),
      detail: t("mods.ckNotIndexDetail", v.sourceRepo),
    });
  }
  checks.push({
    state: "yes",
    title: (
      <>
        {t("mods.ckPinned")} · <code>{shortSha(v.sha256)}</code>
      </>
    ),
  });
  if (v.provenance) {
    checks.push({
      state: "yes",
      title: t("mods.ckBuilt"),
      detail: (
        <>
          {v.provenance.repo ?? v.sourceRepo} @ <code>{shortCommit(v.sourceCommit)}</code>
          {v.provenance.workflow ? ` · ${v.provenance.workflow.split("/").pop()}` : ""}
        </>
      ),
    });
  } else {
    checks.push({ state: "unknown", title: t("mods.ckNoBuild"), detail: t("mods.ckNoBuildDetail") });
  }
  checks.push({
    state: "yes",
    title: t("mods.ckFits"),
    detail: (
      <>
        {t("mods.ckFitsDetail")} <code>{v.abi.slice(0, 8)}</code>
      </>
    ),
  });
  const deps = v.deps.filter((d) => d !== "base");
  if (deps.length) {
    const toInstall = deps.filter((d) => !installedIds.has(d));
    checks.push({
      state: "yes",
      title: t("mods.ckDeps", deps.join(", ")),
      detail: toInstall.length ? t("mods.ckDepsDetail", toInstall.join(", ")) : t("mods.ckDepsHave"),
    });
  }
  return checks;
}

export function InstallDialog({ tag, versionAbi, mod, installed, allowPrerelease, onClose }: InstallDialogProps) {
  const { t, formatSize } = useI18n();
  const { catalog, install, busy, progress, profiles } = useMods();
  // An offered update stays pickable even when prereleases are hidden.
  const versions = useMemo(
    () =>
      fittingVersions(catalog, mod, versionAbi, true).filter(
        (x) => allowPrerelease || x.channel === "release" || x.sha256 === installed?.update?.sha256
      ),
    [catalog, mod, versionAbi, allowPrerelease, installed]
  );
  const [sha, setSha] = useState(installed?.update?.sha256 ?? versions[0]?.sha256 ?? "");
  const [error, setError] = useState<string | null>(null);
  const v = versions.find((x) => x.sha256 === sha) ?? versions[0];
  const working = !!busy[`${tag}:${mod.id}`];
  const current = v ? progress[v.sha256] : undefined;
  const installedIds = new Set((profiles[tag]?.mods ?? []).map((m) => m.id));

  if (!v) return null;
  const replacing = installed && installed.sha256 !== v.sha256;
  const authors = mod.authors.join(", ") || v.sourceRepo;
  const link = mod.homepage ?? sourceUrl(v);

  const confirm = async () => {
    setError(null);
    const err = await install(tag, v.sha256, mod.id);
    if (err) setError(err);
    else onClose();
  };

  return (
    <Dialog
      onClose={onClose}
      locked={working}
      title={t(replacing ? "mods.dlgUpdateTitle" : "mods.dlgInstallTitle", mod.name, v.version)}
      subtitle={
        <>
          <TrustBadge trust={v.trust} /> <ChannelBadge channel={v.channel} />{" "}
          {t("mods.dlgFor", tag, formatSize(v.size))} · {t("mods.by", authors)}
        </>
      }
    >
      {(versions.length > 1 || (replacing && installed?.version)) && (
        <div className="dialog-field">
          {versions.length > 1 && (
            <>
              <span className="dialog-field-label">{t("mods.dlgVersion")}</span>
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
                label={t("mods.dlgVersion")}
                compact
              />
            </>
          )}
          {replacing && installed?.version && <span className="dialog-note">{t("mods.ckReplaces", installed.version)}</span>}
        </div>
      )}
      <CheckList label={t("mods.checksLabel")} checks={buildChecks(t, v, installedIds)} />
      <p className={`dialog-warning ${v.trust === "reviewed" ? "amber" : "red"}`}>
        {v.trust === "reviewed" ? t("mods.warnNative", mod.name) : t("mods.warnUnreviewed", mod.name, v.sourceRepo)}
      </p>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-actions">
        {working ? (
          <ModProgressBar progress={current} />
        ) : (
          <>
            <button className="btn-primary" onClick={confirm} data-autofocus>
              {t(replacing ? "mods.updateButton" : "mods.install")}
            </button>
            <button className="btn-secondary" onClick={onClose}>
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
      </div>
    </Dialog>
  );
}
