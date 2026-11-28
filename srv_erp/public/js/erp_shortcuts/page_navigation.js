import { consume_key, get_visible_page_container, has_open_autocomplete, is_alt_key, is_dialog_open, is_editable_element, is_visible } from "./shared.js";

const PAGE_FIELD_SELECTOR = [
	".page-form .frappe-control",
	".standard-filter-section .frappe-control",
	".layout-main-section .frappe-control",
].join(", ");
const INPUT_SELECTOR = 'input:not([type="hidden"]), select, textarea, [contenteditable="true"]';
const ROW_SELECTOR = ".list-row-container";
const MOVEMENT_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
const ACTIVE_LIST_ROW_CLASS = "srv-erp-list-row-keyboard-active";
const LOAD_MORE_SELECTOR = ".list-paging-area .btn-more";
let navigating_filters = false;
let typing_in_filter = false;
let active_list_row = null;
let active_list_row_key = null;
let loading_more_results = false;

export function reset_page_navigation(clear_list_row = false) {
	navigating_filters = false;
	typing_in_filter = false;
	if (clear_list_row) {
		clear_active_list_row();
		loading_more_results = false;
	}
}

function focus(element) {
	if (!element) {
		return false;
	}
	element.focus({ preventScroll: true });
	element.scrollIntoView({ block: "nearest", inline: "nearest" });
	return true;
}

function reveal_list_filters(page) {
	const filters = page.querySelector(".standard-filter-section");
	if (!filters || !is_visible(filters)) {
		return;
	}
	const page_head = page.querySelector(".page-head");
	const navbar = document.querySelector(".navbar");
	const visible_top = Math.max(
		page_head?.getBoundingClientRect().bottom || 0,
		navbar?.getBoundingClientRect().bottom || 0
	) + 8;
	const distance = filters.getBoundingClientRect().top - visible_top;
	if (Math.abs(distance) > 1) {
		window.scrollBy({ top: distance, behavior: "auto" });
	}
}

function focus_list_control(page, control) {
	if (!focus(control)) {
		return false;
	}
	reveal_list_filters(page);
	return true;
}

function list_rows(page) {
	return [...page.querySelectorAll(ROW_SELECTOR)].filter(is_visible);
}

function list_row_key(row) {
	return row?.querySelector(".list-subject a[href]")?.getAttribute("href") || null;
}

function clear_active_list_row() {
	active_list_row?.classList.remove(ACTIVE_LIST_ROW_CLASS);
	active_list_row = null;
	active_list_row_key = null;
}

function set_active_list_row(row, should_focus = true) {
	if (!row) {
		return false;
	}
	if (active_list_row !== row) {
		active_list_row?.classList.remove(ACTIVE_LIST_ROW_CLASS);
		active_list_row = row;
		active_list_row_key = list_row_key(row);
	}
	row.classList.add(ACTIVE_LIST_ROW_CLASS);
	if (!should_focus) {
		return true;
	}
	if (!row.hasAttribute("tabindex")) {
		row.tabIndex = -1;
	}
	return focus(row);
}

function get_active_list_row(page, rows = list_rows(page)) {
	if (active_list_row && page.contains(active_list_row) && is_visible(active_list_row)) {
		return active_list_row;
	}
	const replacement = active_list_row_key
		? rows.find((row) => list_row_key(row) === active_list_row_key)
		: null;
	if (replacement) {
		active_list_row = replacement;
		replacement.classList.add(ACTIVE_LIST_ROW_CLASS);
		return replacement;
	}
	clear_active_list_row();
	return null;
}

export function track_list_pointer(event) {
	const page = get_visible_page_container();
	const row = event.target.closest?.(ROW_SELECTOR);
	if (row && page.contains(row) && is_visible(row)) {
		set_active_list_row(row, false);
	}
}

function report_table(page) {
	const table = frappe.query_report?.datatable;
	const body = table?.cellmanager?.bodyScrollable;
	return body && page.contains(body) && is_visible(body) ? table : null;
}

