const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const root = path.resolve(__dirname, "..");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  for (const section of [
    null,
    "history",
    "overdues",
    "expenses",
    "party-items",
  ]) {
    const enabled = Boolean(section);
    const page = await browser.newPage();
    const errors = [];
    await page.route("http://home.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html>" })
    );
    await page.goto("http://home.test/");
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setContent(
      '<nav class="navbar"><ul id="navbar-breadcrumbs" class="navbar-nav"></ul><div class="navbar-collapse"><ul class="navbar-nav"></ul></div></nav><aside>Existing sidebar</aside><main><div class="original">Shared Home</div></main>'
    );
    await page.addScriptTag({
      path: path.resolve(
        root,
        "../frappe/frappe/public/js/lib/jquery/jquery.min.js"
      ),
    });
    await page.evaluate((enabled) => {
      window.__ = (s, args) =>
        args ? s.replace(/\{(\d+)\}/g, (_, i) => args[i]) : s;
      window.format_currency = (v) => `INR ${v}`;
      window.frappe = {
        boot: { salesperson_home: enabled },
        utils: { escape_html: (s) => String(s) },
        get_route: () => ["Workspaces", "Home"],
        xcall: () =>
          Promise.resolve(
            window.homeSnapshot || {
              official_opening_balance: 100,
              current: { duty: { opening_balance: 80 }, available_cash: 125 },
              currency: "INR",
              reward_points: 7,
              overdue_party_count: 2,
            }
          ),
        new_doc: (dt) => (window.lastNewDoc = dt),
        set_route: (...route) => (window.lastRoute = route),
        views: {
          Workspace: class {
            show() {
              window.originalCalled = true;
            }
          },
        },
      };
      frappe.workspace = new frappe.views.Workspace();
      Object.assign(frappe.workspace, {
        body: $("main"),
        all_pages: [],
        page: {
          set_title() {},
          clear_primary_action() {},
          clear_secondary_action() {},
        },
      });
    }, enabled);
    await page.addStyleTag({
      path: path.join(root, "srv_erp/public/css/salesperson_home.css"),
    });
    await page.addScriptTag({
      path: path.join(root, "srv_erp/public/js/salesperson_home.js"),
    });
    await page.evaluate(() => {
      const getRoute = frappe.get_route;
      frappe.get_route = () => null;
      $(document).trigger("app_ready");
      frappe.get_route = getRoute;
      if (frappe.boot.salesperson_home) frappe.workspace.show();
    });
    if (!enabled) {
      assert.equal(await page.locator(".salesperson-home").count(), 0);
      assert.equal(await page.locator(".salesperson-home-link").count(), 0);
    } else {
      await page
        .locator('[data-metric="Closing Balance"]')
        .filter({ hasText: "125" })
        .waitFor();
      assert.equal(await page.locator(".salesperson-home-tile").count(), 12);
      assert.equal(await page.locator(".original").isVisible(), false);
      assert.equal(await page.locator("aside").isVisible(), true);
      assert.equal(await page.locator(".salesperson-home-metric").count(), 3);
      assert.equal(
        await page.locator(".salesperson-overdue-count").textContent(),
        "2"
      );
      assert.equal(
        await page.locator('[data-metric="Opening Balance"]').textContent(),
        "INR 80"
      );
      assert.equal(
        await page.locator('[data-metric="Total Earn Points"]').textContent(),
        "7"
      );
      assert.equal(
        await page.locator(".salesperson-home-link").getAttribute("href"),
        "/app/home"
      );
      await page.evaluate(() => $("#navbar-breadcrumbs").empty());
      assert.equal(await page.locator(".salesperson-home-link").count(), 1);
      await page
        .getByRole("button", { name: "Make Sales Order", exact: true })
        .click();
      assert.equal(await page.evaluate(() => window.lastNewDoc), "Sales Order");
      await page
        .getByRole("button", { name: "Overall Sales Orders", exact: true })
        .click();
      assert.deepEqual(await page.evaluate(() => window.lastRoute), [
        "List",
        "Sales Order",
      ]);
      await page.evaluate(() => {
        frappe.get_route = () => ["Workspaces", "Selling"];
        frappe.workspace.show();
      });
      assert.equal(await page.locator(".salesperson-home").count(), 0);
      assert.equal(await page.evaluate(() => window.originalCalled), true);
      assert.equal(await page.locator(".original").isVisible(), true);
      await page.evaluate(() => {
        frappe.get_route = () => ["Workspaces", "Home"];
        frappe.workspace.show();
      });
      await page.evaluate(() => {
        window.homeSnapshot = {
          official_opening_balance: null,
          current: null,
          reward_points: -1,
        };
        frappe.workspace.show();
      });
      await page
        .locator('[data-metric="Opening Balance"]')
        .filter({ hasText: "Not initialized" })
        .waitFor();
      assert.equal(
        await page.locator('[data-metric="Closing Balance"]').textContent(),
        "Not initialized"
      );
      assert.equal(
        await page.locator('[data-metric="Total Earn Points"]').textContent(),
        "-1"
      );
      await page
        .getByRole("button", {
          name:
            section === "history"
              ? "DSR History"
              : section === "overdues"
              ? "Party Overdues: 0 parties"
              : section === "expenses"
              ? "Expenses"
              : "Party Top Items",
          exact: true,
        })
        .click();
      await page.waitForURL(
        "http://home.test/app/smart-dsr?section=" + section
      );
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  await browser.close();
  console.log(
    "PASS: scoped home, metrics, 12 tiles, navigation, shared workspace restoration, persistent Home link. Isolated Desk fixtures."
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
