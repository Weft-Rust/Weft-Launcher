import { describe, expect, it } from "vitest";
import { FLAGS, SCENARIOS } from "./scenarios";
import readme from "../../README.md?raw";

// The README's mock section is written from SCENARIOS and FLAGS; this keeps the two together.
describe("mock scenarios", () => {
  it("are each listed in the README", () => {
    for (const s of SCENARIOS) expect(readme, s.name).toContain(`\`${s.name}\``);
  });

  it("have every flag listed in the README with its values", () => {
    for (const f of FLAGS) {
      expect(readme, f.name).toContain(`\`${f.name}\``);
      for (const v of f.values) expect(readme, `${f.name}=${v}`).toContain(v);
    }
  });

  it("only set flags that exist", () => {
    const names = new Set(FLAGS.map((f) => f.name));
    for (const s of SCENARIOS) for (const k of Object.keys(s.flags)) expect(names.has(k), `${s.name}: ${k}`).toBe(true);
  });
});
