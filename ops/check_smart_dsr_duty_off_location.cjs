const { chromium } = require("playwright");
const fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict");
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
    for (const mode of ["recent", "stale", "timeout", "exception", "denied"]) {
      const page = await browser.newPage({ permissions: ["camera"] });
      await page.addInitScript((mode) => {
        window.attempts = [];
        Object.defineProperty(navigator, "geolocation", {
          value: {
            getCurrentPosition(ok, fail, options) {
              window.attempts.push(options);
              setTimeout(() => {
                if (
                  (mode === "recent" || mode === "stale") &&
                  options.maximumAge > 0
                )
                  ok({
                    timestamp: Date.now() - (mode === "recent" ? 10000 : 60000),
                    coords: { latitude: 28, longitude: 77, accuracy: 500 },
                  });
                else fail({ code: mode === "denied" ? 1 : 3 });
              }, 0);
            },
            watchPosition() {
              return 1;
            },
            clearWatch() {},
          },
        });
      }, mode);
      let submitted;
      const duty = {
        opening_balance: 1000,
        name: "test-duty",
        status: "Active",
        started_at: "2026-11-16 09:00:00",
        gps_exception: mode === "exception" ? "Authorized reason" : null,
      };
      await page.route("**/api/method/srv_erp.smart_dsr.api.*", (r) => {
        const method = r.request().url().split(".").pop();
        if (method === "duty_off_readiness")
          return r.fulfill({ json: { message: { ready: true, tasks: [] } } });
        if (method === "odometer_camera_challenge")
          return r.fulfill({ json: { message: "ending-odometer-token" } });
        if (method === "end_workday") {
          submitted = r.request().postDataJSON();
          duty.status = "Finalized";
        }
        return r.fulfill({
          json: {
            message:
              method === "bootstrap"
                ? {
                    account: "test",
                    employee_name: "Test",
                    current: {
                      duty,
                      available_cash: 1250,
                      activities: [],
                      events: [],
                    },
                  }
                : {},
          },
        });
      });
      const source = fs.readFileSync(
        path.join(__dirname, "../srv_erp/public/smart_dsr/app.js"),
        "utf8"
      );
      await page.route("**/duty-off-test", (r) =>
        r.fulfill({
          contentType: "text/html",
          body: `<div id="smart-dsr"></div><script>window.smart_dsr_user='test';</script><script>${source}</script>`,
        })
      );
      await page.goto("http://localhost/duty-off-test");
      await page.locator(".summary-cards").waitFor();
      assert.match(
        await page.locator(".summary-cards .metric").nth(0).innerText(),
        /Opening Balance.*1,000/s
      );
      assert.match(
        await page.locator(".summary-cards .metric").nth(1).innerText(),
        /Closing Balance.*1,250/s
      );
      await page.getByRole("button", { name: "Duty OFF", exact: true }).click();
      await page.locator("#dsr-dialog [name=odometer_reading]").fill("1100");
      await page.locator("#dsr-dialog [data-open-odometer]").click();
      await page.waitForFunction(
        () => document.querySelector("#dsr-dialog video")?.videoWidth > 0
      );
      await page.locator("#dsr-dialog [data-capture-odometer]").click();
      await page.locator("#dsr-dialog [data-odometer-camera] img").waitFor();
      await page.locator("#dsr-dialog [data-submit-duty-off]").click();
      await page.waitForFunction(
        () => !document.querySelector("#smart-dsr").hasAttribute("aria-busy")
      );
      const attempts = await page.evaluate(() => window.attempts);
      assert.equal(
        attempts.length,
        ["recent", "denied"].includes(mode) ? 1 : 2
      );
      assert.equal(attempts[0].maximumAge, 30000);
      if (attempts.length > 1) assert.equal(attempts[1].maximumAge, 30000);
      if (mode === "recent" || mode === "exception") {
        assert.equal(submitted.duty, "test-duty");
        assert.deepEqual(
          submitted.gps,
          mode === "recent"
            ? { latitude: 28, longitude: 77, accuracy: 500 }
            : null
        );
      } else {
        assert.equal(submitted, undefined);
        const error = await page.locator("#dsr-error").innerText();
        assert.match(error, /Duty OFF/);
        assert.doesNotMatch(error, /Submit Visit/);
        assert.equal(
          await page.locator("#dsr-dialog [data-submit-duty-off]").isEnabled(),
          true
        );
      }
      await page.close();
    }
    console.log(
      "PASS: Duty OFF accepts recent fix; rejects stale fix; timeout/permission errors keep duty active; authorized exception sends no fabricated GPS. Mocked browser/API."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
