// The flows the mod manager's safety depends on, and keyboard use, against the mock backend.
import { expect, test } from "@playwright/test";
import { MODS_TAB, browse, focused, goToTab, open } from "./helpers";

const dialog = "[role=dialog]";

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
    await expect(notice.locator(".mod-failure-title")).toHaveText("Structures stopped Weft from starting: its library didn't load.");
    await expect(notice.locator("button", { hasText: "Update to 0.1.3…" })).toHaveCount(1);
    await goToTab(page, MODS_TAB);
    await expect(page.locator(".mod-failure")).toHaveCount(1);
    await page.locator(".mod-failure button", { hasText: "Turn off" }).click();
    await expect(page.locator(".mod-failure")).toHaveCount(0);
  });

  test("a missing-dependency crash names the dependency and turns it on", async ({ page }) => {
    await open(page, "scenario=crash&crash=missingDep");
    await page.locator(".btn-play").click();
    const notice = page.locator(".mod-failure");
    await expect(notice.locator(".mod-failure-title")).toHaveText("My Tweak stopped Weft from starting: it needs Cogwork.", { timeout: 10_000 });
    await expect(notice.locator("button", { hasText: "Update" })).toHaveCount(0);
    await notice.locator("button", { hasText: "Turn on Cogwork" }).click();
    await goToTab(page, MODS_TAB);
    await expect(page.locator(".mod-row", { hasText: "Cogwork" }).locator(".toggle")).toHaveAttribute("aria-checked", "true");
  });

  test("Home shows a blocker the backend found at Play, with its fixes", async ({ page }) => {
    await open(page, "scenario=lateblock");
    await expect(page.locator(".blocker")).toHaveCount(0);
    await page.locator(".btn-play").click();
    const hearth = page.locator(".blocker", { hasText: "Hearth" });
    await expect(hearth).toContainText("Needs Cogwork, which was pulled from the index.");
    await expect(page.locator(".btn-play")).toBeDisabled();
    // The panel says it; no second, rawer copy of the error.
    await expect(page.locator(".hero > .launch-error[role=alert]")).toHaveCount(0);
    await hearth.locator("button", { hasText: "Turn off Hearth" }).click();
    await expect(page.locator(".btn-play")).toBeEnabled();
  });
});

