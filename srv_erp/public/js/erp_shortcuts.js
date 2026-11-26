(function () {
	"use strict";

	const page_shortcuts = [
		{ key: "i", label: "Item", route: ["List", "Item"], description: "Open Item List" },
		{ key: "c", label: "Customer", route: ["List", "Customer"], description: "Open Customer List" },
		{ key: "u", label: "Supplier", route: ["List", "Supplier"], description: "Open Supplier List" },
		{ key: "s", label: "Sales Order", route: ["List", "Sales Order"], description: "Open Sales Order List" },
		{ key: "p", label: "Purchase Order", route: ["List", "Purchase Order"], description: "Open Purchase Order List" },
		{ key: "l", label: "Stock Ledger", route: ["query-report", "Stock Ledger"], description: "Open Stock Ledger" },
		{ key: "b", label: "Stock Balance", route: ["query-report", "Stock Balance"], description: "Open Stock Balance" },
	];
	const shortcut_by_label = new Map(page_shortcuts.map((definition) => [definition.label, definition]));
	const HINT_STYLE_ID = "srv-erp-home-shortcut-hints";

	function is_dialog_open() {
		return Boolean(document.querySelector(".modal.show"));
	}

	function can_create(doctype) {
		return !frappe.model.can_create || frappe.model.can_create(doctype);
	}

	function show_permission_message(doctype) {
		frappe.msgprint({
			title: __("Not Permitted"),
			message: __("You do not have permission to create {0}.", [__(doctype)]),
			indicator: "orange",
		});
	}

	function inject_home_shortcut_hint_styles() {
		if (document.getElementById(HINT_STYLE_ID)) {
			return;
		}

		const style = document.createElement("style");
		style.id = HINT_STYLE_ID;
		style.textContent = `
			.shortcut-widget-box .widget-title .srv-erp-shortcut-letter {
				color: var(--blue-600, #2490ef) !important;
				font-weight: 800;
				text-decoration: underline 2px currentColor;
				text-underline-offset: 3px;
			}
		`;
		document.head.appendChild(style);
	}

	function decorate_home_shortcuts() {
		document.querySelectorAll(".shortcut-widget-box").forEach((widget) => {
			const title = widget.querySelector(".widget-title .ellipsis");
			const shortcut_block = widget.closest("[shortcut_name]");
			const label = (
				shortcut_block?.getAttribute("shortcut_name") ||
				widget.getAttribute("aria-label") ||
				title?.getAttribute("title") ||
				title?.textContent ||
				widget.dataset.widgetName ||
				""
			).trim();
			const definition = shortcut_by_label.get(label);
			if (!definition || !title || title.dataset.srvShortcutDecorated === "1") {
				return;
			}

			const index = label.toLowerCase().indexOf(definition.key);
			if (index < 0) {
				return;
			}

			const fragments = [...label].map((letter, letter_index) => {
				if (letter_index !== index) {
					return document.createTextNode(letter);
				}

				const highlighted_letter = document.createElement("strong");
				highlighted_letter.className = "srv-erp-shortcut-letter";
				highlighted_letter.textContent = letter.toUpperCase();
				return highlighted_letter;
			});
			title.replaceChildren(...fragments);
			title.dataset.srvShortcutDecorated = "1";
			widget.setAttribute("aria-keyshortcuts", definition.key.toUpperCase());
		});
	}

	function setup_home_shortcut_hints() {
		inject_home_shortcut_hint_styles();
		decorate_home_shortcuts();

		const observer = new MutationObserver(() => {
			window.requestAnimationFrame(decorate_home_shortcuts);
		});
		observer.observe(document.body, { childList: true, subtree: true });
	}

	function should_native_ui_handle_escape() {
		const focused_element = document.activeElement;
		const is_editing = focused_element?.matches(
			"input, select, textarea, [contenteditable=true]"
		);
		return Boolean(
			is_editing ||
			window.cur_dialog ||
			document.querySelector(
				".modal.show, .grid-row-open, .dropdown-menu.show, .dropdown.open, .see-ai-root.is-open"
			)
		);
	}

	function handle_escape_navigation(event) {
		if (event.key !== "Escape" || event.ctrlKey || event.metaKey || event.altKey) {
			return;
		}

		if (should_native_ui_handle_escape()) {
			return;
		}

		const current_form_is_visible = window.cur_frm?.page?.wrapper?.is?.(":visible");
		if (current_form_is_visible && window.cur_frm?.is_dirty?.()) {
			event.preventDefault();
			event.stopImmediatePropagation();
			frappe.show_alert({
				message: __("Save or discard the unsaved changes before going back."),
				indicator: "orange",
			});
			return;
		}

		event.preventDefault();
		event.stopImmediatePropagation();
		if (window.history.length > 1) {
			window.history.back();
		}
	}

	function get_active_sales_order() {
		const frm = window.cur_frm;
		if (frm && frm.doctype === "Sales Order" && frm.doc.docstatus === 0) {
			return frm;
		}
		return null;
	}

	async function add_item_to_sales_order(frm, item) {
		if (!frm || frm.doc.docstatus !== 0 || !item || !item.name) {
			return;
		}

		const row = (frm.doc.items || []).find((entry) => !entry.item_code) || frm.add_child("items");
		await frappe.model.set_value(row.doctype, row.name, "item_code", item.name);
		frm.refresh_field("items");

		const grid_row = frm.fields_dict.items.grid.grid_rows_by_docname[row.name];
		if (grid_row) {
			grid_row.toggle_view(true);
			grid_row.get_field("qty")?.set_focus();
		}
	}

	function create_item(frm = get_active_sales_order()) {
		if (!can_create("Item")) {
			show_permission_message("Item");
			return;
		}

		return frappe.ui.form.make_quick_entry("Item", (item) => {
			if (frm) {
				void add_item_to_sales_order(frm, item);
			}
		});
	}

	function register_page_shortcuts() {
		page_shortcuts.forEach(({ key, route, description }) => {
			frappe.ui.keys.add_shortcut({
				shortcut: key,
				description: __(description),
				condition: () => !is_dialog_open(),
				action: () => {
					void frappe.set_route(...route);
					return true;
				},
			});
		});
	}

	function register_shortcuts() {
		if (window.__srv_erp_shortcuts_registered || !frappe.ui?.keys?.add_shortcut) {
			return false;
		}

		register_page_shortcuts();
		setup_home_shortcut_hints();
		document.addEventListener("keydown", handle_escape_navigation, true);
		window.__srv_erp_shortcuts_registered = true;
		return true;
	}

	window.srv_erp_shortcuts = {
		add_item_to_sales_order,
		create_item,
		register_shortcuts,
	};

	let attempts = 0;
	const registration_timer = window.setInterval(() => {
		attempts += 1;
		if (register_shortcuts() || attempts >= 50) {
			window.clearInterval(registration_timer);
		}
	}, 200);
})();
