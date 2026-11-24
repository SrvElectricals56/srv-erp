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
      errors = [],
      calls = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const user = "sales@test",
      duty = {
        doctype: "DSR Duty Session",
        name: "duty-1",
        account: user,
        status: "Closed",
        closing_balance: 1000,
      };
    const expense = {
      doctype: "DSR Expense Record",
      name: "expense-1",
      account: user,
      amount: 100,
      category: "Other Expense",
    };
    await page.route("**/api/method/srv_erp.smart_dsr.admin.*", (r) => {
      const method = r.request().url().split(".").pop(),
        body = r.request().postDataJSON();
      calls.push(method);
      let message;
      if (method === "bootstrap")
        message = {
          user: "Administrator",
          today: "2026-11-20",
          users: [],
          can_finance: true,
          can_manage_users: true,
        };
      else if (method === "overview") message = {};
      else if (method === "visit_dealer_options") message = [];
      else if (method === "list_records")
        message = {
          rows: [
            {
              name: "record-1",
              employee_name: "User",
              account: user,
              registration_number: "PB31AB1234",
            },
          ],
          total: 1,
          page_size: 20,
        };
      else if (method === "details")
        message =
          body.dataset === "people" || body.dataset === "balances"
            ? {
                profile: { name: user, employee_name: "Sales User" },
                current_duty: duty,
                duties: { rows: [duty] },
                dsrs: { rows: [] },
                ledger: { rows: [] },
              }
            : body.dataset === "vehicles"
            ? {
                record: {
                  name: "vehicle-1",
                  registration_number: "PB31AB1234",
                },
              }
            : body.dataset === "duties"
            ? { record: duty, expenses: { rows: [expense] } }
            : {
                record:
                  body.dataset === "expenses"
                    ? expense
                    : { doctype: "DSR", name: "record-1", amount: 100 },
              };
      else throw Error("Unexpected mutation " + method);
      return r.fulfill({ json: { message } });
    });
    const dir = path.join(__dirname, "../srv_erp/public/smart_dsr");
    await page.route("**/readonly-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<div id="dsr-admin"></div><script>${fs.readFileSync(
          dir + "/admin.js"
        )}</script>`,
      })
    );
    await page.goto("http://localhost/readonly-test#people");
    const readonly = async () => {
      const d = page.locator("#admin-dialog");
      await d.waitFor();
      assert.equal(await d.locator("form, input, textarea, select").count(), 0);
      const controls = await d
        .locator('[data-action]:not([data-action="detail"])')
        .evaluateAll((nodes) => nodes.map((n) => n.dataset.action));
      assert(
        controls.every((action) =>
          [
            "edit-dsr-access",
            "opening-add",
            "opening-return",
            "edit-vehicle",
          ].includes(action)
        )
      );
      if (controls.length) {
        assert(
          controls.every((action) =>
            action === "edit-vehicle"
              ? new URL(page.url()).hash === "#vehicles"
              : action.startsWith("opening-")
              ? new URL(page.url()).hash === "#balances"
              : new URL(page.url()).hash === "#people"
          )
        );
      }
      const links = await d
        .locator('a[href^="/app/"]')
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href")));
      if (links.length) {
        assert.equal(new URL(page.url()).hash, "#people");
        assert(links.every((href) => href.startsWith("/app/user/")));
      }
      assert.doesNotMatch(
        await d.innerText(),
        /Edit Record|Edit Salesperson|Change Duty Status|Correct Other Fields|Cash Adjustment/
      );
    };
    await page
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    await readonly();
    await page
      .locator("#admin-dialog")
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    await page
      .locator("#admin-dialog h2")
      .filter({ hasText: "Duties" })
      .waitFor();
    await readonly();
    await page
      .locator("#admin-dialog")
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    await page
      .locator("#admin-dialog h2")
      .filter({ hasText: "Expenses" })
      .waitFor();
    await readonly();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    for (const section of [
      "balances",
      "vehicles",
      "duties",
      "visits",
      "collections",
      "expenses",
      "dsrs",
      "audit",
    ]) {
      await page.locator(`nav a[href="#${section}"]`).click();
      await page.waitForFunction(
        (id) =>
          document.querySelector("h1")?.textContent ===
          document.querySelector(`nav a[href="#${id}"]`).textContent,
        section
      );
      await page
        .getByRole("button", { name: "View Details", exact: true })
        .click();
      await readonly();
      await page.getByRole("button", { name: "Close", exact: true }).click();
    }
    assert(
      calls.every((method) =>
        [
          "bootstrap",
          "list_records",
          "details",
          "overview",
          "visit_dealer_options",
        ].includes(method)
      )
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: record details remain read-only except the allowed Salesperson, Opening Balance and saved Vehicle controls; nested details have no mutation actions; only Salespersons has native User profile links; browsing calls only read APIs. Mocked API."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
