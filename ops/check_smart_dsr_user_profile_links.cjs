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
    let permitted = true;
    const user = "sales+dsr@example.test",
      profile = { name: user, account: user, employee_name: "Sales User" };
    await page.route("**/api/method/srv_erp.smart_dsr.admin.*", (r) => {
      const method = r.request().url().split(".").pop();
      const message =
        method === "bootstrap"
          ? {
              user: "Administrator",
              today: "2026-11-20",
              users: [],
              can_manage_users: true,
              can_edit_user_profiles: permitted,
              can_create_users: permitted,
            }
          : method === "list_records"
          ? { rows: [profile], total: 1, page_size: 20 }
          : method === "details"
          ? {
              profile,
              current_duty: null,
              duties: { rows: [] },
              dsrs: { rows: [] },
              ledger: { rows: [] },
            }
          : {};
      return r.fulfill({ json: { message } });
    });
    const dir = path.join(__dirname, "../srv_erp/public/smart_dsr");
    await page.route("**/user-links-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<div id="dsr-admin"></div><script>${fs.readFileSync(
          dir + "/admin.js"
        )}</script>`,
      })
    );
    await page.route("**/app/user/**", (r) =>
      r.fulfill({ contentType: "text/html", body: "<h1>Native User form</h1>" })
    );
    const start = "http://localhost/user-links-test#people";
    await page.goto(start);
    await page
      .getByRole("button", { name: "View Details", exact: true })
      .waitFor();
    assert.equal(
      await page
        .locator("tbody")
        .getByRole("link", { name: "Edit User Profile", exact: true })
        .count(),
      0
    );
    await page
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    const edit = page
      .locator("#admin-dialog")
      .getByRole("link", { name: "Edit User Profile", exact: true });
    await edit.waitFor();
    assert.match(await edit.getAttribute("class"), /btn-default/);
    assert.equal(
      await edit.getAttribute("href"),
      "/app/user/" + encodeURIComponent(user)
    );
    await edit.click();
    await page.waitForURL("**/app/user/**");
    assert.equal(
      new URL(page.url()).pathname,
      "/app/user/" + encodeURIComponent(user)
    );
    await page.goto(start);
    await page
      .getByRole("link", { name: "Add Salesperson", exact: true })
      .click();
    await page.waitForURL("**/app/user/new-user-1");
    await page.goto(start);
    await page
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    const detailEdit = page
      .locator("#admin-dialog")
      .getByRole("link", { name: "Edit User Profile", exact: true });
    await detailEdit.waitFor();
    assert.equal(
      await detailEdit.getAttribute("href"),
      "/app/user/" + encodeURIComponent(user)
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator('nav a[href="#balances"]').click();
    await page
      .getByRole("heading", { name: "Opening Balances", level: 1, exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("link", { name: "Add Salesperson", exact: true })
        .count(),
      0
    );
    assert.equal(
      await page
        .getByRole("link", { name: "Edit User Profile", exact: true })
        .count(),
      0
    );
    permitted = false;
    await page.goto(start);
    await page.reload();
    await page
      .getByRole("button", { name: "View Details", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("link", { name: "Add Salesperson", exact: true })
        .count(),
      0
    );
    assert.equal(
      await page
        .getByRole("link", { name: "Edit User Profile", exact: true })
        .count(),
      0
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: salesperson table has no edit link; Frappe-styled detail action opens exact User profile; Add Salesperson opens New User; controls stay in Salespersons and respect User permissions. Mocked native routes/API."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
