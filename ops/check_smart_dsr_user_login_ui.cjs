const { chromium } = require("playwright");
const fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const source = fs.readFileSync(
    path.join(__dirname, "../srv_erp/public/smart_dsr/app.js"),
    "utf8"
  );
  const expectedMetrics = [
    "Opening Balance",
    "Closing Balance",
    "Total Distance",
    "Total Time",
    "Fuel Cost",
  ];
  async function checkMetrics(page) {
    assert.deepEqual(
      await page.locator(".summary-cards .metric > span").allTextContents(),
      expectedMetrics
    );
    assert.equal(await page.locator("[data-fuel-cost]").count(), 1);
    assert.equal(
      await page.getByText("Verified KM × fuel rate", { exact: true }).count(),
      1
    );
  }
  for (const account of ["Administrator", "user@example.invalid"]) {
    const page = await browser.newPage({
      permissions: ["geolocation"],
      geolocation: { latitude: 28, longitude: 77, accuracy: 5 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let configured = true;
    await page.route("**/api/method/srv_erp.smart_dsr.api.bootstrap", (route) =>
      route.fulfill({
        json: {
          message: {
            account,
            employee_name: account,
            sales_person: null,
            territories: [],
            current: null,
            configured,
            official_opening_balance: null,
          },
        },
      })
    );
    await page.route("**/user-login-ui-test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset="utf-8"><div id="smart-dsr"></div><script>window.smart_dsr_user=${JSON.stringify(
          account
        )};window.smart_dsr_csrf='fixture';</script><script>${source}</script>`,
      })
    );
    await page.goto("http://127.0.0.1:8001/user-login-ui-test");
    await page.getByRole("heading", { name: "Duty ON / OFF" }).waitFor();
    await checkMetrics(page);
    assert.equal(await page.locator("#duty-form").count(), 1);
    assert.equal(
      await page
        .getByRole("button", { name: "Duty ON", exact: true })
        .isDisabled(),
      true
    );
    assert.equal(await page.getByRole("alert").isVisible(), false);
    configured = false;
    await page.reload();
    await page
      .getByText(
        "Please ask Administrator to configure the company in DSR Settings before starting duty."
      )
      .waitFor();
    await checkMetrics(page);
    assert.deepEqual(errors, []);
    await page.close();
  }
  await browser.close();
  console.log(
    "PASS: Administrator and salesperson fixtures render all five metrics, including Fuel Cost; missing company shows a setup notice after login. Isolated API fixtures."
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
