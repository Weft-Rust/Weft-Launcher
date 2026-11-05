import { describe, expect, it } from "vitest";
import { asAppError, rateLimitReset, showError } from "./errors";

describe("one parser for rejections", () => {
  it("keeps a known code and its detail", () => {
    expect(asAppError({ code: "DiskFull", detail: "os error 28" })).toEqual({ code: "DiskFull", detail: "os error 28" });
    expect(showError({ code: "DiskFull", detail: "os error 28" }).detail).toBe("os error 28");
  });

  it("never passes off an unknown code, a thrown Error or a string as a known failure", () => {
    expect(asAppError({ code: "SomethingNew", detail: "x" })).toEqual({ code: "Unknown", detail: "SomethingNew: x" });
    expect(asAppError(new Error("boom"))).toEqual({ code: "Unknown", detail: "boom" });
    expect(asAppError("plugin said no")).toEqual({ code: "Unknown", detail: "plugin said no" });
    expect(asAppError({ code: "Unknown", detail: "  " })).toEqual({ code: "Unknown", detail: null });
    // showError says the same as asAppError parsed, for every one of them.
    for (const err of [{ code: "SomethingNew", detail: "x" }, new Error("boom"), "plugin said no"]) {
      expect(showError(err).detail).toBe(asAppError(err).detail);
    }
  });

  it("says nothing for nothing", () => {
    expect(showError(null)).toEqual({ message: "", detail: null });
  });
});

describe("a source's rate limit", () => {
  it("says until when, when GitHub said, and never puts the detail in the sentence", () => {
    const at = Date.UTC(2026, 10, 5, 14, 32) / 1000;
    const limited = { code: "ModSourceRateLimited", detail: `resets at ${at}` } as const;
    expect(rateLimitReset(limited)?.getTime()).toBe(at * 1000);
    const shown = showError(limited);
    expect(shown.message).toMatch(/^GitHub is limiting requests until .+\. Try again then\.$/);
    expect(shown.message).not.toContain("resets at");
    expect(shown.detail).toBeNull();
    expect(showError({ code: "ModSourceRateLimited", detail: null }).message).toBe("GitHub is limiting requests. Try again in a few minutes.");
    expect(rateLimitReset({ code: "RateLimited", detail: `resets at ${at}` })).toBeNull();
  });
});
