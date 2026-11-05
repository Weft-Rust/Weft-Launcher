// The flows the mod manager's safety depends on, and keyboard use, against the mock backend.
import { expect, test, type Page } from "@playwright/test";
import { LOCALES, MODS_TAB, browse, cutButtons, focused, fullRows, goToTab, open, spoken, tops } from "./helpers";

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

  test("a crash notice for a mod with a copy in the player's folder stays until that copy goes", async ({ page }) => {
    await open(page, "scenario=crash&shadow=structures");
    await page.locator(".btn-play").click();
    const notice = page.locator(".mod-failure");
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice.getByTestId("crash-shadow")).toContainText("structures-old.zip");
    // Turning off the launcher's copy doesn't fix it: the player's own copy loads instead.
    await notice.locator("button", { hasText: "Turn off" }).click();
    await expect(notice).toHaveCount(1);
    await expect(notice.getByTestId("crash-shadow")).toContainText("still has structures-old.zip");
    // The player opens their folder and deletes it; back in the launcher, the notice goes.
    await notice.locator("button", { hasText: "Open mods folder" }).click();
    await page.evaluate(() => (window as unknown as { mockPlayer: { deleteFile(f: string): void } }).mockPlayer.deleteFile("structures-old.zip"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(notice).toHaveCount(0);
  });

  test("a missing-dependency crash names the dependency and turns it on", async ({ page }) => {
    await open(page, "scenario=crash&crash=missingDep");
    await page.locator(".btn-play").click();
    const notice = page.locator(".mod-failure");
    await expect(notice.locator(".mod-failure-title")).toHaveText("My Tweak stopped Weft from starting: it needs Cogwork.", { timeout: 10_000 });
    await expect(notice.locator("button", { hasText: "Update" })).toHaveCount(0);
    await notice.locator("button", { hasText: "Turn on Cogwork" }).click();
    // Fixed, so the notice goes: on Home and on Mods.
    await expect(page.locator(".mod-failure")).toHaveCount(0);
    await goToTab(page, MODS_TAB);
    await expect(page.locator(".mod-row", { hasText: "Cogwork" }).locator(".toggle")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(".mod-failure")).toHaveCount(0);
  });

  test("Home shows a blocker the backend found at Play, with its fixes", async ({ page }) => {
    await open(page, "scenario=lateblock");
    await expect(page.locator(".blocker")).toHaveCount(0);
    await page.locator(".btn-play").click();
    const hearth = page.locator(".blocker", { hasText: "Hearth" });
    await expect(hearth).toContainText("Needs Cogwork, which was pulled from the index.");
    // It appeared just now, so it is said at once.
    await expect(page.locator(".blockers [role=alert]")).toContainText("Hearth");
    await expect(page.locator(".btn-play")).toBeDisabled();
    // The panel says it; no second, rawer copy of the error.
    await expect(page.locator(".hero > .launch-error[role=alert]")).toHaveCount(0);
    await hearth.locator("button", { hasText: "Turn off Hearth" }).click();
    await expect(page.locator(".btn-play")).toBeEnabled();
    // Nothing of the refused start is left once it is fixed.
    await expect(page.locator(".blocker")).toHaveCount(0);
    await expect(page.locator(".launch-error")).toHaveCount(0);
  });

  test("turning off a mod with a copy in the player's own folder says that copy loads", async ({ page }) => {
    await open(page, "scenario=mods&shadow=structures");
    await goToTab(page, MODS_TAB);
    await page.locator(".mod-row[data-mod=structures] .toggle").click();
    const notice = page.locator(".banner", { hasText: "Turned off Structures." });
    await expect(notice).toContainText("Your own mods folder has a copy of Structures (structures-old.zip), so the game loads that one instead.");
    await expect(spoken(page)).toContainText("structures-old.zip");
    await expect(page.locator(".mod-row[data-mod=structures]")).toHaveAttribute("data-shadowed", "true");
  });

  test("a revoked mod copied in the player's own folder blocks until that file goes", async ({ page }) => {
    await open(page, "scenario=shadowed");
    await expect(page.locator(".btn-play")).toBeDisabled();
    await goToTab(page, MODS_TAB);
    const blocker = page.locator(".blockers.in-banner .blocker", { hasText: "cogwork-old.zip" });
    await blocker.locator("button", { hasText: "Show cogwork-old.zip" }).click();
    // Showing the folder alone changes nothing.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(300);
    await expect(blocker).toHaveCount(1);
    // The player deletes it in the folder that opened; back in the launcher, it looks again.
    await page.evaluate(() => (window as unknown as { mockPlayer: { deleteFile(f: string): void } }).mockPlayer.deleteFile("cogwork-old.zip"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(blocker).toHaveCount(0);
    await expect(page.locator(".mod-row[data-mod=cogwork]")).not.toHaveAttribute("data-shadowed", "true");
  });
});

test.describe("every install shows what it does", () => {
  test("an update opens the review dialog, warning first", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    await page.locator(".mod-row .update-btn-row").first().click();
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
    await d.locator(".dialog-actions .btn-primary", { hasText: "Copy 4 mods to v26.11.1" }).click();
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
    // Cogwork is installed: the title and the button both say Update.
    await expect(d.locator(".dialog-title")).toHaveText("Update Cogwork to 0.2.0 for v26.11.1 from this file?");
    await expect(d.locator(".checks li", { hasText: "Same file as Cogwork 0.2.0" })).toHaveClass(/check-yes/);
    await expect(d.locator(".dialog-actions .btn-primary")).toHaveText("Update");
  });

  test("a file whose fit can't be found out says unknown, with Retry, never no", async ({ page }) => {
    await open(page, "scenario=knownfile&abi=error");
    await goToTab(page, MODS_TAB);
    await page.locator(".toolbar-actions button").first().click();
    const d = page.locator(dialog);
    const fit = d.locator(".checks li").first();
    await expect(fit).toHaveAttribute("data-check", "abi");
    await expect(fit).toHaveClass(/check-unknown/);
    await expect(fit).toContainText("Whether it fits v26.11.1 couldn't be checked");
    await expect(d.locator(".checks li.check-no")).toHaveCount(0);
    await expect(d.locator(".dialog-actions .btn-primary")).toBeDisabled();
    await fit.locator("button", { hasText: "Retry" }).click();
    await expect(d.locator(".checks li").first()).toHaveClass(/check-unknown/);
  });

  test("installing a mod that needs mods that need others turns the whole chain on", async ({ page }) => {
    await open(page, "scenario=chain");
    await goToTab(page, MODS_TAB);
    await browse(page);
    await page.locator(".mod-card", { hasText: "Chimneys" }).locator("button.btn-primary").click();
    const d = page.locator(dialog);
    await expect(d.locator(".checks li", { hasText: "Needs Hearth: turns it on too" })).toHaveClass(/check-yes/);
    await expect(d.locator(".checks li", { hasText: "Needs Cogwork: turns it on too" })).toHaveClass(/check-yes/);
    await d.locator(".dialog-actions .btn-primary").click();
    await expect(d).toHaveCount(0, { timeout: 15_000 });
    await page.locator(".switch [role=tab]").first().click();
    for (const name of ["Chimneys", "Hearth", "Cogwork"]) {
      await expect(page.locator(".mod-row", { has: page.locator(".mod-name", { hasText: name }) }).locator(".toggle")).toHaveAttribute("aria-checked", "true");
    }
  });

  test("an update keeps a mod that is off turned off", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    const row = page.locator(".mod-row", { hasText: "Structures" });
    const toggle = row.locator(".toggle");
    if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await row.locator(".update-btn-row").click();
    await page.locator(`${dialog} .dialog-actions .btn-primary`).click();
    await expect(page.locator(dialog)).toHaveCount(0, { timeout: 15_000 });
    await expect(row.locator(".toggle")).toHaveAttribute("aria-checked", "false");
  });

  test("the install button doesn't flicker while the set and the catalogue load again", async ({ page }) => {
    await open(page, "scenario=mods");
    // The button's state every frame from the moment the dialog shows.
    await page.evaluate(() => {
      const w = window as unknown as { seq: string[] };
      w.seq = [];
      const tick = () => {
        const b = document.querySelector<HTMLButtonElement>("[role=dialog] .dialog-actions .btn-primary");
        if (b) w.seq.push(b.disabled ? "D" : "e");
        requestAnimationFrame(tick);
      };
      tick();
    });
    await goToTab(page, MODS_TAB);
    // As early as it can be opened: the catalogue and every set are still being read again.
    await page.locator(".mod-row", { hasText: "Lanterns" }).locator(".update-btn-row").click();
    const button = page.locator(`${dialog} .dialog-actions .btn-primary`);
    await expect(button).toBeEnabled();
    await page.waitForTimeout(1500);
    // A refresh from the header brings the same plan again: nothing changes either.
    await page.evaluate(() => (document.querySelector(".btn-refresh") as HTMLButtonElement | null)?.click());
    await page.waitForTimeout(800);
    const seq = await page.evaluate(() => (window as unknown as { seq: string[] }).seq.join(""));
    // Off until the first plan, then on for good.
    expect(seq.replace(/(.)\1*/g, "$1"), "enabled, disabled, enabled again").toBe("De");
    // A click the moment it is enabled starts the install.
    await button.click();
    await expect(page.locator(`${dialog} .progress-bar`)).toHaveCount(1);
  });

  test("a failed dependency download leaves no progress behind", async ({ page }) => {
    await open(page, "scenario=mods&fail=dep");
    await goToTab(page, MODS_TAB);
    await page.locator(".mod-row", { hasText: "Lanterns" }).locator(".update-btn-row").click();
    await page.locator(`${dialog} .dialog-actions .btn-primary`).click();
    await expect(page.locator(`${dialog} .inline-error`)).toContainText("gone from GitHub", { timeout: 15_000 });
    await expect(page.locator(`${dialog} .progress-bar`)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".progress-bar")).toHaveCount(0);
  });
});

