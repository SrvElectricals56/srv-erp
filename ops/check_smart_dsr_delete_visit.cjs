const { chromium } = require("playwright");
const fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const visits = [
      {
        name: "pending",
        duty: "duty",
        visit_number: 1,
        customer: "Pending Dealer",
        status: "Open",
      },
      {
        name: "completed",
        duty: "duty",
        visit_number: 2,
        customer: "Submitted Dealer",
        status: "Completed",
      },
    ];
    let deletions = 0,
      blocked = false;
    const duty = {
      name: "duty",
      status: "Active",
      started_at: "2026-11-16 06:00:00",
    };
    await page.route("**/api/method/srv_erp.smart_dsr.api.*", (r) => {
      const method = r.request().url().split(".").pop(),
        data = r.request().postDataJSON();
      let message = {};
      if (method === "bootstrap")
        message = {
          account: "user",
          employee_name: "User",
          current: {
            duty,
            activities: visits.filter((v) => v.status !== "Deleted"),
            expenses: [],
            events: [],
          },
        };
      if (method === "visit_details")
        message = {
          visit: {
            ...visits.find((v) => v.name === data.activity),
            visit_number:
              visits
                .filter((v) => v.status !== "Deleted")
                .findIndex((v) => v.name === data.activity) + 1,
          },
          dealer: { customer_name: "Dealer" },
          photos: [],
          orders: [],
          collections: [],
          outstanding: { currency: "INR", overdue: 0 },
        };
      if (method === "delete_pending_visit") {
        deletions++;
        if (blocked)
          return r.fulfill({
            status: 417,
            json: {
              message: "This pending visit has linked payments or orders.",
            },
          });
        visits.find((v) => v.name === data.activity).status = "Deleted";
        message = { deleted: data.activity };
      }
      return r.fulfill({ json: { message } });
    });
    const source = fs.readFileSync(
      path.join(__dirname, "../srv_erp/public/smart_dsr/app.js"),
      "utf8"
    );
    const css = fs.readFileSync(
      path.join(__dirname, "../srv_erp/public/smart_dsr/app.css"),
      "utf8"
    );
    await page.route("**/delete-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<meta charset="utf-8"><style>${css}</style><div id="smart-dsr"></div><script>window.smart_dsr_user='user';</script><script>${source}</script>`,
      })
    );
    await page.goto("http://localhost/delete-test");
    await page.locator('a[href="#visit/pending"]').waitFor();
    assert.equal(await page.locator("[data-delete-visit]").count(), 0);
    await page.locator('a[href="#visit/pending"]').click();
    await page
      .getByRole("button", { name: "Delete Visit", exact: true })
      .waitFor();
    assert.equal(await page.locator("[data-delete-visit]").count(), 1);
    assert.equal(await page.locator(".badge.pending").innerText(), "Pending");
    assert.equal(await page.locator(".badge.pending").isVisible(), true);
    await page
      .getByRole("button", { name: "Delete Visit", exact: true })
      .click();
    await page.locator("[data-cancel-delete]").click();
    assert.equal(deletions, 0);
    await page
      .getByRole("button", { name: "Delete Visit", exact: true })
      .click();
    await page.locator("[data-confirm-delete]").click();
    await page.waitForFunction(
      () => !document.querySelector('[data-delete-visit="pending"]')
    );
    assert.equal(deletions, 1);
    assert.equal(visits[0].status, "Deleted");
    assert.equal(
      await page
        .locator("table tbody tr")
        .filter({ has: page.locator('a[href="#visit/completed"]') })
        .locator("td")
        .first()
        .innerText(),
      "1"
    );
    visits.push({
      name: "pending-two",
      duty: "duty",
      visit_number: 3,
      customer: "Second Pending Dealer",
      status: "Open",
    });
    await page.reload();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('a[href="#visit/pending-two"]').click();
    await page
      .getByRole("button", { name: "Delete Visit", exact: true })
      .waitFor();
    blocked = true;
    await page
      .getByRole("button", { name: "Delete Visit", exact: true })
      .click();
    await page.locator("[data-confirm-delete]").click();
    await page.locator("[data-delete-error]:not([hidden])").waitFor();
    assert.equal(visits.at(-1).status, "Open");
    assert.match(
      await page.locator("[data-delete-error]").innerText(),
      /linked payments or orders/
    );
    blocked = false;
    await page.locator("[data-confirm-delete]").click();
    await page.waitForFunction(() => location.hash === "");
    await page.locator('a[href="#visit/completed"]').click();
    await page.getByText("Submitted · Read only", { exact: true }).waitFor();
    await page
      .getByRole("heading", { name: "Party Visit 1", exact: true })
      .waitFor();
    assert.equal(await page.locator("[data-delete-visit]").count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: pending-only delete inside details; no delete in Party Visits list, orange Pending status, cancel preserves visit, successful delete removes row, linked financial records show error, completed visit has no delete action. API fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
