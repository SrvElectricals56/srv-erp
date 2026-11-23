const { chromium } = require("playwright");
const fs = require("fs");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  let active = true,
    interruptions = 0;
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.watchers = [];
    window.permission = {
      state: "granted",
      listeners: [],
      addEventListener(type, cb) {
        this.listeners.push(cb);
      },
    };
    Object.defineProperty(navigator, "permissions", {
      value: { query: async () => window.permission },
    });
    Object.defineProperty(navigator, "geolocation", {
      value: {
        watchPosition(ok, fail, options) {
          window.watchers.push({ ok, fail, options });
          return window.watchers.length;
        },
        clearWatch() {},
        getCurrentPosition(ok) {
          ok({
            coords: { latitude: 28, longitude: 77, accuracy: 5 },
            timestamp: Date.now(),
          });
        },
      },
    });
  });
  const root =
    require("path").resolve(__dirname, "../srv_erp/public/smart_dsr") + "/";
  await page.route("**/api/method/**", (r) => {
    const method = r.request().url().split(".").pop();
    let result = {};
    if (method === "bootstrap")
      result = {
        employee_name: "Test",
        account: "test",
        configured: true,
        vehicles: [],
        territories: [],
        current: active
          ? {
              duty: {
                name: "duty",
                status: "Active",
                work_date: "2026-11-17",
                started_at: new Date().toISOString(),
              },
              activities: [],
              expenses: [],
            }
          : null,
      };
    if (method === "gps_interruption") interruptions++;
    if (method === "gps_batch")
      result = { verified_km: 0, gps_status: "Tracking" };
    return r.fulfill({ json: { message: result } });
  });
  await page.route("**/warning-test", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<html><head><meta charset="utf-8"><style>${fs.readFileSync(
        root + "app.css",
        "utf8"
      )}</style></head><body><div id="smart-dsr"></div><script>window.smart_dsr_user='test';window.smart_dsr_csrf='test'</script><script>${fs.readFileSync(
        root + "app.js",
        "utf8"
      )}</script></body></html>`,
    })
  );
  await page.goto("http://127.0.0.1:8001/warning-test");
  await page.waitForFunction(() => window.watchers.length === 1);
  await page.evaluate(() =>
    window.watchers[0].ok({
      coords: { latitude: 28, longitude: 77, accuracy: 5 },
      timestamp: Date.now(),
    })
  );
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    window.permission.state = "denied";
    window.permission.listeners.forEach((cb) => cb());
  });
  await page.locator("#location-required").waitFor({ state: "visible" });
  assert(
    (await page.locator("#location-required").textContent()).includes(
      "your duty is ON"
    )
  );
  await page.evaluate(() => window.watchers[0].fail({ code: 1 }));
  await page.waitForTimeout(100);
  assert.equal(interruptions, 1);
  await page.evaluate(() => {
    window.permission.state = "granted";
    window.permission.listeners.forEach((cb) => cb());
  });
  await page.waitForFunction(() => window.watchers.length === 2);
  await page.evaluate(() =>
    window.watchers[1].ok({
      coords: { latitude: 28, longitude: 77, accuracy: 5 },
      timestamp: Date.now(),
    })
  );
  await page.locator("#location-required").waitFor({ state: "hidden" });
  await page.evaluate(() => window.watchers[1].fail({ code: 1 }));
  await page.locator("#location-required").waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "Retry Location", exact: true })
    .click();
  await page.locator("#location-required").waitFor({ state: "hidden" });
  await page.evaluate(() => window.watchers.at(-1).fail({ code: 1 }));
  await page.locator("#location-required").waitFor({ state: "visible" });
  active = false;
  await page.evaluate(() => (location.hash = "new-dsr"));
  await page.locator("#duty-form").waitFor();
  await page.locator("#location-required").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  await browser.close();
  console.log(
    "Immediate permission warning, recent-fix revocation, audit deduplication, recovery, retry and duty-off clearing passed"
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
