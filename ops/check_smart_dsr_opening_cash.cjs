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
      mutations = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const user = "sales@test";
    let opening = 1000,
      closing = 1200;
    await page.route("**/api/method/srv_erp.smart_dsr.admin.*", (r) => {
      const method = r.request().url().split(".").pop(),
        body = r.request().postDataJSON();
      let message;
      if (method === "bootstrap")
        message = {
          user: "Administrator",
          today: "2026-11-20",
          users: [{ name: user, full_name: "Sales User" }],
          can_finance: true,
        };
      else if (method === "list_records")
        message = {
          rows: [
            {
              name: user,
              account: user,
              employee_name: "Sales User",
              opening_balance: opening,
              closing_balance: closing,
            },
          ],
          total: 1,
          page_size: 20,
        };
      else if (method === "details")
        message = {
          profile: { name: user, account: user, employee_name: "Sales User" },
          duties: { rows: [] },
          dsrs: { rows: [] },
          ledger: { rows: [] },
        };
      else if (method === "balance_details")
        message = { user, opening_balance: opening, current_cash: closing };
      else if (method === "record_opening_movement") {
        mutations.push(body);
        const n = Number(body.value);
        opening += body.action === "add" ? n : -n;
        closing += body.action === "add" ? n : -n;
        message = { audit: "cash-audit", outcome: "Applied" };
      } else message = {};
      return r.fulfill({ json: { message } });
    });
    const dir = path.join(__dirname, "../srv_erp/public/smart_dsr");
    await page.route("**/opening-cash-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<style>:root{--fg-color:#fff;--dsr-text:#222;--dsr-border:#ddd}</style><style>${fs.readFileSync(
          dir + "/admin.css"
        )}</style><div id="dsr-admin"></div><script>${fs.readFileSync(
          dir + "/admin.js"
        )}</script>`,
      })
    );
    await page.goto("http://localhost/opening-cash-test#balances");
    const d = page.locator("#admin-dialog"),
      review = page.locator("#admin-save-confirm");
    assert.equal(
      await page
        .locator("tbody")
        .getByRole("button", { name: "Add Opening Amount", exact: true })
        .count(),
      0
    );
    await page
      .locator("tbody")
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    await d
      .getByRole("button", { name: "Add Opening Amount", exact: true })
      .click();
    await d.getByLabel("Amount to Add").fill("1000000.01");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    assert.equal(await review.count(), 0);
    assert.equal(mutations.length, 0);
    assert.equal(
      await d.getByLabel("Amount to Add").getAttribute("max"),
      "1000000"
    );
    await d.getByLabel("Amount to Add").fill("500");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    assert.equal(await review.count(), 0);
    await d
      .getByLabel("Reason", { exact: true })
      .fill("Cash issued for dealer visits.");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    await review.waitFor();
    const text = await review.innerText();
    assert.match(text, /Opening Balance/);
    assert.match(text, /1,500/);
    assert.match(text, /1,700/);
    assert.equal(mutations.length, 0);
    await review
      .getByRole("button", { name: "Confirm Save", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#admin-dialog").open
    );
    assert.equal(mutations[0].expected_balance, 1200);
    assert.equal(mutations[0].expected_opening, 1000);
    assert.equal(opening, 1500);
    assert.equal(closing, 1700);
    assert.equal(
      await page
        .locator("tbody")
        .getByRole("button", { name: "Record Returned Cash", exact: true })
        .count(),
      0
    );
    await page
      .locator("tbody")
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    await d
      .getByRole("button", { name: "Record Returned Cash", exact: true })
      .click();
    await d.getByLabel("Amount Returned to Admin").fill("2000");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    assert.equal(await review.count(), 0);
    assert.equal(
      await d
        .getByLabel("Amount Returned to Admin")
        .evaluate((el) => el.validity.customError),
      true
    );
    await d.getByLabel("Amount Returned to Admin").fill("200");
    await d
      .getByLabel("Reason", { exact: true })
      .fill("Unused cash returned after duty.");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    await review.waitFor();
    assert.match(await review.innerText(), /Cash Returned to Admin/);
    assert.match(await review.innerText(), /Unused cash returned after duty/);
    const openingRow = review
      .locator("tbody tr")
      .filter({ hasText: "Opening Balance" });
    assert.match(await openingRow.innerText(), /1,500/);
    assert.match(await openingRow.innerText(), /1,300/);
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(mutations.length, 1);
    assert.equal(
      await d.getByLabel("Amount Returned to Admin").inputValue(),
      "200"
    );
    await d.getByRole("button", { name: "Save", exact: true }).click();
    await review
      .getByRole("button", { name: "Confirm Save", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#admin-dialog").open
    );
    assert.equal(mutations[1].action, "return");
    assert.equal(mutations[1].value, "200");
    assert.equal(mutations[1].reason_text, "Unused cash returned after duty.");
    assert.equal(opening, 1300);
    assert.equal(closing, 1500);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth
        ),
        false
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS: opening additions and returned cash preview correct balances, confirmation shows before/after, over-return blocked, cancel does not mutate, save sends current balance checks and refreshes totals. Mocked API."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
