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
    const page = await browser.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/method/srv_erp.smart_dsr.admin.*", (r) => {
      const method = r.request().url().split(".").pop();
      const message =
        method === "bootstrap"
          ? { user: "Administrator", today: "2026-11-20", users: [] }
          : method === "list_records"
          ? { rows: [{ name: "sales@test", account: "sales@test" }], total: 1 }
          : method === "details"
          ? {
              profile: { name: "sales@test", employee_name: "Sales User" },
              duties: { rows: [] },
              dsrs: { rows: [] },
              ledger: {
                rows: [
                  {
                    name: "ledger-1",
                    posting_time: "2026-11-20T12:00:00+05:30",
                    remarks:
                      "Collected cash from dealer against the pending invoice. Reference-" +
                      "1234567890".repeat(10),
                    amount: 500,
                    transaction_type: "Dealer Cash Collection",
                    dealer_details: {
                      name: "Dealer One",
                      dealer_id: "dealer-1",
                      mobile_no: "9876543210",
                    },
                    collection_details: {
                      collection: "collection-1",
                      payment_method: "Cash",
                      amount: 500,
                      collected_at: "2026-11-20T12:00:00+05:30",
                      transaction_reference: "receipt-1",
                      status: "Recorded",
                    },
                  },
                  {
                    name: "ledger-2",
                    posting_time: "2026-11-20T13:00:00+05:30",
                    transaction_type: "Cash Handover",
                    amount: -200,
                    remarks: "Cash returned to administrator.",
                  },
                ],
              },
            }
          : {};
      return r.fulfill({ json: { message } });
    });
    const dir = path.join(__dirname, "../srv_erp/public/smart_dsr");
    await page.route("**/ledger-dealer-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<meta charset="utf-8"><style>:root{--fg-color:#fff;--modal-bg:#fff;--dsr-bg:#f8f8f8;--text-color:#383838;--dsr-text:#383838;--dsr-muted:#666;--dsr-border:#ddd;--border-color:#ddd;--control-bg:#f3f3f3;--subtle-accent:#f5f5f5;--red-600:#c43232;--font-stack:Arial,sans-serif;--btn-default-bg:#f0f0f0}</style><style>${fs.readFileSync(
          dir + "/admin.css"
        )}</style><div id="dsr-admin"></div><script>${fs.readFileSync(
          dir + "/admin.js"
        )}</script>`,
      })
    );
    await page.goto("http://localhost/ledger-dealer-test#balances");
    await page
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    const ledger = page.locator("#admin-dialog details").filter({
      has: page.locator("summary", {
        hasText: "Cash ledger and adjustments",
      }),
    });
    await ledger.getByText("Dealer One", { exact: true }).waitFor();
    assert.match(await ledger.innerText(), /9876543210/);
    assert.match(await ledger.innerText(), /collection-1/);
    assert.match(await ledger.innerText(), /receipt-1/);
    assert.match(await ledger.innerText(), /Recorded/);
    assert.equal(
      await ledger
        .getByRole("columnheader", { name: "Dealer", exact: true })
        .count(),
      1
    );
    assert.equal(
      await ledger
        .getByRole("columnheader", { name: "Collection Details", exact: true })
        .count(),
      1
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await ledger.scrollIntoViewIfNeeded();
      const scroll = ledger.locator(".cash-ledger-scroll");
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth
        ),
        false
      );
      assert.equal(
        await scroll
          .locator("thead th")
          .first()
          .evaluate((el) => getComputedStyle(el).position),
        "sticky"
      );
      assert.equal(
        await scroll
          .locator("td.ledger-amount")
          .first()
          .evaluate((el) => getComputedStyle(el).textAlign),
        "right"
      );
      assert.equal(
        await scroll
          .locator("td.ledger-remarks")
          .first()
          .evaluate((el) => getComputedStyle(el).whiteSpace),
        "pre-wrap"
      );
      if (width === 390)
        assert(await scroll.evaluate((el) => el.scrollWidth > el.clientWidth));
      else if (process.env.DSR_SCREENSHOT)
        await scroll.screenshot({ path: process.env.DSR_SCREENSHOT });
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS: dealer identity, phone, collection method/reference/status are visible in Cash ledger and adjustments; fixed-width columns, aligned amounts, wrapped remarks, sticky headers and contained mobile scrolling. Mocked API."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
