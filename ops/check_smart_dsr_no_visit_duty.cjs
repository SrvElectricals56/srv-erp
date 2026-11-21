const { chromium } = require("playwright");
const fs = require("fs"),
  path = require("path"),
  assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  try {
    for (const zeroVisits of [true, false]) {
      const page = await browser.newPage({ permissions: ["camera"] });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() =>
        Object.defineProperty(navigator, "geolocation", {
          value: {
            getCurrentPosition(ok) {
              ok({
                timestamp: Date.now(),
                coords: { latitude: 28, longitude: 77, accuracy: 5 },
              });
            },
            watchPosition() {
              return 1;
            },
            clearWatch() {},
          },
        })
      );
      let submitted;
      const duty = {
        name: "duty",
        status: "Active",
        started_at: "2026-11-17T09:00:00+05:30",
        opening_balance: 1000,
        vehicle_number: "PB31AB1234",
        odometer_start: 1000,
        odometer_start_photo: "/private/files/start.jpg",
        verified_km: 10,
      };
      const expense = {
        category: "Breakfast",
        amount: 150,
        paid_from_cash: 1,
        posting_status: "Recorded",
      };
      await page.route("**/api/method/**", (route) => {
        const method = route.request().url().split(".").pop();
        let result = {};
        if (method === "duty_off_readiness")
          result = {
            ready: true,
            tasks: [],
            requires_no_visit_reason: zeroVisits,
          };
        if (method === "odometer_camera_challenge") result = "test-token";
        if (method === "end_workday") {
          submitted = route.request().postDataJSON();
          duty.status = "Finalized";
          duty.ended_at = new Date().toISOString();
          if (zeroVisits) {
            duty.no_visit_duty = 1;
            duty.duty_off_reason = submitted.duty_off_reason;
            expense.posting_status = "Reversed";
          }
        }
        if (method === "bootstrap")
          result = {
            account: "test",
            employee_name: "Test",
            current: {
              duty,
              available_cash: duty.no_visit_duty ? 1000 : 850,
              fuel_reimbursement: duty.no_visit_duty ? 0 : 80,
              activities: [],
              expenses: [expense],
              events: [],
            },
          };
        return route.fulfill({ json: { message: result } });
      });
      const source = fs.readFileSync(
        path.resolve(__dirname, "../srv_erp/public/smart_dsr/app.js"),
        "utf8"
      );
      const css = fs.readFileSync(
        path.resolve(__dirname, "../srv_erp/public/smart_dsr/app.css"),
        "utf8"
      );
      await page.route("**/no-visit-test", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="smart-dsr"></div><script>window.smart_dsr_user='test'</script><script>${source}</script></body></html>`,
        })
      );
      await page.goto("http://localhost/no-visit-test");
      await page.getByRole("button", { name: "Duty OFF", exact: true }).click();
      const form = page.locator("#dsr-dialog form");
      assert.equal(
        await form.locator("[data-no-visit-reason]").isVisible(),
        zeroVisits
      );
      await form.locator("[name=odometer_reading]").fill("1123.45");
      await form.locator("[data-open-odometer]").click();
      await page.waitForFunction(
        () => document.querySelector("#dsr-dialog video")?.videoWidth > 0
      );
      await form.locator("[data-capture-odometer]").click();
      await form.locator("[data-odometer-camera] img").waitFor();
      if (zeroVisits) {
        assert.equal(
          await form.locator("[data-submit-duty-off]").isDisabled(),
          true
        );
        await form.locator("[name=duty_off_reason]").fill("   ");
        assert.equal(
          await form.locator("[data-submit-duty-off]").isDisabled(),
          true
        );
        await form
          .locator("[name=duty_off_reason]")
          .fill("Vehicle breakdown prevented dealer visits");
      }
      await form.locator("[data-submit-duty-off]").click();
      await page.waitForFunction(
        () => !document.querySelector("#dsr-dialog").open
      );
      assert.equal(
        submitted.duty_off_reason,
        zeroVisits ? "Vehicle breakdown prevented dealer visits" : ""
      );
      if (zeroVisits) {
        assert.match(
          await page.locator(".dsr-main").innerText(),
          /No Visits — Excluded/
        );
        assert.equal(
          await page.locator("[data-fuel-cost]").textContent(),
          "₹0.00"
        );
        assert.equal(
          await page.locator(".summary-cards [data-duration]").textContent(),
          "0 min"
        );
        assert.match(
          await page.locator("#dsr-expenses").innerText(),
          /Reversed/
        );
        assert.match(
          await page.locator(".summary-cards .metric").nth(1).innerText(),
          /1,000/
        );
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log(
      "No-visit reason required, whitespace blocked, reason submitted, excluded summary and zero fuel/time; normal visits unchanged. Camera browser checks passed."
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
