const { chromium } = require("playwright"),
  fs = require("fs"),
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
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let failed = false,
      noSources = false,
      requests = 0;
    const parties = [
      { name: "A", customer_name: "Alpha Party" },
      { name: "B", customer_name: "Beta Party" },
    ];
    const lines = [
      {
        source: "orders",
        customer: "A",
        customer_name: "Alpha Party",
        item_code: "ITEM-A",
        item_name: "Product A",
        date: "2026-11-05",
        document: "SO-1",
        company: "Company 1",
        qty: 2,
        uom: "Box",
        stock_qty: 24,
        stock_uom: "Nos",
      },
      {
        source: "orders",
        customer: "A",
        customer_name: "Alpha Party",
        item_code: "ITEM-A",
        item_name: "Product A",
        date: "2026-11-20",
        document: "SO-2",
        company: "Company 1",
        qty: 3,
        uom: "Nos",
        stock_qty: 3,
        stock_uom: "Nos",
      },
      {
        source: "orders",
        customer: "B",
        customer_name: "Beta Party",
        item_code: "ITEM-B",
        item_name: "Product B",
        date: "2026-11-15",
        document: "SO-B",
        company: "Company 2",
        qty: 5,
        uom: "Kg",
        stock_qty: 5,
        stock_uom: "Kg",
      },
      ...Array.from({ length: 56 }, (_, i) => ({
        source: "orders",
        customer: "A",
        customer_name: "Alpha Party",
        item_code: "EXTRA-" + i,
        item_name: "Extra Product " + i,
        date: "2026-11-01",
        document: "SO-X" + i,
        company: "Company 1",
        qty: 1,
        uom: "Nos",
        stock_qty: 1,
        stock_uom: "Nos",
      })),
      {
        source: "invoices",
        customer: "A",
        customer_name: "Alpha Party",
        item_code: "ITEM-A",
        item_name: "Product A",
        date: "2026-11-02",
        document: "SI-1",
        company: "Company 1",
        qty: 10,
        uom: "Nos",
        stock_qty: 10,
        stock_uom: "Nos",
      },
      {
        source: "invoices",
        customer: "A",
        customer_name: "Alpha Party",
        item_code: "ITEM-A",
        item_name: "Product A",
        date: "2026-11-20",
        document: "SI-RETURN",
        company: "Company 1",
        qty: -2,
        uom: "Nos",
        stock_qty: -2,
        stock_uom: "Nos",
        is_return: 1,
      },
    ];
    await page.route("**/api/method/**", (route) => {
      const method = route.request().url().split(".").pop(),
        args = route.request().postDataJSON() || {};
      let message;
      if (method === "bootstrap")
        message = { current: null, duties: [], employee_name: "Salesperson" };
      if (method === "options")
        message = {
          today: "2026-11-21",
          customers: parties,
          sources: noSources
            ? []
            : [
                { value: "orders", label: "Sales Orders" },
                { value: "invoices", label: "Sales Invoices" },
              ],
          companies: ["Company 1", "Company 2"],
        };
      if (method === "report") {
        requests++;
        if (failed)
          return route.fulfill({
            status: 500,
            json: { message: "Purchase report unavailable" },
          });
        const matched = lines.filter(
          (row) =>
            row.source === args.source &&
            (!args.customer || row.customer === args.customer) &&
            (!args.item_code || row.item_code === args.item_code) &&
            (!args.company || row.company === args.company) &&
            (!args.from_date || row.date >= args.from_date) &&
            (!args.to_date || row.date <= args.to_date) &&
            (!args.search ||
              [
                row.customer,
                row.customer_name,
                row.item_code,
                row.item_name,
                row.document,
              ].some((value) =>
                value.toLowerCase().includes(args.search.toLowerCase())
              ))
        );
        const quantities = {};
        for (const row of matched)
          quantities[row.stock_uom] =
            (quantities[row.stock_uom] || 0) + row.stock_qty;
        let rows = matched;
        if (args.view === "items") {
          const groups = {};
          for (const row of matched) {
            const key = [row.customer, row.item_code, row.stock_uom].join("|");
            const group = (groups[key] ||= {
              customer: row.customer,
              customer_name: row.customer_name,
              item_code: row.item_code,
              item_name: row.item_name,
              uom: row.stock_uom,
              qty: 0,
              documents: 0,
              first_date: row.date,
              last_date: row.date,
            });
            group.qty += row.stock_qty;
            group.documents++;
            group.first_date =
              group.first_date < row.date ? group.first_date : row.date;
            group.last_date =
              group.last_date > row.date ? group.last_date : row.date;
          }
          rows = Object.values(groups).sort(
            (a, b) =>
              a.customer_name.localeCompare(b.customer_name) ||
              a.uom.localeCompare(b.uom) ||
              b.qty - a.qty ||
              a.item_code.localeCompare(b.item_code)
          );
        } else rows = [...rows].sort((a, b) => b.date.localeCompare(a.date));
        message = {
          rows: rows.slice(
            Number(args.start || 0),
            Number(args.start || 0) + 50
          ),
          count: rows.length,
          metrics: {
            parties: new Set(matched.map((r) => r.customer)).size,
            products: new Set(matched.map((r) => r.item_code)).size,
            documents: new Set(matched.map((r) => r.document)).size,
          },
          quantities: Object.entries(quantities).map(([uom, qty]) => ({
            uom,
            qty,
          })),
        };
      }
      assert.ok(message, method);
      return route.fulfill({ json: { message } });
    });
    const asset = path.join(__dirname, "../srv_erp/public/smart_dsr");
    await page.route("**/party-items-test*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fs.readFileSync(
          asset + "/app.css",
          "utf8"
        )}</style><div id="smart-dsr"></div><script>${fs.readFileSync(
          asset + "/party-items-page.js",
          "utf8"
        )}</script><script>${fs.readFileSync(
          asset + "/app.js",
          "utf8"
        )}</script>`,
      })
    );
    await page.goto("http://localhost/party-items-test?section=party-items");
    const view = page.locator(".dsr-party-items-page");
    await view
      .getByRole("status")
      .filter({ hasText: "of 58 party/product totals" })
      .waitFor();
    assert.equal(
      await view
        .getByRole("searchbox", {
          name: "Search Party / Customer",
          exact: true,
        })
        .count(),
      0
    );
    await view.getByLabel("Party / Customer", { exact: true }).click();
    assert.equal(
      await view.locator("#party-customer-options [data-customer]").count(),
      3
    );
    const inputBox = await view
      .getByLabel("Party / Customer", { exact: true })
      .boundingBox();
    const listBox = await view.locator("#party-customer-options").boundingBox();
    assert.ok(
      listBox.y >= inputBox.y + inputBox.height,
      "Suggestions must open below the field"
    );
    await view.getByLabel("Party / Customer", { exact: true }).fill("beta");
    await view
      .locator("#party-customer-options")
      .getByRole("option", { name: "Beta Party", exact: false })
      .click();
    await view
      .getByLabel("Party / Customer", { exact: true })
      .fill("Beta Party");
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await view
      .getByRole("status")
      .filter({ hasText: "of 1 party/product totals" })
      .waitFor();
    assert.match(await view.locator("tbody").innerText(), /Product B/);
    await view
      .getByRole("button", { name: "Clear Filters", exact: true })
      .click();
    await view
      .getByRole("status")
      .filter({ hasText: "of 58 party/product totals" })
      .waitFor();
    assert.equal(
      await page
        .locator(".workday-heading,#duty-form,#night-stay,#dsr-history")
        .count(),
      0
    );
    assert.equal(await view.locator("tbody tr").count(), 50);
    await view.getByRole("button", { name: "Next", exact: true }).click();
    await view.getByRole("status").filter({ hasText: "51–58" }).waitFor();
    assert.equal(await view.locator("tbody tr").count(), 8);
    await view
      .getByRole("searchbox", { name: "Search", exact: true })
      .fill("Product A");
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await view
      .getByRole("status")
      .filter({ hasText: "of 1 party/product totals" })
      .waitFor();
    assert.match(await view.locator("tbody").innerText(), /27/);
    assert.match(await view.locator("tbody").innerText(), /2026-11-05/);
    assert.match(await view.locator("tbody").innerText(), /2026-11-20/);
    await view
      .getByRole("button", { name: "View Purchases", exact: true })
      .click();
    await view
      .getByRole("status")
      .filter({ hasText: "of 2 purchase lines" })
      .waitFor();
    assert.match(await view.locator("tbody").innerText(), /Box/);
    assert.match(await view.locator("tbody").innerText(), /24/);
    assert.equal(
      await view
        .getByRole("link", { name: "SO-1", exact: true })
        .getAttribute("href"),
      "/app/sales-order/SO-1"
    );
    await view
      .getByRole("button", { name: "Back to Top Items", exact: true })
      .click();
    await view
      .getByRole("status")
      .filter({ hasText: "of 1 party/product totals" })
      .waitFor();
    assert.equal(
      await view
        .getByRole("searchbox", { name: "Search", exact: true })
        .inputValue(),
      "Product A"
    );
    await view
      .getByRole("button", { name: "Clear Filters", exact: true })
      .click();
    await view
      .getByRole("status")
      .filter({ hasText: "of 58 party/product totals" })
      .waitFor();
    await view.getByLabel("Party / Customer", { exact: true }).fill("B");
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await view
      .getByRole("status")
      .filter({ hasText: "of 1 party/product totals" })
      .waitFor();
    assert.match(await view.locator("tbody").innerText(), /Product B/);
    await view
      .getByRole("button", { name: "Clear Filters", exact: true })
      .click();
    await view
      .getByRole("status")
      .filter({ hasText: "of 58 party/product totals" })
      .waitFor();
    await view.getByLabel("From Date", { exact: true }).fill("2026-11-10");
    await view.getByLabel("To Date", { exact: true }).fill("2026-11-20");
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await view
      .getByRole("status")
      .filter({ hasText: "of 2 party/product totals" })
      .waitFor();
    await view.getByLabel("From Date", { exact: true }).fill("2026-11-22");
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    assert.equal(
      await view
        .getByLabel("To Date", { exact: true })
        .evaluate((node) => node.validity.customError),
      true
    );
    await view
      .getByRole("button", { name: "Clear Filters", exact: true })
      .click();
    await view
      .getByRole("status")
      .filter({ hasText: "of 58 party/product totals" })
      .waitFor();
    assert.equal(
      await view.locator("[name=company],[name=source],[name=period]").count(),
      0
    );
    for (const [interval, from, to] of [
      ["monthly", "2026-11-01", "2026-11-30"],
      ["quarterly", "2026-10-01", "2026-12-31"],
      ["half-yearly", "2026-07-01", "2026-12-31"],
      ["yearly", "2026-01-01", "2026-12-31"],
    ]) {
      await view.getByLabel("Interval", { exact: true }).selectOption(interval);
      assert.equal(
        await view.getByLabel("From Date", { exact: true }).inputValue(),
        from
      );
      assert.equal(
        await view.getByLabel("To Date", { exact: true }).inputValue(),
        to
      );
      await view
        .getByRole("button", { name: "Apply Filters", exact: true })
        .click();
      await view
        .getByRole("status")
        .filter({ hasText: "of 58 party/product totals" })
        .waitFor();
    }
    await view.getByLabel("From Date", { exact: true }).fill("2026-11-10");
    assert.equal(
      await view.getByLabel("Interval", { exact: true }).inputValue(),
      ""
    );
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await view
      .getByRole("status")
      .filter({ hasText: "of 2 party/product totals" })
      .waitFor();
    await view
      .getByRole("button", { name: "Clear Filters", exact: true })
      .click();
    await view
      .getByRole("status")
      .filter({ hasText: "of 58 party/product totals" })
      .waitFor();
    assert.equal(
      await view.getByLabel("Interval", { exact: true }).inputValue(),
      ""
    );
    failed = true;
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    await view
      .getByRole("alert")
      .filter({ hasText: "Purchase report unavailable" })
      .waitFor();
    failed = false;
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    await view.locator("[data-party-error]").waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth
      ),
      false
    );
    const previousRequests = requests;
    noSources = true;
    await page.reload();
    await view
      .getByRole("alert")
      .filter({ hasText: "You do not have permission" })
      .waitFor();
    assert.equal(requests, previousRequests);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: party totals and dated lines, search/date/party filters, four calendar intervals without Period/Company/Sales Source controls, custom dates, clear, drill-down/back, paging, links, errors/retry, no-source guard and mobile layout. Isolated API fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack);
  process.exit(1);
});
