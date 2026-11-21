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
      }),
      errors = [],
      requests = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/method/srv_erp.smart_dsr.admin.*", (route) => {
      const method = route.request().url().split(".").pop(),
        body = route.request().postDataJSON();
      requests.push({ method, ...body });
      const profile = {
        user: "Administrator",
        today: "2026-11-20",
        users: [{ name: "sales@example.test", full_name: "Sales User" }],
        can_finance: true,
        can_manage_users: true,
      };
      const dataset =
        {
          Salespersons: "people",
          "Opening Balances": "balances",
          Vehicles: "vehicles",
          "Duty Records": "duties",
          "Party Visits": "visits",
          Collections: "collections",
          Expenses: "expenses",
          "DSR Records": "dsrs",
        }[body.report] || "duties";
      return route.fulfill({
        json: {
          message:
            method === "bootstrap"
              ? profile
              : method === "overview"
              ? {}
              : { rows: [], total: 0, page_size: 20, dataset },
        },
      });
    });
    const dir = path.join(__dirname, "../srv_erp/public/smart_dsr");
    await page.route("**/admin-filter-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<style>:root{--dsr-bg:#fff;--fg-color:#fff;--dsr-text:#222;--dsr-border:#ddd}</style><style>${fs.readFileSync(
          dir + "/admin.css"
        )}</style><div id="dsr-admin"></div><script>${fs.readFileSync(
          dir + "/admin.js"
        )}</script>`,
      })
    );
    await page.goto("http://localhost/admin-filter-test");
    const form = page.locator("#admin-filters");
    await form.waitFor();
    const lastList = () =>
      requests.filter((r) => r.method === "list_records").at(-1);
    const navigate = async (id) => {
      await page.locator(`nav a[href="#${id}"]`).click();
      await page.waitForFunction(
        (id) =>
          location.hash === "#" + id &&
          document.querySelector("h1")?.textContent ===
            document.querySelector(`nav a[href="#${id}"]`).textContent,
        id
      );
    };
    await navigate("vehicles");
    assert.equal(await form.locator("[name=from_date]").count(), 0);
    assert.equal(await form.locator("[name=all_dates]").count(), 0);
    await form.getByLabel("Search", { exact: true }).fill("PB31");
    await form.getByLabel("Fuel Type").selectOption("CNG");
    await form
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#dsr-admin").hasAttribute("aria-busy")
    );
    assert.equal(lastList().filters.fuel_type, "CNG");
    await navigate("expenses");
    assert.equal(
      await form.getByLabel("Search", { exact: true }).inputValue(),
      ""
    );
    assert.equal(await form.locator("[name=fuel_type]").count(), 0);
    await form.getByLabel("Category", { exact: true }).selectOption("Parking");
    await form
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#dsr-admin").hasAttribute("aria-busy")
    );
    assert.equal(lastList().filters.category, "Parking");
    assert.equal(lastList().filters.fuel_type, undefined);
    await form
      .getByRole("button", { name: "Clear Filters", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#dsr-admin").hasAttribute("aria-busy")
    );
    assert.equal(
      await form.getByLabel("Category", { exact: true }).inputValue(),
      ""
    );
    assert.equal(lastList().page, 1);
    await navigate("vehicles");
    assert.equal(
      await form.getByLabel("Search", { exact: true }).inputValue(),
      "PB31"
    );
    assert.equal(await form.getByLabel("Fuel Type").inputValue(), "CNG");
    await navigate("collections");
    await form.getByLabel("Payment Method").selectOption("Cash");
    await form
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#dsr-admin").hasAttribute("aria-busy")
    );
    assert.equal(lastList().filters.payment_method, "Cash");
    await form.getByLabel("From Date", { exact: true }).fill("2026-11-21");
    await form
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    assert.equal(
      await form
        .getByLabel("To Date", { exact: true })
        .evaluate((e) => e.validity.customError),
      true
    );
    await form.getByLabel("All dates").check();
    assert.equal(
      await form.getByLabel("From Date", { exact: true }).isDisabled(),
      true
    );
    await form
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#dsr-admin").hasAttribute("aria-busy")
    );
    assert.equal(lastList().filters.all_dates, true);
    await navigate("people");
    assert.equal(await form.locator("[name=from_date]").count(), 0);
    await form.getByLabel("DSR Access").selectOption("0");
    await form
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#dsr-admin").hasAttribute("aria-busy")
    );
    assert.equal(lastList().filters.smart_dsr_disabled, "0");
    await navigate("reports");
    await form.getByLabel("Report", { exact: true }).selectOption("Expenses");
    await form.getByLabel("Category", { exact: true }).waitFor();
    assert.equal(await form.locator("[name=payment_method]").count(), 0);
    assert.equal(
      await page
        .getByRole("button", { name: "Run Report", exact: true })
        .count(),
      0
    );
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth
        ),
        false
      );
      const apply = await form
          .getByRole("button", { name: "Apply Filters", exact: true })
          .boundingBox(),
        clear = await form
          .getByRole("button", { name: "Clear Filters", exact: true })
          .boundingBox();
      assert.equal(Math.round(apply.y), Math.round(clear.y));
    }
    for (const [report, expected, present, absent] of [
      ["Salespersons", "people", "smart_dsr_disabled", "from_date"],
      ["Opening Balances", "balances", "balance_as_of", "status"],
      ["Vehicles", "vehicles", "fuel_type", "from_date"],
      ["Duty Records", "duties", "status", "fuel_type"],
      ["Party Visits", "visits", "customer", "duty"],
      ["Collections", "collections", "payment_method", "status"],
      ["Expenses", "expenses", "category", "duty"],
      ["DSR Records", "dsrs", "status", "customer"],
    ]) {
      await form.getByLabel("Report", { exact: true }).selectOption(report);
      await page.waitForFunction(
        (report) =>
          document.querySelector("#admin-filters [name=report]")?.value ===
            report &&
          !document.querySelector("#dsr-admin").hasAttribute("aria-busy"),
        report
      );
      assert.equal(await form.locator(`[name=${present}]`).count(), 1, report);
      assert.equal(await form.locator(`[name=${absent}]`).count(), 0, report);
      await form
        .getByLabel(
          report === "Duty Records" ? "Search Duty Records" : "Search",
          { exact: true }
        )
        .fill("section search");
      await form
        .getByRole("button", { name: "Apply Filters", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#dsr-admin").hasAttribute("aria-busy")
      );
      const request = requests.filter((r) => r.method === "report").at(-1);
      assert.equal(request.report, report);
      assert.equal(request.filters.search, "section search");
      await form
        .getByRole("button", { name: "Clear Filters", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#dsr-admin").hasAttribute("aria-busy")
      );
      assert.equal(
        await form
          .getByLabel(
            report === "Duty Records" ? "Search Duty Records" : "Search",
            { exact: true }
          )
          .inputValue(),
        ""
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS: section-specific controls, independent saved filters, clear/reset, payment/category/access filters, date validation, all dates, report controls and desktop/mobile layout. Mocked API."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
