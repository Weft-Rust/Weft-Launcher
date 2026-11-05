// Every mock scenario, in every language: it renders without errors, nothing overflows the
// 960×565 window, Installed keeps three whole rows under its banners and Browse two rows of
// cards, names aren't cut, small text is readable, and the state the scenario exists for is on
// screen. Text is checked in English; the other languages check the same state
// by structure, since their words differ.
import { expect, test, type Page } from "@playwright/test";
import { SCENARIOS } from "../src/dev/scenarios";
import { LOCALES, MODS_TAB, browse, expectFits, expectTwoCardRows, fullRows, goToTab, lowContrast, open, tops } from "./helpers";

type Check = (page: Page, en: boolean) => Promise<void>;
interface Checks {
  home?: Check;
  installed?: Check;
  browse?: Check;
}

const row = (page: Page, name: string) => page.locator(".mod-row", { hasText: name });
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
      await expect(page.locator(".blockers.in-banner .blocker button")).toHaveCount(2);
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
        expect(at(/won't start/)).toBe(1);
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
        await expect(cogwork.locator(".mod-meta")).toContainText("Pulled from the index and turned off. Reason: Corrupts worlds");
        await expect(cogwork.locator(".update-btn-row")).toHaveText("0.2.1");
        await expect(cogwork.locator(".update-btn-row")).toHaveAttribute("aria-label", "Update Cogwork to 0.2.1…");
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
      if (en) await expect(lead).toContainText("Reviewed mods are unavailable");
      await expect(page.locator(".mod-card .trust-reviewed")).toHaveCount(0);
    },
  },
  stale: {
    installed: async (page, en) => {
      if (en) await expect(page.locator(".banner.compact")).toContainText(/^Mod index signed Sep 21/);
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
        await expect(blocker("Hearth")).toContainText("Needs Cogwork, which is off.");
        await expect(blocker("Hearth").locator("button").first()).toHaveText("Turn on Cogwork");
        await expect(blocker("Lanterns")).toContainText("Needs Glowmoss, which isn't installed.");
        await expect(blocker("Lanterns").locator("button").first()).toHaveText("Install Glowmoss…");
        await expect(blocker("Railways")).toContainText("Needs Signals, which has no build for v26.11.1 yet.");
      }
    },
  },
  shadowed: {
    home: async (page) => {
      await expect(page.locator(".btn-play")).toBeDisabled();
    },
    installed: async (page, en) => {
      // The copy in the player's folder blocks, with a fix that shows that file.
      const blocker = page.locator(".blockers.in-banner .blocker", { has: page.locator("strong", { hasText: "Cogwork" }) });
      await expect(blocker.locator("button")).toHaveCount(2);
      await expect(page.locator(".mod-row[data-mod=cogwork]")).toHaveAttribute("data-shadowed", "true");
      if (en) {
        await expect(blocker).toContainText("a copy in your own mods folder (cogwork-old.zip) would load in its place");
        await expect(blocker.locator("button").nth(1)).toHaveText("Show cogwork-old.zip");
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
      await goToTab(page, MODS_TAB);
      await expect(page.locator(".mods-page")).toBeVisible();
      await expectFits(page);
      if (await page.locator(".switch [role=tab]").count()) {
        await expect(page.locator(".mod-row, .framed-empty").first()).toBeVisible();
        // However many banners, three whole rows stay in view (or all of them, if fewer).
        const rows = await page.locator(".mod-row").count();
        expect(await fullRows(page), "whole rows in view").toBeGreaterThanOrEqual(Math.min(3, rows));
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
        await checks.browse?.(page, en);
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
    // Three blockers: their list scrolls in a box of its own, and three rows still show below it.
    const list = await page.locator(".blockers.in-banner .blocker-list").evaluate((e) => ({ shown: e.clientHeight, all: e.scrollHeight }));
    expect(list.shown).toBeLessThan(list.all);
    expect(list.shown).toBeLessThanOrEqual(100);
    expect(await fullRows(page)).toBeGreaterThanOrEqual(3);
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
