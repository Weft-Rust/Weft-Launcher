// `npm run test:ui`: the UI against the mock backend (src/dev/mockBackend.ts) at the launcher's
// minimum window size.
//
// - Each run starts its own mock server on a free port, so a run never tests a server someone
//   else started. `PW_PORT=1450` picks the port instead; a port already in use fails the run.
// - `PW_REUSE=1` tests a server already running on `PW_PORT` (yours, e.g. while editing).
// - `PW_CHROMIUM=/path/to/chrome` uses an installed Chromium instead of
//   `npx playwright install chromium`.
import { execFileSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

// Chosen once, in the runner; the workers inherit it through the environment.
if (!process.env.PW_PORT) {
  const probe = "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})";
  process.env.PW_PORT = execFileSync(process.execPath, ["-e", probe], { encoding: "utf8" }).trim();
}
const PORT = Number(process.env.PW_PORT);
const REUSE = process.env.PW_REUSE === "1";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No retries, also in CI: a flaky test is a bug to fix, not to hide.
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 960, height: 565 },
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npx vite --mode mock --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: REUSE,
  },
});
