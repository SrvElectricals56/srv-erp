// OVERDUES_MANUAL_REGISTER_V22
frappe.provide("srv_erp.overdues");

frappe.pages["overdues"].on_page_load = function (wrapper) {
	wrapper.overdues = new srv_erp.overdues.Page(wrapper);
};
frappe.pages["overdues"].on_page_show = function (wrapper) {
	if (wrapper.overdues?.data) wrapper.overdues.refresh();
};

srv_erp.overdues.Page = class {
	constructor(wrapper) {
		this.page = frappe.ui.make_app_page({
			parent: wrapper,
			title: __("Overdues"),
			single_column: true,
		});
		this.esc = (value) => frappe.utils.escape_html(String(value ?? ""));
		this.rows = [];
		this.number = 1;
		this.size = 25;
		this.request = 0;
		this.buckets = ["1–30", "31–60", "61–90", "91–120", "120+"];
		this.make();
		this.initialized = this.initialize();
		this.initialized.then(() => this.refresh());
	}

	async initialize() {
		await this.filters.set_value("report_date", frappe.datetime.get_today());
		const defaults = {
			balance_status: "All entries",
			age: "Any age",
			minimum: 0,
			view: "Dealers / Parties",
		};
		for (const [field, value] of Object.entries(defaults)) {
			await this.local[field].set_value(value);
		}
	}

	make() {
		this.$root = $('<div class="overdues-page"></div>').appendTo(this.page.body);
		this.$filters = $('<div class="frappe-card overdues-filters"></div>').appendTo(this.$root);
		this.filters = new frappe.ui.FieldGroup({
			body: this.$filters,
			fields: [
				{ fieldname: "report_date", label: __("Ageing Date"), fieldtype: "Date", reqd: 1 },
				{ fieldtype: "Column Break" },
				{
					fieldname: "customer",
					label: __("Dealer / Party"),
					fieldtype: "Link",
					options: "Customer",
				},
				{ fieldtype: "Column Break" },
				{
					fieldname: "sales_person",
					label: __("Sales Person"),
					fieldtype: "Link",
					options: "Sales Person",
				},
				{ fieldtype: "Column Break" },
				{
					fieldname: "apply",
					label: __("Apply Filters"),
					fieldtype: "Button",
					click: () => this.refresh(),
				},
				{
					fieldname: "clear",
					label: __("Clear Filters"),
					fieldtype: "Button",
					click: () => this.clearFilters(),
				},
			],
		});
		this.filters.make();
		this.filters.fields_dict.apply.$wrapper
			.add(this.filters.fields_dict.clear.$wrapper)
			.wrapAll('<div class="overdues-filter-actions"></div>');
		this.$status = $('<div class="text-muted overdues-note" role="status"></div>').appendTo(
			this.$root
		);
		this.$summary = $('<div class="overdues-summary"></div>').appendTo(this.$root);
		this.$ageing = $(
			'<div class="overdues-ageing" aria-label="Ageing buckets"></div>'
		).appendTo(this.$root);
		this.$card = $('<div class="frappe-card overdues-table-card"></div>').appendTo(this.$root);
		const $tools = $(
			'<div class="overdues-table-tools"><h4>' +
				__("Overdue balances") +
				'</h4><div class="overdues-local-filters"></div></div>'
		).appendTo(this.$card);
		const parent = $tools.find(".overdues-local-filters")[0];
		this.local = {};
		for (const df of [
			{
				fieldname: "search",
				label: __("Search"),
				fieldtype: "Data",
				placeholder: __("Party, entry or reference"),
				change: () => this.localChange(),
			},
			{
				fieldname: "balance_status",
				label: __("Balance Status"),
				fieldtype: "Select",
				options: "All entries\nOverdue\nPending\nPaid",
				change: () => this.localChange(),
			},
			{
				fieldname: "age",
				label: __("Ageing"),
				fieldtype: "Select",
				options: ["Any age", ...this.buckets].join("\n"),
				change: () => this.localChange(),
			},
			{
				fieldname: "minimum",
				label: __("Minimum amount"),
				fieldtype: "Float",
				default: 0,
				change: () => this.localChange(),
			},
			{
				fieldname: "view",
				label: __("View"),
				fieldtype: "Select",
				options: "Dealers / Parties\nManual Entries",
				change: () => this.localChange(),
			},
		]) {
			const holder = $("<div></div>").appendTo(parent)[0];
			this.local[df.fieldname] = frappe.ui.form.make_control({
				parent: holder,
				df,
				render_input: true,
			});
		}
		this.local.search.$input.on(
			"input",
			frappe.utils.debounce(() => this.localChange(), 200)
		);
		this.$tags = $('<div class="overdues-meta"></div>').appendTo(this.$card);
		this.$table = $('<div class="overdues-scroll"></div>').appendTo(this.$card);
		this.$footer = $('<div class="overdues-footer"></div>').appendTo(this.$card);
		this.$root.on("click", "[data-bucket]", (event) => {
			const bucket = event.currentTarget.dataset.bucket;
			this.local.age.set_value(this.local.age.get_value() === bucket ? "Any age" : bucket);
		});
		this.$root.on("click", "[data-party]", (event) =>
			this.showParty(event.currentTarget.dataset.party)
		);
		this.$root.on("click", "[data-page]", (event) => {
			this.number += Number(event.currentTarget.dataset.page);
			this.render();
		});
		this.$root.on("click", "[data-clear-local]", () => this.clearLocal());
		this.page.set_primary_action(__("Add Overdue"), () => this.addEntry(), "add");
		this.page.add_inner_button(__("Refresh"), () => this.refresh());
		this.page.add_inner_button(__("Dealer Overdue Receipt"), () =>
			frappe.set_route("List", "Dealer Overdue Receipt")
		);
		this.page
			.set_secondary_action(__("Add Received Amount"), () => this.receiveAmount(), "add")
			.removeClass("btn-default")
			.addClass("btn-primary");
		this.$status.text(__("Apply filters to load balances."));
	}

	async refresh() {
		await this.initialized;
		const filters = this.filters.get_values();
		if (!filters) return;
		if (filters.report_date > frappe.datetime.get_today()) {
			frappe.msgprint(__("Ageing Date cannot be in the future."));
			return;
		}
		const token = ++this.request;
		this.$root.attr("aria-busy", "true");
		this.$status.text(__("Loading manual overdue entries…"));
		this.$summary.empty();
		this.$ageing.empty();
		this.$table.empty();
		this.$tags.empty();
		this.$footer.empty();
		this.data = null;
		try {
			const response = await frappe.call({
				method: "srv_erp.overdues.get_overdues",
				args: {
					report_date: filters.report_date,
					customer: filters.customer,
					sales_person: filters.sales_person,
				},
			});
			if (token !== this.request) return;
			this.data = response.message;
			this.applied = { ...filters, company: this.data.company };
			this.rows = this.data.rows || [];
			this.number = 1;
			this.$status.text(
				`${this.data.company} · ${__("Ageing Date")} ${frappe.datetime.str_to_user(
					this.data.report_date
				)} · ${__("Updated")} ${frappe.datetime.str_to_user(
					this.data.generated_at
				)} · ${__("All amounts in")} ${this.data.currency}`
			);
			this.render();
		} catch (_) {
			if (token !== this.request) return;
			this.rows = [];
			this.$status.text(
				__(
					"Unable to load manual entries. Check your permissions and connection, then refresh."
				)
			);
			this.$table.html(
				'<div class="overdues-error">' +
					__("Balances are unavailable. No old results are being shown.") +
					"</div>"
			);
		} finally {
			if (token === this.request) this.$root.removeAttr("aria-busy");
		}
	}

	localKey() {
		return JSON.stringify(Object.values(this.local).map((control) => control.get_value()));
	}
	localChange() {
		if (!this.data || this.renderedLocalKey === this.localKey()) return;
		this.number = 1;
		this.render();
	}
	clearLocal() {
		for (const [key, value] of Object.entries({
			search: "",
			age: "Any age",
			minimum: 0,
			balance_status: "All entries",
		}))
			this.local[key].set_value(value);
		this.localChange();
	}
	async clearFilters() {
		await this.filters.set_value("customer", "");
		await this.filters.set_value("sales_person", "");
		await this.filters.set_value("report_date", frappe.datetime.get_today());
		this.clearLocal();
		return this.refresh();
	}
	money(value) {
		return format_currency(value, this.data.currency);
	}
	bucket(days) {
		return days <= 30
			? "1–30"
			: days <= 60
			? "31–60"
			: days <= 90
			? "61–90"
			: days <= 120
			? "91–120"
			: "120+";
	}
	filtered() {
		const query = (this.local.search.get_value() || "").trim().toLocaleLowerCase();
		const age = this.local.age.get_value() || "Any age";
		const minimum = Math.max(0, Number(this.local.minimum.get_value()) || 0);
		return this.rows.filter(
			(row) =>
				this.matchesStatus(row) &&
				(!query ||
					`${row.customer} ${row.customer_name} ${row.voucher_no} ${
						row.reference_no || ""
					} ${row.sales_person}`
						.toLocaleLowerCase()
						.includes(query)) &&
				(age === "Any age" ||
					(row.overdue > 0 && this.bucket(row.days_overdue) === age)) &&
				row.outstanding >= minimum
		);
	}
	rowStatus(row) {
		return row.outstanding <= 0 ? "Paid" : row.overdue > 0 ? "Overdue" : "Pending";
	}
	matchesStatus(row) {
		const status = this.local.balance_status.get_value() || "All entries";
		return status === "All entries" || this.rowStatus(row) === status;
	}
	parties(rows) {
		const map = new Map();
		for (const row of rows) {
			if (!map.has(row.customer))
				map.set(row.customer, {
					...row,
					amount: 0,
					paid: 0,
					outstanding: 0,
					overdue: 0,
					entries: 0,
					days_overdue: 0,
				});
			const party = map.get(row.customer);
			for (const key of ["amount", "paid", "outstanding", "overdue"]) party[key] += row[key];
			party.entries++;
			if (row.outstanding > 0)
				party.days_overdue = Math.max(party.days_overdue, row.days_overdue);
		}
		return [...map.values()].sort((a, b) => b.outstanding - a.outstanding);
	}

	link(doctype, name, label) {
		return `<a href="/app/${frappe.router.slug(doctype)}/${encodeURIComponent(
			name
		)}">${this.esc(label || name)}</a>`;
	}
	render() {
		if (!this.data) return;
		this.renderedLocalKey = this.localKey();
		const rows = this.filtered(),
			parties = this.parties(rows);
		const overdue = rows.reduce((sum, row) => sum + row.overdue, 0);
		const metrics = [
			[__("Total Amount"), this.money(rows.reduce((sum, row) => sum + row.amount, 0))],
			[__("Received"), this.money(rows.reduce((sum, row) => sum + row.paid, 0))],
			[
				__("Remaining Balance"),
				this.money(rows.reduce((sum, row) => sum + row.outstanding, 0)),
			],
			[__("Overdue"), this.money(overdue)],
			[__("Dealers / Parties"), parties.length],
		];
		this.$summary.html(
			metrics
				.map(
					([label, value]) =>
						`<div class="frappe-card overdues-metric"><span class="text-muted">${label}</span><strong>${value}</strong></div>`
				)
				.join("")
		);
		// Bucket amounts ignore the selected bucket, while retaining search/minimum.
		const selected = this.local.age.get_value();
		const bucketRows = this.rows.filter(
			(row) => row.overdue > 0 && this.matchesStatus(row) && this.matchesWithoutAge(row)
		);
		this.$ageing.html(
			this.buckets
				.map(
					(bucket) =>
						`<button type="button" class="overdues-age ${
							selected === bucket ? "active" : ""
						}" data-bucket="${bucket}" aria-pressed="${
							selected === bucket
						}"><span>${bucket} ${__("days")}</span><strong>${this.money(
							bucketRows
								.filter((row) => this.bucket(row.days_overdue) === bucket)
								.reduce((sum, row) => sum + row.overdue, 0)
						)}</strong></button>`
				)
				.join("")
		);
		const tags = Object.entries({
			[__("Dealer / Party")]: this.applied.customer,
			[__("Sales Person")]: this.applied.sales_person,
			[__("Balance Status")]:
				this.local.balance_status.get_value() !== "All entries"
					? this.local.balance_status.get_value()
					: "",
			[__("Search")]: this.local.search.get_value(),
			[__("Ageing")]: selected !== "Any age" ? selected : "",
			[__("Minimum")]:
				Number(this.local.minimum.get_value()) > 0 ? this.local.minimum.get_value() : "",
		}).filter(([, value]) => value);
		this.$tags.html(
			tags
				.map(
					([key, value]) =>
						`<span class="indicator-pill gray">${this.esc(key)}: ${this.esc(
							value
						)}</span>`
				)
				.join("") +
				(tags.length
					? '<button class="btn btn-xs btn-default" data-clear-local>' +
					  __("Clear search / ageing") +
					  "</button>"
					: "")
		);
		const invoiceView = this.local.view.get_value() === "Manual Entries";
		const records = invoiceView ? rows : parties;
		const pages = Math.max(1, Math.ceil(records.length / this.size));
		this.number = Math.max(1, Math.min(this.number, pages));
		const slice = records.slice((this.number - 1) * this.size, this.number * this.size);
		const headers = invoiceView
			? [
					__("Party"),
					__("Manual Entry"),
					__("Reference"),
					__("Due Date"),
					__("Total Amount"),
					__("Received"),
					__("Remaining"),
					__("Status"),
			  ]
			: [
					__("Dealer / Party"),
					__("Entries"),
					__("Total Amount"),
					__("Received"),
					__("Remaining"),
					__("Overdue"),
					__("Details"),
			  ];
		const body = slice
			.map((row) =>
				invoiceView
					? `<tr><td class="overdues-party-name">${this.link(
							"Customer",
							row.customer,
							row.customer_name
					  )}</td><td>${this.link("Dealer Overdue", row.voucher_no)}</td><td>${this.esc(
							row.reference_no || "—"
					  )}</td><td>${this.esc(
							frappe.datetime.str_to_user(row.due_date)
					  )}</td><td>${this.money(row.amount)}</td><td>${this.money(
							row.paid
					  )}</td><td>${this.money(
							row.outstanding
					  )}</td><td><span class="indicator-pill ${
							row.overdue > 0 ? "red" : row.outstanding > 0 ? "orange" : "green"
					  }">${__(this.rowStatus(row))}${
							row.overdue > 0 ? " · " + row.days_overdue + " " + __("days") : ""
					  }</span></td></tr>`
					: `<tr><td class="overdues-party-name">${this.link(
							"Customer",
							row.customer,
							row.customer_name
					  )}<div class="text-muted small">${this.esc(row.customer)}</div></td><td>${
							row.entries
					  }</td><td>${this.money(row.amount)}</td><td>${this.money(
							row.paid
					  )}</td><td>${this.money(row.outstanding)}</td><td>${this.money(
							row.overdue
					  )}</td><td><button class="btn btn-xs btn-default" data-party="${this.esc(
							row.customer
					  )}">${__("View balances")}</button></td></tr>`
			)
			.join("");
		this.$table.html(
			records.length
				? `<table class="table table-bordered table-hover"><thead><tr>${headers
						.map((label) => `<th>${label}</th>`)
						.join("")}</tr></thead><tbody>${body}</tbody></table>`
				: '<div class="overdues-empty">' +
						__(
							"No manual entries match these filters. Use Add Overdue to create one."
						) +
						"</div>"
		);
		this.$footer.html(
			`<span class="text-muted">${records.length} ${
				invoiceView ? __("manual entries") : __("parties")
			} · ${__("Page")} ${
				this.number
			} / ${pages}</span><div><button class="btn btn-default btn-sm" data-page="-1" ${
				this.number <= 1 ? "disabled" : ""
			}>${__("Previous")}</button> <button class="btn btn-default btn-sm" data-page="1" ${
				this.number >= pages ? "disabled" : ""
			}>${__("Next")}</button></div>`
		);
		this.$footer.append(
			$('<p class="text-muted small overdues-note"></p>').text(
				__(
					"Manual register only. Use Add Received Amount to enter a payment. Recorded Smart DSR collections also reduce the balance and create linked receipts. Ageing Date changes the days overdue; received amounts reflect current updates. Minimum amount applies per entry."
				)
			)
		);
	}
	matchesWithoutAge(row) {
		const query = (this.local.search.get_value() || "").trim().toLocaleLowerCase();
		return (
			(!query ||
				`${row.customer} ${row.customer_name} ${row.voucher_no} ${
					row.reference_no || ""
				} ${row.sales_person}`
					.toLocaleLowerCase()
					.includes(query)) &&
			row.outstanding >= Math.max(0, Number(this.local.minimum.get_value()) || 0)
		);
	}
	showParty(customer) {
		const rows = this.rows.filter((row) => row.customer === customer);
		if (!rows.length) return;
		const dialog = new frappe.ui.Dialog({
			title: rows[0].customer_name,
			size: "extra-large",
			fields: [{ fieldtype: "HTML", fieldname: "balances" }],
		});
		const totals = this.parties(rows)[0];
		dialog.fields_dict.balances.$wrapper.html(
			`<p>${this.link("Customer", customer)}</p><p>${__(
				"Total Amount"
			)}: <strong>${this.money(totals.amount)}</strong> · ${__(
				"Received"
			)}: <strong>${this.money(totals.paid)}</strong> · ${__(
				"Remaining"
			)}: <strong>${this.money(
				totals.outstanding
			)}</strong></p><div class="overdues-invoice-scroll"><table class="table table-bordered"><thead><tr><th>${__(
				"Manual Entry"
			)}</th><th>${__("Reference")}</th><th>${__("Due Date")}</th><th>${__(
				"Total Amount"
			)}</th><th>${__("Received")}</th><th>${__("Remaining")}</th></tr></thead><tbody>${rows
				.map(
					(row) =>
						`<tr><td>${this.link("Dealer Overdue", row.voucher_no)}</td><td>${this.esc(
							row.reference_no || "—"
						)}</td><td>${this.esc(
							frappe.datetime.str_to_user(row.due_date)
						)}</td><td>${this.money(row.amount)}</td><td>${this.money(
							row.paid
						)}</td><td>${this.money(row.outstanding)}</td></tr>`
				)
				.join("")}</tbody></table></div><p class="text-muted small">${__(
				"Use Add Received Amount to add a payment, or open an entry to view its details. Changes are tracked in the entry history."
			)}</p>`
		);
		if (this.data.can_create)
			dialog.set_primary_action(__("Add Overdue"), () => {
				dialog.hide();
				this.addEntry(customer);
			});
		const $actions = $('<div class="overdues-meta"></div>').appendTo(
			dialog.fields_dict.balances.$wrapper
		);
		$('<button type="button" class="btn btn-default btn-sm"></button>')
			.text(__("Receipt History"))
			.appendTo($actions)
			.on("click", () => {
				dialog.hide();
				frappe.set_route("List", "Dealer Overdue Receipt", { customer });
			});
		dialog.show();
	}
	async addEntry(customer) {
		let options;
		try {
			const response = await frappe.call({ method: "srv_erp.overdues.get_entry_options" });
			options = response.message;
		} catch (_) {
			return;
		}
		let request_key = crypto.randomUUID();
		const dialog = new frappe.ui.Dialog({
			title: __("Add Dealer Overdue"),
			fields: [
				{
					fieldtype: "Link",
					fieldname: "customer",
					label: __("Dealer / Party"),
					options: "Customer",
					reqd: 1,
					default: customer || this.applied?.customer,
				},
				{
					fieldtype: "Date",
					fieldname: "entry_date",
					label: __("Record Date"),
					reqd: 1,
					default: frappe.datetime.get_today(),
				},
				{
					fieldtype: "Date",
					fieldname: "due_date",
					label: __("Due Date"),
					reqd: 1,
					default: frappe.datetime.get_today(),
				},
				{
					fieldtype: "Data",
					fieldname: "reference_no",
					label: __("Bill / Reference Number"),
				},
				{
					fieldtype: "Link",
					fieldname: "sales_person",
					label: __("Sales Person"),
					options: "Sales Person",
					read_only: 1,
				},
				{
					fieldtype: "Currency",
					fieldname: "amount",
					label: __("Total Amount"),
					reqd: 1,
					options: options.currency,
				},
				{
					fieldtype: "Currency",
					fieldname: "amount_received",
					label: __("Amount Received"),
					default: 0,
					options: options.currency,
					description: __("Enter the amount already received manually."),
				},
				{ fieldtype: "Small Text", fieldname: "remarks", label: __("Remarks") },
			],
			primary_action_label: __("Save Overdue"),
			primary_action: async (values) => {
				if (dialog.saving) return;
				dialog.saving = true;
				dialog.disable_primary_action();
				try {
					await frappe.call({
						method: "srv_erp.overdues.create_overdue",
						args: { values, request_key },
					});
					request_key = crypto.randomUUID();
					const defaults = {
						customer: "",
						sales_person: "",
						reference_no: "",
						amount: null,
						amount_received: 0,
						remarks: "",
						entry_date: frappe.datetime.get_today(),
						due_date: frappe.datetime.get_today(),
					};
					for (const [field, value] of Object.entries(defaults)) {
						await dialog.set_value(field, value);
					}
					// Show the newly entered record even after a narrow previous search.
					await this.filters.set_value("customer", "");
					await this.filters.set_value("sales_person", "");
					await this.filters.set_value("report_date", frappe.datetime.get_today());
					this.clearLocal();
					await this.refresh();
					frappe.show_alert({
						message: __("Manual overdue entry saved."),
						indicator: "green",
					});
					dialog.fields_dict.customer.$input.trigger("focus");
				} catch (_) {
					// frappe.call displays validation; retain the form for retry.
				} finally {
					dialog.saving = false;
					dialog.enable_primary_action();
				}
			},
		});
		const updateSalesPerson = async () => {
			const selected = dialog.get_value("customer");
			await dialog.set_value("sales_person", "");
			if (!selected) return;
			try {
				const response = await frappe.call({
					method: "srv_erp.overdues.get_dealer_details",
					args: { customer: selected },
				});
				if (dialog.get_value("customer") === selected) {
					await dialog.set_value("sales_person", response.message?.sales_person || "");
				}
			} catch (_) {
				/* The field stays empty when the lookup fails. */
			}
		};
		dialog.fields_dict.customer.df.onchange = updateSalesPerson;
		dialog.show();
		void updateSalesPerson();
	}

	receiveAmount(customer) {
		if (!this.data) return frappe.msgprint(__("Wait for balances to finish loading."));
		let request_key = crypto.randomUUID();
		const dialog = new frappe.ui.Dialog({
			title: __("Add Received Amount"),
			fields: [
				{
					fieldtype: "Link",
					fieldname: "customer",
					label: __("Dealer / Party"),
					options: "Customer",
					default: customer,
					reqd: 1,
				},
				{
					fieldtype: "Currency",
					fieldname: "amount",
					label: __("Received Amount"),
					options: this.data.currency,
					reqd: 1,
				},
				{
					fieldtype: "Date",
					fieldname: "received_date",
					label: __("Received Date"),
					default: frappe.datetime.get_today(),
					reqd: 1,
				},
				{ fieldtype: "Data", fieldname: "reference_no", label: __("Payment Reference") },
				{ fieldtype: "Small Text", fieldname: "remarks", label: __("Remarks") },
				{
					fieldtype: "HTML",
					options:
						'<p class="text-muted">' +
						__(
							"The amount will be applied to this dealer’s oldest unpaid entries first, across all entries for this dealer."
						) +
						"</p>",
				},
			],
			primary_action_label: __("Save Received Amount"),
			primary_action: async (values) => {
				if (dialog.saving) return;
				dialog.saving = true;
				dialog.disable_primary_action();
				try {
					await frappe.call({
						method: "srv_erp.overdues.record_received_amount",
						args: { ...values, request_key },
					});
					request_key = crypto.randomUUID();
					const defaults = {
						customer: "",
						amount: null,
						received_date: frappe.datetime.get_today(),
						reference_no: "",
						remarks: "",
					};
					for (const [field, value] of Object.entries(defaults)) {
						await dialog.set_value(field, value);
					}
					await this.filters.set_value("customer", values.customer);
					await this.filters.set_value("sales_person", "");
					await this.filters.set_value("report_date", frappe.datetime.get_today());
					this.clearLocal();
					await this.refresh();
					frappe.show_alert({
						message: __("Received amount saved and dealer balance updated."),
						indicator: "green",
					});
					dialog.fields_dict.customer.$input.trigger("focus");
				} catch (_) {
					// Keep the entered payment and request key available for a safe retry.
				} finally {
					dialog.saving = false;
					dialog.enable_primary_action();
				}
			},
		});
		dialog.show();
	}
};