test.describe("every install shows what it does", () => {
  test("an update opens the review dialog, warning first", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    await page.locator(".mod-row .mod-update button").first().click();
    const d = page.locator(dialog);
    await expect(d.locator(".dialog-warning")).toContainText("It can do anything you can do on this computer");
    // Lanterns 1.1.0 needs Glowmoss, from the same source: named, with its tier.
    await expect(d.locator(".checks li", { hasText: "Needs Glowmoss: installs 0.3.0 with it" }).locator(".badge")).toHaveText("Unreviewed");
  });

  test("provenance a repo only claims is never a green check", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    await browse(page);
    await page.locator(".mod-card", { hasText: "Glowmoss" }).locator("button.btn-primary").click();
    const claimed = page.locator(".checks li", { hasText: "the repo says" });
    await expect(claimed).toHaveClass(/check-unknown/);
    const spoken = await page.locator(".checks li").evaluateAll((rows) => rows.map((r) => r.querySelector(".sr-only")?.textContent ?? ""));
    expect(spoken.length).toBeGreaterThan(0);
    for (const s of spoken) expect(s).toMatch(/Passed|Failed|Unknown/);
  });

  test("a missing dependency installs the mod turned off, and Play keeps working", async ({ page }) => {
    await open(page, "scenario=crash");
    await goToTab(page, MODS_TAB);
    await browse(page);
    await page.locator(".mod-card", { hasText: "Railways" }).locator("button.btn-primary").click();
    const d = page.locator(dialog);
    await expect(d).toContainText("Signals has no build for v26.11.1 yet, so Railways is installed turned off. Play keeps working.");
    await d.locator(".dialog-actions .btn-primary", { hasText: "Install turned off" }).click();
    await expect(d).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(".banner", { hasText: "Railways is installed turned off" })).toHaveCount(1);
    await page.locator(".switch [role=tab]").first().click();
    await expect(page.locator(".mod-row", { hasText: "Railways" }).locator(".toggle")).toHaveAttribute("aria-checked", "false");
    await goToTab(page, 0);
    await expect(page.locator(".btn-play")).toBeEnabled();
  });

  test("Install … on a missing dependency opens its review", async ({ page }) => {
    await open(page, "scenario=missingdep");
    await page.locator(".blocker button", { hasText: "Install Glowmoss…" }).click();
    const d = page.locator(dialog);
    await expect(d.locator(".dialog-title")).toHaveText("Install Glowmoss 0.3.0 for v26.11.1?");
    await d.locator(".dialog-actions .btn-primary").click();
    await expect(d).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(".blocker", { hasText: "Lanterns" })).toHaveCount(0);
  });

  test("copying a mod set shows everything it brings, then does it", async ({ page }) => {
    await open(page, "scenario=empty");
    await goToTab(page, MODS_TAB);
    await page.locator(".empty-actions .btn-secondary").first().click();
    const d = page.locator(dialog);
    // Only turned-on mods; each with its outcome, then what they need.
    await expect(d.locator(".copy-list").first().locator("li")).toHaveCount(6);
    await expect(d.locator("li", { hasText: "Glowmoss 0.3.0: a copied mod needs it" }).locator(".badge")).toHaveText("Unreviewed");
    await expect(d.locator(".dialog-warning")).toContainText("nobody reviewed these: Lanterns and Glowmoss");
    await d.locator(".dialog-actions .btn-primary", { hasText: "Copy 4 mods" }).click();
    await expect(d.locator(".dialog-title")).toHaveText("Mods copied to v26.11.1", { timeout: 30_000 });
    await d.locator(".dialog-actions .btn-primary").click();
    await expect(page.locator(".mod-row")).toHaveCount(5);
    await expect(page.locator(".mod-row .mod-name", { hasText: /^Glowmoss$/ })).toHaveCount(1);
  });

  test("a catalogued file shows the plan of that build", async ({ page }) => {
    await open(page, "scenario=knownfile");
    await goToTab(page, MODS_TAB);
    await page.locator(".toolbar-actions button").first().click();
    const d = page.locator(dialog);
    await expect(d.locator(".dialog-title")).toHaveText("Install Cogwork 0.2.0 for v26.11.1 from this file?");
    await expect(d.locator(".checks li", { hasText: "Same file as Cogwork 0.2.0" })).toHaveClass(/check-yes/);
    await expect(d.locator(".dialog-actions .btn-primary")).toHaveText("Install");
  });

  test("an update keeps a mod that is off turned off", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    const row = page.locator(".mod-row", { hasText: "Structures" });
    const toggle = row.locator(".toggle");
    if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await row.locator(".mod-update button").click();
    await page.locator(`${dialog} .dialog-actions .btn-primary`).click();
    await expect(page.locator(dialog)).toHaveCount(0, { timeout: 15_000 });
    await expect(row.locator(".toggle")).toHaveAttribute("aria-checked", "false");
  });

  test("a failed dependency download leaves no progress behind", async ({ page }) => {
    await open(page, "scenario=mods&fail=dep");
    await goToTab(page, MODS_TAB);
    await page.locator(".mod-row", { hasText: "Lanterns" }).locator(".mod-update button").click();
    await page.locator(`${dialog} .dialog-actions .btn-primary`).click();
    await expect(page.locator(`${dialog} .inline-error`)).toContainText("gone from GitHub", { timeout: 15_000 });
    await expect(page.locator(`${dialog} .progress-bar`)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".progress-bar")).toHaveCount(0);
  });
});

