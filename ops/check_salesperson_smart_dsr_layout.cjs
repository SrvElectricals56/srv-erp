// Use a short-lived local QA session; never print session credentials.
const { chromium } = require("playwright");
const fs = require("fs");
const assert = require("assert/strict");
(async () => {
  const sessionFile = process.env.SMART_DSR_SESSION_FILE;
  if (!sessionFile)
    throw Error("Set SMART_DSR_SESSION_FILE to the temporary QA session file.");
  const { sid } = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  const base = process.env.SMART_DSR_URL || "http://127.0.0.1:8001";
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const guest = await browser.newContext();
    for (const path of ["/smart-dsr", "/smart-dsr?desk=1"]) {
      const response = await guest.request.get(base + path, {
        maxRedirects: 0,
        timeout: 120000,
      });
      assert.ok([301, 302].includes(response.status()));
      assert.equal(response.headers().location, "/app/smart-dsr");
    }
    await guest.close();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await context.addCookies([{ name: "sid", value: sid, url: base }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.stack));
    await page.goto(base + "/smart-dsr", {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    assert.equal(new URL(page.url()).pathname, "/app/smart-dsr");
    const frame = page.frameLocator(".smart-dsr-desk-frame");
    await frame.locator(".reward-balance").waitFor({ timeout: 120000 });
    assert.equal(
      new URL(
        await page.locator(".smart-dsr-desk-frame").getAttribute("src"),
        base
      ).pathname,
      "/smart-dsr-content"
    );
    assert.equal(await page.locator(".navbar").isVisible(), true);
    assert.equal(
      await page.locator(".salesperson-home-link").isVisible(),
      true
    );
    assert.equal(await page.locator(".layout-side-section:visible").count(), 0);
    assert.equal(await frame.locator(".dsr-header").count(), 0);
    assert.equal(
      await frame
        .locator(".workday-heading .reward-balance + .overdue-notification")
        .count(),
      1
    );
    assert.equal(
      await frame
        .getByRole("button", { name: "Notifications", exact: true })
        .count(),
      0
    );
    assert.equal(
      await frame.getByRole("link", { name: "Home", exact: true }).count(),
      0
    );
    await frame.locator(".overdue-notification").click();
    await frame
      .getByRole("heading", { name: "Dealer Overdues", exact: true })
      .waitFor();
    await page.locator(".dropdown-notifications .notifications-icon").click();
    const tab = page
      .locator(".notifications-category")
      .filter({ hasText: /^Smart DSR$/ });
    await tab.click();
    await page
      .locator(".panel-smart-dsr-notifications")
      .waitFor({ state: "visible" });
    await page.waitForFunction(
      () =>
        !document
          .querySelector(".panel-smart-dsr-notifications")
          .textContent.includes("Loading notifications")
    );
    assert.equal(
      await page
        .locator(".notification-item-tabs .notifications-category")
        .count(),
      4
    );
    assert.equal(
      await page
        .locator(".panel-smart-dsr-notifications")
        .textContent()
        .then((value) => value.includes("Could not load")),
      false
    );
    await page.screenshot({
      path: "/tmp/salesperson-smart-dsr-navbar.png",
      fullPage: true,
    });
    console.log(
      "PASS: live Sales profile, full-width Smart DSR, site navbar, Overdues beside points, functional Overdues, existing bell with Smart DSR/history notifications and original tabs."
    );
    console.log("Browser errors:", JSON.stringify(errors));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
