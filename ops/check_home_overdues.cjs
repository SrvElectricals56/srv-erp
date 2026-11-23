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
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let failure = false;
    let rows = [
      {
        customer: "A",
        customer_name: "Alpha Dealer",
        territory: "North",
        currency: "INR",
        overdue_amount: 100,
        entry_count: 2,
        days_overdue: 10,
        oldest_due_date: "2026-11-11",
      },
      {
        customer: "B",
        customer_name: "Beta Party",
        territory: "South",
        currency: "INR",
        overdue_amount: 300,
        entry_count: 3,
        days_overdue: 45,
        oldest_due_date: "2026-10-07",
      },
      {
        customer: "C",
        customer_name: "Gamma Dealer",
        territory: "North",
        currency: "USD",
        overdue_amount: 50,
        entry_count: 4,
        days_overdue: 95,
        oldest_due_date: "2026-08-18",
      },
      ...Array.from({ length: 51 }, (_, index) => ({
        customer: "E" + index,
        customer_name: "Extra Dealer " + index,
        territory: "North",
        currency: "INR",
        overdue_amount: 10,
        entry_count: 1,
        days_overdue: 5,
        oldest_due_date: "2026-11-16",
      })),
    ];
    await page.route("**/api/method/**", (route) => {
      const method = route.request().url().split(".").pop();
      if (method === "bootstrap")
        return route.fulfill({
          json: {
            message: {
              employee_name: "Salesperson",
              current: null,
              duties: [],
              configured: true,
              currency: "INR",
            },
          },
        });
      if (method === "outstanding")
        return route.fulfill({
          json: {
            message: {
              dealer: { customer_name: "Alpha Dealer" },
              entries: [
                {
                  name: "ENTRY-A",
                  due_date: "2026-11-11",
                  outstanding_amount: rows[0].overdue_amount,
                  currency: "INR",
                  days_overdue: 10,
                },
                {
                  name: "FUTURE",
                  due_date: "2026-12-01",
                  outstanding_amount: 80,
                  currency: "INR",
                  days_overdue: 0,
                },
                {
                  name: "FOREIGN",
                  due_date: "2026-11-01",
                  outstanding_amount: 55,
                  currency: "USD",
                  days_overdue: 20,
                },
              ],
            },
          },
        });
      assert.equal(method, "allocated_dealer_overdues");
      return route.fulfill(
        failure
          ? { status: 500, json: { message: "Refresh unavailable" } }
          : { json: { message: { rows, totals: { INR: 910, USD: 50 } } } }
      );
    });
    const asset = path.join(__dirname, "../srv_erp/public/smart_dsr");
    await page.route("**/overdues-test*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fs.readFileSync(
          asset + "/app.css",
          "utf8"
        )}</style><div id="smart-dsr"></div><script>${fs.readFileSync(
          asset + "/overdues-page.js",
          "utf8"
        )}</script><script>${fs.readFileSync(
          asset + "/app.js",
          "utf8"
        )}</script>`,
      })
    );
    await page.goto("http://localhost/overdues-test?section=overdues");
    const view = page.locator(".dsr-overdues-page");
    await view
      .getByRole("heading", { name: "Party Overdues", exact: true })
      .waitFor();
    assert.equal(
      await page
        .locator(
          ".workday-heading,#duty-form,#night-stay,#dsr-expenses,#dsr-history"
        )
        .count(),
      0
    );
    assert.equal(await view.locator("tbody tr").count(), 50);
    const widths = await view
      .locator("thead th")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().width)
      );
    assert.ok(
      widths.every((width) => width >= 60),
      "Every desktop column must have readable width"
    );
    assert.match(
      await view.locator(".overdue-page-totals").innerText(),
      /910\.00/
    );
    assert.match(
      await view.locator(".overdue-page-totals").innerText(),
      /50\.00/
    );
    await view.getByRole("button", { name: "Next", exact: true }).click();
    assert.equal(await view.locator("tbody tr").count(), 4);
    await view.getByRole("searchbox").fill("ALPHA");
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    assert.equal(await view.locator("tbody tr").count(), 1);
    await view.getByRole("button", { name: "View Dues", exact: true }).click();
    await page.locator("#dsr-dialog[open]").waitFor();
    assert.match(await page.locator("#dsr-dialog").innerText(), /ENTRY-A/);
    assert.doesNotMatch(
      await page.locator("#dsr-dialog").innerText(),
      /FUTURE|FOREIGN/
    );
    await page.locator("#dsr-dialog [data-close]").click();
    await view
      .getByRole("button", { name: "Clear Filters", exact: true })
      .click();
    assert.equal(
      await view.locator("[name=territory],[name=currency]").count(),
      0
    );
    assert.equal(
      await view
        .getByRole("columnheader", { name: "Territory", exact: true })
        .count(),
      0
    );
    await view
      .getByLabel("Days Overdue", { exact: true })
      .selectOption("31-60");
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    assert.match(await view.locator("tbody").innerText(), /Beta Party/);
    await view
      .getByRole("button", { name: "Clear Filters", exact: true })
      .click();
    await view.getByLabel("Minimum Overdue", { exact: true }).fill("200");
    await view.getByLabel("Maximum Overdue", { exact: true }).fill("400");
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    assert.equal(await view.locator("tbody tr").count(), 1);
    await view.getByLabel("Minimum Overdue", { exact: true }).fill("500");
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    assert.equal(
      await view
        .getByLabel("Maximum Overdue", { exact: true })
        .evaluate((input) => input.validity.customError),
      true
    );
    await view
      .getByRole("button", { name: "Clear Filters", exact: true })
      .click();
    await view.getByRole("searchbox").fill("Alpha");
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    rows[0].overdue_amount = 75;
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    await view
      .locator(".overdue-page-totals")
      .filter({ hasText: "75.00" })
      .waitFor();
    assert.equal(await view.getByRole("searchbox").inputValue(), "Alpha");
    failure = true;
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    await view
      .getByRole("alert")
      .filter({ hasText: "Refresh unavailable" })
      .waitFor();
    failure = false;
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    await view.locator("[data-overdue-error]").waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth
      ),
      false
    );
    rows = [];
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    await view
      .getByRole("status")
      .filter({ hasText: "No overdue amounts match your filters." })
      .waitFor();
    assert.equal(
      await view
        .getByRole("button", { name: "Apply Filters", exact: true })
        .isVisible(),
      true
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Overdues-only page, same allocated-dealer endpoint, search, aging/amount filters without Territory/Currency controls, separate currency totals, pagination, overdue entry details, refresh preserving filters, errors/retry, empty state and mobile layout. Isolated API fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack);
  process.exit(1);
});
