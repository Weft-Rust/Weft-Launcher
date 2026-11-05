// Runs before every build: a missing string would show up as its key.
//
// Fails when
// - a language lacks a key English has, has one English doesn't, or drops a `{n}` placeholder;
// - a counted message (`key_one`, `key_other`...) lacks a plural form the language needs, as
//   Intl.PluralRules says (Russian: one, few, many, other), or has one it doesn't use;
// - code under src/ uses a message key that en.json doesn't have, or en.json has a key no code
//   names (keys built from a prefix, like `sizeUnits.${unit}`, are listed in DYNAMIC);
// - an error code the backend can send has no `errors.*` message, going by the generated
//   ErrorCode union in src/mods/bindings/ErrorCode.ts;
// - a message names a trust tier or a revocation in English but not with that language's term
//   for it, or uses a word the glossary rules out (Russian «отзыв» reads as "review");
// - code puts two translated pieces side by side in one text, `{t(a)} {t(b)}` in JSX or
//   `${t(a)} ${t(b)}` in a template: a sentence assembled from parts can't be put in another
//   language's order. One message per sentence, with the parts as `{0}`, `{1}`.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, "src/i18n");
const locales = ["en", "pt-BR", "es", "ru"];
const load = (l) => JSON.parse(readFileSync(join(dir, `${l}.json`), "utf8"));
const problems = [];

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

const PLURAL = /^(.*)_(zero|one|two|few|many|other)$/;
const placeholders = (s) => [...new Set([...s.matchAll(/\{(\d+|n)\}/g)].map((m) => m[1]))].sort().join(",");

/** Plain keys, and counted messages by base key with their forms. */
function split(flat) {
  const plain = {};
  const plural = {};
  for (const [key, value] of Object.entries(flat)) {
    const m = key.match(PLURAL);
    if (m) (plural[m[1]] ??= {})[m[2]] = value;
    else plain[key] = value;
  }
  return { plain, plural };
}

const en = split(flatten(load("en")));

for (const locale of locales) {
  const { plain, plural } = locale === "en" ? en : split(flatten(load(locale)));
  const needed = new Intl.PluralRules(locale).resolvedOptions().pluralCategories.sort();

  if (locale !== "en") {
    for (const key of Object.keys(en.plain)) {
      if (!(key in plain)) problems.push(`${locale}: missing ${key}`);
      else if (placeholders(en.plain[key]) !== placeholders(plain[key])) {
        problems.push(`${locale}: ${key} has {${placeholders(plain[key])}}, English has {${placeholders(en.plain[key])}}`);
      }
    }
    for (const key of Object.keys(plain)) {
      if (!(key in en.plain)) problems.push(`${locale}: ${key} is not in en.json`);
    }
    for (const base of Object.keys(plural)) {
      if (!(base in en.plural)) problems.push(`${locale}: counted message ${base} is not in en.json`);
    }
  }

  for (const [base, enForms] of Object.entries(en.plural)) {
    const forms = plural[base];
    if (!forms) {
      problems.push(`${locale}: missing counted message ${base} (${needed.map((c) => `${base}_${c}`).join(", ")})`);
      continue;
    }
    const have = Object.keys(forms).sort();
    for (const c of needed) if (!have.includes(c)) problems.push(`${locale}: ${base} needs a _${c} form`);
    for (const c of have) if (!needed.includes(c)) problems.push(`${locale}: ${base}_${c} is a form ${locale} doesn't use`);
    const want = placeholders(enForms.other ?? "");
    for (const [c, text] of Object.entries(forms)) {
      if (placeholders(text) !== want) problems.push(`${locale}: ${base}_${c} has {${placeholders(text)}}, English has {${want}}`);
    }
  }
}

