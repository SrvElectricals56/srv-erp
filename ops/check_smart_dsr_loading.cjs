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
    const source = fs.readFileSync(
      path.join(__dirname, "../srv_erp/public/smart_dsr/app.js"),
      "utf8"
    );
    const css = fs.readFileSync(
      path.join(__dirname, "../srv_erp/public/smart_dsr/app.css"),
      "utf8"
    );
    for (const initialFailure of [false, true]) {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() =>
        Object.defineProperty(navigator, "geolocation", {
          value: {
            getCurrentPosition(ok) {
              ok({
                timestamp: Date.now(),
                coords: { latitude: 28, longitude: 77, accuracy: 10 },
              });
            },
            watchPosition() {
              return 1;
            },
            clearWatch() {},
          },
        })
      );
      await page.route("**/api/method/srv_erp.smart_dsr.api.*", async (r) => {
        const method = r.request().url().split(".").pop();
        let message = {};
        if (method === "bootstrap") {
          await new Promise((resolve) => setTimeout(resolve, 600));
          if (initialFailure)
            return r.fulfill({
              status: 500,
              json: { exc: 1, message: "Could not load workday" },
            });
          message = {
            account: "user",
            employee_name: "User",
            territories: [],
            current: {
              duty: { name: "duty", status: "Active" },
              activities: [],
              events: [],
            },
          };
        }
        if (method === "search_dealers")
          message = [{ name: "dealer", customer_name: "Dealer" }];
        if (method === "dealer_arrival") {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return r.fulfill({
            status: 500,
            json: { exc: 1, message: "Dealer could not be opened" },
          });
        }
        return r.fulfill({ json: { message } });
      });
      await page.route("**/loading-test", (r) =>
        r.fulfill({
          contentType: "text/html",
          body: `<meta charset="utf-8"><style>${css}</style><div id="smart-dsr"></div><script>${source}</script>`,
        })
      );
      await page.goto("http://localhost/loading-test");
      await page.locator("#dsr-loading").waitFor({ state: "visible" });
      const box = await page.locator(".dsr-spinner").boundingBox();
      assert.ok(Math.abs(box.x + box.width / 2 - 195) < 2);
      assert.ok(Math.abs(box.y + box.height / 2 - 422) < 40);
      await page.locator("#dsr-loading").waitFor({ state: "hidden" });
      if (initialFailure) {
        assert.equal(
          await page.locator("main > :first-child").getAttribute("id"),
          "dsr-error"
        );
        assert.match(
          await page.locator("#dsr-error").innerText(),
          /Could not load workday/
        );
      } else {
        await page
          .getByRole("button", { name: "+ Add Visit", exact: true })
          .click();
        await page.locator('[data-customer="dealer"]').click();
        await page.locator("#dsr-loading").waitFor({ state: "visible" });
        assert.equal(
          await page
            .locator("#dsr-loading")
            .evaluate((n) => n.matches(":popover-open")),
          true
        );
        await page.locator("#dsr-loading").waitFor({ state: "hidden" });
        assert.match(
          await page.locator("#dsr-dialog > :first-child").innerText(),
          /Dealer could not be opened/
        );
        assert.equal(
          await page.locator("main > :first-child").getAttribute("id"),
          "dsr-error"
        );
        assert.match(
          await page.locator("#dsr-error").innerText(),
          /Dealer could not be opened/
        );
        assert.equal(
          await page.locator('[data-customer="dealer"]').isEnabled(),
          true
        );
        assert.equal(await page.evaluate(() => window.scrollY), 0);
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log(
      "PASS: centered spinner during initial load and dealer action; spinner clears on failure; errors at page/dialog top; failed action remains retryable. Mocked browser/API fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
