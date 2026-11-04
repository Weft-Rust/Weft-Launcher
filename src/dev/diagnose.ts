// src-tauri/src/mods/diagnose.rs, for the mock backend: it writes the engine's own log line and
// reads the failure out of it the way the launcher does. diagnose.test.ts runs this against the
// fixtures in diagnose.rs itself, so a changed engine message breaks the mock's crashes too.

import type { FailureKind, ModFailure } from "../mods/types";

/** `launch::strip_ansi_codes`: drops `ESC [ ... <letter>`. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[^A-Za-z]*[A-Za-z]/g, "");
}

function wordAfter(line: string, prefix: string): string | null {
  const at = line.indexOf(prefix);
  if (at < 0) return null;
  const m = line.slice(at + prefix.length).match(/^[A-Za-z0-9_]+/);
  return m ? m[0] : null;
}

/** `…/mods/libcogwork.so` or `C:\…\123-cogwork.dll` → `cogwork`. */
function idFromLibrary(path: string): string | null {
  const file = path.split(/[/\\]/).pop() ?? "";
  const m = file.match(/^(.*)\.(dll|so|dylib)$/);
  if (!m) return null;
  let stem = m[1];
  const dash = stem.indexOf("-");
  if (dash >= 0 && /^\d*$/.test(stem.slice(0, dash))) stem = stem.slice(dash + 1);
  const id = stem.startsWith("lib") ? stem.slice(3) : stem;
  return id || null;
}

/** The message part of a log line: after the last `] `. */
function message(line: string): string {
  const i = line.lastIndexOf("] ");
  return i < 0 ? line : line.slice(i + 2);
}

/** `is_error`: the line was logged at ERROR; the level stands on its own before the message. */
function isError(line: string): boolean {
  const i = line.lastIndexOf("] ");
  const before = i < 0 ? line : line.slice(0, i);
  return before.split(/\s+/).includes("ERROR");
}

const isId = (s: string) => /^[A-Za-z0-9_]+$/.test(s);

function classify(line: string): ModFailure | null {
  if (!isError(line)) return null;
  const failure = (kind: FailureKind, modId: string | null, other: string | null = null): ModFailure => ({
    kind,
    modId,
    other,
    line: line.trim(),
  });
  if (line.includes("was built against another mod ABI")) return failure("wrongVersion", wordAfter(line, "mod "));
  if (line.includes(" requires missing mod ")) {
    return failure("missingDep", wordAfter(line, "mod "), wordAfter(line, " requires missing mod "));
  }
  if (line.includes(" is the crate ")) return failure("wrongName", wordAfter(line, "mod "), wordAfter(line, " is the crate "));
  const loading = wordAfter(line, "loading mod ");
  if (loading && line.includes(`loading mod ${loading} from `)) return failure("loadFailed", loading);
  const notMod = line.indexOf(" is not a Weft mod");
  if (notMod >= 0) return failure("notAMod", idFromLibrary(message(line.slice(0, notMod)).trim()));
  const msg = message(line).trimEnd();
  if (msg.endsWith("init panicked")) {
    // The engine prefixes each registration error with the mod's id: `showcase: init panicked`.
    const before = msg.slice(0, -"init panicked".length).trimEnd();
    const id = before.endsWith(":") ? before.slice(0, -1).trim() : "";
    return failure("initPanicked", isId(id) ? id : null);
  }
  return null;
}

function panickedMod(before: string[]): string | null {
  for (let i = before.length - 1; i >= 0; i--) {
    if (before[i].includes("panicked")) {
      const id = wordAfter(before[i], "[mod:");
      if (id) return id;
    }
  }
  for (let i = before.length - 1; i >= 0; i--) {
    const id = wordAfter(before[i], "loading mod ");
    if (id) return id;
  }
  return null;
}

/** `diagnose::find`: the first mod failure in the log of one run. */
export function findFailure(log: string): ModFailure | null {
  const lines = log.split(/\r?\n/).map(stripAnsi);
  for (let i = 0; i < lines.length; i++) {
    const f = classify(lines[i]);
    if (!f) continue;
    if (f.kind === "initPanicked" && f.modId === null) f.modId = panickedMod(lines.slice(0, i));
    return f;
  }
  return null;
}