/** Opens the update of Lanterns (1.0.0 → 1.1.0, which brings Glowmoss along). */
async function updateLanterns(page: Page, query: string) {
  await open(page, query);
  await goToTab(page, MODS_TAB);
  await page.locator(".mod-row", { hasText: "Lanterns" }).locator(".update-btn-row").click();
  await expect(page.locator(`${dialog} .checks`)).toBeVisible();
  return page.locator(dialog);
}

test.describe("operations", () => {
  test("progress names the file, and Cancel stops it calmly with nothing changed", async ({ page }) => {
    const d = await updateLanterns(page, "scenario=mods&slow=1");
    await d.locator(".dialog-actions .btn-primary").click();
    // As the backend works: the build asked for first, then what it needs. File 1 of 2.
    await expect(d.locator(".progress-label")).toHaveText(/^File 1 of 2: Lanterns, downloading \d+%/);
    await d.locator(".progress-cancel").click();
    await expect(d.getByTestId("cancelled-note")).toHaveText("Cancelled. Nothing was changed.", { timeout: 15_000 });
    await expect(d.locator(".inline-error, [role=alert]")).toHaveCount(0);
    await expect(spoken(page)).toHaveText("Cancelled. Nothing was changed.");
    await expect(d.locator(".progress-bar")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".mod-row[data-mod=lanterns] .mod-version")).toHaveText("1.0.0");
    await expect(page.locator(".mod-row[data-mod=glowmoss]")).toHaveCount(0);
    await expect(page.locator(".progress-bar")).toHaveCount(0);
  });

  test("a set that changed meanwhile is planned again, shown, and asked again", async ({ page }) => {
    const d = await updateLanterns(page, "scenario=mods&fail=meanwhile");
    await d.locator(".dialog-actions .btn-primary").click();
    const changes = d.getByTestId("plan-changes");
    await expect(changes).toContainText("This changed since you looked:");
    await expect(changes).toContainText("Glowmoss 0.3.1 instead of 0.3.0");
    await expect(d.locator(".checks li", { hasText: "Needs Glowmoss: installs 0.3.1 with it" })).toHaveCount(1);
    // Asked again: nothing ran, and the button works on the new plan.
    await expect(d.locator(".progress-bar")).toHaveCount(0);
    await d.locator(".dialog-actions .btn-primary").click();
    await expect(d).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(".mod-row[data-mod=glowmoss] .mod-version")).toHaveText("0.3.1");
  });
});

