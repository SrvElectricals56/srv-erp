import { consume_key, get_visible_page_container, has_open_autocomplete, is_alt_key, is_dialog_open, is_visible } from "./shared.js";

const PAGE_FIELD_SELECTOR = [
	".page-form .frappe-control",
	".standard-filter-section .frappe-control",
	".layout-main-section .frappe-control",
].join(", ");
const INPUT_SELECTOR = 'input:not([type="hidden"]), select, textarea, [contenteditable="true"]';
const ROW_SELECTOR = ".list-row-container";
const MOVEMENT_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
let navigating_filters = false;
let typing_in_filter = false;

export function reset_page_navigation() {
	navigating_filters = false;
	typing_in_filter = false;
}

function focus(element) {
	if (!element) {
		return false;
	}
	element.focus({ preventScroll: true });
	element.scrollIntoView({ block: "nearest", inline: "nearest" });
	return true;
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

function handle_list_result(event, page, controls) {
	const row = event.target.closest?.(ROW_SELECTOR);
	if (!row || !page.contains(row) || row !== event.target) {
		return false;
	}
	const rows = [...page.querySelectorAll(ROW_SELECTOR)].filter(is_visible);
	const index = rows.indexOf(row);
	if (index < 0) {
		return false;
	}

	if (event.key === "Enter") {
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
		const next = rows[index + step] || (step < 0 ? controls.at(-1) : null);
		if (focus(next)) {
			consume_key(event);
			return true;
		}
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
	const table = is_report ? report_table(page) : null;
	const focus_body = (from_end = false) => {
		const rows = is_list ? [...page.querySelectorAll(ROW_SELECTOR)].filter(is_visible) : [];
		return focus(from_end ? rows.at(-1) : rows[0]) || focus_report_cell(table, from_end);
	};

	if (start) {
		if (!event.repeat && (focus(controls[0]) || focus_body())) {
			navigating_filters = true;
			typing_in_filter = false;
			consume_key(event);
			return true;
		}
		return false;
	}
	if (is_list && handle_list_result(event, page, controls)) {
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
	if (focus(next) || (!next && step > 0 && focus_body())) {
		typing_in_filter = false;
		consume_key(event);
		return true;
	}
	return false;
}
