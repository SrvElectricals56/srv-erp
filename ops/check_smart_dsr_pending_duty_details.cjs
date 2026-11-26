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
      errors = [],
      mutations = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const ago = new Date(Date.now() - 6 * 3600000).toISOString(),
      user = "sales@test";
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
        };
      else if (method === "list_records")
        message = {
          rows: [{ name: user, account: user, employee_name: "Sales User" }],
          total: 1,
          page_size: 20,
        };
      else if (method === "details")
        message = {
          profile: { name: user, account: user, employee_name: "Sales User" },
          current_duty: { name: "qr72m2d290", status: "Active" },
          duties: { rows: [] },
          dsrs: { rows: [] },
          ledger: { rows: [] },
        };
      else if (method === "duty_status_requirements")
        message = {
          duty_started_at: ago,
          visits: [
            {
              name: "visit-1",
              customer: "dealer-1",
              customer_name: "Pending Dealer",
              status: "Open",
              arrived_at: ago,
              photo_missing: true,
            },
          ],
          breaks: [{ name: "break-1", break_type: "Lunch", started_at: ago }],
          stays: [{ name: "stay-1", checked_in_at: ago, address: "Test stay" }],
          odometer: [{ phase: "end", reading: 0 }],
          max_accuracy_m: 50,
        };
      else if (method === "change_duty_status") {
        mutations.push(body);
        message = { audit: "resolved", outcome: "Applied" };
      } else message = {};
      return r.fulfill({ json: { message } });
    });
    const dir = path.join(__dirname, "../srv_erp/public/smart_dsr");
    await page.route("**/pending-duty-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<style>:root{--fg-color:white;--dsr-border:#ddd;--dsr-text:#222}</style><style>${fs.readFileSync(
          dir + "/admin.css"
        )}</style><div id="dsr-admin"></div><script>${fs.readFileSync(
          dir + "/admin.js"
        )}</script>`,
      })
    );
    await page.goto("http://localhost/pending-duty-test#people");
    const d = page.locator("#admin-dialog");
    await page
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    await d.waitFor();
    assert.equal(
      await d
        .getByRole("button", { name: "Edit Duty Status", exact: true })
        .count(),
      0
    );
    assert.equal(
      await d.locator("[data-pending-task],input,textarea,select").count(),
      0
    );
    assert.equal(mutations.length, 0);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: salesperson details keep duty transitions and pending-resolution forms unavailable; opening details does not mutate duty or evidence. Backend pending-resolution rules are covered by test_smart_dsr_admin_pending."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
