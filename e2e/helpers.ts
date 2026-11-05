import { expect, type Locator, type Page } from "@playwright/test";

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

/** How many installed rows are wholly inside the list's scroll box, above any toast over it. */
export const fullRows = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector(".mods-panel")!.getBoundingClientRect();
    const toasts = document.querySelector<HTMLElement>(".toasts:not([hidden])");
    const bottom = Math.min(box.bottom, window.innerHeight, toasts ? toasts.getBoundingClientRect().top : Infinity);
    return [...document.querySelectorAll(".mod-row")].filter((r) => {
      const b = r.getBoundingClientRect();
      return b.top >= box.top - 0.5 && b.bottom <= bottom + 0.5;
    }).length;
  });

/**
 * Buttons in `scope` that aren't wholly visible: cut by an ancestor that clips (a scroller, a
 * clamp), by the window, or covered by something drawn over them. Empty when every one can be
 * seen and pressed in full.
 */
export const cutButtons = (page: Page, scope: string) =>
  page.evaluate((scope) => {
    const bad: string[] = [];
    for (const root of document.querySelectorAll(scope)) {
      for (const b of root.querySelectorAll<HTMLElement>("button")) {
        const r = b.getBoundingClientRect();
        if (!r.width || !r.height || b.closest("[hidden], .sr-only")) continue;
        const name = (b.getAttribute("aria-label") || b.textContent || "").trim().slice(0, 40);
        const outside = (c: DOMRect) => r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5 || r.left < c.left - 0.5 || r.right > c.right + 0.5;
        if (outside(new DOMRect(0, 0, window.innerWidth, window.innerHeight))) {
          bad.push(`${name}: outside the window`);
          continue;
        }
        for (let a = b.parentElement; a && a !== document.body; a = a.parentElement) {
          const s = getComputedStyle(a);
          if (/(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY) && outside(a.getBoundingClientRect())) {
            bad.push(`${name}: cut by .${a.className.split(" ").join(".")}`);
            break;
          }
        }
        // Nothing drawn over its corners and middle.
        const points = [[r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2], [(r.left + r.right) / 2, (r.top + r.bottom) / 2]];
        if (points.some(([x, y]) => { const hit = document.elementFromPoint(x, y); return !hit || !b.contains(hit); })) bad.push(`${name}: covered`);
      }
    }
    return [...new Set(bad)];
  }, scope);

/**
 * Every page of the Mods tab's blocker banner, each with all its fix buttons wholly in view. Goes
 * through the pager and back to the first page.
 */
export async function expectBlockerFixesInView(page: Page) {
  const banner = page.locator(".blockers.in-banner");
  if (!(await banner.count())) return;
  const pager = banner.locator(".blocker-pager");
  const pages = (await pager.count()) ? Number((await pager.locator(".pager-at").innerText()).match(/\d+/g)!.at(-1)) : 1;
  const seen = new Set<string>();
  for (let i = 0; i < pages; i++) {
    const id = (await banner.locator(".blocker").getAttribute("data-blocker"))!;
    seen.add(id);
    expect(await banner.locator(".blocker-actions button").count(), `${id} has fixes`).toBeGreaterThan(0);
    expect(await cutButtons(page, ".blockers.in-banner"), `fixes of ${id} in view`).toEqual([]);
    if (pages > 1) await pager.locator("button").last().click();
  }
  expect(seen.size, "the pager reaches every blocking mod").toBe(pages);
}

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

/**
 * Remove, then confirm: two presses, the second after the double-click gap (a press closer than
 * that to the first doesn't confirm, so a double-click can't remove a mod).
 */
export async function confirmRemove(page: Page, button: Locator) {
  await button.click();
  await expect(button).toHaveClass(/confirming/);
  await page.waitForTimeout(450);
  await button.click();
}

/**
 * Elements marked `data-must-fit` (a tier word, a reason, a version, a cause, an installed mod's
 * name, an error) that don't show whole: their text is wider or taller than their own box, or an
 * ancestor that clips cuts them. Ancestors that scroll end the search: what is in a scroller is
 * reached by scrolling. Empty when every one is whole.
 */
export const unfit = (page: Page) =>
  page.evaluate(() => {
    const bad: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("[data-must-fit]")) {
      if (!el.getClientRects().length || el.closest("[hidden], .sr-only")) continue;
      const name = `${el.className || el.tagName} "${(el.textContent ?? "").trim().slice(0, 40)}"`;
      if (getComputedStyle(el).display !== "inline") {
        if (el.scrollWidth > el.clientWidth + 0.5) bad.push(`${name}: wider than its box (${el.scrollWidth} > ${el.clientWidth})`);
        if (el.scrollHeight > el.clientHeight + 0.5) bad.push(`${name}: taller than its box (${el.scrollHeight} > ${el.clientHeight})`);
      }
      const r = el.getBoundingClientRect();
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const s = getComputedStyle(a);
        const overflow = s.overflowX + " " + s.overflowY;
        if (/auto|scroll/.test(overflow)) break;
        if (!/hidden|clip/.test(overflow)) continue;
        const c = a.getBoundingClientRect();
        if (r.left < c.left - 0.5 || r.right > c.right + 0.5 || r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5) {
          bad.push(`${name}: cut by .${String(a.className).split(" ").join(".")}`);
          break;
        }
      }
    }
    return [...new Set(bad)];
  });

/** Every element that must show whole does. */
export async function expectWhole(page: Page, where: string) {
  expect(await unfit(page), `cut on ${where}`).toEqual([]);
}