test.describe("remove and undo", () => {
  test("Remove says what it did, Undo puts it back, and focus stays on a row", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    const remove = page.locator(".mod-row", { hasText: "Showcase" }).locator(".delete-btn");
    await remove.click();
    await remove.click();
    const notice = page.locator(".banner", { hasText: "Removed Showcase from v26.11.1." });
    await expect(notice).toHaveCount(1);
    await expect(page.locator(".mod-row", { hasText: "Showcase" })).toHaveCount(0);
    // Focus went to the row that took its place, not to <body>.
    await expect.poll(async () => (await focused(page)).row).not.toBeNull();
    await notice.locator("button", { hasText: "Undo" }).click();
    await expect(page.locator(".banner", { hasText: "Showcase is back in v26.11.1, turned off as before." })).toHaveCount(1);
    const back = page.locator(".mod-row", { hasText: "Showcase" });
    await expect(back.locator(".toggle")).toHaveAttribute("aria-checked", "false");
    await expect.poll(async () => (await focused(page)).row).toBe("showcase");
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

  test("the version picker is a combobox over a listbox", async ({ page }) => {
    await open(page, "scenario=mods");
    const box = page.locator(".hero-play-area [role=combobox]");
    await expect(box).toHaveAttribute("aria-expanded", "false");
    await box.focus();
    await page.keyboard.press("ArrowDown");
    await expect(box).toHaveAttribute("aria-expanded", "true");
    const list = page.locator(`#${await box.getAttribute("aria-controls")}`);
    await expect(list).toHaveAttribute("role", "listbox");
    const active = await box.getAttribute("aria-activedescendant");
    await expect(list.locator(`#${active}`)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    const next = await box.getAttribute("aria-activedescendant");
    expect(next).not.toBe(active);
    await expect(list.locator("[aria-selected=true]")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(box).toHaveAttribute("aria-expanded", "false");
  });

  test("the notes toggle keeps focus and says whether it is open", async ({ page }) => {
    await open(page, "scenario=offline");
    await goToTab(page, MODS_TAB);
    const toggle = page.locator(".banner-toggle");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toBeFocused();
    await expect(page.locator(`#${await toggle.getAttribute("aria-controls")} .banner`).first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();
  });

  test("dialogs start on Cancel, keep focus inside and close on Escape", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    await page.locator(".mod-row .mod-update button").first().click();
    await expect(page.locator(dialog)).toBeVisible();
    const first = await focused(page);
    expect(first.inDialog).toBe(true);
    expect(first.text).toBe("Cancel");
    await page.evaluate(() => (document.querySelector(".tab-btn") as HTMLElement | null)?.focus());
    await expect.poll(async () => (await focused(page)).inDialog).toBe(true);
    for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
    expect((await focused(page)).inDialog).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator(dialog)).toHaveCount(0);
  });

  test("an unverified file starts in its typed confirmation, which says why Install is off", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    await page.locator(".toolbar-actions button").first().click();
    const input = page.locator(`${dialog} .dialog-actions input`);
    await expect(input).toBeFocused();
    const install = page.locator(`${dialog} .btn-danger`);
    await expect(install).toBeDisabled();
    const why = await install.getAttribute("aria-describedby");
    await expect(page.locator(`[id="${why}"]`)).toHaveText("Type mytweak to install it anyway");
    await page.keyboard.type("mytweak");
    await expect(install).toBeEnabled();
    await page.keyboard.press("Enter");
    await expect(page.locator(dialog)).toHaveCount(0, { timeout: 10_000 });
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
    await browse(page);
    await expect(page.locator(".mods-panel button", { hasText: "Retry" })).toHaveCount(1);
  });

  test("removing a source asks first, and a bad or unknown repo fails inline", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    await page.locator(".header-actions button", { hasText: "Sources" }).click();
    await page.locator(".source-row button", { hasText: "Remove" }).click();
    await expect(page.locator(".source-confirm")).toHaveCount(1);
    await page.locator(".source-confirm .btn-danger").click();
    await expect(page.locator(".source-row")).toHaveCount(1);
    const input = page.locator(`${dialog} input`);
    await input.fill("not a repo");
    await page.keyboard.press("Enter");
    await expect(page.locator(`${dialog} .inline-error`)).toContainText("Not a GitHub repo");
    await input.fill("nobody/nothing-here");
    await page.keyboard.press("Enter");
    await expect(page.locator(`${dialog} .inline-error`)).toContainText("No such GitHub repo: nobody/nothing-here");
  });
});
