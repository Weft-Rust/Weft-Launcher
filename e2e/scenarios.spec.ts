// Every mock scenario, in every language: it renders without errors, nothing overflows the
// 960×565 window, nothing that carries meaning is cut (`data-must-fit`: tiers, Revoked, reasons,
// causes, installed names, versions, errors) on Home, Installed or Browse, Installed keeps four
// whole rows under every banner of the busiest scenarios (three elsewhere) and Browse two rows of
// cards, small text is readable, and the state the scenario exists for is on screen. Text is checked in English; the other languages check the same state
// by structure, since their words differ.
import { expect, test, type Page } from "@playwright/test";
import { SCENARIOS } from "../src/dev/scenarios";
import { LOCALES, MODS_TAB, browse, cutButtons, expectBlockerFixesInView, expectFits, expectTwoCardRows, expectWhole, fullRows, goToTab, lowContrast, open, tops } from "./helpers";

type Check = (page: Page, en: boolean) => Promise<void>;
interface Checks {
  home?: Check;
  installed?: Check;
  browse?: Check;
}

const row = (page: Page, name: string) => page.locator(".mod-row", { hasText: name });

/** The scenarios with the most banners over Installed: four whole rows under them all. */
const BUSIEST = ["mods", "offline", "shadowed", "missingdep", "revoked"];

/** Rows whose red reason shows less than its first line: "Built f…". */
const cutReasons = (page: Page) =>
  page.locator(".mod-meta.bad").evaluateAll((els) =>
    els
      .filter((e) => {
        const style = getComputedStyle(e);
        const line = parseFloat(style.lineHeight);
        // Cut on its first line (one-line ellipsis, or a clamp that couldn't wrap at all).
        return e.scrollWidth > e.clientWidth + 1 || (e.scrollHeight > e.clientHeight + 1 && e.clientHeight < line * 2 - 1);
      })
      .map((e) => e.closest("[data-mod]")?.getAttribute("data-mod") ?? "?")
  );
