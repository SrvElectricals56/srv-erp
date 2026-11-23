frappe.provide("srv_erp.home_collections");
(() => {
	"use strict";
	// xcall discards the error response in this Frappe version. Keep it so the
	// payment dialog can display validation failures next to the Save button.
	const api = (method, args) =>
		new Promise((resolve, reject) => {
			frappe.call({
				method: "srv_erp.smart_dsr.home_collections." + method,
				args,
				callback: (response) => resolve(response.message),
				error: (response) => reject(response),
			});
		});
	const esc = (value) => frappe.utils.escape_html(String(value ?? ""));
	const cash = (value, currency) => format_currency(value || 0, currency);
	const date = (value) => (value ? frappe.datetime.str_to_user(value) : "—");

	srv_erp.home_collections.collect = async ({ onSave = () => {} } = {}) => {
		let context;
		try {
			context = await api("options");
		} catch (_) {
			frappe.msgprint(
				__("Could not open Collect Money. Check your connection and try again.")
			);
			return;
		}
		const request_key = crypto.randomUUID();
		let busy = false;
		const dialog = new frappe.ui.Dialog({
			title: __("Collect Money"),
			fields: [
				{
					fieldname: "context",
					fieldtype: "HTML",
					options: `<p>${
						context.duty
							? __("Active DSR") + ": <strong>" + esc(context.duty) + "</strong>"
							: __(
									"Select your dealer and record the payment directly. No active duty is required."
							  )
					}</p><p>${__(
						"Cash, UPI, bank transfers and cheques increase your closing balance and reduce the dealer’s recorded dues."
					)}</p>`,
				},
				{
					fieldname: "save_status",
					fieldtype: "HTML",
				},
				{
					fieldname: "customer",
					label: __("Dealer / Party"),
					fieldtype: "Link",
					options: "Customer",
					reqd: 1,
					get_query: () => ({
						query: "srv_erp.smart_dsr.home_collections.dealer_query",
					}),
				},
				{
					fieldname: "value",
					label: __("Collection Amount"),
					fieldtype: "Currency",
					options: context.currency,
					reqd: 1,
				},
				{
					fieldname: "payment_method",
					label: __("Payment Method"),
					fieldtype: "Select",
					options: ["Cash", "UPI", "Bank Transfer", "Cheque"],
					default: "Cash",
					reqd: 1,
				},
				{
					fieldname: "transaction_reference",
					label: __("Transaction Reference"),
					fieldtype: "Data",
					mandatory_depends_on: "eval:doc.payment_method !== 'Cash'",
				},
				{ fieldname: "remarks", label: __("Remarks"), fieldtype: "Small Text" },
				{
					fieldname: "help",
					fieldtype: "HTML",
					options: `<p class="text-muted">${__(
						"A linked collection receipt reduces the dealer’s recorded dues. Any excess is recorded as unapplied."
					)}</p>`,
				},
			],
			primary_action_label: __("Save Collection"),
			primary_action: async (values) => {
				if (busy) return;
				if (!(Number(values.value) > 0)) {
					frappe.msgprint(__("Collection amount must be greater than zero."));
					return;
				}
				if (values.payment_method !== "Cash" && !values.transaction_reference?.trim()) {
					frappe.msgprint(__("Transaction reference is required for noncash payments."));
					return;
				}
				busy = true;
				dialog.get_primary_btn().prop("disabled", true).text(__("Saving…"));
				const status = dialog.fields_dict.save_status.$wrapper;
				status.html(`<p role="status">${__("Saving collection. Please wait…")}</p>`);
				try {
					const result = await api("collect", {
						customer: values.customer,
						value: values.value,
						payment_method: values.payment_method,
						transaction_reference: values.transaction_reference || "",
						remarks: values.remarks || "",
						request_key,
					});
					dialog.hide();
					frappe.show_alert({
						message: __("Collection saved: {0}", [result.name]),
						indicator: "green",
					});
					Promise.resolve()
						.then(() => onSave(result))
						.catch(() => {
							frappe.msgprint(
								__(
									"Collection saved, but Home could not refresh. Reload Home to see the updated balance."
								)
							);
						});
				} catch (error) {
					let message = __(
						"Could not confirm the collection. Check your connection and retry; the same request will not be recorded twice."
					);
					const response = error?.responseJSON || error;
					try {
						const messages = JSON.parse(response?._server_messages || "[]");
						if (messages.length) message = JSON.parse(messages[0]).message || message;
						else if (typeof response?.message === "string") message = response.message;
					} catch (_) {
						/* Keep retry guidance when server error details cannot be parsed. */
					}
					status.html(`<p class="text-danger" role="alert">${esc(message)}</p>`);
				} finally {
					busy = false;
					dialog.get_primary_btn().prop("disabled", false).text(__("Save Collection"));
				}
			},
		});
		dialog.show();
	};

	srv_erp.home_collections.show = (panel, { onSave, onBack }) => {
		panel.find(".home-collections-view").remove();
		panel.find(".salesperson-home-grid").hide();
		const view = $('<section class="home-collections-view">').appendTo(panel);
		const header = $('<div class="home-collections-heading">').appendTo(view);
		$("<h2>").text(__("Collections")).appendTo(header);
		const actions = $('<div class="home-collections-actions">').appendTo(header);
		$('<button type="button" class="btn btn-default">')
			.text(__("Back to Home"))
			.appendTo(actions)
			.on("click", onBack);
		$('<button type="button" class="btn btn-primary">')
			.text(__("Collect Money"))
			.appendTo(actions)
			.on("click", () => {
				void srv_erp.home_collections
					.collect({
						onSave: () => {
							onSave();
							void load();
						},
					})
					.catch(() => {});
			});
		const filters = $('<form class="home-collection-filters">').appendTo(view);
		filters.html(
			`<label>${__(
				"Search"
			)}<input class="form-control" name="search" type="search" placeholder="${__(
				"Dealer, receipt, DSR, reference or remarks"
			)}"></label><label>${__(
				"From Date"
			)}<input class="form-control" type="date" name="from_date"></label><label>${__(
				"To Date"
			)}<input class="form-control" type="date" name="to_date"></label>${[
				[
					"payment_method",
					"Payment Method",
					["", "Cash", "UPI", "Bank Transfer", "Cheque"],
				],
				["status", "Status", ["", "Recorded", "Posted", "Reversed"]],
				[
					"source",
					"Source",
					[
						["", "All sources"],
						["home", "Home / Direct"],
						["visit", "Smart DSR Visit"],
					],
				],
			]
				.map(
					([name, label, values]) =>
						`<label>${__(label)}<select class="form-control" name="${name}">${values
							.map((option) => {
								const [value, text] = Array.isArray(option)
									? option
									: [option, option || "All"];
								return `<option value="${value}">${__(text)}</option>`;
							})
							.join("")}</select></label>`
				)
				.join("")}<button type="submit" class="btn btn-primary">${__(
				"Apply Filters"
			)}</button><button type="button" class="btn btn-default" data-clear>${__(
				"Clear"
			)}</button>`
		);
		const status = $('<p class="text-muted" role="status">').appendTo(view);
		const totals = $('<div class="home-collections-totals">').appendTo(view);
		const table = $('<div class="home-collections-table">').appendTo(view);
		const pagination = $('<div class="home-collections-pagination">').appendTo(view);
		const previous = $('<button type="button" class="btn btn-default">')
			.text(__("Previous"))
			.appendTo(pagination);
		const next = $('<button type="button" class="btn btn-default">')
			.text(__("Next"))
			.appendTo(pagination);
		let start = 0,
			applied = {},
			generation = 0;
		async function load() {
			const request = ++generation;
			status.text(__("Loading collections…"));
			previous.prop("disabled", true);
			next.prop("disabled", true);
			try {
				const result = await api("collections", { ...applied, start });
				if (request !== generation || !view[0].isConnected) return;
				if (start && !result.rows.length) {
					start = 0;
					return load();
				}
				const count = Number(result.totals.count);
				status.text(
					count
						? __("Showing {0}–{1} of {2} collections", [
								start + 1,
								start + result.rows.length,
								count,
						  ])
						: __("No collections match your filters.")
				);
				totals.html(
					[
						["Total Collected", result.totals.total],
						["Cash Collected", result.totals.cash],
						["Noncash Collected", result.totals.noncash],
					]
						.map(
							([label, value]) =>
								`<div><span>${__(label)}</span><strong>${cash(
									value,
									result.currency
								)}</strong></div>`
						)
						.join("")
				);
				table.html(
					`<p class="text-muted">${__(
						"Totals cover all matching collections, including previous DSRs. Reversed collections are excluded from totals."
					)}</p><table class="table"><thead><tr>${[
						"Date",
						"Dealer / Party",
						"Amount",
						"Payment Method",
						"Source",
						"Status",
						"Reference",
						"Details",
					]
						.map((label) => `<th>${__(label)}</th>`)
						.join("")}</tr></thead><tbody>${
						result.rows
							.map(
								(row, index) =>
									`<tr><td>${esc(date(row.collected_at))}</td><td><strong>${esc(
										row.customer_name || row.customer
									)}</strong><small>${esc(
										row.name
									)}</small></td><td class="collection-amount">${cash(
										row.amount,
										result.currency
									)}</td><td>${esc(row.payment_method)}</td><td>${__(
										row.activity ? "Smart DSR Visit" : "Home / Direct"
									)}</td><td><span class="indicator-pill ${
										row.verification_status === "Reversed"
											? "red"
											: row.verification_status === "Posted"
											? "green"
											: "orange"
									}">${__(row.verification_status)}</span></td><td>${esc(
										row.transaction_reference || "—"
									)}</td><td><button type="button" class="btn btn-default btn-xs" data-details="${index}">${__(
										"View"
									)}</button></td></tr>`
							)
							.join("") ||
						`<tr><td colspan="8">${__("No collections found.")}</td></tr>`
					}</tbody></table>`
				);
				table.find("[data-details]").on("click", (event) => {
					const row = result.rows[Number(event.currentTarget.dataset.details)];
					const dialog = new frappe.ui.Dialog({
						title: __("Collection Details"),
						fields: [
							{
								fieldtype: "HTML",
								fieldname: "details",
								options: `<dl>${[
									["Receipt", row.name],
									["Dealer / Party", row.customer_name || row.customer],
									["Amount", cash(row.amount, result.currency)],
									["Date", date(row.collected_at)],
									["Payment Method", row.payment_method],
									["Reference", row.transaction_reference || "—"],
									["Status", row.verification_status],
									["Source", row.activity ? "Smart DSR Visit" : "Home / Direct"],
									["DSR", row.duty || "No DSR · Direct collection"],
									["Visit", row.activity || "—"],
									["Payment Entry", row.payment_entry || "Not posted"],
									["Remarks", row.remarks || "—"],
								]
									.map(
										([label, value]) =>
											`<dt>${__(label)}</dt><dd>${esc(value)}</dd>`
									)
									.join("")}</dl>`,
							},
						],
					});
					dialog.show();
				});
				previous.prop("disabled", start === 0);
				next.prop("disabled", start + result.rows.length >= count);
			} catch (_) {
				if (request === generation) {
					status.text(__("Could not load collections. Apply Filters to retry."));
					table.empty();
					totals.empty();
				}
			}
		}
		filters.on("submit", (event) => {
			event.preventDefault();
			const values = Object.fromEntries(new FormData(filters[0]));
			if (values.from_date && values.to_date && values.from_date > values.to_date) {
				frappe.msgprint(__("To Date must be on or after From Date."));
				return;
			}
			applied = values;
			start = 0;
			void load();
		});
		filters.find("[data-clear]").on("click", () => {
			filters[0].reset();
			applied = {};
			start = 0;
			void load();
		});
		previous.on("click", () => {
			start = Math.max(0, start - 50);
			void load();
		});
		next.on("click", () => {
			start += 50;
			void load();
		});
		void load();
	};
})();
