// Every mock scenario, in every language: it renders without errors, nothing overflows the
// 960×565 window, and the dialogs keep their buttons on screen.
import { expect, test } from "@playwright/test";
import { SCENARIOS } from "../src/dev/scenarios";
import { LOCALES, MODS_TAB, expectFits, goToTab, open } from "./helpers";

for (const locale of LOCALES) {
  for (const scenario of SCENARIOS) {
    test(`${scenario.name} renders in ${locale}`, async ({ page }) => {
      const errors = await open(page, `scenario=${scenario.name}`, locale);
      await expectFits(page);
      await goToTab(page, MODS_TAB);
      await expect(page.locator(".mods-page")).toBeVisible();
      await expectFits(page);
      const browse = page.locator(".switch [role=tab]").nth(1);
      if (await browse.count()) {
        await browse.click();
        await expectFits(page);
      }
      expect(errors).toEqual([]);
    });
  }

  test(`dialogs fit in ${locale}`, async ({ page }) => {
    await open(page, "scenario=mods&long=1", locale);
    await goToTab(page, MODS_TAB);

    // Install dialog for an update.
    await page.locator(".mod-row .mod-update button").first().click();
    await expect(page.locator("[role=dialog]")).toBeVisible();
    await expectFits(page);
    await page.keyboard.press("Escape");

    // The unverified file dialog is the tallest one.
    await page.locator(".toolbar-actions button").first().click();
    await expect(page.locator("[role=dialog] input")).toBeVisible();
    await expectFits(page);
    await page.keyboard.press("Escape");
  });
}
