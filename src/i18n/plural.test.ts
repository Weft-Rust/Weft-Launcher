import { describe, expect, it } from "vitest";
import { fill, initI18n, pluralKey, tn, t } from "./index";
import en from "./en.json";
import ru from "./ru.json";
import ptBR from "./pt-BR.json";
import es from "./es.json";

describe("pluralKey", () => {
  it("picks Russian's one, few and many", () => {
    const cases: [number, string][] = [
      [0, "many"],
      [1, "one"],
      [2, "few"],
      [4, "few"],
      [5, "many"],
      [11, "many"],
      [21, "one"],
      [22, "few"],
      [25, "many"],
      [101, "one"],
    ];
    for (const [n, form] of cases) expect(pluralKey("mods.noticeCopied", n, "ru"), String(n)).toBe(`mods.noticeCopied_${form}`);
  });

  it("picks English one and other", () => {
    expect(pluralKey("mods.noticeCopied", 1, "en")).toBe("mods.noticeCopied_one");
    expect(pluralKey("mods.noticeCopied", 0, "en")).toBe("mods.noticeCopied_other");
    expect(pluralKey("mods.noticeCopied", 2, "en")).toBe("mods.noticeCopied_other");
  });
});

describe("tn", () => {
  it("never says 'Brought 1 mods'", () => {
    initI18n("en");
    expect(tn("mods.noticeCopied", 1, "v26.10.4")).toBe("Copied 1 mod from v26.10.4.");
    expect(tn("mods.noticeCopied", 3, "v26.10.4")).toBe("Copied 3 mods from v26.10.4.");
  });

  it("uses the right Russian form for 1, 2, 5 and 21", () => {
    initI18n("ru");
    expect(tn("mods.sourcesMods", 1)).toBe("1 мод");
    expect(tn("mods.sourcesMods", 2)).toBe("2 мода");
    expect(tn("mods.sourcesMods", 5)).toBe("5 модов");
    expect(tn("mods.sourcesMods", 21)).toBe("21 мод");
    initI18n("en");
  });
});

describe("fill", () => {
  it("fills numbered placeholders and the count", () => {
    expect(fill("{0} and {1}: {n}", ["a", "b"], "3")).toBe("a and b: 3");
    expect(fill("{0} {2}", ["a"])).toBe("a {2}");
  });

  it("keeps a sentence whole, the placeholder inside it", () => {
    initI18n("en");
    expect(t("mods.typeToConfirm", "mytweak")).toBe("Type mytweak to install it anyway");
  });
});

describe("locale files", () => {
  type Tree = { [k: string]: string | Tree };
  const flat = (o: Tree, p = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [`${p}${k}`] : flat(v, `${p}${k}.`)));

  it("have every plural form their language needs", () => {
    const files: [string, Tree][] = [["en", en], ["ru", ru], ["pt-BR", ptBR], ["es", es]];
    const bases = flat(en as Tree)
      .filter((k) => k.endsWith("_other"))
      .map((k) => k.slice(0, -"_other".length));
    expect(bases.length).toBeGreaterThan(5);
    for (const [locale, tree] of files) {
      const keys = new Set(flat(tree));
      const needed = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
      for (const base of bases) for (const c of needed) expect(keys.has(`${base}_${c}`), `${locale} ${base}_${c}`).toBe(true);
    }
  });

  it("use the Russian glossary for the tiers, everywhere", () => {
    const mods = (ru as unknown as { mods: Record<string, string> }).mods;
    expect([mods.badgeReviewed, mods.badgeUnreviewed, mods.badgeUnverified]).toEqual(["Проверен", "Не проверен", "Не верифицирован"]);
    // "Одобрен" was the old word for Reviewed; one word per tier, so it pairs with "Не проверен".
    expect(JSON.stringify(ru)).not.toMatch(/[Оо]добр/);
  });

  it("say on and off in full in Spanish", () => {
    const mods = (es as unknown as { mods: Record<string, string> }).mods;
    expect([mods.on, mods.off]).toEqual(["Activado", "Desactivado"]);
  });

  it("have no doubled punctuation", () => {
    const flatValues = (tree: object, prefix = ""): Record<string, string> =>
      Object.entries(tree).reduce<Record<string, string>>(
        (out, [k, v]) => (typeof v === "string" ? { ...out, [prefix + k]: v } : { ...out, ...flatValues(v, `${prefix}${k}.`) }),
        {}
      );
    for (const [locale, tree] of Object.entries({ en, ru, es, ptBR })) {
      for (const [key, value] of Object.entries(flatValues(tree))) {
        expect(value, `${locale} ${key}`).not.toMatch(/(?<!\.)\.\.(?!\.)|[!?:]\.|\s[.,:;]/);
      }
    }
  });
});
