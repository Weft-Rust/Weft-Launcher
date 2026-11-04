import { expect, type Page } from "@playwright/test";

export const LOCALES = ["en", "pt-BR", "es", "ru"] as const;

/** Opens the launcher on a mock scenario, in a language, and fails the test on any page error. */
export async function open(page: Page, query: string, locale = "en") {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((l) => localStorage.setItem("locale", l), locale);
  await page.goto(`/?${query}`);
  await expect(page.locator(".tab-btn").first()).toBeVisible();
  return errors;
}

export async function goToTab(page: Page, index: number) {
  await page.locator(".tab-btn").nth(index).click();
}

export const MODS_TAB = 2;

/** What has keyboard focus, and whether it is inside the open dialog. */
export const focused = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName ?? "", text: a?.textContent?.trim() ?? "", inDialog: !!a?.closest("[role=dialog]") };
  });

/** Nothing sticks out sideways, and the dialog's buttons (if one is open) are inside the window. */
export async function expectFits(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(0);
  const actions = page.locator("[role=dialog] .dialog-actions");
  if (await actions.count()) {
    const box = await actions.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box, "dialog actions are rendered").not.toBeNull();
    expect(box!.y + box!.height, "dialog actions are below the window").toBeLessThanOrEqual(viewport.height);
  }
}
