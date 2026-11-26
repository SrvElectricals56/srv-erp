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
    const user = "sales@example.test",
      profile = {
        name: user,
        account: user,
        employee_name: "Sales User",
        smart_dsr_disabled: 0,
      },
      duty = { name: "duty-1", status: "Active" };
    await page.route("**/api/method/srv_erp.smart_dsr.admin.*", (r) => {
      const method = r.request().url().split(".").pop(),
        body = r.request().postDataJSON();
      let message;
      if (method === "bootstrap")
        message = {
          user: "Administrator",
          today: "2026-11-20",
          users: [],
          can_manage_users: true,
          can_finance: true,
        };
      else if (method === "list_records")
        message = { rows: [profile], total: 1, page_size: 20 };
      else if (method === "details")
        message = {
          profile,
          current_duty: duty,
          duties: { rows: [] },
          dsrs: { rows: [] },
          ledger: { rows: [] },
        };
      else if (["manage_user", "change_duty_status"].includes(method)) {
        mutations.push({ method, ...body });
        message = { audit: "test", outcome: "Applied" };
      } else message = {};
      return r.fulfill({ json: { message } });
    });
    const dir = path.join(__dirname, "../srv_erp/public/smart_dsr");
    await page.route("**/controls-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<style>${fs.readFileSync(
          dir + "/admin.css"
        )}</style><div id="dsr-admin"></div><script>${fs.readFileSync(
          dir + "/admin.js"
        )}</script>`,
      })
    );
    await page.goto("http://localhost/controls-test#people");
    const d = page.locator("#admin-dialog"),
      confirm = page.locator("#admin-save-confirm");
    await page
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    assert.equal(
      await d
        .getByRole("button", { name: "Edit Duty Status", exact: true })
        .count(),
      0
    );
    assert.equal(await d.locator(".detail-actions button").count(), 1);
    await d
      .getByRole("button", { name: "Edit Smart DSR Access", exact: true })
      .click();
    assert.equal(await d.locator("select").count(), 1);
    await d.getByLabel("Smart DSR Access", { exact: true }).selectOption("0");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    assert.match(await confirm.innerText(), /Smart DSR Access/);
    assert.match(await confirm.innerText(), /Deactivated/);
    await confirm
      .getByRole("button", { name: "Confirm Save", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#admin-dialog").open
    );
    assert.equal(mutations[0].method, "manage_user");
    assert.equal(mutations[0].access_enabled, "0");
    assert.equal(mutations[0].user, user);
    assert.equal(mutations[0].profile_changes, undefined);
    assert.equal(mutations[0].sales_roles, undefined);
    await page.locator('nav a[href="#balances"]').click();
    await page
      .getByRole("heading", { name: "Opening Balances", level: 1, exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    await d.getByText("Salesperson Profile", { exact: true }).waitFor();
    assert.equal(
      await d
        .getByRole("button", { name: "Add Opening Amount", exact: true })
        .count(),
      1
    );
    assert.equal(
      await d
        .getByRole("button", { name: "Record Returned Cash", exact: true })
        .count(),
      1
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Salespersons exposes DSR access and read-only duty status; centered confirmation/cancel; narrow mutation payloads; no role/profile edits; Opening Balances exposes only its cash issue/return controls. Mocked API."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
