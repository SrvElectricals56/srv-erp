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
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const dealers = [
      { name: "dealer-a", customer_name: "Dealer Alpha" },
      { name: "dealer-b", customer_name: "Dealer Beta" },
    ];
    await page.route("**/api/method/srv_erp.smart_dsr.admin.*", (r) => {
      const method = r.request().url().split(".").pop(),
        body = r.request().postDataJSON();
      let message;
      if (method === "bootstrap")
        message = {
          user: "Administrator",
          today: "2026-11-20",
          users: [
            { name: "sales-a@test", full_name: "Sales A" },
            { name: "sales-b@test", full_name: "Sales B" },
          ],
        };
      else if (method === "visit_dealer_options")
        message =
          body.account === "sales-a@test"
            ? [dealers[0]]
            : body.account === "sales-b@test"
            ? [dealers[1]]
            : dealers;
      else if (method === "list_records") {
        queries.push(body);
        message = { rows: [], total: 0, page_size: 20 };
      } else message = {};
      return r.fulfill({ json: { message } });
    });
    const dir = path.join(__dirname, "../srv_erp/public/smart_dsr");
    await page.route("**/party-filters-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<meta charset="utf-8"><style>:root{--fg-color:#fff;--modal-bg:#fff;--dsr-text:#383838;--dsr-border:#ddd;--control-bg:#f0f0f0;--text-color:#383838;--text-muted:#777;--btn-primary:#171717;--neutral:white;--btn-default-bg:#f3f3f3;--font-stack:Arial,sans-serif}</style><style>${fs.readFileSync(
          dir + "/admin.css"
        )}</style><style>${fs.readFileSync(
          dir + "/frappe-theme.css"
        )}</style><div id="dsr-admin"></div><script>${fs.readFileSync(
          dir + "/admin.js"
        )}</script>`,
      })
    );
    await page.goto("http://localhost/party-filters-test#visits");
    const f = page.locator("#admin-filters"),
      field = f.getByRole("combobox", { name: "Dealer", exact: true }),
      list = f.getByRole("listbox", { name: "Dealer options" });
    await f.waitFor();
    assert.equal(await f.locator("[name=duty],[name=visit_number]").count(), 0);
    await field.click();
    assert.equal(await list.getByRole("option").count(), 3);
    if (process.env.DSR_SCREENSHOT)
      await page.screenshot({ path: process.env.DSR_SCREENSHOT });
    const inputBox = await field.boundingBox(),
      listBox = await list.boundingBox();
    assert(listBox.y >= inputBox.y + inputBox.height);
    await field.fill("ALPHA");
    assert.equal(await list.getByRole("option").count(), 1);
    await list.getByRole("option").filter({ hasText: "Dealer Alpha" }).click();
    assert.equal(await field.getAttribute("aria-expanded"), "false");
    assert.equal(await f.locator("[name=customer]").inputValue(), "dealer-a");
    await f
      .getByLabel("Salesperson", { exact: true })
      .selectOption("sales-b@test");
    await page.waitForFunction(
      () => !document.querySelector("#admin-filters").dataset.dealersLoading
    );
    assert.equal(await f.locator("[name=customer]").inputValue(), "");
    await field.fill("Beta");
    await field.press("ArrowDown");
    await field.press("Enter");
    assert.equal(await f.locator("[name=customer]").inputValue(), "dealer-b");
    await f.getByRole("button", { name: "Apply Filters", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector("#dsr-admin").hasAttribute("aria-busy")
    );
    assert.equal(queries.at(-1).filters.customer, "dealer-b");
    assert.equal(queries.at(-1).filters.duty, undefined);
    assert.equal(queries.at(-1).filters.visit_number, undefined);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const bottom = (selector) =>
      f
        .locator(selector)
        .evaluateAll((nodes) =>
          nodes.map((el) => Math.round(el.getBoundingClientRect().bottom))
        );
    const first = await bottom(
        "label:has([name=search]),label:has([name=account]),label:has([name=customer]),label:has([name=status])"
      ),
      second = await bottom(
        "label:has([name=from_date]),label:has([name=to_date]),label:has([name=all_dates])"
      );
    assert(Math.max(...first) - Math.min(...first) < 3);
    assert(Math.max(...second) - Math.min(...second) < 3);
    assert((await f.locator(".filter-actions").boundingBox()).y > second[0]);
    await f.getByRole("button", { name: "Clear Filters", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector("#dsr-admin").hasAttribute("aria-busy")
    );
    assert.equal(await field.inputValue(), "");
    assert.equal(await f.locator("[name=customer]").inputValue(), "");
    await field.fill("No such dealer");
    await list
      .getByText("No matching dealers found.", { exact: true })
      .waitFor();
    const before = queries.length;
    await f.getByRole("button", { name: "Apply Filters", exact: true }).click();
    assert.equal(queries.length, before);
    assert.equal(await field.evaluate((el) => el.validity.customError), true);
    await f
      .getByRole("button", { name: "Clear dealer selection", exact: true })
      .click();
    assert.equal(await field.evaluate((el) => el.validity.customError), false);
    await page.locator('nav a[href="#collections"]').click();
    await page
      .getByRole("heading", { name: "Collections", level: 1, exact: true })
      .waitFor();
    await field.fill("Alpha");
    await list.getByRole("option").filter({ hasText: "Dealer Alpha" }).click();
    await f.getByRole("button", { name: "Apply Filters", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector("#dsr-admin").hasAttribute("aria-busy")
    );
    assert.equal(queries.at(-1).dataset, "collections");
    assert.equal(queries.at(-1).filters.customer, "dealer-a");
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await field.click();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth
        ),
        false
      );
      await field.press("Escape");
      assert.equal(await field.getAttribute("aria-expanded"), "false");
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS: searchable dealer picker in Party Visits/Collections; downward results, name search, mouse/keyboard selection, salesperson scoping, clear/no-results validation, three-row visit layout and mobile containment. Mocked API."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
