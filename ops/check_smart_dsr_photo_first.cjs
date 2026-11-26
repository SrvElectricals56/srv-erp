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
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.locationCalls = 0;
      Object.defineProperty(navigator, "geolocation", {
        value: {
          getCurrentPosition(ok) {
            window.locationCalls++;
            ok({
              timestamp: Date.now(),
              coords: { latitude: 28, longitude: 77, accuracy: 10 },
            });
          },
          watchPosition() {
            return 1;
          },
          clearWatch() {},
        },
      });
    });
    const duty = {
      name: "duty",
      status: "Active",
      started_at: "2026-11-18 09:00:00",
    };
    const visit = {
      name: "visit",
      duty: "duty",
      status: "Open",
      customer: "dealer",
    };
    let photos = [],
      arrival,
      uploaded;
    await page.route("**/api/method/srv_erp.smart_dsr.api.*", (r) => {
      const method = r.request().url().split(".").pop();
      let message = {};
      if (method === "bootstrap")
        message = {
          account: "user",
          employee_name: "User",
          territories: [],
          current: { duty, activities: [], events: [] },
        };
      if (method === "search_dealers")
        message = Array.from({ length: 45 }, (_, i) => ({
          name: "dealer-" + (i + 1),
          customer_name: "Dealer " + (i + 1),
        }));
      if (method === "dealer_arrival") {
        arrival = r.request().postDataJSON();
        message = "visit";
      }
      if (method === "visit_details")
        message = {
          visit,
          dealer: { customer_name: "Dealer" },
          photos,
          photo_verified: photos.length > 0,
          orders: [],
          collections: [],
          outstanding: { currency: "INR", overdue: 0 },
        };
      if (method === "browser_photo_challenge") message = "token";
      if (method === "browser_photo") {
        uploaded = r.request().postDataJSON();
        photos = [
          {
            name: "photo",
            photo: "/private/files/shop.jpg",
            captured_at: "2026-11-18 10:00:00",
            capture_source: "Browser camera pending location",
          },
        ];
        message = photos[0];
      }
      if (method === "browser_photo_location") {
        uploaded.gps = r.request().postDataJSON().gps;
        photos[0] = {
          ...photos[0],
          ...uploaded.gps,
          capture_source: "Browser camera",
        };
        message = {
          visit,
          dealer: { customer_name: "Dealer" },
          photos,
          photo_verified: photos.length > 0,
          orders: [],
          collections: [],
          outstanding: { currency: "INR", overdue: 0 },
        };
      }
      if (method === "retake_visit_photo") {
        photos = [];
        message = "retake-token";
      }
      return r.fulfill({ json: { message } });
    });
    await page.route("**/private/files/shop.jpg", (r) =>
      r.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="blue"/></svg>',
      })
    );
    const source = fs.readFileSync(
      path.join(__dirname, "../srv_erp/public/smart_dsr/app.js"),
      "utf8"
    );
    const css = fs.readFileSync(
      path.join(__dirname, "../srv_erp/public/smart_dsr/app.css"),
      "utf8"
    );
    await page.route("**/photo-first-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<meta charset="utf-8"><style>${css}</style><div id="smart-dsr"></div><script>${source}</script>`,
      })
    );
    await page.goto("http://localhost/photo-first-test");
    await page.locator("#dsr-expenses").waitFor();
    await page
      .getByRole("button", { name: "+ Add Visit", exact: true })
      .click();
    await page.locator('[data-customer="dealer-45"]').waitFor();
    assert.equal(await page.locator("[data-customer]").count(), 45);
    assert.equal(await page.locator("#territory").count(), 0);
    assert.match(
      await page.locator("#dealer-count").innerText(),
      /45 dealers found/
    );
    await page.locator('[data-customer="dealer-45"]').click();
    await page
      .getByRole("button", { name: "Open Camera", exact: true })
      .waitFor();
    assert.equal(await page.evaluate(() => window.locationCalls), 0);
    assert.equal(arrival.gps, undefined);
    assert.equal(arrival.customer, "dealer-45");
    assert.equal(await page.locator("#dsr-expenses").count(), 0);
    const services = [
      "Make Order",
      "Overdue Amount",
      "Collected Money",
      "Dealer Reviews",
      "Submit Visit",
    ];
    for (const name of services)
      assert.equal(
        await page
          .getByRole("button", { name, exact: name === "Submit Visit" })
          .isDisabled(),
        true
      );
    await page
      .getByRole("button", { name: "Open Camera", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelector("#camera-view video")?.videoWidth > 0
    );
    assert.equal(await page.evaluate(() => window.locationCalls), 0);
    await page.locator("#capture-photo").click();
    await page.locator(".shop-photo").waitFor();
    await page.waitForFunction(
      () => !document.querySelector("#smart-dsr").hasAttribute("aria-busy")
    );
    assert.equal(await page.evaluate(() => window.locationCalls), 2);
    await page.waitForFunction(
      () => !document.querySelector('[data-action="submit"]').disabled
    );
    assert.deepEqual(uploaded.gps, {
      latitude: 28,
      longitude: 77,
      accuracy: 10,
    });
    for (const name of services)
      assert.equal(
        await page
          .getByRole("button", { name, exact: name === "Submit Visit" })
          .isEnabled(),
        true
      );
    await page
      .getByRole("button", { name: "Retake Photo", exact: true })
      .click();
    await page.locator("[data-confirm-retake]").click();
    await page.locator("#capture-photo").waitFor();
    for (const name of services)
      assert.equal(
        await page
          .getByRole("button", { name, exact: name === "Submit Visit" })
          .isDisabled(),
        true
      );
    assert.equal(await page.evaluate(() => window.locationCalls), 2);
    await page
      .getByRole("button", { name: "Back to Party Visits", exact: true })
      .click();
    await page.locator("#dsr-expenses").waitFor();
    assert.deepEqual(errors, []);
    console.log(
      "PASS: dealer selection/camera opening make no GPS request; capture sends GPS; visit services unlock after upload and lock on retake; Expenses appears only on home. Mocked GPS/camera/API fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