function focus_report_cell(table, from_end = false) {
	const manager = table?.cellmanager;
	const cells = [...(manager?.bodyScrollable?.querySelectorAll(".dt-cell[data-col-index]:not(.dt-cell--header):not(.dt-cell--filter)") || [])];
	const candidates = from_end ? cells.reverse() : cells;
	const cell = candidates.find((candidate) =>
		is_visible(candidate) &&
		manager.columnmanager.getColumn(Number(candidate.dataset.colIndex))?.focusable !== false
	);
	if (!cell) {
		return false;
	}
	manager.focusCell(cell);
	return true;
}

function page_controls(page, kind) {
	const selector = kind === "dialog" ? ".frappe-control" : kind === "list"
		? ".standard-filter-section .frappe-control"
		: kind === "query-report" || kind === "report"
			? ".page-form .frappe-control"
			: PAGE_FIELD_SELECTOR;
	return [...page.querySelectorAll(selector)]
		.flatMap((wrapper) => [...wrapper.querySelectorAll(INPUT_SELECTOR)])
		.filter((input) =>
			is_visible(input) && !input.matches(":disabled, [aria-disabled=true], [readonly]") &&
			!input.closest(".grid-field, .awesomplete ul")
		);
}

function list_header_controls(page) {
	return [...new Set([
		...page.querySelectorAll([
			".page-head button:not(:disabled)",
			".page-head a[href]",
			'.page-head [role="button"]:not([aria-disabled="true"])',
		].join(", ")),
	])].filter((control) =>
		is_visible(control) && !control.closest(".dropdown-menu")
	);
}

function get_load_more_button(page) {
	const button = page.querySelector(LOAD_MORE_SELECTOR);
	return button && is_visible(button) && !button.disabled ? button : null;
}

function wait_for_additional_rows(page, previous_count) {
	return new Promise((resolve) => {
		let finished = false;
		const finish = (rows) => {
			if (finished) {
				return;
			}
			finished = true;
			observer.disconnect();
			window.clearTimeout(timeout);
			resolve(rows);
		};
		const check = () => {
			const rows = list_rows(page);
			if (!page.isConnected || rows.length > previous_count) {
				finish(rows);
			}
		};
		const observer = new MutationObserver(check);
		const timeout = window.setTimeout(() => finish(list_rows(page)), 5000);
		observer.observe(page, { childList: true, subtree: true });
		window.setTimeout(check, 0);
	});
}

async function load_more_list_results(page, previous_count) {
	if (loading_more_results) {
		return;
	}
	const button = get_load_more_button(page);
	if (!button) {
		return;
	}

	loading_more_results = true;
	button.click();
	try {
		const rows = await wait_for_additional_rows(page, previous_count);
		if (!page.isConnected || !is_visible(page)) {
			return;
		}
		set_active_list_row(rows[previous_count] || rows.at(-1));
	} finally {
		loading_more_results = false;
	}
}

function handle_list_result(event, page, controls, header_controls) {
	const rows = list_rows(page);
	const pointer_row = event.target.closest?.(ROW_SELECTOR);
	if (pointer_row && page.contains(pointer_row)) {
		set_active_list_row(pointer_row, false);
	}
	const target_is_editable = is_editable_element(event.target);
	let row = pointer_row || (!target_is_editable ? get_active_list_row(page, rows) : null);

	if (!row && target_is_editable) {
		return false;
	}
	if (!row && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
		const boundary_row = event.key === "ArrowDown" ? rows[0] : rows.at(-1);
		if (set_active_list_row(boundary_row)) {
			if (boundary_row === rows[0]) {
				reveal_list_filters(page);
			}
			consume_key(event);
			return true;
		}
		return false;
	}
	if (!row) {
		return false;
	}

	const index = rows.indexOf(row);
	if (index < 0) {
		return false;
	}

	if (event.key === "Enter" && pointer_row) {
		const link = row.querySelector(".list-subject a[href]");
		if (link) {
			consume_key(event);
			if (!event.repeat) {
				link.click();
			}
			return true;
		}
	}
	if (event.key === "ArrowUp" || event.key === "ArrowDown") {
		const step = event.key === "ArrowUp" ? -1 : 1;
		const next_row = rows[index + step];
		if (next_row && set_active_list_row(next_row)) {
			if (step < 0 && next_row === rows[0]) {
				reveal_list_filters(page);
			}
			consume_key(event);
			return true;
		}
		if (step < 0) {
			const previous_control = controls.at(-1) || header_controls.at(-1);
			if (focus_list_control(page, previous_control)) {
				navigating_filters = true;
				typing_in_filter = false;
				consume_key(event);
				return true;
			}
		}
		if (step > 0) {
			set_active_list_row(row, false);
			consume_key(event);
			if (!event.repeat) {
				void load_more_list_results(page, rows.length);
			}
			return true;
		}
	}
	return false;
}

