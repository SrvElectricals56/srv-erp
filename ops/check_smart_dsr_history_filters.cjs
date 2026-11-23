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
    const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "geolocation", {
        value: {
          watchPosition() {
            return 1;
          },
          clearWatch() {},
        },
      })
    );
    const duty = {
      name: "current",
      status: "Active",
      work_date: "2026-11-19",
      started_at: "2026-11-19 09:00:00",
    };
    const duties = [
      duty,
      { name: "older-final", status: "Finalized", work_date: "2026-11-18" },
      { name: "older-closed", status: "Closed", work_date: "2026-11-17" },
      {
        name: "older-excluded",
        status: "Finalized",
        no_visit_duty: 1,
        work_date: "2026-11-16",
      },
    ];
    await page.route("**/api/method/**", (r) => {
      const args = JSON.parse(r.request().postData() || "{}");
      const current = {
        duty: r.request().url().endsWith(".summary")
          ? duties.find((row) => row.name === args.duty)
          : duty,
        activities: [],
        expenses: [],
        events: [],
      };
      return r.fulfill({
        json: {
          message: r.request().url().endsWith(".summary")
            ? current
            : { account: "user", employee_name: "User", duties, current },
        },
      });
    });
    const asset = path.join(__dirname, "../srv_erp/public/smart_dsr");
    await page.route("**/history-filter-test*", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<style>${fs.readFileSync(
          asset + "/app.css",
          "utf8"
        )}</style><div id="smart-dsr"></div><script>${fs.readFileSync(
          asset + "/app.js",
          "utf8"
        )}</script>`,
      })
    );
    await page.goto("http://localhost/history-filter-test");
    const history = page.locator("#dsr-history"),
      form = history.locator("form");
    await history.waitFor();
    assert.equal(await history.locator("tbody tr").count(), 3);
    await form.getByLabel("From Date").fill("2026-11-17");
    await form.getByLabel("To Date").fill("2026-11-18");
    await form
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    assert.equal(await history.locator("tbody tr").count(), 2);
    await form.getByLabel("Status", { exact: true }).selectOption("Closed");
    await form
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    assert.equal(await history.locator("tbody tr").count(), 1);
    assert.match(await history.locator("tbody").innerText(), /2026-11-17/);
    await form.getByLabel("Status", { exact: true }).selectOption("no-visits");
    await form
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await history
      .getByText("No DSRs match these filters.", { exact: true })
      .waitFor();
    await form
      .getByRole("button", { name: "Clear Filters", exact: true })
      .click();
    assert.equal(await history.locator("tbody tr").count(), 3);
    assert.equal(await form.getByLabel("From Date").inputValue(), "");
    await form.getByLabel("Status", { exact: true }).selectOption("no-visits");
    await form
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    assert.match(await history.locator("tbody").innerText(), /2026-11-16/);
    assert.equal(
      await history.locator("tbody a").getAttribute("href"),
      "#dsr/older-excluded"
    );
    await form.getByLabel("From Date").fill("2026-11-18");
    await form.getByLabel("To Date").fill("2026-11-17");
    await form
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    assert.equal(
      await form
        .getByLabel("To Date")
        .evaluate((el) => el.validity.customError),
      true
    );
    assert.match(await history.locator("tbody").innerText(), /2026-11-16/);
    await form
      .getByRole("button", { name: "Clear Filters", exact: true })
      .click();
    assert.equal(await history.getByRole("searchbox").count(), 0);
    assert.equal(
      await history
        .getByRole("columnheader", { name: "DSR Number", exact: true })
        .count(),
      0
    );
    await form.getByLabel("Status", { exact: true }).selectOption("Finalized");
    await form
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    assert.equal(await history.locator("tbody tr").count(), 2);
    await history
      .getByRole("button", { name: "Remove Status: Finalized", exact: true })
      .click();
    assert.equal(await history.locator("tbody tr").count(), 3);
    assert.equal(
      await history.locator("[data-remove-history-filter]").count(),
      0
    );
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const bottomEdges = await history
        .locator(".history-filter-toolbar > *")
        .evaluateAll((nodes) =>
          nodes.map((el) => Math.round(el.getBoundingClientRect().bottom))
        );
      assert(
        Math.max(...bottomEdges) - Math.min(...bottomEdges) <= 2,
        "History controls must occupy a single row"
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth
        ),
        false
      );
    }
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth
      ),
      false
    );
    // Dedicated history view retains the filters but renders no workday content.
    duty.status = "Finalized";
    await page.goto("http://localhost/history-filter-test?section=history");
    await page.locator("#dsr-history").waitFor();
    assert.equal(
      await page.locator("#dsr-history tbody a").count(),
      4,
      "Include the latest completed DSR"
    );
    assert.equal(
      await page
        .locator(
          ".workday-heading, #night-stay, #dsr-expenses, .summary-cards, .add-visit, #duty-form"
        )
        .count(),
      0
    );
    await page
      .locator("#dsr-history")
      .getByLabel("Status", { exact: true })
      .selectOption("Closed");
    await page
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    assert.equal(await page.locator("#dsr-history tbody a").count(), 1);
    await page.getByRole("link", { name: "View DSR", exact: true }).click();
    await page
      .getByRole("link", { name: "Back to Previous DSRs", exact: true })
      .waitFor();
    await page
      .getByRole("link", { name: "Back to Previous DSRs", exact: true })
      .click();
    await page.locator(".dsr-history-page").waitFor();
    assert.equal(
      await page
        .locator("#dsr-history")
        .getByLabel("Status", { exact: true })
        .inputValue(),
      "Closed"
    );
    await page
      .getByRole("button", { name: "Clear Filters", exact: true })
      .click();
    assert.equal(await page.locator("#dsr-history tbody a").count(), 4);
    duties.splice(0);
    await page.reload();
    await page
      .getByRole("heading", { name: "Previous DSRs", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Apply Filters", exact: true })
      .waitFor();
    assert.equal(await page.locator("#duty-form").count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: inclusive date range, status, no-visit filter, empty results, reset, invalid range, report links, removed search/number column, removable active tags and single-row desktop/mobile toolbar. API fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
