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
      geolocation: { latitude: 28.5, longitude: 77.5, accuracy: 10 },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "geolocation", {
        value: {
          getCurrentPosition(ok) {
            ok({
              timestamp: Date.now(),
              coords: { latitude: 28.5, longitude: 77.5, accuracy: 10 },
            });
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
    let retakes = 0,
      capture,
      review,
      bootstraps = 0;
    let photos = [
      {
        name: "old-photo",
        photo: "/private/files/old.jpg",
        captured_at: "2026-11-16 09:00:00",
      },
    ];
    const visit = {
      name: "visit-test",
      duty: "duty",
      customer: "dealer",
      status: "Open",
      arrived_at: "2026-11-16 09:00:00",
      latitude: 28,
      longitude: 77,
      accuracy: 5,
    };
    await page.route("**/api/method/srv_erp.smart_dsr.api.*", (r) => {
      const method = r.request().url().split(".").pop();
      let message = {};
      if (method === "bootstrap") {
        bootstraps++;
      }
      if (method === "bootstrap")
        message = {
          account: "user",
          employee_name: "User",
          current: {
            duty: {
              name: "duty",
              status: "Active",
              started_at: "2026-11-16 08:00:00",
            },
            activities: [],
            events: [],
          },
        };
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
      if (method === "previous_reviews")
        message = [
          {
            arrived_at: "2026-11-15 09:00:00",
            dealer_review: JSON.stringify({
              product: "Hidden product",
              remarks: "Previous remark",
            }),
          },
        ];
      if (method === "save_visit_review") {
        review = r.request().postDataJSON().review;
        visit.dealer_review = JSON.stringify(review);
      }
      if (method === "retake_visit_photo") {
        retakes++;
        photos = [];
        message = "new-challenge";
      }
      if (method === "browser_photo") {
        capture = r.request().postDataJSON();
        photos = [
          {
            name: "new-photo",
            photo: "/private/files/new.jpg",
            captured_at: "2026-11-16 10:00:00",
            capture_source: "Browser camera pending location",
          },
        ];
        Object.assign(visit, {
          arrived_at: "2026-11-16 10:00:00",
          ...(capture.gps || {}),
        });
        message = photos[0];
      }
      if (method === "browser_photo_location") {
        capture.gps = r.request().postDataJSON().gps;
        photos[0] = {
          ...photos[0],
          ...capture.gps,
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
      return r.fulfill({ json: { message } });
    });
    const source = fs.readFileSync(
      path.join(__dirname, "../srv_erp/public/smart_dsr/app.js"),
      "utf8"
    );
    await page.route("**/retake-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<div id="smart-dsr"></div><script>window.smart_dsr_user='user';</script><script>${source}</script>`,
      })
    );
    await page.goto("http://localhost/retake-test#visit/visit-test");
    await page.getByRole("button", { name: "Dealer Reviews" }).click();
    await page.locator("#dsr-dialog[open]").waitFor();
    assert.deepEqual(
      await page
        .locator("#dsr-dialog textarea")
        .evaluateAll((els) => els.map((e) => e.name)),
      ["remarks"]
    );
    assert.doesNotMatch(
      await page.locator("#dsr-dialog").innerText(),
      /Hidden product|Pricing|Complaints|Suggestions/
    );
    await page.getByLabel("Remarks", { exact: true }).fill("New remark");
    await page
      .getByRole("button", { name: "Save Review", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Retake Photo", exact: true })
      .waitFor();
    assert.deepEqual(review, { remarks: "New remark" });
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
    assert.equal(retakes, 0);
    assert.equal(await page.locator(".shop-photo").count(), 1);
    await page
      .getByRole("button", { name: "Retake Photo", exact: true })
      .click();
    assert.match(
      await page.locator("#dsr-dialog").innerText(),
      /remove the previous uploaded image/
    );
    assert.match(
      await page.locator("#dsr-dialog").innerText(),
      /update the visit time and location/
    );
    await page.locator("[data-confirm-retake]").click();
    await page.locator("#capture-photo").waitFor();
    assert.equal(await page.locator("[data-action=camera]").isVisible(), false);
    assert.equal(await page.locator(".dsr-camera-frame").count(), 1);
    assert.equal(
      await page
        .getByRole("button", { name: "Cancel Camera", exact: true })
        .count(),
      0
    );
    assert.equal(retakes, 1);
    assert.equal(await page.locator(".shop-photo").count(), 0);
    await page.waitForFunction(
      () => document.querySelector("video").videoWidth > 0
    );
    const bootstrapsBeforeCapture = bootstraps;
    await page.locator("#capture-photo").click();
    await page.locator('.shop-photo[src="/private/files/new.jpg"]').waitFor();
    assert.equal(await page.locator(".shop-photo").count(), 1);
    await page.waitForFunction(
      () => !document.querySelector('[data-action="submit"]').disabled
    );
    assert.equal(capture.challenge, "new-challenge");
    assert.deepEqual(capture.gps, {
      latitude: 28.5,
      longitude: 77.5,
      accuracy: 10,
    });
    assert.ok(capture.image_base64.length > 100);
    assert.equal(
      bootstraps,
      bootstrapsBeforeCapture,
      "photo upload should not reload the full workday"
    );
    const dimensions = await page.evaluate(async (data) => {
      const img = new Image();
      img.src = "data:image/jpeg;base64," + data;
      await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    }, capture.image_base64);
    assert.ok(Math.max(...dimensions) <= 1280);
    assert.match(
      await page.locator("#smart-dsr").innerText(),
      /Photo uploaded/
    );

    await page
      .getByRole("button", { name: "Retake Photo", exact: true })
      .click();
    await page.locator("[data-confirm-retake]").click();
    await page.locator("#capture-photo").waitFor();
    await page.waitForFunction(
      () => !document.querySelector("#smart-dsr").hasAttribute("aria-busy")
    );
    assert.equal(await page.locator("#dsr-expenses").count(), 0);
    await page
      .getByRole("button", { name: "Back to Party Visits", exact: true })
      .click();
    await page.locator("#dsr-expenses").waitFor();
    assert.equal(await page.locator("#camera-view video").count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: remarks-only reviews; no Delete Photo; canceled retake preserves photo; confirmed retake removes old image and captures replacement with new GPS. Fake camera and API fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
