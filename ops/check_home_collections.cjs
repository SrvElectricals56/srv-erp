// Real Desk controls with isolated collection API fixtures: no payments are posted.
const { chromium } = require("playwright");
const fs = require("fs"),
  assert = require("assert/strict");
(async () => {
  const { sid } = JSON.parse(
    fs.readFileSync(process.env.SMART_DSR_SESSION_FILE, "utf8")
  );
  const base = process.env.SMART_DSR_URL || "http://127.0.0.1:8001";
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await context.addCookies([{ name: "sid", value: sid, url: base }]);
    const parties = await (
      await context.request.get(
        base + "/api/method/srv_erp.smart_dsr.api.search_dealers",
        { timeout: 120000 }
      )
    ).json();
    const customer = parties.message[0].name;
    const page = await context.newPage();
    let balance = 1000,
      active = true,
      writes = 0;
    const keys = new Set();
    const rows = Array.from({ length: 55 }, (_, i) => ({
      name: "QA-" + i,
      customer,
      customer_name: i === 4 ? "Needle Dealer" : "Allocated Party",
      amount: 10,
      payment_method: i % 2 ? "UPI" : "Cash",
      verification_status: i === 2 ? "Reversed" : "Recorded",
      activity: i % 2 ? "visit" : null,
      duty: "QA-DUTY",
      collected_at: "2026-11-21 10:00:00",
      transaction_reference: i % 2 ? "REF-" + i : "",
      remarks: "",
    }));
    await page.route("**/api/method/srv_erp.smart_dsr.api.bootstrap", (route) =>
      route.fulfill({
        json: {
          message: {
            official_opening_balance: 1000,
            current: {
              duty: {
                name: "QA-DUTY",
                opening_balance: 1000,
                status: "Active",
              },
              available_cash: balance,
            },
            reward_points: 7,
            currency: "INR",
          },
        },
      })
    );
    await page.route(
      "**/api/method/srv_erp.smart_dsr.home_collections.*",
      async (route) => {
        const method = route.request().url().split(".").pop();
        const args = Object.fromEntries(
          new URLSearchParams(route.request().postData() || "")
        );
        let message;
        if (method === "options")
          message = {
            duty: active ? "QA-DUTY" : null,
            closing_balance: balance,
            currency: "INR",
          };
        if (method === "collect") {
          writes++;
          assert.equal(args.customer, customer);
          assert.ok(args.request_key);
          if (!keys.has(args.request_key)) {
            keys.add(args.request_key);
            balance += ["Cash", "UPI", "Bank Transfer", "Cheque"].includes(
              args.payment_method
            )
              ? Number(args.value)
              : 0;
            rows.unshift({
              name: "HOME-QA",
              customer,
              customer_name: "Allocated Party",
              amount: Number(args.value),
              payment_method: args.payment_method,
              verification_status: "Recorded",
              duty: "QA-DUTY",
              collected_at: "2026-11-21 11:00:00",
              transaction_reference: args.transaction_reference,
              remarks: args.remarks,
            });
          }
          message = { name: "HOME-QA", balance };
        }
        if (method === "collections") {
          const matching = rows.filter(
            (row) =>
              (!args.source || (args.source === "visit") === !!row.activity) &&
              (!args.payment_method ||
                row.payment_method === args.payment_method) &&
              (!args.status || row.verification_status === args.status) &&
              (!args.search ||
                JSON.stringify(row)
                  .toLowerCase()
                  .includes(args.search.toLowerCase()))
          );
          const valid = matching.filter(
            (row) => row.verification_status !== "Reversed"
          );
          const sum = (filter) =>
            valid.filter(filter).reduce((total, row) => total + row.amount, 0);
          message = {
            rows: matching.slice(
              Number(args.start || 0),
              Number(args.start || 0) + 50
            ),
            totals: {
              count: matching.length,
              total: sum(() => true),
              cash: sum((row) => row.payment_method === "Cash"),
              noncash: sum((row) => row.payment_method !== "Cash"),
            },
            currency: "INR",
            page_size: 50,
          };
        }
        assert.ok(message, method);
        await route.fulfill({ json: { message } });
      }
    );
    await page.goto(base + "/app/home", {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await page
      .getByRole("button", { name: "Collect Money", exact: true })
      .click({ timeout: 60000 });
    await page
      .getByRole("heading", { name: "Collect Money", exact: true })
      .waitFor();
    await page.waitForFunction(() => window.cur_dialog?.fields_dict?.customer);
    assert.equal(
      await page.evaluate(
        () => cur_dialog.fields_dict.customer.df.get_query().query
      ),
      "srv_erp.smart_dsr.home_collections.dealer_query"
    );
    await page.evaluate(
      (customer) =>
        cur_dialog.set_values({
          customer,
          value: 200,
          payment_method: "Cash",
          remarks: "UI fixture",
        }),
      customer
    );
    await page
      .getByRole("button", { name: "Save Collection", exact: true })
      .click();
    await page
      .locator('[data-metric="Closing Balance"]')
      .filter({ hasText: "1,200" })
      .waitFor();
    assert.equal(writes, 1);
    for (const [method, amount, expected] of [
      ["UPI", 50, "1,250"],
      ["Bank Transfer", 75, "1,325"],
      ["Cheque", 25, "1,325"],
    ]) {
      await page.waitForFunction(() => !$(".modal:visible").length);
      await page
        .getByRole("button", { name: "Collect Money", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          window.cur_dialog?.fields_dict?.customer &&
          cur_dialog.$wrapper.hasClass("show")
      );
      await page.evaluate(
        ({ customer, method, amount }) =>
          cur_dialog.set_values({
            customer,
            value: amount,
            payment_method: method,
            transaction_reference: "QA-REF",
            remarks: "UI fixture",
          }),
        { customer, method, amount }
      );
      await page
        .getByRole("button", { name: "Save Collection", exact: true })
        .click();
      await page.waitForFunction(() => !$(".modal:visible").length);
      await page
        .locator('[data-metric="Closing Balance"]')
        .filter({ hasText: expected })
        .waitFor();
    }
    assert.equal(writes, 4);
    await page
      .getByRole("button", { name: "Collections", exact: true })
      .click();
    const view = page.locator(".home-collections-view");
    await view
      .getByRole("status")
      .filter({ hasText: "59 collections" })
      .waitFor();
    assert.equal(await view.locator("tbody tr").count(), 50);
    await view.getByRole("button", { name: "Next", exact: true }).click();
    await view.getByRole("status").filter({ hasText: "51–59" }).waitFor();
    assert.equal(await view.locator("tbody tr").count(), 9);
    await view.locator("[name=source]").selectOption("visit");
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await view
      .getByRole("status")
      .filter({ hasText: "27 collections" })
      .waitFor();
    assert.equal(
      await view
        .locator("tbody")
        .getByText("Home / Direct", { exact: true })
        .count(),
      0
    );
    await view.getByRole("button", { name: "Clear", exact: true }).click();
    await view
      .getByRole("status")
      .filter({ hasText: "59 collections" })
      .waitFor();
    await view.locator("[name=search]").fill("needle");
    await view
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await view
      .getByRole("status")
      .filter({ hasText: "1 collections" })
      .waitFor();
    assert.equal(await view.locator("tbody tr").count(), 1);
    await view.getByRole("button", { name: "View", exact: true }).click();
    await page
      .getByRole("heading", { name: "Collection Details", exact: true })
      .waitFor();
    await page.waitForFunction(
      () => window.cur_dialog?.title === "Collection Details"
    );
    await page.evaluate(() => cur_dialog.hide());
    await page.waitForFunction(() => !$(".modal:visible").length);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => frappe.workspace.page.close_sidebar?.());
    await page.waitForFunction(
      () => !document.querySelector(".overlay-sidebar.opened")
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth
      ),
      false
    );
    await page.screenshot({
      path: "/tmp/home-collections-mobile.png",
      fullPage: true,
      animations: "disabled",
    });
    await view
      .getByRole("button", { name: "Back to Home", exact: true })
      .click();
    active = false;
    await page
      .getByRole("button", { name: "Collect Money", exact: true })
      .click();
    await page
      .getByRole("heading", {
        name: "Collect Money",
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Save Collection", exact: true })
        .isEnabled(),
      true
    );
    console.log(
      "PASS: real Desk form and assigned-dealer query, save refreshes closing balance, unified collections, pagination, source filter, search, details, mobile layout, Home return and direct collection without duty. Collection APIs use isolated fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack);
  process.exit(1);
});
