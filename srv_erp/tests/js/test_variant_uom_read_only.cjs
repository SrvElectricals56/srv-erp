const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = vm.createContext({
	erpnext: { item: {} },
	srv_erp: { item: {} },
	frappe: { provide() {}, ui: { form: { on() {} } } },
});
vm.runInContext(
	fs.readFileSync(path.resolve(__dirname, "../../public/js/item.js"), "utf8"),
	context,
);
const properties = {};
const frm = {
	doc: { variant_of: "TEMPLATE" },
	set_df_property(field, property, value) {
		properties[`${field}.${property}`] = value;
	},
};
context.srv_erp.item.toggle_variant_item_group(frm);
assert.equal(properties["uoms.read_only"], 1);
frm.doc = { has_variants: 1 };
context.srv_erp.item.toggle_variant_item_group(frm);
assert.equal(properties["uoms.read_only"], 0);
frm.doc = {};
context.srv_erp.item.toggle_variant_item_group(frm);
assert.equal(properties["uoms.read_only"], 0);
process.stdout.write("PASS: variant UOM table is read only; template and standalone UOMs remain editable\n");
