import { describe, expect, it } from "vitest";
import {
  compareVersions,
  copyDonors,
  fittingVersions,
  installedFor,
  keepOrder,
  networkDown,
  parseRepo,
  sameRepo,
  sortInstalled,
} from "./select";
import { ABI, OLD_ABI, build, catalog, catalogMod, installed, report } from "./fixtures";

describe("compareVersions", () => {
  // The vectors of src-tauri/src/mods/version.rs, so both sides order versions the same way.
  it("orders like the backend's semver_precedence test", () => {
    const v = ["0.2.0", "0.1.2", "0.2.1-rc.1", "0.2.1", "0.2.1-rc.2", "0.10.0"];
    v.sort(compareVersions);
    expect(v).toEqual(["0.1.2", "0.2.0", "0.2.1-rc.1", "0.2.1-rc.2", "0.2.1", "0.10.0"]);
    expect(compareVersions("v1.0.0", "1.0")).toBe(0);
  });

  it("ranks a numeric prerelease identifier below an alphanumeric one", () => {
    // Semver 11.4.3: numeric identifiers always have lower precedence. String order said otherwise.
    expect(compareVersions("1.0.0-2", "1.0.0-1a")).toBe(-1);
    expect(compareVersions("1.0.0-1a", "1.0.0-2")).toBe(1);
  });

  it("follows the semver spec's example chain", () => {
    const chain = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(compareVersions(chain[i], chain[i + 1]), `${chain[i]} < ${chain[i + 1]}`).toBe(-1);
      expect(compareVersions(chain[i + 1], chain[i])).toBe(1);
    }
  });

  it("ignores build metadata and compares words by ASCII", () => {
    expect(compareVersions("1.0.0+abc", "1.0.0+xyz")).toBe(0);
    expect(compareVersions("0.1.2-experimental.4563878.917596d", "0.1.2-experimental.4563878.a")).toBe(-1);
    expect(compareVersions("1.0.0-Beta", "1.0.0-alpha")).toBe(-1);
  });
});

describe("fittingVersions", () => {
  const mod = catalogMod("cogwork", [
    build("0.1.0", { abi: OLD_ABI }),
    build("0.2.0"),
    build("0.2.1-rc.1", { channel: "prerelease" }),
    build("0.3.0", { platforms: ["windows-x64"] }),
    build("0.2.5"),
  ]);

  it("keeps builds for this interface and system, best first", () => {
    const c = catalog([mod]);
    expect(fittingVersions(c, mod, ABI, false).map((v) => v.version)).toEqual(["0.2.5", "0.2.0"]);
    expect(fittingVersions(c, mod, ABI, true).map((v) => v.version)).toEqual(["0.2.5", "0.2.1-rc.1", "0.2.0"]);
  });

  it("drops revoked builds and offers nothing without a known interface", () => {
    const c = catalog([mod], { revoked: [{ sha256: build("0.2.5").sha256, reason: "bad" }] });
    expect(fittingVersions(c, mod, ABI, false).map((v) => v.version)).toEqual(["0.2.0"]);
    expect(fittingVersions(c, mod, null, true)).toEqual([]);
  });
});

describe("repos", () => {
  it("compare without case, like GitHub", () => {
    expect(sameRepo("Lantern-Dev/Lanterns", "lantern-dev/lanterns")).toBe(true);
    expect(sameRepo("a/b", "a/c")).toBe(false);
    const source = catalogMod("lanterns", [], { origin: { kind: "source", repo: "Lantern-Dev/Lanterns" } });
    const mine = installed("lanterns", { origin: { kind: "source", repo: "lantern-dev/lanterns" } });
    expect(installedFor(source, [mine])).toBe(mine);
  });

  it("parse what the backend accepts", () => {
    expect(parseRepo("lantern-dev/lanterns")).toBe("lantern-dev/lanterns");
    expect(parseRepo("https://github.com/lantern-dev/lanterns.git/")).toBe("lantern-dev/lanterns");
    expect(parseRepo("github.com/a/b")).toBe("a/b");
    expect(parseRepo("not a repo")).toBeNull();
    expect(parseRepo("a/b/c")).toBeNull();
    expect(parseRepo("../x")).toBeNull();
    expect(parseRepo("a/..")).toBeNull();
  });
});

describe("installed order", () => {
  const mods = [
    installed("b", { enabled: false, status: "off" }),
    installed("a"),
    installed("c", { status: "wrongVersion" }),
  ];

  it("puts problems first, then on, then off", () => {
    expect(sortInstalled(mods)).toEqual(["c", "a", "b"]);
  });

  it("keeps rows in place after a toggle and adds new ones after", () => {
    const toggled = mods.map((m) => (m.id === "a" ? { ...m, enabled: false, status: "off" as const } : m));
    expect(keepOrder(["c", "a", "b"], toggled)).toEqual(["c", "a", "b"]);
    expect(keepOrder(["c", "a", "b"], [...toggled.filter((m) => m.id !== "c"), installed("d")])).toEqual(["a", "b", "d"]);
  });
});

describe("copyDonors", () => {
  it("lists other versions that have mods", () => {
    const profiles = { v3: report([installed("a")]), v2: report([]), v1: report([installed("b")]) };
    expect(copyDonors(["v3", "v2", "v1"], "v3", profiles)).toEqual(["v1"]);
    expect(copyDonors(["v3", "v2", "v1"], "v2", profiles)).toEqual(["v3", "v1"]);
  });
});

describe("networkDown", () => {
  const net = { code: "Network", detail: "offline" } as const;
  const fresh = { repo: "a/b", mods: 1, freshness: "fresh", checked: "2026-11-04T00:00:00Z", error: null, noMods: null } as const;
  const offline = { ...fresh, freshness: "cached", error: net } as const;
  const indexDown = { freshness: "unavailable", generated: null, signedAt: null, error: net, cacheError: null } as const;

  it("is down when the catalogue itself couldn't be fetched for want of a connection", () => {
    expect(networkDown(null, net)).toBe(true);
    expect(networkDown(null, { code: "Io" })).toBe(false);
  });

  it("is down when every origin failed with Network", () => {
    expect(networkDown(catalog([], { index: indexDown, sources: [offline] }), null)).toBe(true);
    expect(networkDown(catalog([], { index: indexDown }), null)).toBe(true);
  });

  it("is not down when only the index is unreachable and a source answered", () => {
    expect(networkDown(catalog([], { index: indexDown, sources: [fresh] }), null)).toBe(false);
  });

  it("is not down when a failing source got a reply (a rate limit is an answer)", () => {
    const limited = { ...fresh, freshness: "cached", error: { code: "ModSourceRateLimited", detail: null } } as const;
    expect(networkDown(catalog([], { index: indexDown, sources: [limited] }), null)).toBe(false);
  });

  it("is not down when the index answered and only a source lost its connection", () => {
    expect(networkDown(catalog([], { sources: [offline] }), null)).toBe(false);
  });
});
