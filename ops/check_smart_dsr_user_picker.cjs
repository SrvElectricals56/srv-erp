const { chromium } = require("playwright");
const fs = require("fs"),
  path = require("path"),
  assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    let saved = [],
      queries = [];
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const users = [
      { name: "anu@example.invalid", full_name: "Anu Sharma" },
      ...Array.from({ length: 130 }, (_, index) => ({
        name: `salesperson-${index}@example.invalid`,
        full_name: `Salesperson ${index}`,
      })),
    ];
    await page.route("**/api/method/**", (route) => {
      const method = route.request().url().split(".").pop();
      let result = {};
      if (method === "bootstrap")
        result = {
          user: "Administrator",
          today: "2026-11-17",
          users,
          currency: "INR",
          can_finance: true,
        };
      if (method === "list_records") {
        queries.push(route.request().postDataJSON());
        result = { rows: [], total: 0 };
      }
      if (method === "balance_details")
        result = { opening_balance: 0, current_cash: 0 };
      if (method === "record_opening_movement") {
        saved.push(route.request().postDataJSON());
        result = { audit: "mock-audit" };
      }
      return route.fulfill({ json: { message: result } });
    });
    const dir = path.resolve(__dirname, "../srv_erp/public/smart_dsr");
    await page.route("**/picker-test*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fs.readFileSync(
          dir + "/admin.css",
          "utf8"
        )}</style></head><body><div id="dsr-admin"></div><script>window.dsr_admin_csrf='test'</script><script>${fs.readFileSync(
          dir + "/admin.js",
          "utf8"
        )}</script></body></html>`,
      })
    );
    for (const [width, height] of [
      [1920, 1080],
      [820, 1180],
      [390, 844],
      [320, 740],
      [844, 390],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(
        `http://127.0.0.1:8001/picker-test?width=${width}#balances`
      );
      await page
        .getByRole("button", { name: "Add Opening Amount", exact: true })
        .click();

      const dialog = page.locator("#admin-dialog");
      const field = dialog.locator("select[name=user]");
      await field.waitFor();
      assert.equal(await field.inputValue(), "");
      assert.equal(
        await field.locator("option").first().textContent(),
        "Select User"
      );
      assert.equal(await field.locator("option").count(), users.length + 1);
      assert.equal(await field.getAttribute("required"), "");
      assert.equal(await page.locator("[data-user-picker]").count(), 0);
      const bounds = await dialog.boundingBox(),
        control = await field.boundingBox();
      assert(
        control.x >= bounds.x &&
          control.x + control.width <= bounds.x + bounds.width + 1
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        ),
        true
      );
      await field.selectOption("anu@example.invalid");
      assert.equal(await field.inputValue(), "anu@example.invalid");
      assert.match(
        await field.locator("option:checked").textContent(),
        /Anu Sharma/
      );
      await dialog.locator("[name=value]").fill("1000");
      await dialog
        .locator("[name=reason_text]")
        .fill("Authorized opening balance");
      const before = saved.length;
      await dialog.getByRole("button", { name: "Save" }).click();
      await page
        .locator("#admin-save-confirm")
        .getByRole("button", { name: "Confirm Save", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#admin-dialog").open
      );
      assert.equal(saved.length, before + 1);
      assert.equal(saved.at(-1).user, "anu@example.invalid");
      assert.equal(saved.at(-1).value, "1000");
      const filter = page.locator("#admin-filters select[name=account]");
      assert.equal(
        await filter.locator("option").first().textContent(),
        "All Users"
      );
      await filter.selectOption("anu@example.invalid");
      await page.getByRole("button", { name: "Apply Filters" }).click();
      await page.waitForFunction(
        () => !document.querySelector("#dsr-admin").hasAttribute("aria-busy")
      );
      assert.equal(queries.at(-1).filters.account, "anu@example.invalid");
    }
    assert.deepEqual(errors, []);
    console.log(
      "Native User select: default option, all users listed, correct email submission, filters and layout passed at 5 desktop/tablet/phone/landscape sizes."
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
