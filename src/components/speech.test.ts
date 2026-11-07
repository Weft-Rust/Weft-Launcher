import { describe, expect, it } from "vitest";
import { Speech } from "./speech";

describe("speech", () => {
  it("says each key once, and again once it is forgotten", () => {
    const s = new Speech();
    const heard: string[] = [];
    const stop = s.listen((t) => heard.push(t));
    s.say("a", "Removed Cogwork.");
    s.say("a", "Removed Cogwork.");
    s.say("b", "");
    s.forget("a");
    s.say("a", "Removed Cogwork.");
    stop();
    s.say("c", "Not heard.");
    expect(heard).toEqual(["Removed Cogwork.", "Removed Cogwork."]);
  });

  it("finds what is new on a channel, and forgets what went away", () => {
    const s = new Speech();
    const a = { id: "hearth" };
    const b = { id: "lanterns" };
    expect(s.fresh("v1", [a, b])).toEqual([a, b]);
    // The same problems, re-rendered or on another tab: nothing new.
    expect(s.fresh("v1", [a, b])).toEqual([]);
    // One fixed: the other isn't said again.
    expect(s.fresh("v1", [b])).toEqual([]);
    // The fixed one comes back: new again. Channels are apart.
    expect(s.fresh("v1", [a, b])).toEqual([a]);
    expect(s.fresh("v2", [a])).toEqual([a]);
  });

  it("is one memory per app tree: a second tree says it all again", () => {
    const one = new Speech();
    const two = new Speech();
    expect(one.fresh("v1", [{ id: "x" }])).toHaveLength(1);
    expect(two.fresh("v1", [{ id: "x" }])).toHaveLength(1);
  });
});
