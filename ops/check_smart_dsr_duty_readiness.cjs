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
    const context = await browser.newContext({ permissions: ["camera"] });
    for (const mode of [
      "pending",
      "break",
      "evidence",
      "race-before-submit",
      "race-server",
    ]) {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => {
        window.streams = [];
        const media = navigator.mediaDevices.getUserMedia.bind(
          navigator.mediaDevices
        );
        navigator.mediaDevices.getUserMedia = async (...args) => {
          const stream = await media(...args);
          window.streams.push(stream);
          return stream;
        };
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
        });
      });
      let blocked = !mode.startsWith("race"),
        endCalls = 0;
      const message =
        mode === "break"
          ? "End the active break before Duty OFF."
          : mode === "evidence"
          ? "Visit photos need an Administrator before Duty OFF."
          : "Complete pending party visits before Duty OFF.";
      const duty = {
        name: "duty",
        status: "Active",
        started_at: "2026-11-16 06:00:00",
        work_date: "2026-11-16",
        odometer_start: 1000,
        odometer_start_photo: "/private/files/start.jpg",
      };
      await page.route("**/api/method/srv_erp.smart_dsr.api.*", (r) => {
        const method = r.request().url().split(".").pop();
        let result = {};
        if (method === "bootstrap")
          result = {
            account: "user",
            employee_name: "User",
            work_date: "2026-11-16",
            current: {
              duty,
              activities: [],
              breaks: [],
              expenses: [],
              events: [],
            },
          };
        if (method === "duty_off_readiness")
          result = {
            ready: !blocked,
            message: blocked ? message : "",
            tasks: blocked
              ? [{ type: mode === "break" ? "break" : "visit" }]
              : [],
          };
        if (method === "odometer_camera_challenge") result = "odometer-token";
        if (method === "end_workday") {
          endCalls++;
          blocked = true;
          return r.fulfill({ status: 417, json: { message } });
        }
        return r.fulfill({ json: { message: result } });
      });
      const source = fs.readFileSync(
        path.join(__dirname, "../srv_erp/public/smart_dsr/app.js"),
        "utf8"
      );
      const css = fs.readFileSync(
        path.join(__dirname, "../srv_erp/public/smart_dsr/app.css"),
        "utf8"
      );
      await page.route("**/readiness-test", (r) =>
        r.fulfill({
          contentType: "text/html",
          body: `<meta charset="utf-8"><style>${css}</style><div id="smart-dsr"></div><script>window.smart_dsr_user='user';</script><script>${source}</script>`,
        })
      );
      await page.goto("http://localhost/readiness-test");
      await page.getByRole("button", { name: "Duty OFF", exact: true }).click();
      if (mode.startsWith("race")) {
        const form = page.locator("#dsr-dialog form");
        await form
          .getByLabel("Ending Meter (KM)", { exact: true })
          .fill("1100");
        await form.locator("[data-open-odometer]").click();
        await page.waitForFunction(
          () => document.querySelector("#dsr-dialog video")?.videoWidth > 0
        );
        await form.locator("[data-capture-odometer]").click();
        await form.locator("[data-odometer-camera] img").waitFor();
        if (mode === "race-before-submit") blocked = true;
        await form.locator("[data-submit-duty-off]").click();
      }
      await page.locator("#dsr-error:not([hidden])").waitFor();
      await page.waitForFunction(
        () => !document.querySelector("#dsr-dialog").open
      );
      assert.equal(await page.locator("#dsr-error").innerText(), message);
      assert.equal(
        await page
          .getByRole("button", { name: "Duty OFF", exact: true })
          .isVisible(),
        true
      );
      assert.equal(endCalls, mode === "race-server" ? 1 : 0);
      assert.equal(duty.status, "Active");
      assert.equal(
        await page.evaluate(() =>
          window.streams.every((s) =>
            s.getTracks().every((t) => t.readyState === "ended")
          )
        ),
        true
      );
      if (!mode.startsWith("race"))
        assert.equal(await page.evaluate(() => window.streams.length), 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log(
      "PASS: unfinished visits, breaks and evidence return to workday before camera; new unfinished tasks during closing and server-side races close Duty OFF and preserve active duty; camera streams stop. API fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
