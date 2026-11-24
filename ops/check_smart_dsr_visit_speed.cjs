const { chromium } = require("playwright");
const fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    for (const stale of [false]) {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript((stale) => {
        window.locationAttempts = [];
        Object.defineProperty(navigator, "geolocation", {
          value: {
            getCurrentPosition(ok, fail, options) {
              window.locationAttempts.push(options);
              ok({
                timestamp: Date.now() - (stale ? 60000 : 1000),
                coords: { latitude: 28, longitude: 77, accuracy: 10 },
              });
            },
            watchPosition() {
              return 1;
            },
            clearWatch() {},
          },
        });
      }, stale);
      const duty = {
        name: "duty-test",
        status: "Active",
        started_at: "2026-11-18 09:00:00",
        verified_km: 0,
      };
      let arrived = false,
        bootstraps = 0,
        detailsWhileBootstrapPending = false,
        pendingBootstrap = false;
      await page.route("**/api/method/srv_erp.smart_dsr.api.*", async (r) => {
        const method = r.request().url().split(".").pop();
        let message = {};
        if (method === "bootstrap") {
          bootstraps++;
          pendingBootstrap = true;
          await new Promise((resolve) => setTimeout(resolve, 150));
          pendingBootstrap = false;
          message = {
            account: "user",
            employee_name: "User",
            territories: [],
            current: { duty, activities: [], events: [] },
          };
        }
        if (method === "search_dealers")
          message = [
            { name: "dealer", customer_name: "Dealer", territory: "Test" },
          ];
        if (method === "dealer_arrival") {
          arrived = true;
          message = "visit-test";
        }
        if (method === "visit_details") {
          detailsWhileBootstrapPending = pendingBootstrap;
          message = {
            visit: { name: "visit-test", duty: duty.name, status: "Open" },
            dealer: { customer_name: "Dealer" },
            photos: [],
            orders: [],
            collections: [],
            outstanding: { currency: "INR", overdue: 0 },
          };
        }
        await r.fulfill({ json: { message } });
      });
      const source = fs.readFileSync(
        path.join(__dirname, "../srv_erp/public/smart_dsr/app.js"),
        "utf8"
      );
      await page.route("**/visit-speed-test", (r) =>
        r.fulfill({
          contentType: "text/html",
          body: `<meta charset="utf-8"><div id="smart-dsr"></div><script>${source}</script>`,
        })
      );
      await page.goto("http://localhost/visit-speed-test");
      await page
        .getByRole("button", { name: "+ Add Visit", exact: true })
        .click();
      await page.locator('[data-customer="dealer"]').click();
      await page.waitForFunction(
        () => !document.querySelector("#smart-dsr").hasAttribute("aria-busy")
      );
      assert.equal(
        await page.evaluate(() => window.locationAttempts.length),
        0
      );
      await page
        .getByRole("button", { name: "Open Camera", exact: true })
        .waitFor();
      assert.equal(arrived, true);
      assert.equal(bootstraps, 2);
      assert.equal(
        detailsWhileBootstrapPending,
        true,
        "visit details should load alongside bootstrap"
      );
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log(
      "PASS: dealer selection skips GPS; visit requests run concurrently. Mocked browser/API fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
