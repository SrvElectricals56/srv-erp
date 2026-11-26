const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    for (const mode of [
      "success",
      "unavailable",
      "timeout",
      "denied",
      "both-fail",
    ]) {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript((mode) => {
        window.locationAttempts = [];
        Object.defineProperty(navigator, "geolocation", {
          value: {
            getCurrentPosition(success, fail, options) {
              window.locationAttempts.push(options);
              const code = mode === "denied" ? 1 : mode === "timeout" ? 3 : 2;
              setTimeout(
                () =>
                  mode === "success" ||
                  (!options.enableHighAccuracy &&
                    mode !== "denied" &&
                    mode !== "both-fail")
                    ? success({
                        coords: { latitude: 28, longitude: 77, accuracy: 1500 },
                      })
                    : fail({ code }),
                0
              );
            },
            watchPosition() {
              return 1;
            },
            clearWatch() {},
          },
        });
      }, mode);
      let completed = null;
      let photos = [
        {
          name: "photo-test",
          photo: "/private/files/test.jpg",
          captured_at: "2026-11-16 09:00:00",
        },
      ];
      const duty = {
        name: "duty-test",
        status: "Active",
        started_at: "2026-11-16 09:00:00",
        verified_km: 0,
      };
      await page.route("**/api/method/srv_erp.smart_dsr.api.*", (route) => {
        const method = route.request().url().split(".").pop();
        let message = {};
        if (method === "bootstrap")
          message = {
            account: "test@example.invalid",
            employee_name: "Test",
            current: { duty, activities: [], events: [] },
          };
        if (method === "visit_details")
          message = {
            visit: { name: "visit-test", duty: "duty-test", status: "Open" },
            dealer: { customer_name: "Dealer" },
            photos,
            photo_verified: photos.length > 0,
            orders: [],
            collections: [],
            outstanding: { currency: "INR", overdue: 0 },
          };
        if (method === "complete_activity") {
          completed = route.request().postDataJSON();
          message = "visit-test";
        }
        return route.fulfill({ json: { message } });
      });
      const source = fs.readFileSync(
        path.join(__dirname, "../srv_erp/public/smart_dsr/app.js"),
        "utf8"
      );
      await page.route("**/visit-location-test", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<div id="smart-dsr"></div><script>window.smart_dsr_user='test@example.invalid';</script><script>${source}</script>`,
        })
      );
      await page.goto("http://localhost/visit-location-test#visit/visit-test");
      assert.equal(
        await page
          .getByRole("button", { name: "Delete Photo", exact: true })
          .count(),
        0
      );
      await page
        .getByRole("button", { name: "Retake Photo", exact: true })
        .click();
      await page.locator("[data-cancel-retake]").click();
      assert.equal(await page.locator(".shop-photo").count(), 1);
      await page
        .getByRole("button", { name: "Submit Visit", exact: true })
        .click();
      await page.waitForFunction(
        () => !document.querySelector("#smart-dsr").hasAttribute("aria-busy")
      );
      const attempts = await page.evaluate(() => window.locationAttempts);
      assert.equal(
        attempts.length,
        mode === "denied" || mode === "success" ? 1 : 2
      );
      assert.equal(attempts[0].enableHighAccuracy, true);
      assert.ok(attempts.every((a) => a.maximumAge === 0));
      if (attempts.length > 1)
        assert.equal(attempts[1].enableHighAccuracy, false);
      if (mode === "denied" || mode === "both-fail") {
        assert.equal(completed, null);
        assert.equal(new URL(page.url()).hash, "#visit/visit-test");
        assert.match(
          await page.locator("#dsr-error").innerText(),
          mode === "denied" ? /permission is blocked/ : /could not determine/
        );
        assert.equal(
          await page
            .getByRole("button", { name: "Submit Visit", exact: true })
            .isEnabled(),
          true
        );
      } else {
        assert.equal(completed.activity, "visit-test");
        assert.deepEqual(completed.gps, {
          latitude: 28,
          longitude: 77,
          accuracy: 1500,
        });
        assert.equal(duty.status, "Active");
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log(
      "PASS: standalone Delete Photo removed and canceled retake preserves image; visit submission with fresh location; unavailable/timeout fallback; permission denial without retry; failed fixes preserve visit and block submission. Mocked browser/API fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
