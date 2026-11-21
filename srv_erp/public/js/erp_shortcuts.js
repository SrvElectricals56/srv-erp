(function () {
	"use strict";

	const page_shortcuts = [
		{ key: "i", label: "Item", route: ["List", "Item"], description: "Open Item List" },
		{ key: "c", label: "Customer", route: ["List", "Customer"], description: "Open Customer List" },
		{ key: "u", label: "Supplier", route: ["List", "Supplier"], description: "Open Supplier List" },
		{ key: "p", label: "Purchase Order", route: ["List", "Purchase Order"], description: "Open Purchase Order List" },
		{ key: "e", label: "Stock Entry", route: ["List", "Stock Entry"], description: "Open Stock Entry List" },
		{ key: "t", label: "Purchase Receipt", route: ["List", "Purchase Receipt"], description: "Open Purchase Receipt List" },
		{ key: "s", label: "Sales Order", route: ["List", "Sales Order"], description: "Open Sales Order List" },
		{ key: "d", label: "Delivery Note", route: ["List", "Delivery Note"], description: "Open Delivery Note List" },
		{ key: "r", label: "DSR", route: ["List", "DSR"], description: "Open DSR List" },
		{ key: "b", label: "Stock Balance", route: ["query-report", "Stock Balance"], description: "Open Stock Balance" },
		{ key: "l", label: "Stock Ledger", route: ["query-report", "Stock Ledger"], description: "Open Stock Ledger" },
		{ key: "o", label: "Items Ordered in Date Range", route: ["query-report", "Items Ordered in Date Range"], description: "Open Items Ordered in Date Range" },
		{ key: "m", label: "Items Sold in Date Range", route: ["query-report", "Items Sold in Date Range"], description: "Open Items Sold in Date Range" },
		{ key: "f", label: "Production Planning Forecast", route: ["query-report", "Production Planning Forecast"], description: "Open Production Planning Forecast" },
		{ key: "y", label: "Daily Outgoing", route: ["query-report", "Daily Outgoing"], description: "Open Daily Outgoing" },
	];
	const shortcut_by_label = new Map(page_shortcuts.map((definition) => [definition.label, definition]));
	const HINT_STYLE_ID = "srv-erp-home-shortcut-hints";
	const SIDEBAR_KEYBOARD_CLASS = "srv-erp-sidebar-keyboard-active";
	const FORM_TAB_KEYBOARD_CLASS = "srv-erp-form-tab-keyboard-active";
	const LIST_ADD_SHORTCUT_KEY = "a";
	let sidebar_keyboard_anchor = null;
	let form_keyboard_tab = null;
	let form_tab_highlight = null;
	let form_keyboard_input = null;
	let list_filter_shortcuts = [];
	let list_primary_action = null;
	let shortcut_decoration_frame = null;
	let route_search_cleanup_timers = [];

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
			.standard-sidebar-item.${SIDEBAR_KEYBOARD_CLASS} {
				background: var(--control-bg, var(--bg-light-gray));
				outline: 2px solid var(--blue-500, #2490ef);
				outline-offset: -2px;
				border-radius: var(--border-radius, 6px);
			}
			.standard-filter-section .srv-erp-filter-shortcut-checkbox {
				flex: 0 0 170px !important;
				width: 170px !important;
				max-width: 170px;
				min-height: 30px;
				padding-right: 0;
			}
			.standard-filter-section .srv-erp-filter-shortcut-checkbox .checkbox {
				width: auto;
				min-width: 0;
				margin: 0;
			}
			.standard-filter-section .srv-erp-filter-shortcut-checkbox .checkbox label {
				display: flex;
				align-items: center;
				width: 100%;
				min-height: 30px;
				margin: 0;
				white-space: nowrap;
			}
			.standard-filter-section .srv-erp-filter-shortcut-checkbox input[type="checkbox"] {
				flex: 0 0 var(--checkbox-size);
				padding: 0 !important;
			}
			.standard-filter-section .srv-erp-filter-shortcut-checkbox .label-area {
				display: inline-block;
				overflow: visible;
				white-space: nowrap;
			}
			.standard-filter-section .srv-erp-filter-shortcut-autocomplete {
				flex: 0 0 180px !important;
				width: 180px !important;
				max-width: 180px;
			}
			.standard-filter-section .srv-erp-filter-shortcut-hint,
			.page-head .srv-erp-list-add-shortcut-hint {
				display: block;
				margin-top: 2px;
				font-size: 8px;
				line-height: 10px;
				font-weight: 400;
				color: var(--gray-500);
				white-space: nowrap;
			}
			.page-head .srv-erp-list-add-shortcut {
				display: inline-flex;
				flex-direction: column;
				align-items: flex-end;
			}
			.form-tabs.srv-erp-form-tabs-keyboard {
				position: relative;
				isolation: isolate;
			}
			.form-tabs .srv-erp-form-tab-highlight {
				position: absolute;
				top: 5px;
				bottom: 5px;
				left: 0;
				z-index: 1;
				pointer-events: none;
				transition: transform 240ms ease, width 240ms ease;
			}
			.form-tabs .srv-erp-form-tab-highlight,
			.form-control.srv-erp-form-field-keyboard:focus:not([type="checkbox"]):not([type="radio"]) {
				border-radius: var(--border-radius);
				background-color: var(--control-bg);
				box-shadow: inset 0 0 0 1px var(--dark-border-color);
			}
			.srv-erp-form-field-keyboard:focus {
				outline: 1px solid var(--gray-500);
				outline-offset: 1px;
			}
			.form-tabs .nav-link.${FORM_TAB_KEYBOARD_CLASS} {
				position: relative;
				z-index: 2;
				background-color: transparent;
			}
			@media (prefers-reduced-motion: reduce) {
				.form-tabs .srv-erp-form-tab-highlight {
					transition: none;
				}
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

	function setup_shortcut_hints() {
		inject_home_shortcut_hint_styles();
		schedule_shortcut_decoration();

		const observer = new MutationObserver(schedule_shortcut_decoration);
		observer.observe(document.body, { childList: true, subtree: true });
	}

	function schedule_shortcut_decoration() {
		if (shortcut_decoration_frame !== null) {
			return;
		}

		shortcut_decoration_frame = window.requestAnimationFrame(() => {
			shortcut_decoration_frame = null;
			decorate_home_shortcuts();
			decorate_list_filter_shortcuts();
			decorate_list_primary_action_shortcut();
		});
	}

	function is_visible(element) {
		return Boolean(element && element.getClientRects().length);
	}

	function get_visible_page_container() {
		return [...document.querySelectorAll(".page-container")].find(is_visible) || document;
	}

	function get_filter_shortcut_candidates(label) {
		const words = label.match(/[\p{L}\p{N}]+/gu) || [];
		const candidates = words.map((word) => [...word][0]);
		words.forEach((word) => candidates.push(...word));
		return [...new Set(candidates.map((letter) => letter.toLocaleLowerCase()))].filter((letter) =>
			/^[a-z0-9]$/.test(letter)
		);
	}

	function get_standard_filter_controls() {
		const page = get_visible_page_container();
		const section = page.querySelector(".standard-filter-section");
		if (!section || !is_visible(section)) {
			return { section: null, controls: [] };
		}

		const controls = [...section.querySelectorAll(":scope > .frappe-control")]
			.map((wrapper) => {
				const input = [...wrapper.querySelectorAll("input:not([type=hidden]), select, textarea")].find(
					(element) => !element.disabled && is_visible(element)
				);
				const label = (
					wrapper.getAttribute("data-original-title") ||
					wrapper.getAttribute("title") ||
					input?.getAttribute("placeholder") ||
					input?.getAttribute("aria-label") ||
					""
				).trim();
				return { wrapper, input, label };
			})
			.filter(({ input, label }) => input && label);

		return { section, controls };
	}

	function decorate_list_filter_shortcuts() {
		const { section, controls } = get_standard_filter_controls();
		if (!section) {
			list_filter_shortcuts = [];
			return;
		}

		const used_keys = new Set([LIST_ADD_SHORTCUT_KEY]);
		const bindings = controls
			.map(({ wrapper, input, label }) => {
				const key = get_filter_shortcut_candidates(label).find((candidate) => !used_keys.has(candidate));
				if (!key) {
					return null;
				}
				used_keys.add(key);
				return { wrapper, input, label, key };
			})
			.filter(Boolean);

		const signature = bindings
			.map(({ label, key, input }) => `${label}:${key}:${input.type || input.tagName}`)
			.join("|");
		if (section.dataset.srvFilterShortcutSignature !== signature) {
			section.querySelectorAll(".srv-erp-filter-shortcut-hint").forEach((hint) => hint.remove());
			section
				.querySelectorAll(".srv-erp-filter-shortcut-checkbox, .srv-erp-filter-shortcut-autocomplete")
				.forEach((wrapper) =>
					wrapper.classList.remove(
						"srv-erp-filter-shortcut-checkbox",
						"srv-erp-filter-shortcut-autocomplete"
					)
				);

			bindings.forEach(({ wrapper, input, label, key }) => {
				wrapper.classList.toggle(
					"srv-erp-filter-shortcut-checkbox",
					input.matches('input[type="checkbox"]')
				);
				wrapper.classList.toggle(
					"srv-erp-filter-shortcut-autocomplete",
					Boolean(input.closest(".awesomplete"))
				);
				input.setAttribute("aria-keyshortcuts", `Shift+${key.toUpperCase()}`);
				input.dataset.srvFilterShortcut = key;

				const hint = document.createElement("span");
				hint.className = "srv-erp-filter-shortcut-hint";
				hint.title = __(
					"Press Shift + {0} to focus {1}",
					[key.toUpperCase(), label]
				);
				hint.textContent = input.getAttribute("aria-keyshortcuts");
				wrapper.append(hint);
			});
			section.dataset.srvFilterShortcutSignature = signature;
		}

		list_filter_shortcuts = bindings;
	}

	function is_list_route() {
		const route = frappe.get_route?.() || [];
		return String(route[0] || "").toLocaleLowerCase() === "list";
	}

	function get_list_primary_action() {
		if (!is_list_route()) {
			return null;
		}

		const button = window.cur_list?.page?.btn_primary?.get?.(0);
		return button && is_visible(button) && !button.disabled ? button : null;
	}

	function clear_list_primary_action_shortcut(button = list_primary_action) {
		if (!button) {
			return;
		}

		button.removeAttribute("aria-keyshortcuts");
		const container = button.parentElement;
		if (container?.classList.contains("srv-erp-list-add-shortcut")) {
			container.replaceWith(button);
		}
		if (button === list_primary_action) {
			list_primary_action = null;
		}
	}

	function decorate_list_primary_action_shortcut() {
		const button = get_list_primary_action();
		if (list_primary_action && list_primary_action !== button) {
			clear_list_primary_action_shortcut(list_primary_action);
		}

		if (!button) {
			list_primary_action = null;
			return;
		}

		list_primary_action = button;
		button.setAttribute("aria-keyshortcuts", "Shift+A");
		if (button.parentElement?.classList.contains("srv-erp-list-add-shortcut")) {
			return;
		}

		const container = document.createElement("div");
		container.className = "srv-erp-list-add-shortcut";

		const hint = document.createElement("span");
		hint.className = "srv-erp-list-add-shortcut-hint";
		hint.title = __("Press Shift + A");
		hint.textContent = "Shift+A";

		button.before(container);
		container.append(button, hint);
	}

	function handle_list_primary_action_keyboard(event) {
		if (
			!event.shiftKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey ||
			event.repeat ||
			event.key.toLocaleLowerCase() !== LIST_ADD_SHORTCUT_KEY ||
			is_dialog_open() ||
			is_editable_element(event.target)
		) {
			return;
		}

		const button = get_list_primary_action();
		if (!button) {
			return;
		}

		event.preventDefault();
		event.stopImmediatePropagation();
		button.click();
	}

	function close_route_search_dropdowns() {
		const page = get_visible_page_container();
		const inputs = [
			...page.querySelectorAll(
				".standard-filter-section .frappe-control input, " +
					".standard-filter-section .frappe-control textarea"
			),
			document.querySelector("#navbar-search"),
		].filter(Boolean);

		inputs.forEach((input) => {
			const list = input.closest(".awesomplete")?.querySelector("ul");
			if (list) {
				list.hidden = true;
				list.setAttribute("aria-hidden", "true");
			}
			input.setAttribute("aria-expanded", "false");
		});

		if (inputs.includes(document.activeElement)) {
			document.activeElement.blur();
		}
	}

	function schedule_route_search_cleanup() {
		route_search_cleanup_timers.forEach((timer) => window.clearTimeout(timer));
		route_search_cleanup_timers = [0, 120, 360].map((delay) =>
			window.setTimeout(close_route_search_dropdowns, delay)
		);
	}

	function is_editable_element(element) {
		return Boolean(
			element?.matches?.("input, select, textarea, [contenteditable=true]")
		);
	}

	function has_open_autocomplete(input) {
		const suggestions = input?.closest?.(".awesomplete")?.querySelector("ul");
		return Boolean(suggestions && is_visible(suggestions) && !suggestions.hasAttribute("hidden"));
	}

	function focus_list_result(direction) {
		const page = get_visible_page_container();
		const rows = [...page.querySelectorAll(".list-row-container")].filter(is_visible);
		const row = direction === "down" ? rows[0] : rows[rows.length - 1];
		if (!row) {
			return false;
		}

		row.focus({ preventScroll: true });
		row.scrollIntoView({ block: "nearest" });
		return true;
	}

	function handle_list_filter_keyboard(event) {
		const standard_filter_input = event.target.closest?.(
			".standard-filter-section .frappe-control input, " +
				".standard-filter-section .frappe-control select, " +
				".standard-filter-section .frappe-control textarea"
		);
		if (
			standard_filter_input &&
			(event.key === "ArrowDown" || event.key === "ArrowUp") &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.altKey &&
			!event.shiftKey &&
			!has_open_autocomplete(standard_filter_input)
		) {
			const direction = event.key === "ArrowDown" ? "down" : "up";
			if (focus_list_result(direction)) {
				event.preventDefault();
				event.stopImmediatePropagation();
			}
			return;
		}

		if (
			!event.shiftKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey ||
			event.repeat ||
			is_dialog_open() ||
			is_editable_element(event.target)
		) {
			return;
		}

		const key = event.key.toLocaleLowerCase();
		const binding = list_filter_shortcuts.find(
			(candidate) => candidate.key === key && is_visible(candidate.input)
		);
		if (!binding) {
			return;
		}

		event.preventDefault();
		event.stopImmediatePropagation();
		binding.input.focus({ preventScroll: true });
		binding.input.select?.();
		binding.input.scrollIntoView({ block: "nearest", inline: "nearest" });
	}

	function get_visible_form_tabs(frm = window.cur_frm) {
		if (!frm?.layout?.tabs?.length) {
			return [];
		}

		const form_wrapper = frm.wrapper?.get?.(0) || frm.wrapper;
		if (form_wrapper && !is_visible(form_wrapper)) {
			return [];
		}

		return frm.layout.tabs.filter((tab) => {
			const tab_element = tab.tab_link?.get?.(0) || tab.tab_link?.[0];
			return !tab.hidden && !tab.is_hidden?.() && is_visible(tab_element);
		});
	}

	function get_form_tab_button(tab) {
		return tab?.tab_link?.find?.(".nav-link")?.get?.(0);
	}

	function clear_form_tab_keyboard_selection() {
		get_form_tab_button(form_keyboard_tab)?.classList.remove(FORM_TAB_KEYBOARD_CLASS);
		const tab_bar = form_tab_highlight?.parentElement;
		form_tab_highlight?.remove();
		tab_bar?.classList.remove("srv-erp-form-tabs-keyboard");
		form_tab_highlight = null;
		form_keyboard_tab = null;
	}

	function update_form_tab_highlight() {
		const tab_button = get_form_tab_button(form_keyboard_tab);
		const tab_bar = tab_button?.closest(".form-tabs");
		if (!tab_bar || !is_visible(tab_button)) {
			return;
		}

		if (!form_tab_highlight) {
			form_tab_highlight = document.createElement("li");
			form_tab_highlight.className = "srv-erp-form-tab-highlight";
			form_tab_highlight.setAttribute("aria-hidden", "true");
			tab_bar.classList.add("srv-erp-form-tabs-keyboard");
		}

		const tab_rect = tab_button.getBoundingClientRect();
		const bar_rect = tab_bar.getBoundingClientRect();
		const left = tab_rect.left - bar_rect.left - tab_bar.clientLeft + tab_bar.scrollLeft;
		form_tab_highlight.style.width = `${tab_rect.width + 16}px`;
		form_tab_highlight.style.transform = `translateX(${left - 8}px)`;
		if (form_tab_highlight.parentElement !== tab_bar) {
			tab_bar.append(form_tab_highlight);
		}
	}

	function select_form_keyboard_tab(tab) {
		const previous_button = get_form_tab_button(form_keyboard_tab);
		const tab_button = get_form_tab_button(tab);
		if (!tab_button) {
			clear_form_tab_keyboard_selection();
			return;
		}

		if (previous_button?.closest(".form-tabs") !== tab_button.closest(".form-tabs")) {
			clear_form_tab_keyboard_selection();
		} else {
			previous_button.classList.remove(FORM_TAB_KEYBOARD_CLASS);
		}

		form_keyboard_tab = tab;
		tab.set_active();
		tab_button.classList.add(FORM_TAB_KEYBOARD_CLASS);
		tab_button.focus({ preventScroll: true });
		update_form_tab_highlight();
		tab_button.scrollIntoView({ block: "nearest", inline: "nearest" });
	}

	function activate_form_tab_keyboard_mode() {
		const frm = window.cur_frm;
		const tabs = get_visible_form_tabs(frm);
		if (!tabs.length) {
			return false;
		}

		const active_tab = frm.get_active_tab?.() || tabs.find((tab) => tab.is_active?.()) || tabs[0];
		select_form_keyboard_tab(tabs.includes(active_tab) ? active_tab : tabs[0]);
		return true;
	}

	function handle_form_tab_arrow(event) {
		if (!form_keyboard_tab || !["ArrowLeft", "ArrowRight"].includes(event.key)) {
			return false;
		}
		if (is_editable_element(event.target)) {
			return false;
		}

		const tabs = get_visible_form_tabs();
		if (!tabs.length) {
			clear_form_tab_keyboard_selection();
			return false;
		}

		event.preventDefault();
		event.stopImmediatePropagation();
		const current_index = Math.max(tabs.indexOf(form_keyboard_tab), 0);
		const direction = event.key === "ArrowRight" ? 1 : -1;
		const next_index = (current_index + direction + tabs.length) % tabs.length;
		select_form_keyboard_tab(tabs[next_index]);
		return true;
	}

	function clear_form_field_navigation() {
		form_keyboard_input?.classList.remove("srv-erp-form-field-keyboard");
		form_keyboard_input = null;
	}

	function get_editable_form_inputs(frm, tab) {
		return (frm.layout?.fields_list || [])
			.filter((field) => (!tab || field.tab === tab) && field.disp_status === "Write")
			.map((field) => field.$input?.get?.(0))
			.filter((input) =>
				input?.matches('input:not([type="hidden"]), select, textarea') &&
				!input.matches(":disabled, [readonly], [aria-disabled=true]") &&
				!input.closest(".hide, .hide-control, [hidden]")
			);
	}

	function focus_form_input(input) {
		clear_form_field_navigation();
		form_keyboard_input = input;
		input.classList.add("srv-erp-form-field-keyboard");
		input.focus({ preventScroll: true });
		input.scrollIntoView({ block: "nearest", inline: "nearest" });
		if (input.matches('input[type="text"], input[type="search"], textarea')) {
			input.select();
		}
	}

	function handle_form_field_navigation(event) {
		if (is_dialog_open() || event.isComposing) {
			return;
		}

		const frm = window.cur_frm;
		const form_wrapper = frm?.wrapper?.get?.(0) || frm?.wrapper;
		if (!is_visible(form_wrapper)) {
			return;
		}

		const activate = event.altKey && !event.ctrlKey && !event.metaKey && event.code === "KeyD";
		if (activate) {
			const tabs = get_visible_form_tabs(frm);
			const current_tab = tabs.find((tab) => tab.is_active?.()) || tabs[0];
			const input = get_editable_form_inputs(frm, current_tab).find(is_visible);
			if (input && !event.repeat) {
				event.preventDefault();
				event.stopImmediatePropagation();
				clear_form_tab_keyboard_selection();
				focus_form_input(input);
			}
			return;
		}

		if (!form_keyboard_input) {
			return;
		}

		if (event.key === "Escape") {
			clear_form_field_navigation();
			if (!has_open_autocomplete(event.target)) {
				event.preventDefault();
				event.stopImmediatePropagation();
			}
			return;
		}

		if (!["ArrowDown", "ArrowUp"].includes(event.key) ||
			event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
			has_open_autocomplete(event.target)) {
			return;
		}

		const tabs = get_visible_form_tabs(frm);
		const current_tab = tabs.find((tab) => tab.is_active?.()) || tabs[0];
		const inputs = get_editable_form_inputs(frm, current_tab).filter(is_visible);
		const index = inputs.indexOf(document.activeElement);
		if (index < 0) {
			clear_form_field_navigation();
			return;
		}

		event.preventDefault();
		event.stopImmediatePropagation();
		const direction = event.key === "ArrowDown" ? 1 : -1;
		const next_input = inputs[index + direction];
		if (next_input) {
			focus_form_input(next_input);
		}
	}

	function get_workspace_sidebar_anchors() {
		const page = get_visible_page_container();
		return [...page.querySelectorAll(".standard-sidebar-section .sidebar-item-container")]
			.map((container) => container.querySelector(":scope > .standard-sidebar-item > .item-anchor"))
			.filter(is_visible);
	}

	function clear_sidebar_keyboard_selection() {
		sidebar_keyboard_anchor
			?.closest(".standard-sidebar-item")
			?.classList.remove(SIDEBAR_KEYBOARD_CLASS);
		sidebar_keyboard_anchor = null;
	}

	function select_sidebar_anchor(anchor) {
		clear_sidebar_keyboard_selection();
		if (!anchor) {
			return;
		}

		sidebar_keyboard_anchor = anchor;
		anchor.closest(".standard-sidebar-item")?.classList.add(SIDEBAR_KEYBOARD_CLASS);
		anchor.focus({ preventScroll: true });
		anchor.scrollIntoView({ block: "nearest" });
	}

	function get_home_sidebar_anchor() {
		return get_workspace_sidebar_anchors().find(
			(anchor) => anchor.closest(".sidebar-item-container")?.getAttribute("item-name") === "Home"
		);
	}

	function open_sidebar_if_collapsed() {
		const page = get_visible_page_container();
		const sidebar = page.querySelector(".layout-side-section");
		if (is_visible(sidebar)) {
			return false;
		}

		const toggle = [...document.querySelectorAll(".page-head .sidebar-toggle-btn")].find(is_visible);
		toggle?.click();
		return Boolean(toggle);
	}

	function focus_home_sidebar_item() {
		open_sidebar_if_collapsed();
		window.setTimeout(() => {
			const home_anchor = get_home_sidebar_anchor();
			if (!home_anchor) {
				return;
			}

			if (!is_home_route()) {
				home_anchor.click();
				window.setTimeout(() => select_sidebar_anchor(get_home_sidebar_anchor()), 150);
				return;
			}
			select_sidebar_anchor(home_anchor);
		}, 0);
	}

	function handle_sidebar_keyboard(event) {
		const is_sidebar_shortcut =
			event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === "KeyM";
		if (is_sidebar_shortcut) {
			if (is_dialog_open()) {
				return;
			}
			event.preventDefault();
			event.stopImmediatePropagation();
			clear_sidebar_keyboard_selection();
			clear_form_field_navigation();
			if (activate_form_tab_keyboard_mode()) {
				return;
			}
			clear_form_tab_keyboard_selection();
			focus_home_sidebar_item();
			return;
		}

		if (form_keyboard_tab) {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopImmediatePropagation();
				clear_form_tab_keyboard_selection();
				return;
			}
			if (handle_form_tab_arrow(event)) {
				return;
			}
		}

		if (!sidebar_keyboard_anchor) {
			return;
		}

		if (event.key === "Escape") {
			event.preventDefault();
			event.stopImmediatePropagation();
			clear_sidebar_keyboard_selection();
			return;
		}

		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			event.stopImmediatePropagation();
			const selected_anchor = sidebar_keyboard_anchor;
			clear_sidebar_keyboard_selection();
			selected_anchor.click();
			return;
		}

		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
			return;
		}

		const anchors = get_workspace_sidebar_anchors();
		if (!anchors.length) {
			clear_sidebar_keyboard_selection();
			return;
		}

		event.preventDefault();
		event.stopImmediatePropagation();
		const current_index = Math.max(anchors.indexOf(sidebar_keyboard_anchor), 0);
		const direction = event.key === "ArrowDown" ? 1 : -1;
		const next_index = (current_index + direction + anchors.length) % anchors.length;
		select_sidebar_anchor(anchors[next_index]);
	}

	function is_home_route() {
		const route = frappe.get_route?.() || [];
		const route_path = route.map((part) => String(part).toLowerCase()).join("/");
		return (
			route_path === "home" ||
			route_path === "workspaces/home" ||
			/^\/app\/home\/?$/.test(window.location.pathname.toLowerCase())
		);
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

		if (is_home_route()) {
			event.preventDefault();
			event.stopImmediatePropagation();
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
		setup_shortcut_hints();

		document.addEventListener("keydown", handle_form_field_navigation, true);
		document.addEventListener("keydown", handle_list_primary_action_keyboard, true);
		document.addEventListener("keydown", handle_list_filter_keyboard, true);
		document.addEventListener("keydown", handle_sidebar_keyboard, true);
		window.addEventListener("resize", update_form_tab_highlight);
		document.addEventListener("keydown", handle_escape_navigation, true);
		frappe.router?.on?.("change", () => {
			clear_form_field_navigation();
			clear_form_tab_keyboard_selection();
			clear_sidebar_keyboard_selection();
			schedule_route_search_cleanup();
		});
		schedule_route_search_cleanup();
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
