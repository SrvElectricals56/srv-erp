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
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const asset = path.resolve(__dirname, "../srv_erp/public/smart_dsr");
    const assets = path.resolve(__dirname, "../../../sites/assets");
    const bundles = JSON.parse(
      fs.readFileSync(assets + "/assets.json", "utf8")
    );
    const deskCss = fs.readFileSync(
      path.join(assets, bundles["desk.bundle.css"].replace("/assets/", "")),
      "utf8"
    );
    const sharedCss = fs.readFileSync(asset + "/frappe-theme.css", "utf8");
    const leaflet = path.resolve(
      __dirname,
      "../../frappe/frappe/public/js/lib/leaflet"
    );
    const long = "LongSalespersonOrDealerName".repeat(5);
    let mode = "form";
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "geolocation", {
        value: {
          getCurrentPosition(ok) {
            ok({
              coords: { latitude: 28, longitude: 77, accuracy: 5 },
              timestamp: Date.now(),
            });
          },
          watchPosition() {
            return 1;
          },
          clearWatch() {},
        },
      })
    );
    const duty = () => ({
      doctype: "DSR Duty Session",
      name: "test-duty",
      account: long + "@example.invalid",
      status: mode === "history" ? "Finalized" : "Active",
      work_date: "2026-11-17",
      started_at: "2026-11-17T08:00:00+05:30",
      ended_at: mode === "history" ? "2026-11-17T18:00:00+05:30" : null,
      vehicle_number: "PB31AB1234",
      opening_balance: 12345678.9,
      verified_km: 123.45,
      estimated_km: 124.56,
    });
    const expenses = [
      {
        category: "Other Business Expenses",
        amount: 123456.78,
        remarks: long,
        posting_status: "Recorded",
      },
    ];
    const summary = () => ({
      duty: duty(),
      available_cash: 12345678.9,
      fuel_reimbursement: 98765.43,
      activities: [
        {
          name: "visit",
          customer: long,
          status: "Completed",
          reward_rule_version: 4,
          reward_points: 19,
        },
      ],
      expenses,
      events: [],
    });
    await page.route("**/api/method/**", (route) => {
      const method = route.request().url().split(".").pop();
      const isAdmin = route.request().url().includes(".admin.");
      let result = {};
      if (method === "bootstrap")
        result = isAdmin
          ? {
              user: long + "@example.invalid",
              today: "2026-11-17",
              users: [{ name: "test", full_name: long }],
              currency: "INR",
            }
          : {
              account: "test",
              employee_name: long,
              sales_person: long,
              configured: true,
              reward_points: 123456.7,
              territories: [],
              vehicles: [
                { registration_number: "PB31AB1234", fuel_type: "Petrol" },
              ],
              current: mode === "form" ? null : summary(),
              duties: [
                {
                  name: "older-duty",
                  status: "Finalized",
                  work_date: "2026-11-16",
                },
              ],
            };
      if (method === "visit_details")
        result = {
          visit: {
            name: "visit",
            duty: "test-duty",
            customer: "dealer",
            status: "Completed",
            arrived_at: "2026-11-17T09:00:00+05:30",
            departed_at: "2026-11-17T10:00:00+05:30",
            latitude: 28,
            longitude: 77,
            accuracy: 5,
            reward_started_at: "2026-11-17T09:00:00+05:30",
            reward_near_seconds: 3600,
            reward_rule_version: 4,
            reward_points: 2,
            travel_duration_seconds: 5400,
          },
          dealer: { customer_name: long, mobile_no: "+91-9876543210" },
          outstanding: { currency: "INR", overdue: 12345 },
          photos: [],
          orders: [{ name: long, grand_total: 150000 }],
          collections: [],
        };
      if (method === "allocated_dealer_overdues")
        result = {
          sales_person: long,
          totals: { INR: 12345678.9 },
          rows: [
            {
              customer: long,
              customer_name: long,
              territory: long,
              currency: "INR",
              overdue_amount: 12345678.9,
              entry_count: 5,
              oldest_due_date: "2026-11-01",
              days_overdue: 16,
            },
          ],
        };
      if (method === "list_records") result = { rows: [duty()], total: 1 };
      if (method === "details") result = { record: duty() };
      if (method === "duty_route")
        result = {
          status: "Active",
          points: [
            {
              latitude: 28,
              longitude: 77,
              accuracy: 5,
              captured_at: "2026-11-17T09:00:00+05:30",
            },
          ],
          segments: [],
          gaps: [],
          visits: [],
          verified_km: 123.45,
        };
      return route.fulfill({ json: { message: result } });
    });
    await page.route("**/reverse-geocode-client**", (route) =>
      route.fulfill({ json: { locality: long, city: long } })
    );
    await page.route("https://tile.openstreetmap.org/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
          "base64"
        ),
      })
    );
    await page.route("**/responsive-sales*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${deskCss}${fs.readFileSync(
          asset + "/app.css",
          "utf8"
        )}${sharedCss}</style></head><body><div id="smart-dsr"></div><script>window.smart_dsr_user='test';window.smart_dsr_csrf='test';window.smart_dsr_sales_home=true</script><script>${fs.readFileSync(
          asset + "/app.js",
          "utf8"
        )}</script></body></html>`,
      })
    );
    await page.route("**/responsive-admin*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${deskCss}${fs.readFileSync(
          leaflet + "/leaflet.css",
          "utf8"
        )}${fs.readFileSync(
          asset + "/admin.css",
          "utf8"
        )}${sharedCss}</style></head><body><div id="dsr-admin"></div><script>window.dsr_admin_csrf='test'</script><script>${fs.readFileSync(
          leaflet + "/leaflet.js",
          "utf8"
        )}</script><script>${fs.readFileSync(
          asset + "/route-map.js",
          "utf8"
        )}</script><script>${fs.readFileSync(
          asset + "/admin.js",
          "utf8"
        )}</script></body></html>`,
      })
    );
    const sizes = [
      [320, 740],
      [360, 800],
      [390, 844],
      [540, 720],
      [600, 900],
      [768, 1024],
      [820, 1180],
      [1024, 768],
      [1280, 800],
      [1440, 1000],
      [1920, 1080],
      [2560, 1440],
      [844, 390],
      [667, 375],
    ];
    const fits = async function (label) {
      for (const box of await page
        .locator(".dealer-overdues-table, .dealer-overdues-table table")
        .all())
        assert.equal(
          await box.evaluate((el) => el.scrollWidth > el.clientWidth),
          false,
          `Dealer overdues scroll: ${label}`
        );
      const palettes = [];
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (theme) => (document.documentElement.dataset.theme = theme),
          theme
        );
        palettes.push(
          await page.locator("#smart-dsr, #dsr-admin").evaluate((el) => {
            const panel = el.querySelector(".panel");
            const input = el.querySelector('input:not([type="checkbox"])');
            const button = el.querySelector(".primary");
            return {
              text: getComputedStyle(el).color,
              panel: panel && getComputedStyle(panel).backgroundColor,
              input: input && getComputedStyle(input).backgroundColor,
              button: button && [
                getComputedStyle(button).backgroundColor,
                getComputedStyle(button).color,
              ],
            };
          })
        );
        if (theme === "dark" && label.endsWith("1440x1000"))
          await page.screenshot({
            path: `/tmp/smart-dsr-screenshots/frappe-dark-${
              label.split(" ")[0]
            }.png`,
          });
      }
      assert.notEqual(
        palettes[0].text,
        palettes[1].text,
        `Text does not follow theme: ${label}`
      );
      assert.notEqual(
        palettes[0].panel,
        palettes[1].panel,
        `Panel does not follow theme: ${label}`
      );
      if (palettes[0].input)
        assert.notEqual(
          palettes[0].input,
          palettes[1].input,
          `Input does not follow theme: ${label}`
        );
      for (const colors of palettes)
        if (colors.button)
          assert.notEqual(
            ...colors.button,
            `Primary button contrast: ${label}`
          );
      await page.evaluate(
        () => (document.documentElement.dataset.theme = "light")
      );
      const dimensions = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      assert(
        dimensions.scroll <= dimensions.width,
        `${label}: page width ${dimensions.scroll} exceeds viewport ${dimensions.width}`
      );
    };
    let checks = 0;
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      for (mode of ["form", "history", "visit"]) {
        await page.goto(
          `http://127.0.0.1:8001/responsive-sales?mode=${mode}${
            mode === "visit" ? "#visit/visit" : ""
          }`
        );
        await page.locator(".summary-cards, .visit-grid").first().waitFor();
        await fits(`sales ${mode} ${width}x${height}`);
        checks++;
        if (mode === "form" && [320, 820, 1440].includes(width))
          await page.screenshot({
            path: `/tmp/smart-dsr-screenshots/responsive-sales-${width}.png`,
          });
        if (mode === "form" && width > 800) {
          const current = await page.locator(".duty-location").boundingBox();
          const meter = await page
            .locator("#duty-form .odometer-capture")
            .boundingBox();
          assert(
            meter.x >= current.x + current.width - 1,
            `meter is not to the right at ${width}`
          );
        }
        if (mode === "history") {
          await page.locator('[data-action="dealer-overdues"]').click();
          await page.getByRole("heading", { name: "Party Overdues" }).waitFor();
          await fits(`overdues ${width}`);
          const box = await page.locator("dialog[open]").boundingBox();
          assert(box.x >= 0 && box.x + box.width <= width + 1);
          assert(box.height <= height);
          await page
            .getByRole("button", { name: "Close", exact: true })
            .click();
          checks++;
        }
      }
      mode = "active";
      await page.goto(
        `http://127.0.0.1:8001/responsive-admin?size=${width}x${height}#duties`
      );
      await page
        .getByRole("button", { name: "View Details", exact: true })
        .waitFor();
      await fits(`admin ${width}`);
      checks++;
      await page
        .getByRole("button", { name: "View Details", exact: true })
        .click();
      await page.getByText(/1 GPS points/).waitFor();
      await fits(`admin route ${width}`);
      const dialog = await page.locator("dialog[open]").boundingBox();
      assert(dialog.x >= 0 && dialog.x + dialog.width <= width + 1);
      assert(dialog.height <= height);
      if ([320, 820, 1440].includes(width)) {
        await page.screenshot({
          path: `/tmp/smart-dsr-screenshots/responsive-admin-${width}.png`,
        });
      }
      checks++;
      await page.getByRole("button", { name: "Close", exact: true }).click();
    }
    assert.deepEqual(errors, []);
    console.log(
      `${checks} responsive checks passed across ${sizes.length} phone/tablet/desktop/landscape viewports, long data, forms, tables, dialogs and maps.`
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
