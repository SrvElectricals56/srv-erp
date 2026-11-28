import {
	get_visible_page_container, has_open_autocomplete, is_dialog_open, is_editable_element, is_visible,
} from "./shared.js";

const LIST_ADD_SHORTCUT_KEY = "a";
let list_filter_shortcuts = [];
let list_primary_action = null;
let route_search_cleanup_timers = [];

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

export function decorate_list_filter_shortcuts() {
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

export function decorate_list_primary_action_shortcut() {
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

export function handle_list_primary_action_keyboard(event) {
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

export function schedule_route_search_cleanup() {
	route_search_cleanup_timers.forEach((timer) => window.clearTimeout(timer));
	route_search_cleanup_timers = [0, 120, 360].map((delay) =>
		window.setTimeout(close_route_search_dropdowns, delay)
	);
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

export function handle_list_filter_keyboard(event) {
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
