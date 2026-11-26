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
    const page = await browser.newPage({ permissions: ["camera"] });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.locationRequests = [];
      Object.defineProperty(navigator, "geolocation", {
        value: {
          getCurrentPosition(ok, fail, options) {
            window.locationRequests.push({ ok, fail, options });
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
      origin_activity: "origin-internal-id",
    };
    let photos = [],
      photoVerified = false,
      upload,
      locationData;
    const details = () => ({
      visit,
      dealer: { customer_name: "Dealer" },
      photos,
      photo_verified: photoVerified,
      orders: [{ name: "order-internal-id", grand_total: 1000 }],
      collections: [
        {
          name: "collection-internal-id",
          amount: 5000,
          payment_method: "Cash",
          verification_status: "Recorded",
          payment_entry: "payment-internal-id",
        },
      ],
      outstanding: {
        currency: "INR",
        overdue: 1000,
        invoices: [
          {
            name: "DUE-MANUAL-1",
            currency: "INR",
            outstanding_amount: 1000,
            days_overdue: 4,
            due_date: "2026-11-14",
          },
        ],
      },
    });
    await page.route("https://api.bigdatacloud.net/**", (r) =>
      r.fulfill({
        json: {
          locality: "Mansa",
          principalSubdivision: "Punjab",
          countryName: "India",
        },
      })
    );
    await page.route("**/private/files/shop.jpg", (r) =>
      r.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="blue"/></svg>',
      })
    );
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
      if (method === "visit_details") message = details();
      if (method === "browser_photo_challenge") message = "token";
      if (method === "browser_photo") {
        upload = r.request().postDataJSON();
        photos = [
          {
            name: "photo",
            photo: "/private/files/shop.jpg",
            captured_at: "2026-11-18T10:00:00+05:30",
            capture_source: "Browser camera pending location",
          },
        ];
        message = photos[0];
        photoVerified = true;
      }
      if (method === "browser_photo_location") {
        locationData = r.request().postDataJSON();
        photos[0] = {
          ...photos[0],
          ...locationData.gps,
          capture_source: "Browser camera",
        };
        Object.assign(visit, {
          reward_started_at: "2026-11-18T10:00:00+05:30",
          arrived_at: "2026-11-18T10:00:00+05:30",
        });
        message = details();
      }
      if (method === "order_return_reference") {
        assert.deepEqual(r.request().postDataJSON(), { activity: "visit" });
        message = { token: "order-token", activity: "visit", customer: "dealer" };
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
    await page.route("**/async-photo-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<meta charset="utf-8"><style>${css}</style><div id="smart-dsr"></div><script>${source}</script>`,
      })
    );
    await page.route("**/app/sales-order/new-sales-order", (r) => r.fulfill({ body: "Sales Order" }));
    await page.goto("http://localhost/async-photo-test#visit/visit");
    await page
      .getByRole("button", { name: "Open Camera", exact: true })
      .waitFor();
    assert.doesNotMatch(
      await page.locator("#smart-dsr").innerText(),
      /origin-internal-id|order-internal-id|collection-internal-id|payment-internal-id/
    );
    await page
      .getByRole("button", { name: "Open Camera", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelector("#camera-view video")?.videoWidth > 0
    );
    assert.equal(await page.evaluate(() => window.locationRequests.length), 0);
    await page.locator("#capture-photo").click();
    await page.locator(".shop-photo").waitFor();
    await page.locator("#dsr-loading").waitFor({ state: "hidden" });
    assert.ok(upload.image_base64);
    assert.equal(upload.gps, undefined);
    assert.equal(locationData, undefined);
    assert.equal(
      await page
        .getByRole("button", { name: "Submit Visit", exact: true })
        .isDisabled(),
      true
    );
    for (const name of [
      "Make Order",
      "Overdue Amount",
      "Collected Money",
      "Dealer Reviews",
    ])
      assert.equal(await page.getByRole("button", { name }).isEnabled(), true);
    assert.match(
      await page.locator("[data-visit-photo-details]").innerText(),
      /Fetching live location/
    );
    const options = await page.evaluate(() =>
      window.locationRequests.map((r) => r.options)
    );
    assert.equal(options.length, 2);
    assert.ok(options.every((o) => o.timeout <= 8000));
    await page.evaluate(() =>
      window.locationRequests.splice(0).forEach((r) => r.fail({ code: 2 }))
    );
    await page.locator('[data-action="photo-location"]').waitFor();
    assert.match(await page.locator("#dsr-error").innerText(), /Photo saved/);
    assert.equal(await page.locator(".shop-photo").count(), 1);
    await page.locator('[data-action="photo-location"]').click();
    await page.waitForFunction(() => window.locationRequests.length === 2);
    await page.evaluate(() =>
      window.locationRequests.splice(0).forEach((r) =>
        r.ok({
          timestamp: Date.now(),
          coords: { latitude: 28, longitude: 77, accuracy: 10 },
        })
      )
    );
    await page.waitForFunction(
      () => !document.querySelector('[data-action="submit"]').disabled
    );
    assert.deepEqual(locationData.gps, {
      latitude: 28,
      longitude: 77,
      accuracy: 10,
    });
    await page.getByText("Mansa, Punjab, India", { exact: true }).waitFor();
    assert.match(
      await page.locator("[data-visit-photo-details]").innerText(),
      /Photo time/
    );
    assert.doesNotMatch(
      await page.locator("[data-visit-photo-details]").innerText(),
      /latitude|longitude/i
    );
    await page.getByRole("button", { name: "Overdue Amount" }).click();
    await page.locator("#dsr-dialog[open]").waitFor();
    assert.match(await page.locator("#dsr-dialog").innerText(), /DUE-MANUAL-1/);
    assert.match(await page.locator("#dsr-dialog").innerText(), /Manual Entry/);
    photoVerified = false;
    await page.reload();
    await page.getByText(/saved shop photo could not be verified/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Make Order" }).isDisabled(), true);
    await page.getByRole("button", { name: "Retake Photo" }).waitFor();
    photoVerified = true;
    await page.reload();
    await page.getByRole("button", { name: "Make Order" }).click();
    await page.waitForURL("**/app/sales-order/new-sales-order");
    assert.deepEqual(
      await page.evaluate(() => JSON.parse(sessionStorage.getItem("dsr-order-return"))),
      { token: "order-token", activity: "visit", customer: "dealer" }
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: photo uploads while GPS unresolved; services unlock on saved image; Submit waits for location; failure retains photo; retry attaches GPS and details beside photo without full-page loading. Mocked camera/GPS/API fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