// Keys used in code.
function sources(path, out = []) {
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    if (statSync(full).isDirectory()) {
      if (name !== "bindings") sources(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const known = (key) => key in en.plain || key in en.plural;
const CALL = /\b(t|tn|tr)\(\s*["']([^"']+)["']/g;
// Quoted only: backticks are comments' code spans here, not keys.
const LITERAL = /["']((?:mods|errors|sizeUnits)\.[A-Za-z0-9_]+)["']/g;
const PIECE = String.raw`\b(?:t|tn|tm)\((?:[^()]|\([^()]*\))*\)`;
const SIDE_BY_SIDE = [
  new RegExp(String.raw`\{\s*${PIECE}\s*\}(?:\s|\{" "\}|[,:;.—-])*\{\s*${PIECE}\s*\}`, "g"),
  new RegExp(String.raw`\$\{\s*${PIECE}\s*\}[^\`$]{0,3}\$\{\s*${PIECE}\s*\}`, "g"),
];
function sideBySide(text) {
  return SIDE_BY_SIDE.flatMap((re) => [...text.matchAll(re)].map((m) => ({ line: text.slice(0, m.index).split("\n").length, text: m[0].replace(/\s+/g, " ") })));
}
// Every message is used: a key is used when code names it in quotes (t("playButton"),
// "mods.ckIndex" in a table). Keys that code builds from a prefix are listed here, and only these.
const DYNAMIC = ["sizeUnits."];
const mentioned = new Set();
for (const file of sources(join(root, "src"))) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/["'`]([A-Za-z][A-Za-z0-9_.]*)["'`]/g)) mentioned.add(m[1]);
  const rel = file.slice(root.length);
  for (const m of sideBySide(text)) problems.push(`${rel}:${m.line}: two translated pieces side by side make one sentence: ${m.text}`);
  for (const m of text.matchAll(CALL)) {
    const [, fn, key] = m;
    if (fn === "tn" ? !(key in en.plural) : !(key in en.plain)) {
      problems.push(`${rel}: ${fn}("${key}") is not ${fn === "tn" ? "a counted message" : "a message"} in en.json`);
    }
  }
  for (const m of text.matchAll(LITERAL)) {
    if (!known(m[1])) problems.push(`${rel}: "${m[1]}" is not in en.json`);
  }
}

for (const key of [...Object.keys(en.plain), ...Object.keys(en.plural)]) {
  if (!mentioned.has(key) && !DYNAMIC.some((p) => key.startsWith(p))) problems.push(`en.json: "${key}" is never used; remove it from every locale`);
}

// Every error code the backend can send has a message. The codes are the ErrorCode union that
// the backend generates (src/mods/bindings/ErrorCode.ts); a Rust test keeps that file current.
const codes = new Set();
const unionPath = "src/mods/bindings/ErrorCode.ts";
const union = readFileSync(join(root, unionPath), "utf8").match(/export type ErrorCode =([\s\S]*?);/);
if (!union) problems.push(`${unionPath}: no ErrorCode union found`);
else for (const m of union[1].matchAll(/"([A-Za-z0-9]+)"/g)) codes.add(m[1]);
const errorsTs = readFileSync(join(dir, "errors.ts"), "utf8");
const mapping = Object.fromEntries([...errorsTs.matchAll(/^\s*([A-Z][A-Za-z0-9]*):\s*'([^']+)'/gm)].map((m) => [m[1], m[2]]));
for (const code of codes) {
  const key = mapping[code];
  if (!key) problems.push(`src/i18n/errors.ts: error code ${code} has no message in ERROR_KEY`);
  else if (!(key in en.plain)) problems.push(`src/i18n/errors.ts: ${code} maps to ${key}, which en.json doesn't have`);
}
for (const code of Object.keys(mapping)) {
  if (!codes.has(code)) problems.push(`src/i18n/errors.ts: ${code} is not an ErrorCode the backend sends`);
}

// The trust words, one term per language: a player learns them from the badges, so every message
// that names one says it the same way. Stems, compared without case, so inflected forms pass.
//
// Russian keeps the three tiers apart, as three steps a reader recognises, and never with the
// stem of the mechanical checks («провер…»: the signature, the file, the version), which a
// tier word would be confused with: Reviewed «Одобрен» (approved by the index's reviewers),
// Unreviewed «Без модерации» (published, nobody moderated it), Unverified «С компьютера» (a file
// from the player's computer, of unknown origin; short enough to sit beside a name, and not
// «источник», which is what an added GitHub repo is called).
const TIER_FORMS = { ru: [/провер/i] };
const GLOSSARY = [
  { en: /\bunverified\b/i, term: { ru: "компьютер", "pt-BR": "não verificad", es: "sin verificar" }, not: TIER_FORMS },
  { en: /\bunreviewed\b|nobody reviewed|\bnot reviewed\b/i, term: { ru: "модерац", "pt-BR": "revis", es: "revis" }, not: TIER_FORMS },
  // The tier's own word (capitalised in English), and what it means: someone reviewed exactly this file.
  { en: /\bReviewed\b|reviewed exactly/, term: { ru: "одобр", "pt-BR": "revis", es: "revis" }, not: TIER_FORMS },
  { en: /\brevok|\brevocation/i, term: { ru: "отозв", "pt-BR": "retirad", es: "retirad" } },
];
const FORBIDDEN = { ru: [/отзыв/i, /неизвестн\S* файл/i] };
const flat = Object.fromEntries(locales.map((l) => [l, flatten(load(l))]));
for (const [key, english] of Object.entries(flat.en)) {
  for (const { en: pattern, term, not = {} } of GLOSSARY) {
    if (!pattern.test(english)) continue;
    for (const [locale, stem] of Object.entries(term)) {
      const text = flat[locale][key];
      if (text !== undefined && !text.toLowerCase().includes(stem)) problems.push(`${locale}: ${key} should say "${stem}…" for "${english.match(pattern)[0]}"`);
      for (const word of not[locale] ?? []) {
        if (text !== undefined && word.test(text)) problems.push(`${locale}: ${key} names a tier with ${word}, the word of the mechanical checks`);
      }
    }
  }
}
for (const [locale, words] of Object.entries(FORBIDDEN))
  for (const [key, text] of Object.entries(flat[locale]))
    for (const word of words) if (word.test(text)) problems.push(`${locale}: ${key} uses ${word}, which the glossary rules out`);

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(
  `i18n: ${Object.keys(en.plain).length} messages and ${Object.keys(en.plural).length} counted messages in ${locales.join(", ")}; ` +
    `${codes.size} error codes covered`
);
