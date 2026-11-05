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

export async function browse(page: Page) {
  await page.locator(".switch [role=tab]").nth(1).click();
  await expect(page.locator("#mods-panel-browse")).toBeVisible();
}

/** What has keyboard focus, and whether it is inside the open dialog. */
export const focused = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return {
      tag: a?.tagName ?? "",
      text: a?.textContent?.trim() ?? "",
      label: a?.getAttribute("aria-label") ?? "",
      inDialog: !!a?.closest("[role=dialog]"),
      row: a?.closest("[data-mod]")?.getAttribute("data-mod") ?? null,
    };
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

/** On Browse, the banners leave room for two whole rows of cards, when there are that many. */
export async function expectTwoCardRows(page: Page) {
  const { total, visible } = await page.locator(".mod-card").evaluateAll((cards) => ({
    total: cards.length,
    visible: cards.filter((c) => c.getBoundingClientRect().bottom <= window.innerHeight).length,
  }));
  expect(visible, `whole cards in view (of ${total})`).toBeGreaterThanOrEqual(Math.min(4, total));
}

/** An element is inside the window, not below the fold. */
export async function expectInView(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, `${selector} is rendered`).not.toBeNull();
  expect(box!.y + box!.height, `${selector} is below the window`).toBeLessThanOrEqual(page.viewportSize()!.height);
}

/** How many installed rows are wholly inside the list's scroll box. */
export const fullRows = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector(".mods-panel")!.getBoundingClientRect();
    const bottom = Math.min(box.bottom, window.innerHeight);
    return [...document.querySelectorAll(".mod-row")].filter((r) => r.getBoundingClientRect().bottom <= bottom + 0.5).length;
  });

/** Where some elements are, to check they don't move. */
export const tops = (page: Page, selectors: string[]) =>
  page.evaluate((s) => s.map((sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().top ?? -1)), selectors);

/** What the one polite live region says now. */
export const spoken = (page: Page) => page.getByTestId("live-region");

/**
 * Text set at 16px or less that is on screen and has less than 4.5:1 contrast with what is behind
 * it. The background is the first opaque one up the tree; text on an image isn't checked.
 */
export const lowContrast = (page: Page, min = 4.5) =>
  page.evaluate((min) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bg = (el: Element | null): number[] | null => {
      for (; el; el = el.parentElement) {
        const s = getComputedStyle(el);
        if (s.backgroundImage !== "none" && el !== document.body && el !== document.documentElement) return null;
        const c = rgb(s.backgroundColor);
        if (c.length >= 3 && (c.length < 4 || c[3] === 1)) return c;
      }
      return [0, 0, 0];
    };
    const bad: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.textContent?.trim()) continue;
      const s = getComputedStyle(el);
      if (parseFloat(s.fontSize) > 16 || s.visibility === "hidden" || el.closest(".sr-only, [aria-hidden=true], :disabled, [hidden]")) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || r.bottom < 0 || r.top > window.innerHeight) continue;
      const back = bg(el);
      if (!back) continue;
      const fg = rgb(s.color);
      const [a, b] = [lum(fg), lum(back)].sort((x, y) => y - x);
      const ratio = (a + 0.05) / (b + 0.05);
      if (ratio < min && parseFloat(s.opacity) === 1) bad.push(`${el.className || el.tagName}: "${n.textContent.trim().slice(0, 30)}" ${ratio.toFixed(2)}`);
    }
    return [...new Set(bad)];
  }, min);
