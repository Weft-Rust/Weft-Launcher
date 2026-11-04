import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/useI18n";
import { useMods } from "../../hooks/useMods";
import type { InstalledMod, ProfileReport } from "../../mods/types";
import { StableLabel } from "../StableLabel";
import { ModIcon } from "./ModIcon";
import { ModProgressBar } from "./ModProgressBar";
import { ChannelBadge, TrustBadge } from "./TrustBadge";

interface RowProps {
  tag: string;
  mod: InstalledMod;
  onError: (message: string | null) => void;
  locked: boolean;
}

/** One line under the name: what the launcher knows, or what is wrong. */
function useMeta(mod: InstalledMod, tag: string): { text: string; bad: boolean } {
  const { t } = useI18n();
  switch (mod.status) {
    case "off":
      return { text: t("mods.statusOff"), bad: false };
    case "wrongVersion":
      return {
        text: mod.weftTag ? t("mods.statusWrongVersionTag", mod.weftTag) : t("mods.statusWrongVersion"),
        bad: true,
      };
    case "missingDeps":
      return { text: t("mods.statusMissingDeps", mod.missingDeps.join(", ")), bad: true };
    case "revoked":
      return { text: t("mods.statusRevoked", mod.revokedReason ?? ""), bad: true };
    case "unchecked":
      return {
        text: mod.origin.kind === "file" ? t("mods.statusUncheckedFile", mod.origin.name) : t("mods.statusUnchecked"),
        bad: false,
      };
    default: {
      const parts = [mod.weftTag ? t("mods.metaBuiltFor", mod.weftTag) : t("mods.metaBuiltForThis", tag)];
      if (mod.origin.kind === "source") parts.push(t("mods.metaFromSource", mod.origin.repo));
      const deps = mod.deps.filter((d) => d !== "base");
      if (deps.length) parts.push(t("mods.metaNeeds", deps.join(", ")));
      return { text: parts.join(" · "), bad: false };
    }
  }
}

function ModRow({ tag, mod, onError, locked }: RowProps) {
  const { t } = useI18n();
  const { setEnabled, remove, install, busy, progress } = useMods();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const meta = useMeta(mod, tag);
  const working = !!busy[`${tag}:${mod.id}`];
  const updating = mod.update ? progress[mod.update.sha256] : undefined;
  const disabled = working || locked;

  useEffect(() => {
    if (!confirmRemove) return;
    const timer = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmRemove]);

  const act = async (work: () => Promise<string | null>) => onError(await work());

  const onRemove = () => {
    if (!confirmRemove) return setConfirmRemove(true);
    setConfirmRemove(false);
    act(() => remove(tag, mod.id));
  };

  const fix = mod.status === "wrongVersion";
  const rowClass = [
    "mod-row framed",
    mod.enabled ? "" : "is-off",
    meta.bad ? "has-problem" : "",
  ].join(" ");

  return (
    <li className={rowClass}>
      <ModIcon id={mod.id} url={mod.icon} />
      <div className="mod-main">
        <div className="mod-title">
          <span className="mod-name">{mod.name}</span>
          {mod.version && <span className="mod-version">{mod.version}</span>}
          <TrustBadge trust={mod.trust} />
          <ChannelBadge channel={mod.channel} />
        </div>
        <p className={`mod-meta${meta.bad ? " bad" : ""}`} title={meta.text}>
          {meta.text}
        </p>
        {(updating || mod.update) && (
          <div className="mod-update">
            {updating ? (
            <ModProgressBar progress={updating} />
          ) : (
            mod.update && (
              <button
                className="btn-primary btn-small"
                disabled={disabled}
                onClick={() => act(() => install(tag, mod.update!.sha256, mod.id))}
                title={fix ? undefined : t("mods.updateTooltip", mod.update.version)}
              >
                {fix ? t("mods.installFitting", mod.update.version) : t("mods.update", mod.update.version)}
              </button>
            )
          )}
          </div>
        )}
      </div>
      <div className="mod-actions">
        <button
          className={`toggle${mod.enabled ? " on" : ""}`}
          role="switch"
          aria-checked={mod.enabled}
          aria-label={t("mods.toggleLabel", mod.name)}
          disabled={disabled || mod.status === "revoked"}
          onClick={() => act(() => setEnabled(tag, mod.id, !mod.enabled))}
        >
          <span className="toggle-knob" aria-hidden="true" />
          <StableLabel text={mod.enabled ? t("mods.on") : t("mods.off")} widest={[t("mods.on"), t("mods.off")]} />
        </button>
        <button
          className={`delete-btn btn-small${confirmRemove ? " confirming" : ""}`}
          disabled={disabled}
          onClick={onRemove}
          aria-label={confirmRemove ? t("mods.removeConfirm") : t("mods.removeLabel", mod.name)}
        >
          <StableLabel
            text={confirmRemove ? t("mods.removeConfirm") : t("mods.remove")}
            widest={[t("mods.removeConfirm"), t("mods.remove")]}
          />
        </button>
      </div>
    </li>
  );
}

interface InstalledListProps {
  report: ProfileReport;
  onError: (message: string | null) => void;
  locked: boolean;
}

export function InstalledList({ report, onError, locked }: InstalledListProps) {
  const { t } = useI18n();
  // Problems first, then what's on, then what's off: what needs a look is on top.
  const order = (m: InstalledMod) =>
    m.status === "wrongVersion" || m.status === "missingDeps" ? 0 : m.status === "revoked" ? 1 : m.enabled ? 2 : 3;
  const mods = [...report.mods].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  return (
    <ul className="mod-list" aria-label={t("mods.installedListLabel", report.tag)}>
      {mods.map((m) => (
        <ModRow key={m.id} tag={report.tag} mod={m} onError={onError} locked={locked} />
      ))}
    </ul>
  );
}
