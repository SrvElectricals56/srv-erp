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
      queries = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const rows = [
      {
        name: "duty-1",
        account: "sales@test",
        salesperson_name: "Sales User",
        work_date: "2026-11-20",
        status: "Active",
        vehicle_number: "PB31AB1234",
        started_at: "2026-11-20T09:00:00+05:30",
        duty_minutes: 125,
        verified_km: 15.24,
        closing_balance: 1500,
      },
      {
        name: "duty-2",
        account: "sales@test",
        salesperson_name: "Sales User",
        work_date: "2026-11-19",
        status: "Closed",
        vehicle_number: "PB31AB1234",
        started_at: "2026-11-19T09:00:00+05:30",
        ended_at: "2026-11-19T17:00:00+05:30",
        duty_minutes: 480,
        verified_km: 42.6,
        closing_balance: 1700,
      },
    ];
    await page.route("**/api/method/srv_erp.smart_dsr.admin.*", (r) => {
      const method = r.request().url().split(".").pop(),
        body = r.request().postDataJSON();
      if (method === "list_records") queries.push(body);
      return r.fulfill({
        json: {
          message:
            method === "bootstrap"
              ? {
                  user: "Administrator",
                  today: "2026-11-20",
                  users: [{ name: "sales@test", full_name: "Sales User" }],
                }
              : method === "list_records"
              ? { rows, total: 2, page_size: 20 }
              : method === "details"
              ? { record: rows[0] }
              : {},
        },
      });
    });
    const dir = path.join(__dirname, "../srv_erp/public/smart_dsr");
    await page.route("**/duty-layout-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<meta charset="utf-8"><style>:root{--font-stack:Arial,sans-serif;--fg-color:#fff;--modal-bg:#fff;--dsr-bg:#f8f8f8;--text-color:#383838;--dsr-text:#383838;--dsr-muted:#666;--dsr-border:#ddd;--border-color:#ddd;--control-bg:#f3f3f3;--subtle-accent:#f5f5f5;--btn-default-bg:#f0f0f0}</style><style>${fs.readFileSync(
          dir + "/admin.css"
        )}</style><div id="dsr-admin"></div><script>${fs.readFileSync(
          dir + "/admin.js"
        )}</script>`,
      })
    );
    await page.goto("http://localhost/duty-layout-test#duties");
    const filters = page.locator("#admin-filters");
    await filters.waitFor();
    assert.equal(await filters.locator("[name=fuel_type]").count(), 0);
    assert.equal(
      await page
        .getByRole("columnheader", { name: "Fuel Type", exact: true })
        .count(),
      0
    );
    await page.getByText("End: In progress", { exact: true }).waitFor();
    assert.equal(await page.locator(".duty-status").count(), 2);
    await filters
      .getByLabel("Search Duty Records", { exact: true })
      .fill("PB31");
    await filters
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#dsr-admin").hasAttribute("aria-busy")
    );
    assert.equal(queries.at(-1).filters.search, "PB31");
    assert.equal(queries.at(-1).filters.fuel_type, undefined);
    await filters
      .getByRole("button", { name: "Clear Filters", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#dsr-admin").hasAttribute("aria-busy")
    );
    assert.equal(
      await filters
        .getByLabel("Search Duty Records", { exact: true })
        .inputValue(),
      ""
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth
        ),
        false
      );
      const a = await filters
          .getByRole("button", { name: "Apply Filters", exact: true })
          .boundingBox(),
        c = await filters
          .getByRole("button", { name: "Clear Filters", exact: true })
          .boundingBox();
      assert.equal(Math.round(a.y), Math.round(c.y));
      if (width === 390)
        assert(
          await page
            .locator(".duty-records-scroll")
            .evaluate((el) => el.scrollWidth > el.clientWidth)
        );
      else {
        const primary = await filters
          .locator(
            "label:has([name=search]), label:has([name=account]), label:has([name=status])"
          )
          .evaluateAll((nodes) =>
            nodes.map((el) => Math.round(el.getBoundingClientRect().bottom))
          );
        assert(Math.max(...primary) - Math.min(...primary) < 3);
        const secondary = await filters
          .locator(
            "label:has([name=from_date]), label:has([name=to_date]), .filter-actions"
          )
          .evaluateAll((nodes) =>
            nodes.map((el) => Math.round(el.getBoundingClientRect().bottom))
          );
        assert(Math.max(...secondary) - Math.min(...secondary) < 3);
        assert(secondary[0] > primary[0]);
        if (process.env.DSR_SCREENSHOT)
          await page.screenshot({ path: process.env.DSR_SCREENSHOT });
      }
    }
    await page
      .locator("tbody")
      .getByRole("button", { name: "View Details", exact: true })
      .first()
      .click();
    await page.locator("#admin-dialog").waitFor();
    assert.equal(await page.locator("#admin-dialog form").count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Duty Records has no fuel filter, scoped search payload, status badges and grouped times; Apply/Clear adjacent; contained mobile scroll; read-only details retained. Mocked API."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