const openNotes = async (page: Page) => {
  const toggle = page.locator(".banner-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  return page.locator(".banner-group .banner");
};

const CHECKS: Record<string, Checks> = {
  mods: {
    home: async (page, en) => {
      await expect(page.locator(".btn-play")).toBeDisabled();
      await expect(page.locator(".blockers .blocker strong")).toHaveText(["Lanterns"]);
      if (en) await expect(page.locator(".hero-version-badge")).toContainText("MODS NEED A FIX");
    },
    installed: async (page, en) => {
      await expect(page.locator(".mod-row")).toHaveCount(5);
      // The same fixes as Home, right above the rows.
      await expect(page.locator(".blockers.in-banner .blocker-actions button")).toHaveCount(2);
      await expect(page.locator(".blockers.in-banner .blocker-pager")).toHaveCount(0);
      if (en) await expect(page.locator(".blockers.in-banner")).toContainText("Update to 1.1.0…");
    },
  },
  empty: {
    installed: async (page, en) => {
      await expect(page.locator(".framed-empty .empty-actions button")).toHaveCount(2);
      await expect(page.locator(".framed-empty .empty-actions .btn-secondary")).toContainText("v26.10.4");
      if (en) await expect(page.locator(".framed-empty")).toContainText("No mods for v26.11.1 yet.");
    },
  },
  fresh: {
    home: async (page, en) => {
      await expect(page.locator(".hero.empty button")).toHaveCount(1);
      if (en) await expect(page.locator(".hero.empty")).toContainText("No versions installed.");
    },
  },
  offline: {
    browse: async (page, en) => {
      // Offline leads the folded row, also with a blocker among the notes.
      if (en) await expect(page.locator(".banner.compact")).toContainText(/^Offline: mod index from Nov 2/);
      const notes = await openNotes(page);
      const texts = await notes.allInnerTexts();
      const at = (s: RegExp) => texts.findIndex((x) => s.test(x));
      if (en) {
        // The player's own folder is last.
        expect(at(/Showing the mod index from Nov 2/)).toBe(0);
        expect(at(/stops Play/)).toBe(1);
        expect(at(/Showing its mods from/)).toBe(2);
        expect(at(/own Weft mods folder/)).toBe(3);
      }
      expect(texts.length).toBe(4);
      // Every install button says it needs the network, and is described by that.
      const buttons = page.locator(".mod-card .btn-primary");
      expect(await buttons.count()).toBeGreaterThan(0);
      for (const b of await buttons.all()) {
        const why = await b.getAttribute("aria-describedby");
        await expect(page.locator(`[id="${why}"]`)).toHaveClass(/needs-net/);
      }
      if (en) await expect(page.locator(".needs-net").first()).toHaveText("needs internet");
    },
  },
  crash: {
    home: async (page, en) => {
      await expect(page.locator(".btn-play")).toBeEnabled();
      if (en) await expect(page.locator(".mods-line")).toContainText("Cogwork, My Tweak, and Structures");
    },
  },
  knownfile: {
    installed: async (page) => {
      await expect(page.locator(".mod-row")).toHaveCount(3);
    },
  },
  revoked: {
    installed: async (page, en) => {
      const cogwork = row(page, "Cogwork");
      // Revoked in place of the tier, and it can't be turned on.
      await expect(cogwork.locator(".badge.revoked")).toHaveCount(1);
      await expect(cogwork.locator(".badge[class*=trust-]")).toHaveCount(0);
      await expect(cogwork.locator(".toggle")).toBeDisabled();
      if (en) {
        await expect(cogwork.locator(".mod-meta")).toContainText("Turned off, pulled from the index: “Corrupts worlds");
        await expect(cogwork.locator(".update-btn-row")).toHaveText("0.2.1");
        await expect(cogwork.locator(".update-btn-row")).toHaveAttribute("aria-label", "Update Cogwork to 0.2.1 for v26.11.1…");
      }
    },
  },
  ratelimited: {
    browse: async (page, en) => {
      const notes = await openNotes(page);
      if (en) await expect(notes.filter({ hasText: "GitHub is limiting requests" })).toHaveCount(1);
    },
  },
  indexdown: {
    browse: async (page, en) => {
      // Never behind "More": it leads the one banner row, with its Retry.
      const lead = page.locator(".banner.compact");
      await expect(lead).toHaveClass(/warn/);
      await expect(lead.locator(".banner-actions button")).toHaveCount(1);
      // Pages answered 404: the network works, so it never says unreachable or offline.
      if (en) await expect(lead).toContainText("No mod index: no Reviewed mods");
      await expect(page.locator(".mod-card .trust-reviewed")).toHaveCount(0);
    },
  },
  stale: {
    installed: async (page, en) => {
      if (en) await expect(page.locator(".banner.compact")).toContainText(/^Mod index signed Sep 21/);
    },
  },
  // A refused index is a warning that says it was refused, never "Offline": the network worked.
  invalid: {
    installed: async (page, en) => {
      const lead = page.locator(".banner.compact", { has: page.locator(".banner-actions button", { hasText: /./ }) }).filter({ hasNotText: /stops Play/ }).first();
      await expect(lead).toHaveClass(/warn/);
      if (en) await expect(lead).toContainText("Index refused: using the copy from Nov 2");
      await expect(page.locator(".banner", { hasText: /Offline/ })).toHaveCount(0);
    },
  },
  rollback: {
    installed: async (page, en) => {
      if (en) await expect(page.locator(".banner.compact", { hasText: "Index refused" })).toHaveClass(/warn/);
      await expect(page.locator(".banner", { hasText: /Offline/ })).toHaveCount(0);
    },
  },
  missingdep: {
    home: async (page, en) => {
      await expect(page.locator(".btn-play")).toBeDisabled();
      const blocker = (name: string) => page.locator(".blocker", { has: page.locator("strong", { hasText: name }) });
      await expect(page.locator(".blocker")).toHaveCount(3);
      await expect(blocker("Hearth").locator("button")).toHaveCount(2);
      await expect(blocker("Lanterns").locator("button")).toHaveCount(2);
      await expect(blocker("Railways").locator("button")).toHaveCount(1);
      if (en) {
        // One whole sentence per reason, naming the mod.
        await expect(blocker("Hearth")).toContainText("Hearth stops Play: it needs Cogwork, which is off.");
        await expect(blocker("Hearth").locator("button").first()).toHaveText("Turn on Cogwork");
        await expect(blocker("Lanterns")).toContainText("Lanterns stops Play: it needs Glowmoss, which isn't installed.");
        await expect(blocker("Lanterns").locator("button").first()).toHaveText("Install Glowmoss…");
        await expect(blocker("Railways")).toContainText("Railways stops Play: it needs Signals, which has no build for v26.11.1 yet.");
      }
    },
  },
  shadowed: {
    home: async (page) => {
      await expect(page.locator(".btn-play")).toBeDisabled();
    },
    installed: async (page, en) => {
      // The copy in the player's folder blocks, with a fix that shows that file: one page on.
      const banner = page.locator(".blockers.in-banner");
      await expect(banner.locator(".pager-at")).toHaveText(/^1\D+2$/);
      // Cogwork first, the one that blocks itself; then Hearth, which needs it.
      await expect(banner.locator(".blocker")).toHaveAttribute("data-blocker", "cogwork");
      const blocker = banner.locator(".blocker[data-blocker=cogwork]");
      await expect(blocker.locator(".blocker-actions button")).toHaveCount(2);
      await expect(page.locator(".mod-row[data-mod=cogwork]")).toHaveAttribute("data-shadowed", "true");
      if (en) {
        await expect(blocker).toContainText("Cogwork stops Play: it was pulled from the index, but the copy in your own mods folder (cogwork-old.zip) would load instead.");
        await expect(blocker.locator(".blocker-actions button").nth(1)).toHaveText("Show cogwork-old.zip");
      }
    },
  },
  chain: {
    browse: async (page) => {
      await expect(page.locator(".mod-card[data-key*=chimneys], .mod-card[data-key*=junctions]")).toHaveCount(2);
    },
  },
  lateblock: {
    home: async (page) => {
      await expect(page.locator(".btn-play")).toBeEnabled();
      await expect(page.locator(".blocker")).toHaveCount(0);
    },
  },
};

// One verb for copying a set, in every language: a copy, never a move («Перенести»).
const COPY_FROM: Record<(typeof LOCALES)[number], string> = {
  en: "Copy mods from…",
  "pt-BR": "Copiar mods de…",
  es: "Copiar mods de…",
  ru: "Скопировать моды из…",
};

for (const locale of LOCALES) {
  for (const scenario of SCENARIOS) {
    test(`${scenario.name} in ${locale}`, async ({ page }) => {
      const en = locale === "en";
      const checks = CHECKS[scenario.name] ?? {};
      const errors = await open(page, `scenario=${scenario.name}`, locale);
      await expectFits(page);
      await checks.home?.(page, en);
      await expectWhole(page, "Home");
      await goToTab(page, MODS_TAB);
      await expect(page.locator(".mods-page")).toBeVisible();
      await expectFits(page);
      if (await page.locator(".switch [role=tab]").count()) {
        await expect(page.locator(".mod-row, .framed-empty").first()).toBeVisible();
        // However many banners, four whole rows stay in view in the busiest scenarios and three
        // elsewhere (or all of them, if fewer). Very long names wrap whole, so two there.
        const rows = await page.locator(".mod-row").count();
        const want = BUSIEST.includes(scenario.name) ? 4 : scenario.name === "long" ? 2 : 3;
        expect(await fullRows(page), "whole rows in view").toBeGreaterThanOrEqual(Math.min(want, rows));
        await expectWhole(page, "Installed");
        // Every fix of every blocking mod, and every banner's button, wholly in view.
        await expectBlockerFixesInView(page);
        expect(await cutButtons(page, ".banners"), "banner buttons in view").toEqual([]);
        // A row's reason is never cut after a few letters: it has a line of its own, two when needed.
        if (scenario.name !== "long") expect(await cutReasons(page), "reasons cut short").toEqual([]);
        await checks.installed?.(page, en);
        expect(await lowContrast(page), "small text under 4.5:1").toEqual([]);
        await browse(page);
        await expect(page.locator(".mod-card").first()).toBeVisible();
        await expectFits(page);
        await expectTwoCardRows(page);
        if (scenario.name !== "long") {
          // Names have the card's width: the tier and source sit on the line below.
          await expect(page.locator(".mod-card .mod-name[tabindex='0']"), "cut names").toHaveCount(0);
        }
        // Who a mod is from and why there is nothing to install (e.g. "Prereleases only") are whole
        // on every card: they wrap rather than being cut, and nothing about them is a tab stop.
        expect(await page.locator(".mod-card-by[data-must-fit]").count()).toBe(await page.locator(".mod-card").count());
        await checks.browse?.(page, en);
        await expectWhole(page, "Browse");
        expect(await lowContrast(page), "small text under 4.5:1").toEqual([]);
      }
      expect(errors).toEqual([]);
    });
  }

  test(`the Mods header stays put and blockers stay bounded in ${locale}`, async ({ page }) => {
    await open(page, "scenario=missingdep", locale);
    await goToTab(page, MODS_TAB);
    await expect(page.locator(".mod-row").first()).toBeVisible();
    // The switch and the toolbar share one line, in every language.
    const [sw, actions] = await tops(page, [".switch", ".toolbar-actions"]);
    expect(Math.abs(sw - actions), "toolbar wrapped").toBeLessThanOrEqual(8);
    // Three blockers: one at a time, with a pager, so the banner stays a few lines tall whichever
    // is shown, and four rows still show below it on every page.
    const banner = page.locator(".blockers.in-banner");
    await expect(banner.locator(".pager-at")).toHaveText(/^1\D+3$/);
    const heights = new Set<number>();
    for (let i = 0; i < 3; i++) {
      heights.add(Math.round((await page.locator(".banners").boundingBox())!.height));
      expect(await fullRows(page), `whole rows under blocker ${i + 1}`).toBeGreaterThanOrEqual(4);
      await banner.locator(".pager-btn").last().click();
    }
    expect(Math.max(...heights), "banner height").toBeLessThanOrEqual(124);
    // Round the pager and back: the first one again.
    await expect(banner.locator(".blocker")).toHaveAttribute("data-blocker", "hearth");
    // Only the list scrolls: the header, version picker, switch, toolbar and banners stay put.
    const fixed = [".page-header", ".mods-page .version-select", ".switch", ".toolbar-actions", ".banners"];
    const before = await tops(page, fixed);
    const scrolled = await page.locator(".mods-panel").evaluate((e) => {
      e.scrollTop = e.scrollHeight;
      return e.scrollTop;
    });
    expect(scrolled, "the list scrolls").toBeGreaterThan(0);
    expect(await tops(page, fixed)).toEqual(before);
    expect(await page.evaluate(() => document.querySelector(".page-container")?.scrollTop ?? 0)).toBe(0);
    await expect(page.locator(".toolbar-actions button").last()).toHaveText(COPY_FROM[locale]);
  });

  test(`dialogs fit in ${locale}`, async ({ page }) => {
    await open(page, "scenario=mods&long=1", locale);
    await goToTab(page, MODS_TAB);

    // Install dialog for an update: the warning is above the checks, in view.
    await page.locator(".mod-row .update-btn-row").first().click();
    await expect(page.locator("[role=dialog] .checks")).toBeVisible();
    await expectFits(page);
    const warning = await page.locator("[role=dialog] .dialog-warning").boundingBox();
    const checks = await page.locator("[role=dialog] .checks").boundingBox();
    expect(warning!.y).toBeLessThan(checks!.y);
    expect(warning!.y + warning!.height).toBeLessThanOrEqual(565);
    await page.keyboard.press("Escape");

    // The unverified file dialog is the tallest: warning in view, typed confirmation in the footer.
    await page.locator(".toolbar-actions button").first().click();
    const input = page.locator("[role=dialog] .dialog-actions input");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await expectFits(page);
    const w = await page.locator("[role=dialog] .dialog-warning").boundingBox();
    expect(w!.y + w!.height).toBeLessThanOrEqual(565);
    await page.keyboard.press("Escape");
  });
}
