// Every mock scenario, in every language: it renders without errors, nothing overflows the
// 960×565 window, Browse keeps two rows of cards under its banners, and the state the scenario
// exists for is on screen. Text is checked in English; the other languages check the same state
// by structure, since their words differ.
import { expect, test, type Page } from "@playwright/test";
import { SCENARIOS } from "../src/dev/scenarios";
import { LOCALES, MODS_TAB, browse, expectFits, expectTwoCardRows, goToTab, open } from "./helpers";

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
      const notes = await openNotes(page);
      const texts = await notes.allInnerTexts();
      const at = (s: RegExp) => texts.findIndex((x) => s.test(x));
      if (en) {
        // The catalogue's problems come before the player's own folder.
        expect(at(/Showing the mod index from Nov 2, 2026/)).toBeGreaterThan(-1);
        expect(at(/Showing its mods from/)).toBeGreaterThan(at(/mod index/));
        expect(at(/own Weft mods folder/)).toBeGreaterThan(at(/Showing its mods/));
      }
      expect(texts.length).toBe(4);
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
        await expect(cogwork.locator(".mod-update button")).toHaveText("Update to 0.2.1…");
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
      if (en) await expect(page.locator(".banner.compact")).toContainText("The mod index was last signed on Sep 21, 2026");
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
  lateblock: {
    home: async (page) => {
      await expect(page.locator(".btn-play")).toBeEnabled();
      await expect(page.locator(".blocker")).toHaveCount(0);
    },
  },
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
        await checks.installed?.(page, en);
        await browse(page);
        await expect(page.locator(".mod-card").first()).toBeVisible();
        await expectFits(page);
        await expectTwoCardRows(page);
        await checks.browse?.(page, en);
      }
      expect(errors).toEqual([]);
    });
  }

  test(`dialogs fit in ${locale}`, async ({ page }) => {
    await open(page, "scenario=mods&long=1", locale);
    await goToTab(page, MODS_TAB);

    // Install dialog for an update: the warning is above the checks, in view.
    await page.locator(".mod-row .mod-update button").first().click();
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
