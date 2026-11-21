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
      queries = [],
      saves = [],
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const duty = {
      doctype: "DSR Duty Session",
      name: "duty-1",
      account: "sales@test",
      work_date: "2026-11-20",
      status: "Active",
      started_at: "2026-11-20T09:00:00+05:30",
      creation: "2026-11-20T08:00:00+05:30",
      duty_minutes: 60,
      closing_balance: 1000,
    };
    const vehicle = {
      name: "vehicle-1",
      registration_number: "PB31AB1234",
      allocated_to: "sales@test",
      fuel_type: "Diesel",
      insurance_expiry: "2099-12-31",
      puc_expiry: "2027-01-01",
      status: "Active",
    };
    await page.route("**/api/method/srv_erp.smart_dsr.admin.*", (r) => {
      const method = r.request().url().split(".").pop(),
        body = r.request().postDataJSON();
      let message;
      if (method === "bootstrap")
        message = {
          user: "Administrator",
          today: "2026-11-20",
          users: [{ name: "sales@test", full_name: "Sales User" }],
        };
      else if (method === "list_records") {
        queries.push(body);
        message = {
          rows: [body.dataset === "vehicles" ? vehicle : duty],
          total: 1,
          page_size: 20,
        };
      } else if (method === "details")
        message = { record: body.dataset === "vehicles" ? vehicle : duty };
      else if (method === "manage_vehicle") {
        saves.push(body);
        message = { audit: "test", outcome: "Applied" };
      } else message = {};
      return r.fulfill({ json: { message } });
    });
    const dir = path.join(__dirname, "../srv_erp/public/smart_dsr");
    await page.route("**/short-date-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<meta charset="utf-8"><style>${fs.readFileSync(
          dir + "/admin.css"
        )}</style><div id="dsr-admin"></div><script>${fs.readFileSync(
          dir + "/admin.js"
        )}</script>`,
      })
    );
    await page.goto("http://localhost/short-date-test#duties");
    const f = page.locator("#admin-filters"),
      from = f.getByRole("textbox", { name: "From Date", exact: true }),
      to = f.getByRole("textbox", { name: "To Date", exact: true });
    await from.waitFor();
    assert.equal(await from.inputValue(), "20-11-26");
    assert.match(
      await page.locator(".duty-records-table").innerText(),
      /20-11-26/
    );
    assert.doesNotMatch(
      await page.locator(".duty-records-table").innerText(),
      /2026/
    );
    await from.fill("191126");
    await to.focus();
    assert.equal(await from.inputValue(), "19-11-26");
    await f.getByRole("button", { name: "Apply Filters", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector("#dsr-admin").hasAttribute("aria-busy")
    );
    assert.equal(queries.at(-1).filters.from_date, "2026-11-19");
    await from.fill("31-02-26");
    const count = queries.length;
    await f.getByRole("button", { name: "Apply Filters", exact: true }).click();
    assert.equal(queries.length, count);
    assert.equal(await from.evaluate((el) => el.validity.customError), true);
    await from.fill("19-11-26");
    await to.fill("18-11-26");
    await f.getByRole("button", { name: "Apply Filters", exact: true }).click();
    assert.equal(await to.evaluate((el) => el.validity.customError), true);
    await f.getByRole("button", { name: "Clear Filters", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector("#dsr-admin").hasAttribute("aria-busy")
    );
    await f
      .locator('[data-admin-date="to_date"] [data-date-native]')
      .evaluate((el) => {
        el.value = "2027-01-03";
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    assert.equal(await to.inputValue(), "03-01-27");
    assert.equal(await f.locator("[name=to_date]").inputValue(), "2027-01-03");
    await f.getByLabel("All dates", { exact: true }).check();
    assert.equal(await from.isDisabled(), true);
    await f.getByRole("button", { name: "Apply Filters", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector("#dsr-admin").hasAttribute("aria-busy")
    );
    assert.equal(queries.at(-1).filters.all_dates, true);
    assert.equal(queries.at(-1).filters.from_date, undefined);
    await page
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    const d = page.locator("#admin-dialog");
    await d.getByText("20-11-26, 08:00 am", { exact: true }).waitFor();
    assert.doesNotMatch(await d.innerText(), /2026-11-20/);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.locator('nav a[href="#vehicles"]').click();
    await page
      .getByRole("heading", { name: "Vehicles", level: 1, exact: true })
      .waitFor();
    await page.getByRole("cell", { name: "31-12-99", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    await d.getByRole("button", { name: "Edit Vehicle", exact: true }).click();
    const expiry = d.getByRole("textbox", {
      name: "Insurance Expiry (optional)",
      exact: true,
    });
    assert.equal(await expiry.inputValue(), "31-12-99");
    assert.equal(
      await d.locator("[name=insurance_expiry]").inputValue(),
      "2099-12-31"
    );
    await expiry.fill("30-12-99");
    await d.getByRole("button", { name: "Save Vehicle", exact: true }).click();
    const review = page.locator("#admin-save-confirm");
    await review.waitFor();
    assert.match(await review.innerText(), /31-12-99/);
    assert.match(await review.innerText(), /30-12-99/);
    await review
      .getByRole("button", { name: "Confirm Save", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#admin-dialog").open
    );
    assert.equal(saves[0].values.insurance_expiry, "2099-12-30");
    assert.deepEqual(errors, []);
    console.log(
      "PASS: DD-MM-YY in duty dates/details/expiry controls; ISO filter/save payloads; invalid dates/ranges blocked; calendar synchronization; All dates; two-digit confirmation and full-year storage. Mocked API."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
