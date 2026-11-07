import { describe, expect, it, vi } from "vitest";

// A plain function, not a spy: a spy keeps a handle on each promise it returns, and a rejected
// one then counts as unhandled after the test.
const backend = vi.hoisted(() => ({ answer: (): Promise<unknown> => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => backend.answer() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { CommandError, asAppError, call } = await import("./api");
const { showError } = await import("../i18n/errors");
const { COMMANDS } = await import("./ipc");

describe("a command that fails", () => {
  it("rejects with the backend's payload as a CommandError", async () => {
    backend.answer = () => Promise.reject({ code: "DiskFull", detail: "No space left on device" });
    const err = await call("get_mod_profile", { tag: "v1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    const e = err as InstanceType<typeof CommandError>;
    expect([e.code, e.detail, e.command]).toEqual(["DiskFull", "No space left on device", "get_mod_profile"]);
    // What the page does with it is the same as with the payload itself.
    expect(asAppError(err)).toEqual({ code: "DiskFull", detail: "No space left on device" });
    expect(showError(err).message).toBe(showError({ code: "DiskFull", detail: null }).message);
  });

  it("is Unknown, with what there was, for a string, an Error or a code this build doesn't know", async () => {
    for (const [raw, detail] of [
      ["plugin failed", "plugin failed"],
      [new Error("boom"), "boom"],
      [{ code: "SomethingNewer", detail: "x" }, "SomethingNewer: x"],
    ] as const) {
      backend.answer = () => Promise.reject(raw);
      const err = await call("get_mod_profile", { tag: "v1" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommandError);
      const e = err as InstanceType<typeof CommandError>;
      expect([e.code, e.detail]).toEqual(["Unknown", detail]);
    }
  });

  it("passes results through", async () => {
    backend.answer = () => Promise.resolve(["a/b"]);
    await expect(call(COMMANDS.getModSources, {})).resolves.toEqual(["a/b"]);
  });
});
