// The flows the mod manager's safety depends on, and keyboard use, against the mock backend.
import { expect, test } from "@playwright/test";
import { MODS_TAB, focused, goToTab, open } from "./helpers";

test.describe("launch safety", () => {
  test("blocked mods disable Play and one click fixes it", async ({ page }) => {
    await open(page, "scenario=mods");
    await expect(page.locator(".btn-play")).toBeDisabled();
    await expect(page.locator(".hero-version-badge")).toContainText("MODS NEED A FIX");
    await page.locator(".blocker button", { hasText: "Turn off" }).first().click();
    await expect(page.locator(".btn-play")).toBeEnabled();
  });

  test("a crash notice names the mod and stays until it is fixed", async ({ page }) => {
    await open(page, "scenario=crash");
    await page.locator(".btn-play").click();
    const notice = page.locator(".mod-failure");
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice.locator("button", { hasText: "Get update" })).toHaveCount(1);
    await goToTab(page, MODS_TAB);
    await expect(page.locator(".mod-failure")).toHaveCount(1);
    await page.locator(".mod-failure button", { hasText: "Turn off" }).click();
    await expect(page.locator(".mod-failure")).toHaveCount(0);
  });
});

test.describe("every install shows what was checked", () => {
  test("an update opens the review dialog, it isn't installed silently", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    await page.locator(".mod-row .mod-update button").first().click();
    const dialog = page.locator("[role=dialog]");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".checks li").first()).toBeVisible();
    await expect(dialog).toContainText(/can do anything/i);
  });

  test("provenance a repo only claims is never a green check", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    await page.locator(".switch [role=tab]").nth(1).click();
    await page.locator(".mod-card", { hasText: "Glowmoss" }).locator("button.btn-primary").click();
    const claimed = page.locator(".checks li", { hasText: "the repo says" });
    await expect(claimed).toHaveClass(/check-unknown/);
    const spoken = await page
      .locator(".checks li")
      .evaluateAll((rows) => rows.map((r) => r.querySelector(".sr-only")?.textContent ?? ""));
    expect(spoken.length).toBeGreaterThan(0);
    for (const s of spoken) expect(s).toMatch(/Passed|Failed|Unknown/);
  });

  test("copying a mod set previews it before installing", async ({ page }) => {
    await open(page, "scenario=empty");
    await goToTab(page, MODS_TAB);
    await page.locator(".empty-actions .btn-secondary").first().click();
    const dialog = page.locator("[role=dialog]");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".trust-badge, .badge").first()).toBeVisible();
  });

  test("an update keeps a mod that is off turned off", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    const row = page.locator(".mod-row", { hasText: "Structures" });
    const toggle = row.locator(".toggle");
    if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await row.locator(".mod-update button").click();
    await page.locator("[role=dialog] .dialog-actions .btn-primary").click();
    await expect(page.locator("[role=dialog]")).toHaveCount(0, { timeout: 15_000 });
    await expect(row.locator(".toggle")).toHaveAttribute("aria-checked", "false");
  });
});

test.describe("keyboard", () => {
  test("top tabs: one tab stop, arrows, Home and End", async ({ page }) => {
    await open(page, "scenario=mods");
    const stops = await page.locator(".tab-btn").evaluateAll((els) => els.filter((e) => (e as HTMLElement).tabIndex === 0).length);
    expect(stops).toBe(1);
    await page.locator(".tab-btn").first().focus();
    await page.keyboard.press("ArrowRight");
    expect((await focused(page)).text).toMatch(/^Versions/);
    await expect(page.locator("#main-panel-versions[role=tabpanel]")).toHaveCount(1);
    await page.keyboard.press("End");
    expect((await focused(page)).text).toMatch(/^Release Notes/);
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowLeft");
    expect((await focused(page)).text).toMatch(/^Release Notes/);
  });

  test("Installed/Browse switch follows the arrows", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    await page.locator(".switch [role=tab]").first().focus();
    await page.keyboard.press("ArrowRight");
    expect((await focused(page)).text).toMatch(/^Browse/);
    await expect(page.locator("#mods-panel-browse")).toHaveCount(1);
  });

  test("dialogs start on Cancel, keep focus inside and close on Escape", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    await page.locator(".mod-row .mod-update button").first().click();
    await expect(page.locator("[role=dialog]")).toBeVisible();
    const first = await focused(page);
    expect(first.inDialog).toBe(true);
    expect(first.text).toBe("Cancel");
    await page.evaluate(() => (document.querySelector(".tab-btn") as HTMLElement | null)?.focus());
    await expect.poll(async () => (await focused(page)).inDialog).toBe(true);
    for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
    expect((await focused(page)).inDialog).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator("[role=dialog]")).toHaveCount(0);
  });

  test("an unverified file can be confirmed by keyboard alone", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    await page.locator(".toolbar-actions button").first().click();
    const input = page.locator("[role=dialog] input");
    await expect(input).toBeVisible();
    expect((await focused(page)).inDialog).toBe(true);
    await input.focus();
    await page.keyboard.type("mytweak");
    await page.keyboard.press("Enter");
    await expect(page.locator("[role=dialog]")).toHaveCount(0, { timeout: 10_000 });
  });

  test("toggling a mod doesn't move its row", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    const names = () => page.locator(".mod-list .mod-name").allInnerTexts();
    const before = await names();
    await page.locator(".mod-row", { hasText: "Cogwork" }).locator(".toggle").click();
    await expect.poll(names).toEqual(before);
  });
});

test.describe("degraded states", () => {
  test("a catalogue that fails to load offers Retry, not 'no mods'", async ({ page }) => {
    await open(page, "scenario=mods&fail=catalog");
    await goToTab(page, MODS_TAB);
    await page.locator(".switch [role=tab]").nth(1).click();
    await expect(page.locator(".mods-panel button", { hasText: "Retry" })).toHaveCount(1);
  });

  test("removing a source asks first and a bad repo fails inline", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    await page.locator(".toolbar-actions button", { hasText: "Sources" }).click();
    await page.locator(".source-row button", { hasText: "Remove" }).click();
    await expect(page.locator(".source-confirm")).toHaveCount(1);
    await page.locator(".source-confirm .btn-danger").click();
    await expect(page.locator(".source-row")).toHaveCount(1);
    await page.locator("[role=dialog] input").fill("not a repo");
    await page.keyboard.press("Enter");
    await expect(page.locator("[role=dialog] .inline-error")).toHaveCount(1);
  });
});
