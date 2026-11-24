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
      window.receiptStreams = [];
      window.failReceiptCamera = false;
      const getMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices
      );
      navigator.mediaDevices.getUserMedia = async (...args) => {
        if (window.failReceiptCamera)
          throw Object.assign(new Error("Camera permission blocked"), {
            name: "NotAllowedError",
          });
        const stream = await getMedia(...args);
        window.receiptStreams.push(stream);
        return stream;
      };
      const original = window.setInterval.bind(window);
      window.setInterval = (fn, delay, ...args) => {
        if (delay === 60000) {
          window.refreshMeals = fn;
          return 12345;
        }
        return original(fn, delay, ...args);
      };
    });
    const expenses = [],
      requests = [];
    let summaries = 0;
    let balance = 1000,
      fail = false;
    const duty = {
      name: "duty-test",
      status: "Active",
      started_at: "2026-11-16 09:00:00",
      opening_balance: 1000,
    };
    await page.route("**/api/method/srv_erp.smart_dsr.api.*", (r) => {
      const method = r.request().url().split(".").pop();
      let message = {};
      if (method === "bootstrap")
        message = {
          account: "user",
          employee_name: "User",
          currency: "INR",
          current: {
            duty,
            expenses,
            available_cash: balance,
            activities: [],
            events: [],
          },
        };
      if (method === "refresh_expenses") {
        summaries++;
        message = {
          duty,
          expenses,
          available_cash: balance,
          activities: [],
          events: [],
        };
      }
      if (method === "receipt_camera_challenge") message = "receipt-challenge";
      if (method === "record_expense") {
        const data = r.request().postDataJSON();
        if (!data.receipt_file)
          return r.fulfill({
            status: 417,
            json: { message: "Capture a receipt photo before saving." },
          });
        requests.push(data);
        if (fail)
          return r.fulfill({
            status: 417,
            json: { message: "Expense could not be saved" },
          });
        if (data.paid_from_cash) balance -= Number(data.value);
        expenses.push({
          name: "expense-" + expenses.length,
          category: data.category,
          amount: Number(data.value),
          remarks: data.remarks,
          paid_from_cash: data.paid_from_cash,
          receipt: data.receipt_file ? "/private/files/receipt.jpg" : null,
          posting_status: "Recorded",
        });
        message = { name: expenses.at(-1).name, balance };
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
    await page.route("**/expense-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<style>${css}</style><div id="smart-dsr"></div><script>window.smart_dsr_user='user';</script><script>${source}</script>`,
      })
    );
    await page.goto("http://localhost/expense-test");
    await page
      .getByRole("button", { name: "+ Add Expense", exact: true })
      .waitFor();
    assert.ok(
      await page
        .locator("#dsr-expenses")
        .evaluate((el) =>
          el.previousElementSibling.textContent.includes("Party Visits")
        )
    );
    await page
      .getByRole("button", { name: "+ Add Expense", exact: true })
      .click();
    const dialog = page.locator("#dsr-dialog");
    const captureReceipt = async function () {
      await dialog.locator("[data-open-receipt]").click();
      await page.waitForFunction(
        () =>
          document.querySelector("[data-receipt-camera] video")?.videoWidth > 0
      );
      await dialog
        .getByRole("button", { name: "Capture Photo", exact: true })
        .click();
      await dialog.getByAltText("Captured receipt", { exact: true }).waitFor();
    };

    assert.doesNotMatch(await dialog.innerText(), /optional/i);
    await page.evaluate(() => window.refreshMeals());
    assert.equal(summaries, 0);
    assert.equal(await dialog.locator("input[type=file]").count(), 0);
    assert.equal(
      await dialog
        .getByRole("button", { name: "Open Receipt Camera", exact: true })
        .count(),
      1
    );
    await dialog.locator("[name=category]").selectOption("Other Expense");
    await dialog.getByLabel("Amount", { exact: true }).fill("100");
    await dialog.getByLabel("Remarks", { exact: true }).fill("Dealer parking");
    await dialog
      .getByRole("button", { name: "Save Expense", exact: true })
      .click();
    await dialog
      .getByText("Capture a receipt photo before saving.", { exact: true })
      .first()
      .waitFor();
    assert.equal(requests.length, 0);
    await captureReceipt();
    await dialog
      .getByRole("button", { name: "Save Expense", exact: true })
      .click();
    await page
      .locator("#dsr-expenses")
      .getByText("Dealer parking", { exact: true })
      .waitFor();
    assert.equal(requests[0].receipt_file.filename, "receipt.jpg");
    assert.equal(requests[0].paid_from_cash, 0);
    assert.equal(balance, 1000);
    await page
      .getByRole("button", { name: "+ Add Expense", exact: true })
      .click();
    await dialog.getByLabel("Amount", { exact: true }).fill("50");
    assert.equal(await dialog.locator("[name=paid_from_cash]").count(), 0);
    await dialog
      .getByRole("button", { name: "Open Receipt Camera", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-receipt-camera] video")?.videoWidth > 0
    );
    assert.equal(
      await dialog.locator("[data-open-receipt]").isVisible(),
      false
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: "Cancel Camera", exact: true })
        .count(),
      0
    );
    assert.equal(await dialog.locator(".dsr-camera-frame").count(), 1);
    await dialog
      .getByRole("button", { name: "Capture Photo", exact: true })
      .click();
    await dialog.getByAltText("Captured receipt", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() =>
        window.receiptStreams.every((s) =>
          s.getTracks().every((t) => t.readyState === "ended")
        )
      ),
      true
    );
    await dialog
      .getByRole("button", { name: "Retake Photo", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-receipt-camera] video")?.videoWidth > 0
    );
    assert.equal(
      await dialog.locator("[data-open-receipt]").isVisible(),
      false
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: "Cancel Camera", exact: true })
        .count(),
      0
    );
    assert.equal(await dialog.locator(".dsr-camera-frame").count(), 1);
    await dialog
      .getByRole("button", { name: "Capture Photo", exact: true })
      .click();
    await dialog.getByAltText("Captured receipt", { exact: true }).waitFor();
    await dialog
      .getByRole("button", { name: "Save Expense", exact: true })
      .click();
    await page
      .getByRole("link", { name: "View Receipt", exact: true })
      .first()
      .waitFor();
    assert.equal(requests[1].receipt_file.filename, "receipt.jpg");
    assert.equal(requests[1].receipt_file.challenge, "receipt-challenge");
    assert.equal(
      Buffer.from(requests[1].receipt_file.content, "base64").readUInt16BE(0),
      0xffd8
    );
    assert.equal(balance, 1000);
    assert.equal(
      await page
        .getByRole("link", { name: "View Receipt", exact: true })
        .first()
        .getAttribute("href"),
      "/private/files/receipt.jpg"
    );
    expenses.push({
      name: "automatic-breakfast",
      category: "Breakfast",
      amount: 100,
      paid_from_cash: 1,
      remarks: "Automatic breakfast expense",
      posting_status: "Recorded",
    });
    balance -= 100;
    await page.evaluate(() => window.refreshMeals());
    await page
      .locator("#dsr-expenses")
      .getByText("Breakfast", { exact: true })
      .waitFor();
    assert.equal(summaries, 1);
    assert.match(
      await page.locator(".summary-cards .metric").nth(1).innerText(),
      /900/
    );
    fail = true;
    await page
      .getByRole("button", { name: "+ Add Expense", exact: true })
      .click();
    await dialog.getByLabel("Amount", { exact: true }).fill("25");
    await captureReceipt();
    await dialog
      .getByRole("button", { name: "Save Expense", exact: true })
      .click();
    await dialog.locator("[data-expense-error]:not([hidden])").waitFor();
    assert.equal(
      await dialog.getByLabel("Amount", { exact: true }).inputValue(),
      "25"
    );
    const retryKey = requests.at(-1).request_key;
    fail = false;
    await dialog
      .getByRole("button", { name: "Save Expense", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("#dsr-dialog").open
    );
    assert.equal(requests.at(-1).request_key, retryKey);
    await page
      .getByRole("button", { name: "+ Add Expense", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Open Receipt Camera", exact: true })
      .click();
    await dialog.locator("video").waitFor();
    await dialog.locator("[data-close]").click();
    await page.waitForFunction(() =>
      window.receiptStreams.every((s) =>
        s.getTracks().every((t) => t.readyState === "ended")
      )
    );
    await page
      .getByRole("button", { name: "+ Add Expense", exact: true })
      .click();
    await page.evaluate(() => (window.failReceiptCamera = true));
    await dialog
      .getByRole("button", { name: "Open Receipt Camera", exact: true })
      .click();
    await dialog.locator("[data-expense-error]:not([hidden])").waitFor();
    assert.match(
      await dialog.locator("[data-expense-error]").innerText(),
      /Camera permission is blocked/
    );
    await dialog.locator("[data-close]").click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth
      ),
      false
    );
    duty.status = "Finalized";
    await page.reload();
    await page
      .getByRole("button", { name: "+ Add Expense", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "+ Add Expense", exact: true })
        .isDisabled(),
      true
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: automatic expense refresh updates list and closing balance without interrupting forms; expenses below visits; missing receipt blocks save; live receipt camera capture/retake, camera shutdown/denial and private receipt link; manual expenses preserve closing balance; retry retains request key; closed duty disabled; mobile layout. Isolated API fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
