import { ReactNode } from "react";
import { useI18n } from "../../i18n/useI18n";
import { translateError } from "../../i18n/errors";
import type { Arg, RichMsg } from "../../mods/checks";
import { Code } from "../Truncate";
import { TRUST_LABEL } from "./TrustBadge";

/** A message from src/mods: placeholders become text, short codes with their full value, or tier names. */
export function RichText({ msg }: { msg: RichMsg }) {
  const { t, tr } = useI18n();
  const render = (arg: Arg): ReactNode => {
    if (typeof arg === "string") return arg;
    if ("code" in arg) return <Code full={arg.code} short={arg.short} />;
    if ("error" in arg) return translateError(arg.error);
    return t(TRUST_LABEL[arg.trust]);
  };
  return <>{tr(msg.key, ...(msg.args ?? []).map(render))}</>;
}