function handle_list_header(event, page, header_controls, controls, focus_body) {
	const index = header_controls.indexOf(event.target);
	if (index < 0 || !MOVEMENT_KEYS.includes(event.key)) {
		return false;
	}

	const step = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1;
	const next = header_controls[index + step];
	const boundary = step > 0 ? (controls[0] || null) : null;
	if (focus(next) || focus_list_control(page, boundary) || (step > 0 && focus_body())) {
		navigating_filters = true;
		typing_in_filter = false;
		consume_key(event);
		return true;
	}
	return false;
}

export function handle_page_keyboard(event) {
	if (event.isComposing) {
		return false;
	}
	const dialog = is_dialog_open() ? window.cur_dialog?.$wrapper?.get?.(0) : null;
	const kind = dialog ? "dialog" : String((frappe.get_route?.() || [])[0] || "").toLowerCase();
	if (["form", "workspaces", "workspace", "home"].includes(kind)) {
		return false;
	}
	const is_list = kind === "list";
	const is_report = kind === "query-report" || kind === "report";
	const start = is_alt_key(event, "KeyM") || is_alt_key(event, "KeyD");
	const ordinary_key = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
	if (!start && (!ordinary_key || (!navigating_filters && !is_list))) {
		return false;
	}
	const page = dialog || get_visible_page_container();
	const controls = page_controls(page, kind);
	const header_controls = is_list ? list_header_controls(page) : [];
	const table = is_report ? report_table(page) : null;
	const focus_body = (from_end = false) => {
		const rows = is_list ? list_rows(page) : [];
		const row = from_end ? rows.at(-1) : rows[0];
		return (row && set_active_list_row(row)) || focus_report_cell(table, from_end);
	};

	if (start) {
		if (!event.repeat && (focus_list_control(page, controls[0]) || focus_body())) {
			navigating_filters = true;
			typing_in_filter = false;
			consume_key(event);
			return true;
		}
		return false;
	}
	if (is_list && handle_list_header(event, page, header_controls, controls, focus_body)) {
		return true;
	}
	if (is_list && handle_list_result(event, page, controls, header_controls)) {
		return true;
	}
	if (!navigating_filters) {
		return false;
	}
	const index = controls.indexOf(event.target);
	if (index < 0 || event.key === "Escape" || event.key === "Tab") {
		reset_page_navigation();
		return false;
	}
	if (event.key.length === 1 || event.key === "Backspace" || event.key === "Delete") {
		typing_in_filter = true;
		return false;
	}
	if (!MOVEMENT_KEYS.includes(event.key) ||
		(typing_in_filter && has_open_autocomplete(event.target))) {
		return false;
	}
	const step = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1;
	const next = controls[index + step];
	const boundary = step < 0 ? header_controls.at(-1) : null;
	const focused = is_list
		? focus_list_control(page, next) || focus(boundary) || (!next && step > 0 && focus_body())
		: focus(next) || focus(boundary) || (!next && step > 0 && focus_body());
	if (focused) {
		typing_in_filter = false;
		consume_key(event);
		return true;
	}
	return false;
}
