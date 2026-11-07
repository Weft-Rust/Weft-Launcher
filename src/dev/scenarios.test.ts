import { describe, expect, it } from "vitest";
import { FLAGS, SCENARIOS } from "./scenarios";
import reference from "../../docs/dev-mock.md?raw";

// docs/dev-mock.md is written from SCENARIOS and FLAGS; this keeps the two together.
describe("mock scenarios", () => {
  it("are each listed in docs/dev-mock.md", () => {
    for (const s of SCENARIOS) expect(reference, s.name).toContain(`\`${s.name}\``);
  });

  it("have every flag listed in docs/dev-mock.md with its values", () => {
    for (const f of FLAGS) {
      expect(reference, f.name).toContain(`\`${f.name}\``);
      for (const v of f.values) expect(reference, `${f.name}=${v}`).toContain(v);
    }
  });

  it("only set flags that exist", () => {
    const names = new Set(FLAGS.map((f) => f.name));
    for (const s of SCENARIOS) for (const k of Object.keys(s.flags)) expect(names.has(k), `${s.name}: ${k}`).toBe(true);
  });
});
