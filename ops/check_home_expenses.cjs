const { chromium } = require("playwright");
const fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  try {
    const context = await browser.newContext({
      permissions: ["camera"],
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "geolocation", {
        value: {
          watchPosition() {
            return 1;
          },
          clearWatch() {},
        },
      });
      const interval = window.setInterval.bind(window);
      window.setInterval = (fn, delay, ...args) =>
        delay === 60000 ? 1 : interval(fn, delay, ...args);
    });
    let active = true,
      fail = false,
      writes = 0;
    const duty = {
      name: "active",
      status: "Active",
      opening_balance: 1000,
      work_date: "2026-11-21",
      started_at: "2026-11-21 10:00:00",
    };
    const rows = Array.from({ length: 55 }, (_, index) => ({
      name: "EXP-" + index,
      duty: index % 2 ? "older" : "active",
      work_date: index % 2 ? "2026-11-10" : "2026-11-21",
      duty_status: index % 2 ? "Finalized" : "Active",
      recorded_at: index % 2 ? "2026-11-10 10:00:00" : "2026-11-21 10:00:00",
      category: index % 2 ? "Breakfast" : "Other Expense",
      amount: 10,
      posting_status: index === 2 ? "Reversed" : "Recorded",
      remarks:
        index === 4
          ? "Needle expense"
          : "Automatic breakfast expense for continuous duty at 07:00 am.",
      receipt: index === 4 ? "/private/files/existing.jpg" : null,
    }));
    await page.route("**/api/method/**", (route) => {
      const method = route.request().url().split(".").pop(),
        args = route.request().postDataJSON() || {};
      let message = {};
      if (method === "bootstrap") {
        duty.status = active ? "Active" : "Finalized";
        message = {
          employee_name: "Salesperson",
          currency: "INR",
          current: { duty, expenses: [], available_cash: 1000, activities: [] },
          duties: [
            duty,
            { name: "older", work_date: "2026-11-10", status: "Finalized" },
          ],
        };
      }
      if (method === "list_expenses") {
        if (fail)
          return route.fulfill({
            status: 500,
            json: { message: "Expense history unavailable" },
          });
        const matched = rows.filter(
          (row) =>
            (!args.search ||
              JSON.stringify(row)
                .toLowerCase()
                .includes(args.search.toLowerCase())) &&
            (!args.category || row.category === args.category) &&
            (!args.status || row.posting_status === args.status) &&
            (!args.duty || row.duty === args.duty) &&
            (!args.from_date ||
              row.recorded_at.slice(0, 10) >= args.from_date) &&
            (!args.to_date || row.recorded_at.slice(0, 10) <= args.to_date)
        );
        message = {
          rows: matched.slice(
            Number(args.start || 0),
            Number(args.start || 0) + 50
          ),
          totals: {
            count: matched.length,
            amount: matched
              .filter((row) => row.posting_status !== "Reversed")
              .reduce((total, row) => total + row.amount, 0),
            reversed_amount: matched
              .filter((row) => row.posting_status === "Reversed")
              .reduce((total, row) => total + row.amount, 0),
          },
          categories: ["Breakfast", "Other Expense"],
          currency: "INR",
        };
      }
      if (method === "receipt_camera_challenge")
        message = "expense-receipt-challenge";
      if (method === "record_expense") {
        if (!args.receipt_file)
          return route.fulfill({
            status: 417,
            json: { message: "A receipt is required for every expense." },
          });
        assert.equal(args.receipt_file.challenge, "expense-receipt-challenge");
        assert.ok(args.receipt_file.content.length > 1000);
        assert.equal(args.paid_from_cash, 0);
        assert.equal(args.category, "Other Expense");
        writes++;
        rows.unshift({
          name: "EXP-NEW",
          duty: "active",
          work_date: "2026-11-21",
          duty_status: "Active",
          recorded_at: "2026-11-21 12:00:00",
          category: args.category,
          amount: Number(args.value),
          posting_status: "Recorded",
          remarks: args.remarks,
          receipt: "/private/files/receipt-new.jpg",
        });
        message = { name: "EXP-NEW", balance: 1000 };
      }
      return route.fulfill({ json: { message } });
    });
    const asset = path.join(__dirname, "../srv_erp/public/smart_dsr");
    await page.route("**/expenses-page-test*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fs.readFileSync(
          asset + "/app.css",
          "utf8"
        )}</style><div id="smart-dsr"></div><script>${fs.readFileSync(
          asset + "/expenses-page.js",
          "utf8"
        )}</script><script>${fs.readFileSync(
          asset + "/app.js",
          "utf8"
        )}</script>`,
      })
    );
    await page.goto("http://localhost/expenses-page-test?section=expenses");
    const view = page.locator(".dsr-expenses-page");
    await view.getByRole("status").filter({ hasText: "55 expenses" }).waitFor();
    assert.equal(
      await page
        .locator(".workday-heading,#night-stay,#dsr-history,#duty-form")
        .count(),
      0
    );
    assert.equal(await view.locator("tbody tr").count(), 50);
    assert.equal(
      await view
        .locator("tbody td")
        .evaluateAll((nodes) =>
          nodes.some((node) => node.scrollWidth > node.clientWidth + 1)
        ),
      false,
      "Desktop cell contents must not overlap"
    );
    assert.match(
      await view.locator(".expense-page-totals").innerText(),
      /540\.00/
    );
    await view.getByRole("button", { name: "Next", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-expense-status]").textContent !==
        "Loading expenses…"
    );
    await view.getByRole("status").filter({ hasText: "51–55" }).waitFor();
    assert.equal(await view.locator("tbody tr").count(), 5);
    await view.getByRole("searchbox").fill("needle");
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await view.getByRole("status").filter({ hasText: "1 expenses" }).waitFor();
    await view
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    await page.locator("#dsr-dialog[open]").waitFor();
    assert.match(
      await page.locator("#dsr-dialog").innerText(),
      /Needle expense/
    );
    assert.equal(
      await page
        .locator("#dsr-dialog")
        .getByRole("link", { name: "View Receipt", exact: true })
        .getAttribute("href"),
      "/private/files/existing.jpg"
    );
    await page.locator("#dsr-dialog [data-close]").click();
    await view
      .getByRole("button", { name: "Clear Filters", exact: true })
      .click();
    await view.getByRole("status").filter({ hasText: "55 expenses" }).waitFor();
    await view.getByLabel("DSR", { exact: true }).selectOption("older");
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await view.getByRole("status").filter({ hasText: "27 expenses" }).waitFor();
    await view
      .getByRole("button", { name: "Clear Filters", exact: true })
      .click();
    await view.getByRole("status").filter({ hasText: "55 expenses" }).waitFor();
    await view.getByLabel("From Date", { exact: true }).fill("2026-11-22");
    await view.getByLabel("To Date", { exact: true }).fill("2026-11-01");
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    assert.equal(
      await view
        .getByLabel("To Date", { exact: true })
        .evaluate((input) => input.validity.customError),
      true
    );
    await view
      .getByRole("button", { name: "Clear Filters", exact: true })
      .click();
    await view.getByRole("status").filter({ hasText: "55 expenses" }).waitFor();
    await view.getByLabel("Status", { exact: true }).selectOption("Reversed");
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await view.getByRole("status").filter({ hasText: "1 expenses" }).waitFor();
    assert.match(
      await view.locator(".expense-page-totals").innerText(),
      /0\.00/
    );
    await view
      .getByRole("button", { name: "Clear Filters", exact: true })
      .click();
    await view.getByRole("status").filter({ hasText: "55 expenses" }).waitFor();
    await view
      .getByLabel("Expense Type", { exact: true })
      .selectOption("Other Expense");
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await view.getByRole("status").filter({ hasText: "28 expenses" }).waitFor();
    await view
      .getByRole("button", { name: "Add Expense", exact: true })
      .click();
    const dialog = page.locator("#dsr-dialog");
    await dialog.locator("[name=category]").selectOption("Other Expense");
    await dialog.getByLabel("Amount", { exact: true }).fill("42");
    await dialog
      .getByLabel("Remarks", { exact: true })
      .fill("Needle new expense");
    await dialog
      .getByRole("button", { name: "Save Expense", exact: true })
      .click();
    await dialog
      .locator("[data-expense-error]")
      .filter({ hasText: "A receipt is required" })
      .waitFor();
    assert.equal(writes, 0);
    await dialog
      .getByRole("button", { name: "Open Receipt Camera", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-receipt-camera] video")?.videoWidth > 0
    );
    await dialog.locator("[data-capture-receipt]").click();
    await dialog.getByAltText("Captured receipt", { exact: true }).waitFor();
    await dialog
      .getByRole("button", { name: "Save Expense", exact: true })
      .click();
    await view
      .locator("tbody")
      .getByText("Needle new expense", { exact: true })
      .waitFor();
    assert.equal(writes, 1);
    assert.equal(
      await view.getByLabel("Expense Type", { exact: true }).inputValue(),
      "Other Expense"
    );
    fail = true;
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    await view
      .getByRole("alert")
      .filter({ hasText: "Expense history unavailable" })
      .waitFor();
    fail = false;
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    await view.locator("[data-expense-error]").waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth
      ),
      false
    );
    active = false;
    await page.reload();
    await view.getByRole("status").waitFor();
    assert.equal(
      await view
        .getByRole("button", { name: "Add Expense", exact: true })
        .isDisabled(),
      true
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Expenses-only history, search/type/status/DSR/date filters, clear, totals, pagination, receipt/details, mandatory live-camera add, retained filters, errors/retry, mobile cards and inactive-duty guard. Isolated API fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack);
  process.exit(1);
});
