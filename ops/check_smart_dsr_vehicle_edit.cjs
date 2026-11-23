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
    const vehicle = {
      name: "vehicle-1",
      registration_number: "PB31AB1234",
      allocated_to: "sales@test",
      allocated_to_name: "Sales User",
      fuel_type: "Diesel",
      insurance_available: 1,
      puc_available: 1,
      rc_available: 1,
      fastag_available: 0,
      insurance_expiry: "2027-01-01",
      puc_expiry: "2027-02-01",
      rc_expiry: "2027-03-01",
      status: "Active",
    };
    await page.route("**/api/method/srv_erp.smart_dsr.admin.*", (r) => {
      const method = r.request().url().split(".").pop(),
        body = r.request().postDataJSON();
      let message;
      if (method === "bootstrap")
        message = { user: "Administrator", today: "2026-11-20", users: [] };
      else if (method === "list_records")
        message = { rows: [vehicle], total: 1 };
      else if (method === "details") message = { record: vehicle };
      else if (method === "manage_vehicle") {
        mutations.push(body);
        Object.assign(vehicle, body.values);
        message = { audit: "vehicle-edit", outcome: "Applied" };
      } else message = {};
      return r.fulfill({ json: { message } });
    });
    const dir = path.join(__dirname, "../srv_erp/public/smart_dsr");
    await page.route("**/vehicle-edit-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<meta charset="utf-8"><div id="dsr-admin"></div><script>${fs.readFileSync(
          dir + "/admin.js"
        )}</script>`,
      })
    );
    await page.goto("http://localhost/vehicle-edit-test#vehicles");
    await page
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    const d = page.locator("#admin-dialog");
    await d.getByRole("button", { name: "Edit Vehicle", exact: true }).click();
    assert.equal(
      await d.locator("[name=allocated_to]").inputValue(),
      "sales@test"
    );
    assert.equal(
      await d.getByLabel("Vehicle Number", { exact: true }).inputValue(),
      "PB31AB1234"
    );
    assert.equal(
      await d.getByLabel("Fuel Type", { exact: true }).inputValue(),
      "Diesel"
    );
    assert.equal(
      await d.locator("[name=insurance_expiry]").inputValue(),
      "2027-01-01"
    );
    assert.equal(
      await d
        .locator("input[type=checkbox][name=fastag_available]")
        .isChecked(),
      false
    );
    await d.getByLabel("Fuel Type", { exact: true }).selectOption("CNG");
    await d.getByLabel("Status", { exact: true }).selectOption("Inactive");
    await d.getByRole("button", { name: "Save Vehicle", exact: true }).click();
    const review = page.locator("#admin-save-confirm");
    await review.waitFor();
    assert.match(await review.innerText(), /Diesel/);
    assert.match(await review.innerText(), /CNG/);
    assert.match(await review.innerText(), /Inactive/);
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(mutations.length, 0);
    await d.getByRole("button", { name: "Save Vehicle", exact: true }).click();
    await review
      .getByRole("button", { name: "Confirm Save", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#admin-dialog").open
    );
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].name, "vehicle-1");
    assert.equal(mutations[0].values.fuel_type, "CNG");
    assert.equal(mutations[0].values.status, "Inactive");
    assert.equal(mutations[0].values.allocated_to, "sales@test");
    assert.equal(mutations[0].values.insurance_expiry, "2027-01-01");
    assert.equal(mutations[0].values.fastag_available, "0");
    assert.deepEqual(errors, []);
    console.log(
      "PASS: saved vehicle View Details offers Edit Vehicle; existing values and allocation prefill; centered diff/cancel; save targets same record and preserves unchanged fields. Mocked API."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
