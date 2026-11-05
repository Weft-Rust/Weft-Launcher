import { describe, expect, it } from "vitest";
import { ProfileReads } from "./profileReads";
import type { ProfileReport } from "./types";

/** A report told apart by its label. */
const report = (label: string) => ({ tag: "v1", label }) as unknown as ProfileReport;
const label = (r: ProfileReport | undefined) => (r as unknown as { label: string } | undefined)?.label;

/** A backend whose reads answer when the test says, each with the state at the time it began. */
function backend() {
  let state = "old";
  const calls: { began: string; answer: () => void; fail: () => void }[] = [];
  const shown: string[] = [];
  const reads = new ProfileReads(
    () =>
      new Promise<ProfileReport>((resolve, reject) => {
        const began = state;
        calls.push({ began, answer: () => resolve(report(began)), fail: () => reject(new Error("io")) });
      }),
    (_tag, r) => shown.push(label(r)!)
  );
  return { reads, calls, shown, change: (s: string) => (state = s) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("profile reads", () => {
  it("share one read between callers that don't need it fresh", async () => {
    const b = backend();
    const one = b.reads.read("v1");
    const two = b.reads.read("v1");
    expect(b.calls).toHaveLength(1);
    b.calls[0].answer();
    expect(label(await one)).toBe("old");
    expect(label(await two)).toBe("old");
  });

  it("never serve a fresh read with one that began before it was asked", async () => {
    const b = backend();
    const older = b.reads.read("v1");
    // The catalogue refresh lands meanwhile (revocations): the set is now "new".
    b.change("new");
    const fresh = b.reads.read("v1", true);
    // It waits for the older read to end, then reads again.
    expect(b.calls).toHaveLength(1);
    b.calls[0].answer();
    expect(label(await older)).toBe("old");
    await tick();
    expect(b.calls).toHaveLength(2);
    b.calls[1].answer();
    expect(label(await fresh)).toBe("new");
    expect(b.shown).toEqual(["old", "new"]);
  });

  it("share the read queued for freshness among the fresh reads asked before it began", async () => {
    const b = backend();
    b.reads.read("v1");
    b.change("new");
    const a = b.reads.read("v1", true);
    const c = b.reads.read("v1", true);
    const plain = b.reads.read("v1");
    b.calls[0].answer();
    await tick();
    expect(b.calls).toHaveLength(2);
    b.calls[1].answer();
    expect([label(await a), label(await c), label(await plain)]).toEqual(["new", "new", "new"]);
  });

  it("read again when the older read failed", async () => {
    const b = backend();
    const older = b.reads.read("v1");
    b.change("new");
    const fresh = b.reads.read("v1", true);
    b.calls[0].fail();
    await expect(older).rejects.toThrow("io");
    await tick();
    b.calls[1].answer();
    expect(label(await fresh)).toBe("new");
  });

  it("drop an answer older than a change already shown", async () => {
    const b = backend();
    const slow = b.reads.read("v1");
    b.reads.changed("v1", report("changed"));
    b.calls[0].answer();
    await slow;
    expect(b.shown).toEqual(["changed"]);
  });

  it("let a refresh finishing during an older read end on the refreshed set", async () => {
    const b = backend();
    // The start-up read of the set is slow.
    const startup = b.reads.read("v1");
    // A catalogue refresh ends meanwhile and reads every set again, fresh.
    b.change("refreshed");
    const afterRefresh = b.reads.read("v1", true);
    // The fresh read can't start before the start-up one ends; the start-up one answers last
    // of the old state, and the refreshed set is what stays shown.
    b.calls[0].answer();
    await startup;
    await tick();
    b.calls[1].answer();
    await afterRefresh;
    expect(b.shown[b.shown.length - 1]).toBe("refreshed");
  });
});