test.describe("announcements", () => {
  test("results are said politely; only blockers that appear are said assertively", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    // Every assertive region belongs to a blocker panel.
    const alerts = page.locator("[role=alert]");
    for (const a of await alerts.all()) expect(await a.evaluate((e) => !!e.closest(".blockers"))).toBe(true);
    const said = await alerts.allTextContents();
    // A plain toggle is said by the switch itself; a result with more to it goes to the live region.
    const remove = page.locator(".mod-row[data-mod=showcase] .delete-btn");
    await remove.click();
    await remove.click();
    await expect(spoken(page)).toContainText("Removed Showcase from v26.11.1.");
    // The blockers didn't change, so nothing is said about them again.
    expect(await alerts.allTextContents()).toEqual(said);
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

  test("arrows move from the tab that has focus, not the one selected", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    // Mods is selected; focus is on Home.
    await page.locator(".tab-btn").first().focus();
    await page.keyboard.press("ArrowRight");
    expect((await focused(page)).text).toMatch(/^Versions/);
    await page.keyboard.press("ArrowLeft");
    expect((await focused(page)).text).toMatch(/^Home/);
  });

  test("Tab and Shift+Tab go through an error's Details inside a dialog, in order", async ({ page }) => {
    await open(page, "scenario=mods&fail=sources");
    await goToTab(page, MODS_TAB);
    await page.locator(".header-actions button", { hasText: "Sources" }).click();
    const summary = page.locator(`${dialog} .inline-error summary`);
    await expect(summary).toBeVisible();
    // The dialog's tab stops in document order.
    const stops = await page.locator(dialog).evaluate((d) =>
      [...d.querySelectorAll<HTMLElement>("button, input, summary, [href], [tabindex]")]
        .filter((e) => e.tabIndex >= 0 && !(e as HTMLButtonElement).disabled && e.getClientRects().length > 0)
        .map((e) => e.textContent?.trim() || e.getAttribute("placeholder") || e.tagName)
    );
    const at = stops.indexOf("Details");
    expect(at, "Details is a tab stop").toBeGreaterThan(0);
    const name = () => page.evaluate(() => { const a = document.activeElement as HTMLElement; return a.textContent?.trim() || a.getAttribute("placeholder") || a.tagName; });
    await summary.focus();
    await page.keyboard.press("Tab");
    expect(await name()).toBe(stops[at + 1]);
    await page.keyboard.press("Shift+Tab");
    expect(await name()).toBe("Details");
    await page.keyboard.press("Shift+Tab");
    expect(await name()).toBe(stops[at - 1]);
    // All the way round, forward, through Details and back to where it started.
    await summary.focus();
    const seen: string[] = [];
    for (let i = 0; i < stops.length; i++) {
      await page.keyboard.press("Tab");
      seen.push(await name());
    }
    expect(seen.at(-1)).toBe("Details");
    expect(new Set(seen).size).toBe(stops.length);
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
    await page.locator(".mod-row .update-btn-row").first().click();
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

  test("an unverified file starts in its typed confirmation, which says why Replace is off", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    await page.locator(".toolbar-actions button").first().click();
    const input = page.locator(`${dialog} .dialog-actions input`);
    await expect(input).toBeFocused();
    // My Tweak is installed: the title, the button and the hint all say Replace.
    await expect(page.locator(`${dialog} .dialog-title`)).toHaveText("Replace My Tweak with unverified mytweak.zip for v26.11.1?");
    const install = page.locator(`${dialog} .btn-danger`);
    await expect(install).toHaveText("Replace anyway");
    await expect(install).toBeDisabled();
    const why = await install.getAttribute("aria-describedby");
    await expect(page.locator(`[id="${why}"]`)).toHaveText("Type mytweak to replace it anyway");
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
  test("Sources says how old the index signature is, and why a source couldn't be refreshed", async ({ page }) => {
    await open(page, "scenario=stale&source=ratelimited");
    await goToTab(page, MODS_TAB);
    await page.locator(".header-actions button", { hasText: "Sources" }).click();
    await expect(page.getByTestId("index-meta")).toContainText(/signed Sep 21: revocations since then may be missing/);
    const index = page.locator(".source-row").first();
    // The index has its own state, never a mod's green Reviewed: signed, and amber when old.
    await expect(index.locator(".badge[class*=trust-]")).toHaveCount(0);
    await expect(index.locator(".index-badge")).toHaveClass(/stale/);
    await expect(index.locator(".index-badge")).toHaveText("Signed Sep 21 · may be out of date");
    await expect(index.locator("button", { hasText: "Retry" })).toHaveCount(1);
    const source = page.locator(".source-row", { hasText: "lantern-dev/lanterns" });
    await expect(source).toContainText("GitHub is limiting requests, so lantern-dev/lanterns couldn't be refreshed.");
    await expect(source.locator("button", { hasText: "Retry" })).toHaveCount(1);
  });

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

test.describe("sources", () => {
  test("a fresh index is signed and verified, not Reviewed", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    await page.locator(".header-actions button", { hasText: "Sources" }).click();
    const badge = page.locator(".source-row").first().locator(".index-badge");
    await expect(badge).toHaveClass(/ok/);
    await expect(badge).toHaveText("Signed · verified Nov 4");
    await expect(page.locator(`${dialog} .trust-reviewed`)).toHaveCount(0);
  });

  test("a source added is checked while the dialog is open, and one with no mods says why", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    await page.locator(".header-actions button", { hasText: "Sources" }).click();
    await page.locator(`${dialog} input`).fill("glow-team/fireflies");
    await page.keyboard.press("Enter");
    const row = page.locator(".source-row[data-repo='glow-team/fireflies']");
    await expect(row).toHaveCount(1);
    // Before Close: what GitHub has there, and what a source needs.
    await expect(row.getByTestId("source-meta")).toHaveText(
      "No compatible mod releases found: no release has an <id>.zip with its <id>.mod.json. What a source needs",
      { timeout: 10_000 }
    );
    await expect(row.getByTestId("source-meta")).toHaveClass(/warn/);
    await expect(row.locator(".link-btn", { hasText: "What a source needs" })).toHaveCount(1);
  });

  test("a damaged list of sources is kept and said, and a new one can be started", async ({ page }) => {
    await open(page, "scenario=mods&fail=sources");
    await goToTab(page, MODS_TAB);
    // Said on the Mods tab too, never shown as "no sources".
    await browse(page);
    const toggle = page.locator(".banner-toggle");
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
    await expect(page.locator(".banner-group .banner", { hasText: "Your list of sources couldn't be read" })).toHaveCount(1);
    await page.locator(".header-actions button", { hasText: "Sources" }).click();
    const d = page.locator(dialog);
    await expect(d.locator(".inline-error")).toContainText("Your list of mod sources couldn't be read, so it was set aside and kept.");
    await d.locator(".inline-error summary").click();
    await expect(d.locator(".inline-error code")).toContainText("sources.damaged-");
    await d.locator("input").fill("lantern-dev/lanterns");
    await page.keyboard.press("Enter");
    await expect(d.locator(".source-row[data-repo='lantern-dev/lanterns']")).toHaveCount(1);
    await expect(d.locator(".inline-error")).toHaveCount(0);
  });
});

test.describe("results never move the list", () => {
  const FIXED = [".mods-page .version-select", ".switch", ".banners", ".mods-panel"];
  for (const locale of LOCALES) {
    test(`a result is a toast over the list, which keeps its place and room for its last row, in ${locale}`, async ({ page }) => {
      // The busiest Installed: a blocker with a pager, the folded notes, and then a result.
      await open(page, "scenario=shadowed", locale);
      await goToTab(page, MODS_TAB);
      await expect(page.locator(".mod-row").first()).toBeVisible();
      const before = await tops(page, FIXED);
      const remove = page.locator(".mod-row[data-mod=structures] .delete-btn");
      await remove.click();
      await remove.click();
      const toast = page.locator(".toasts .toast");
      await expect(toast).toHaveCount(1);
      // Nothing above the list moved, nor its first row.
      expect(await tops(page, FIXED)).toEqual(before);
      expect(await cutButtons(page, ".toasts"), "toast buttons in view").toEqual([]);
      // Scrolled to its end, the last row's buttons are clear of the toast.
      await page.locator(".mods-panel").evaluate((e) => (e.scrollTop = e.scrollHeight));
      expect(await cutButtons(page, ".mod-row:last-child"), "the last row's buttons").toEqual([]);
    });
  }

  test("an install keeps the version picker and the switch where they are", async ({ page }) => {
    await open(page, "scenario=mods");
    await goToTab(page, MODS_TAB);
    await expect(page.locator(".mod-row").first()).toBeVisible();
    const before = await tops(page, FIXED);
    await page.locator(".mod-row[data-mod=structures] .update-btn-row").click();
    await page.locator(`${dialog} .dialog-actions .btn-primary`).click();
    await expect(page.locator(dialog)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(".toasts .toast")).toHaveCount(1);
    expect(await tops(page, FIXED)).toEqual(before);
    await page.locator(".mods-panel").evaluate((e) => (e.scrollTop = 0));
    expect(await fullRows(page)).toBeGreaterThanOrEqual(3);
  });
});
