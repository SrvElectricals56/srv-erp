import {
	consume_key, get_visible_page_container, has_open_autocomplete, is_alt_key, is_dialog_open, is_visible,
} from "./shared.js";
import { show_unsaved_navigation_dialog } from "./unsaved_changes.js";

const page_shortcuts = [
	{ key: "i", label: "Item", route: ["List", "Item"] },
	{ key: "c", label: "Customer", route: ["List", "Customer"] },
	{ key: "u", label: "Supplier", route: ["List", "Supplier"] },
	{ key: "p", label: "Purchase Order", route: ["List", "Purchase Order"] },
	{ key: "e", label: "Stock Entry", route: ["List", "Stock Entry"] },
	{ key: "t", label: "Purchase Receipt", route: ["List", "Purchase Receipt"] },
	{ key: "s", label: "Sales Order", route: ["List", "Sales Order"] },
	{ key: "d", label: "Delivery Note", route: ["List", "Delivery Note"] },
	{ key: "r", label: "DSR", route: ["List", "DSR"] },
	{ key: "b", label: "Stock Balance", route: ["query-report", "Stock Balance"] },
	{ key: "l", label: "Stock Ledger", route: ["query-report", "Stock Ledger"] },
	{ key: "o", label: "Items Ordered in Date Range", route: ["query-report", "Items Ordered in Date Range"] },
	{ key: "m", label: "Items Sold in Date Range", route: ["query-report", "Items Sold in Date Range"] },
	{ key: "f", label: "Production Planning Forecast", route: ["query-report", "Production Planning Forecast"] },
];
const shortcut_by_label = new Map(page_shortcuts.map((definition) => [definition.label, definition]));
const shortcut_by_key = new Map(page_shortcuts.map((definition) => [definition.key, definition]));
const SIDEBAR_KEYBOARD_CLASS = "srv-erp-sidebar-keyboard-active";
const HOME_TITLE_CLASS = "srv-erp-home-title";
const HOME_TITLE_HOST_CLASS = "srv-erp-home-title-host";
const HOME_MASTER_TITLE_CLASS = "srv-erp-home-master-title";
let sidebar_keyboard_anchor = null;

export function decorate_home_shortcuts() {
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
			highlighted_letter.textContent = letter;
			return highlighted_letter;
		});
		title.replaceChildren(...fragments);
		title.dataset.srvShortcutDecorated = "1";
		widget.setAttribute("aria-keyshortcuts", definition.key.toUpperCase());
	});
}

export function decorate_home_title() {
	const existing_titles = [...document.querySelectorAll(`.${HOME_TITLE_CLASS}`)];
	const existing_hosts = [...document.querySelectorAll(`.${HOME_TITLE_HOST_CLASS}`)];
	if (!is_home_route()) {
		existing_titles.forEach((title) => title.remove());
		existing_hosts.forEach((host) => host.classList.remove(HOME_TITLE_HOST_CLASS));
		return;
	}

	const page = get_visible_page_container();
	existing_titles.filter((title) => !page.contains(title)).forEach((title) => title.remove());
	const home_title = page.querySelector(".page-head .page-title .title-text");
	const title_host = page.querySelector(".page-head .page-head-content");
	const master_title = page.querySelector(`.${HOME_MASTER_TITLE_CLASS}`);
	if (home_title?.textContent.trim() !== __("Home") || !title_host || !master_title) {
		return;
	}

	let gateway_title = page.querySelector(`.${HOME_TITLE_CLASS}`);
	if (!gateway_title) {
		gateway_title = document.createElement("span");
		gateway_title.className = `${HOME_TITLE_CLASS} h3`;
		gateway_title.textContent = __("Gateway of Tally");
	}

	title_host.classList.add(HOME_TITLE_HOST_CLASS);
	if (gateway_title.parentElement !== title_host) {
		title_host.append(gateway_title);
	}

	const host_bounds = title_host.getBoundingClientRect();
	const master_bounds = master_title.getBoundingClientRect();
	const home_bounds = home_title.getBoundingClientRect();
	const is_rtl = document.documentElement.dir === "rtl";
	const master_inline_start = is_rtl
		? host_bounds.right - master_bounds.right
		: master_bounds.left - host_bounds.left;
	const minimum_inline_start = is_rtl
		? host_bounds.right - home_bounds.left + 16
		: home_bounds.right - host_bounds.left + 16;
	const inline_start = Math.max(master_inline_start, minimum_inline_start);
	gateway_title.style.setProperty("--srv-erp-home-title-inline-start", `${Math.max(0, inline_start)}px`);
}

