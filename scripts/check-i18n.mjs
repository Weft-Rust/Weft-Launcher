// Fails when a language file lacks a key English has, has one English doesn't, or drops a
// `{n}` placeholder. Runs before every build: a missing string would show up as its key.
import { readFileSync } from "node:fs";

const dir = new URL("../src/i18n/", import.meta.url);
const locales = ["en", "pt-BR", "es", "ru"];
const load = (l) => JSON.parse(readFileSync(new URL(`${l}.json`, dir), "utf8"));

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

const placeholders = (s) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(",");
const base = flatten(load("en"));
const problems = [];
for (const locale of locales.slice(1)) {
  const other = flatten(load(locale));
  for (const key of Object.keys(base)) {
    if (!(key in other)) problems.push(`${locale}: missing ${key}`);
    else if (placeholders(base[key]) !== placeholders(other[key])) {
      problems.push(`${locale}: ${key} has {${placeholders(other[key])}}, English has {${placeholders(base[key])}}`);
    }
  }
  for (const key of Object.keys(other)) {
    if (!(key in base)) problems.push(`${locale}: ${key} is not in en.json`);
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`i18n: ${Object.keys(base).length} keys, same in ${locales.join(", ")}`);
