// The mock reads crashes like the backend: the TypeScript port runs on the fixtures written in
// diagnose.rs (read from that file, so a changed fixture is seen here), and on the mock's logs.
import { describe, expect, it } from "vitest";
import rust from "../../src-tauri/src/mods/diagnose.rs?raw";
import { findFailure } from "./diagnose";
import { CRASH_LOGS } from "./crashes";
import type { FailureKind } from "../mods/types";

const KIND: Record<string, FailureKind> = {
  WrongVersion: "wrongVersion",
  LoadFailed: "loadFailed",
  NotAMod: "notAMod",
  WrongName: "wrongName",
  MissingDep: "missingDep",
  InitPanicked: "initPanicked",
};

/** The `every_failure_kind` cases: (what, log, K::Kind, Some("id") | None, Some("other") | None). */
function rustCases() {
  const body = rust.slice(rust.indexOf("fn every_failure_kind"), rust.indexOf("fn an_init_panic"));
  const str = String.raw`(r?)"((?:[^"\\]|\\.)*)"`;
  const opt = String.raw`(?:Some\("([^"]*)"\)|None)`;
  const re = new RegExp(String.raw`\(\s*"([^"]+)",\s*${str},\s*K::(\w+),\s*${opt},\s*${opt},?\s*\)`, "g");
  return [...body.matchAll(re)].map(([, what, raw, log, kind, id, other]) => ({
    what,
    log: raw ? log : log.replace(/\\x1b/g, "\x1b").replace(/\\\\/g, "\\"),
    kind: KIND[kind],
    id: id ?? null,
    other: other ?? null,
  }));
}

describe("crash diagnosis", () => {
  const cases = rustCases();

  it("finds every fixture in diagnose.rs", () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
    expect(new Set(cases.map((c) => c.kind))).toEqual(new Set(Object.values(KIND)));
  });

  it.each(cases)("reads the Rust fixture: $what", (c) => {
    const f = findFailure(c.log);
    expect(f).not.toBeNull();
    const named = f!.kind === "missingDep" ? f!.dependency : f!.kind === "wrongName" ? f!.crate : null;
    expect([f!.kind, f!.modId, named]).toEqual([c.kind, c.id, c.other]);
    expect(f!.line).not.toContain("\x1b");
  });

  it("names the mod of an init panic from the lines before", () => {
    const log = "[stderr] ERROR [mod:cogwork::pipes] panicked at src/pipes.rs:3:1: x\n[stderr] ERROR [app] init panicked";
    expect(findFailure(log)?.modId).toBe("cogwork");
  });

  it.each(Object.entries(CRASH_LOGS))("the mock's %s log reads as that kind", (kind, log) => {
    expect(findFailure(log)?.kind).toBe(kind);
    expect(findFailure(log)?.modId).toBeTruthy();
  });
});