function get_workspace_sidebar_anchors() {
	const page = get_visible_page_container();
	return [...page.querySelectorAll(".standard-sidebar-section .sidebar-item-container")]
		.map((container) => container.querySelector(":scope > .standard-sidebar-item > .item-anchor"))
		.filter(is_visible);
}

export function clear_sidebar_keyboard_selection() {
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

export function focus_home_sidebar_item() {
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

export function handle_sidebar_keyboard(event) {
	if (!sidebar_keyboard_anchor || is_dialog_open() || event.altKey || event.ctrlKey || event.metaKey) {
		return;
	}

	if (event.key === "Escape") {
		consume_key(event);
		clear_sidebar_keyboard_selection();
		return;
	}

	if (event.key === "Enter" || event.key === " ") {
		consume_key(event);
		const selected_anchor = sidebar_keyboard_anchor;
		clear_sidebar_keyboard_selection();
		selected_anchor.click();
		return;
	}

	if (!["ArrowDown", "ArrowUp"].includes(event.key)) {
		return;
	}

	const anchors = get_workspace_sidebar_anchors();
	if (!anchors.length) {
		clear_sidebar_keyboard_selection();
		return;
	}

	consume_key(event);
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
	return Boolean(
		has_open_autocomplete(focused_element) ||
		window.cur_dialog ||
		document.querySelector(
			".modal.show, .grid-row-open, .dropdown-menu.show, .dropdown.open, .see-ai-root.is-open"
		)
	);
}

export function handle_escape_navigation(event) {
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
		consume_key(event);
		show_unsaved_navigation_dialog(window.cur_frm);
		return;
	}

	event.preventDefault();
	event.stopImmediatePropagation();
	if (window.history.length > 1) {
		window.history.back();
	}
}

export function handle_page_shortcut(event) {
	if (
		event.repeat ||
		event.altKey ||
		event.ctrlKey ||
		event.metaKey ||
		event.shiftKey ||
		is_dialog_open() ||
		event.target?.closest?.("input, select, textarea, [contenteditable=true]")
	) {
		return false;
	}

	const definition = shortcut_by_key.get(event.key?.toLowerCase());
	if (!definition) {
		return false;
	}

	// Capture the event before Workspace's native A-Z Awesome Bar shortcuts run.
	consume_key(event);
	void frappe.set_route(...definition.route);
	return true;
}

function get_user_menu_button() {
	const menu = document.querySelector("#toolbar-user")?.closest(".dropdown");
	return menu?.querySelector("[data-toggle='dropdown']") ||
		document.querySelector(".dropdown-navbar-user [data-toggle='dropdown']");
}

export function decorate_user_menu_hint() {
	const button = get_user_menu_button();
	if (!button || button.querySelector(".srv-erp-user-menu-hint")) {
		return;
	}
	button.setAttribute("aria-keyshortcuts", "Alt+P");
	const hint = document.createElement("span");
	hint.className = "srv-erp-user-menu-hint";
	hint.textContent = "Alt+P";
	hint.title = __("Open user menu");
	hint.setAttribute("aria-hidden", "true");
	button.append(hint);
}

export function open_user_menu(event) {
	const button = get_user_menu_button();
	if (!button || !is_visible(button)) {
		return false;
	}

	if (!event.repeat && button.getAttribute("aria-expanded") !== "true") {
		button.focus({ preventScroll: true });
		button.click();
	}
	return true;
}

export function handle_user_menu_shortcut(event) {
	if (!is_alt_key(event, "KeyP") || event.isComposing) {
		return;
	}
	// Own Alt+P before native access keys or the plain P route see it.
	consume_key(event);
	if (!is_dialog_open()) {
		open_user_menu(event);
	}
}

export function register_profile_shortcut() {
	frappe.ui.keys.add_shortcut({
		shortcut: "alt+p",
		description: __("Open User Menu"),
		condition: () => !is_dialog_open() && is_visible(get_user_menu_button()),
		ignore_inputs: true,
		action: open_user_menu,
	});
}
