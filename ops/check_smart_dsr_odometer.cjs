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
    const context = await browser.newContext({
      permissions: ["camera", "geolocation"],
    });
    await context.addInitScript(() => {
      window.streams = [];
      window.failCamera = false;
      const media = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices
      );
      navigator.mediaDevices.getUserMedia = async (...args) => {
        if (window.failCamera)
          throw Object.assign(new Error("Permission blocked"), {
            name: "NotAllowedError",
          });
        const stream = await media(...args);
        window.streams.push(stream);
        return stream;
      };
      Object.defineProperty(navigator, "geolocation", {
        value: {
          getCurrentPosition(ok) {
            setTimeout(
              () =>
                ok({
                  timestamp: Date.now(),
                  coords: { latitude: 28, longitude: 77, accuracy: 5 },
                }),
              1
            );
          },
          watchPosition() {
            return 1;
          },
          clearWatch() {},
        },
      });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let duty = null,
      started,
      ended;
    const challenges = [];
    await page.route("https://api.bigdatacloud.net/**", (r) =>
      r.fulfill({ json: { locality: "Test Area", city: "Test City" } })
    );
    await page.route("**/api/method/srv_erp.smart_dsr.api.*", (r) => {
      const method = r.request().url().split(".").pop(),
        data = r.request().postDataJSON();
      let message = {};
      if (method === "duty_off_readiness") message = { ready: true, tasks: [] };
      if (method === "bootstrap")
        message = {
          account: "user",
          employee_name: "User",
          configured: true,
          work_date: "2026-11-16",
          official_opening_balance: 1000,
          currency: "INR",
          vehicles: [{ registration_number: "PB31AB1234" }],
          current: duty
            ? {
                duty,
                available_cash: 1000,
                activities: [],
                expenses: [],
                events: [],
              }
            : null,
        };
      if (method === "odometer_camera_challenge") {
        challenges.push(data);
        message = "odometer-" + challenges.length;
      }
      if (method === "duty_on") {
        started = data;
        duty = {
          name: "duty",
          status: "Active",
          work_date: "2026-11-16",
          started_at: "2026-11-16 06:00:00",
          vehicle_number: data.vehicle_number,
          odometer_required: 1,
          odometer_start: Number(data.odometer_start),
          odometer_start_photo: "/private/files/start.jpg",
          opening_balance: 1000,
          verified_km: 8,
        };
        message = { duty };
      }
      if (method === "end_workday") {
        ended = data;
        Object.assign(duty, {
          status: "Finalized",
          ended_at: "2026-11-16 18:00:00",
          odometer_end: Number(data.odometer_end),
          odometer_end_photo: "/private/files/end.jpg",
          odometer_distance: Number(
            (Number(data.odometer_end) - duty.odometer_start).toFixed(2)
          ),
        });
        message = { duty };
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
    await page.route("**/odometer-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<meta charset="utf-8"><style>${css}</style><div id="smart-dsr"></div><script>window.smart_dsr_user='user';</script><script>${source}</script>`,
      })
    );
    await page.goto("http://localhost/odometer-test");
    await page.getByText("Test Area, Test City", { exact: true }).waitFor();
    const startForm = page.locator("#duty-form");
    assert.equal(await startForm.locator("#start-duty").isDisabled(), true);
    assert.equal(await page.locator("input[type=file]").count(), 0);
    assert.equal(
      await startForm.locator("[name=vehicle]").inputValue(),
      "PB31AB1234"
    );
    await startForm
      .getByLabel("Starting Meter (KM)", { exact: true })
      .fill("1000");
    const capture = async function (form) {
      await form.locator("[data-open-odometer]").click();
      await page.waitForFunction(() =>
        Array.from(
          document.querySelectorAll("[data-odometer-camera] video")
        ).some((v) => v.videoWidth > 0)
      );
      assert.equal(
        await form.locator("[data-open-odometer]").isVisible(),
        false
      );
      assert.equal(await form.locator("[data-cancel-odometer]").count(), 0);
      assert.equal(
        await form
          .getByRole("button", { name: "Capture Photo", exact: true })
          .count(),
        1
      );
      await form.locator("[data-capture-odometer]").click();
      await form.locator("[data-odometer-camera] img").waitFor();
    };
    await capture(startForm);
    await page.waitForFunction(
      () => !document.querySelector("#start-duty").disabled
    );
    await startForm
      .getByLabel("Starting Meter (KM)", { exact: true })
      .fill("1001");
    assert.equal(await startForm.locator("#start-duty").isDisabled(), true);
    assert.equal(
      await startForm.locator("[data-odometer-camera] img").count(),
      0
    );
    await startForm
      .getByLabel("Starting Meter (KM)", { exact: true })
      .fill("1000");
    await capture(startForm);
    await startForm.locator("#start-duty").click();
    await page.getByRole("button", { name: "Duty OFF", exact: true }).waitFor();
    assert.equal(started.odometer_start, "1000");
    assert.equal(started.request_key, challenges.at(-1).request_key);
    assert.equal(started.odometer_photo.challenge, "odometer-2");
    assert.equal(
      Buffer.from(started.odometer_photo.content, "base64").readUInt16BE(0),
      0xffd8
    );
    await page.getByRole("button", { name: "Duty OFF", exact: true }).click();
    const form = page.locator("#dsr-dialog form");
    await form.getByLabel("Ending Meter (KM)", { exact: true }).fill("999");
    assert.match(
      await form.locator("[data-odometer-distance]").innerText(),
      /at least/
    );
    assert.equal(
      await form.locator("[data-submit-duty-off]").isDisabled(),
      true
    );
    await form.getByLabel("Ending Meter (KM)", { exact: true }).fill("1123.45");
    assert.match(
      await form.locator("[data-odometer-distance]").innerText(),
      /123.45 KM/
    );
    await page.evaluate(() => (window.failCamera = true));
    await form.locator("[data-open-odometer]").click();
    await form.locator("[data-odometer-error]:not([hidden])").waitFor();
    assert.match(
      await form.locator("[data-odometer-error]").innerText(),
      /permission is blocked/
    );
    assert.equal(
      await form.locator("[data-submit-duty-off]").isDisabled(),
      true
    );
    await page.evaluate(() => (window.failCamera = false));
    await capture(form);
    await form.locator("[data-submit-duty-off]").click();
    await page
      .getByText("Meter distance travelled: 123.45 KM", { exact: true })
      .waitFor();
    assert.equal(ended.odometer_end, "1123.45");
    assert.equal(challenges.at(-1).phase, "end");
    assert.equal(challenges.at(-1).duty, "duty");
    assert.ok(ended.odometer_photo.content.length > 100);
    assert.match(
      await page.locator(".summary-cards .metric").nth(2).innerText(),
      /8.00 KM/
    );
    assert.equal(
      await page
        .getByRole("button", { name: "View Starting meter photo", exact: true })
        .count(),
      1
    );
    assert.equal(
      await page
        .getByRole("button", { name: "View Ending meter photo", exact: true })
        .count(),
      1
    );
    assert.equal(
      await page.evaluate(() =>
        window.streams.every((s) =>
          s.getTracks().every((t) => t.readyState === "ended")
        )
      ),
      true
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth
      ),
      false
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: required starting/ending live-camera readings; reading change invalidates capture; negative distance blocked; permission denial blocks closing; 123.45 KM shown after Duty OFF; GPS remains 8 KM; private photo links and camera cleanup. API fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
