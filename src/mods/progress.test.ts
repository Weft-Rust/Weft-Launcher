import { describe, expect, it } from "vitest";
import trace from "../dev/fixtures/trace.json";
import { dwellDelay, stepKey, VERIFY_DWELL } from "./progress";
import type { UiProgress, UiStage } from "./types";

const MODS = ["cogwork", "hearth"];

/** The backend's trace as records, arriving `gap` ms apart. */
function records(steps: string[], count: number, gap: number): { at: number; p: UiProgress }[] {
  return steps.map((s, i) => {
    const [index, stage, percent] = s.split(":");
    const id = MODS[Number(index) - 1];
    return {
      at: i * gap,
      p: { operationId: "op", sha256: `${id}-sha`, modId: id, stage: stage as UiStage, percent: Number(percent), index: Number(index), count },
    };
  });
}

/** What the bar shows over time, stepping through it as the hook does: each record whole. */
function shown(events: { at: number; p: UiProgress }[]): { at: number; p: UiProgress }[] {
  const out: { at: number; p: UiProgress }[] = [];
  let on: UiProgress | undefined;
  let since = 0;
  const end = events[events.length - 1].at + VERIFY_DWELL * 4;
  for (let now = 0, i = 0; now <= end; now++) {
    while (i < events.length && events[i].at <= now) i++;
    const next = i ? events[i - 1].p : undefined;
    if (next && next !== on && dwellDelay(on, next, since, now) === 0) {
      if (stepKey(next) !== stepKey(on)) {
        since = now;
        out.push({ at: now, p: next });
      }
      on = next;
    }
  }
  return out;
}

describe("progress dwell", () => {
  it("holds a file's check, and never pairs it with the next file's number or name", () => {
    // The backend moves on from checking Cogwork to downloading Hearth well within the dwell.
    const events = records(trace.installWithDependency.steps, trace.installWithDependency.count, 150);
    const seen = shown(events);
    for (const { p } of seen) {
      // Every record shown is one the backend sent: index, mod and step belong together.
      expect(MODS[p.index - 1]).toBe(p.modId);
    }
    const checks = seen.filter((s) => s.p.stage === "verifying");
    expect(checks.map((c) => `${c.p.index}:${c.p.modId}`)).toEqual(["1:cogwork", "2:hearth"]);
    // Each check stays on screen for the dwell, then gives way to what came next.
    for (const c of checks) {
      const after = seen[seen.indexOf(c) + 1];
      expect(after.at - c.at).toBeGreaterThanOrEqual(VERIFY_DWELL);
    }
  });

  it("a check is only shown for a file whose download was shown first", () => {
    const seen = shown(records(trace.installWithDependency.steps, 2, 3)).map((s) => `${s.p.index}:${s.p.stage}`);
    for (const [i, step] of seen.entries()) {
      if (step.endsWith(":verifying")) expect(seen.slice(0, i)).toContain(step.replace("verifying", "downloading"));
    }
  });

  it("gives way at once when nothing is being checked, or the check goes on", () => {
    const [a, b] = records(["1:downloading:10", "1:downloading:40"], 1, 0).map((r) => r.p);
    expect(dwellDelay(a, b, 0, 0)).toBe(0);
    const [check, again] = records(["1:verifying:100", "1:verifying:100"], 1, 0).map((r) => r.p);
    expect(dwellDelay(check, again, 0, 0)).toBe(0);
    const [, next] = records(["1:verifying:100", "2:downloading:0"], 2, 0).map((r) => r.p);
    expect(dwellDelay(check, next, 100, 300)).toBe(VERIFY_DWELL - 200);
  });
});
