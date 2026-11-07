// The mod manager's IPC, written by hand to match src-tauri/src/mods/commands.rs.
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { translateError } from "../i18n/errors";

export interface Build {
  version: string;
  tag: string;
  abi: string;
  deps: string[];
  sha256: string;
}

export interface IndexMod {
  id: string;
  name: string;
  summary: string;
  repo: string;
  builds: Build[];
}

export interface Index {
  mods: IndexMod[];
  revoked: { sha256: string; reason: string | null }[];
}

export interface InstalledMod {
  id: string;
  name: string;
  version: string;
  on: boolean;
  unverified: boolean;
  revoked: boolean;
  reason: string | null;
  update: string | null;
}

export interface Planned {
  id: string;
  name: string;
  version: string;
  repo: string;
  tag: string;
}

export interface FileInfo {
  id: string;
  name: string;
  version: string;
  replaces: boolean;
  plan: Planned[];
}

export interface Progress {
  tag: string;
  file: number;
  files: number;
  name: string;
  percent: number | null;
}

export const mods = {
  /** The version's mod ABI; null if the version is older than mods. */
  abi: (tag: string) => invoke<string | null>("mods_abi", { tag }),
  catalog: (refresh: boolean) => invoke<Index>("mods_catalog", { refresh }),
  list: (tag: string) => invoke<InstalledMod[]>("mods_list", { tag }),
  plan: (tag: string, id: string, version: string) => invoke<Planned[]>("mods_plan", { tag, id, version }),
  install: (tag: string, id: string, version: string) => invoke<InstalledMod[]>("mods_install", { tag, id, version }),
  inspectFile: (tag: string, path: string) => invoke<FileInfo>("mods_inspect_file", { tag, path }),
  installFile: (tag: string, path: string) => invoke<InstalledMod[]>("mods_install_file", { tag, path }),
  setEnabled: (tag: string, id: string, on: boolean) => invoke<InstalledMod[]>("mods_set_enabled", { tag, id, on }),
  remove: (tag: string, id: string) => invoke<InstalledMod[]>("mods_remove", { tag, id }),
};

/** The newest build of a mod for this ABI that isn't revoked: what Browse offers. The index's
 * builds come newest first. */
export function newestBuild(index: Index, mod: IndexMod, abi: string): Build | null {
  const revoked = new Set(index.revoked.map((r) => r.sha256));
  return mod.builds.find((b) => b.abi === abi && !revoked.has(b.sha256)) ?? null;
}

/** "by Zorro909": the repository's owner. */
export function owner(repo: string): string {
  return repo.split("/")[0];
}

/** One line for any mod error; `tag` fills "has no build for v…". */
export function modError(err: unknown, tag: string): string {
  const e = err as { code?: string; detail?: string | null } | null;
  const key = `mods.errors.${e?.code}`;
  if (e?.code === "Revoked" && !e.detail) return t(key, t("mods.noReason"));
  const text = t(key, e?.detail ?? "", tag);
  return text === key ? translateError(err) : text;
}
