const { chromium } = require("playwright");
const fs = require("fs");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    permissions: ["geolocation"],
    geolocation: { latitude: 28, longitude: 77, accuracy: 5 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const root =
    require("path").resolve(__dirname, "../srv_erp/public/smart_dsr") + "/";
  let status = "Finalized";
  const summary = () => ({
    duty: {
      name: "previous-dsr",
      status,
      work_date: "2026-11-16",
      started_at: "2026-11-16T06:00:00+05:30",
      ended_at: "2026-11-16T18:00:00+05:30",
      opening_balance: 1000,
      verified_km: 12,
      odometer_start: 100,
      odometer_end: 112,
    },
    available_cash: 850,
    activities: [
      {
        name: "visit",
        customer: "Previous Dealer",
        customer_name: "Previous Dealer",
        status: "Completed",
      },
    ],
    expenses: [{ category: "Lunch", amount: 150 }],
    events: [],
  });
  await page.route("**/api/method/**", (r) => {
    let result = {};
    const method = r.request().url().split(".").pop();
    if (method === "bootstrap")
      result = {
        employee_name: "Test",
        account: "test",
        configured: true,
        territories: [],
        vehicles: [],
        official_opening_balance: 1000,
        current: summary(),
        duties: [{ name: "previous-dsr", status, work_date: "2026-11-16" }],
      };
    if (method === "summary") result = summary();
    if (method === "finalize") {
      status = "Finalized";
      result = summary();
    }
    return r.fulfill({ json: { message: result } });
  });
  await page.route("**/reverse-geocode-client**", (r) =>
    r.fulfill({ json: { locality: "Test City" } })
  );
  await page.route("**/another-test", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fs.readFileSync(
        root + "app.css",
        "utf8"
      )}</style></head><body><div id="smart-dsr"></div><script>window.smart_dsr_user='test';window.smart_dsr_csrf='test'</script><script>${fs.readFileSync(
        root + "app.js",
        "utf8"
      )}</script></body></html>`,
    })
  );
  // Home opens the new-DSR route, but must resume unfinished work.
  for (const pendingStatus of ["Finalized", "Active", "Closed"]) {
    status = pendingStatus;
    await page.goto("http://127.0.0.1:8001/another-test#new-dsr");
    await page.reload();
    if (status === "Finalized") {
      await page.locator("#duty-form").waitFor();
      assert.equal(await page.getByText("Previous Dealer", { exact: true }).count(), 0);
    } else {
      await page.locator(".badge").filter({ hasText: status === "Active" ? "Duty ON" : "Duty OFF" }).first().waitFor();
      assert.equal(await page.locator("#duty-form").count(), 0);
      assert.equal(status, pendingStatus, "Home must not finalize pending DSRs");
    }
  }
  status = "Finalized";
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await page.goto("http://127.0.0.1:8001/another-test");
    await page
      .getByRole("button", { name: "Add another DSR", exact: true })
      .waitFor();
    assert.equal(await page.locator("#duty-form").count(), 0);
    await page.getByText("Previous Dealer", { exact: true }).waitFor();
    await page
      .locator("#dsr-expenses")
      .getByText("Lunch", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Add another DSR", exact: true })
      .click();
    await page.locator("#duty-form").waitFor();
    assert.equal(
      await page.getByText("Previous Dealer", { exact: true }).count(),
      0
    );
    await page
      .locator("#dsr-history")
      .locator('a[href="#dsr/previous-dsr"]')
      .waitFor();
    assert(
      (await page.locator(".summary-cards").textContent()).includes("850")
    );
    await page.screenshot({
      path: `/tmp/smart-dsr-screenshots/another-dsr-${width}.png`,
      fullPage: true,
    });
    await page.getByRole("link", { name: "View DSR", exact: true }).click();
    await page.getByText("Previous Dealer", { exact: true }).waitFor();
    assert.equal(await page.locator("#duty-form").count(), 0);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      ),
      true
    );
  }
  status = "Closed";
  await page.goto("http://127.0.0.1:8001/another-test");
  await page
    .getByRole("button", { name: "Add another DSR", exact: true })
    .click();
  await page.locator("#duty-form").waitFor();
  assert.equal(status, "Finalized");
  await page.addInitScript(() => {
    window.gpsClears = 0;
    Object.defineProperty(navigator, "geolocation", {
      value: {
        watchPosition(cb) {
          window.gpsCallback = cb;
          return 1;
        },
        clearWatch() {
          window.gpsClears++;
        },
      },
    });
  });
  let tracked = [];
  await page.route("**/api/method/**", (r) => {
    const method = r.request().url().split(".").pop();
    let result = {};
    if (method === "bootstrap")
      result = {
        employee_name: "Test",
        account: "test",
        configured: true,
        territories: [],
        vehicles: [],
        current: {
          ...summary(),
          duty: { ...summary().duty, name: "active-dsr", status: "Active" },
        },
        duties: [
          {
            name: "previous-dsr",
            status: "Finalized",
            work_date: "2026-11-16",
          },
        ],
      };
    if (method === "summary") result = summary();
    if (method === "gps_batch") {
      tracked.push(r.request().postDataJSON().duty);
      result = { verified_km: 15 };
    }
    return r.fulfill({ json: { message: result } });
  });
  await page.goto("http://127.0.0.1:8001/another-test");
  await page.getByRole("link", { name: "View DSR", exact: true }).click();
  await page.getByText("Previous Dealer", { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      location.hash === "#dsr/previous-dsr" &&
      document.querySelector('[data-action="another-dsr"]')
  );
  assert.equal(await page.evaluate(() => window.gpsClears), 0);
  await page.evaluate(() =>
    window.gpsCallback({
      timestamp: Date.now(),
      coords: { latitude: 28, longitude: 77, accuracy: 5 },
    })
  );
  await page.waitForTimeout(100);
  assert.deepEqual(tracked, ["active-dsr"]);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log(
    "Completed details retained; fresh DSR empty; closing cash carried forward; history opens previous DSR; Closed finalized before new DSR; desktop/mobile passed"
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
