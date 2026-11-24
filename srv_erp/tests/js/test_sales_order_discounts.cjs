const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const rows = {};
const context = vm.createContext({
  frappe: {
    ui: { form: { on() {} } },
    model: {
      set_value(dt, name, field, value) {
        Object.assign(
          rows[name],
          typeof field === "string" ? { [field]: value } : field
        );
        return Promise.resolve();
      },
    },
  },
  locals: { "Sales Order Item": rows },
  flt: (value) => Number(value) || 0,
  precision: () => 2,
  setTimeout: () => {},
});
vm.runInContext(
  fs.readFileSync(
    path.resolve(__dirname, "../../public/js/sales_order.js"),
    "utf8"
  ),
  context
);
rows.new = { rate: 0, price_list_rate: 100, srv_discount_percentage: 10 };
context.apply_rate_discount({}, "Sales Order Item", "new");
assert.equal(rows.new.rate, 0);
assert.equal(
  rows.new.srv_last_discount_percentage,
  undefined,
  "Wait for the real rate"
);
rows.new.rate = 100;
context.apply_rate_discount({}, "Sales Order Item", "new");
assert.equal(rows.new.rate, 90);
rows.new.__applying_srv_rate_discount = false;
context.apply_rate_discount({}, "Sales Order Item", "new");
assert.equal(rows.new.rate, 90, "Recalculation must not compound discounts");
rows.other = { srv_discount_percentage: 0 };
context.set_item_discount_default({ doc: {} }, "Sales Order Item", "other");
assert.equal(rows.other.srv_discount_percentage, 0);
context.set_item_discount_default(
  { doc: { custom_discount__as_per_list: 12 } },
  "Sales Order Item",
  "other"
);
assert.equal(rows.other.srv_discount_percentage, 12);
assert.equal(
  rows.new.srv_discount_percentage,
  10,
  "Another order keeps its own discount"
);
rows.loading = {
  rate: 0,
  price_list_rate: 100,
  srv_rate_before_discount: 100,
  srv_discount_percentage: 10,
  srv_last_discount_percentage: 10,
};
context.apply_rate_discount({}, "Sales Order Item", "loading");
assert.equal(
  rows.loading.rate,
  90,
  "A temporary zero must not overwrite a known base"
);
console.log("Sales Order discount regression checks passed");
