import { chromium } from "playwright";
const [,, query, locale, out, ...steps] = process.argv;
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 960, height: 565 } });
await page.addInitScript((l) => localStorage.setItem("locale", l), locale);
await page.goto(`http://127.0.0.1:1442/?${query}`);
await page.waitForTimeout(1200);
for (const s of steps) {
  if (s.startsWith("tab:")) await page.locator(".tab-btn").nth(Number(s.slice(4))).click();
  else if (s === "browse") await page.locator(".switch [role=tab]").nth(1).click();
  else if (s.startsWith("click:")) await page.locator(s.slice(6)).first().click();
  else if (s.startsWith("wait:")) await page.waitForTimeout(Number(s.slice(5)));
  await page.waitForTimeout(500);
}
await page.screenshot({ path: out });
await browser.close();
