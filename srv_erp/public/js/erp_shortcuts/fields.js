import { consume_key, has_open_autocomplete, is_dialog_open, is_visible } from "./shared.js";

const FIELD_CLASS = "srv-erp-form-field-keyboard";
const ACTION_CONTROL = 'input[type="checkbox"], input[type="radio"], button, [role="switch"], [role="checkbox"]';
const NAVIGATION_CONTROL = `input:not([type="hidden"]), select, textarea, [contenteditable="true"], ${ACTION_CONTROL}`;
let selected_input = null;
let selected_section = null;
let typing_into_field = false;

function field_input(field) {
	return field.quill?.root || field.$input?.get?.(0);
}

export function reset_field_navigation() {
	selected_input?.classList.remove(FIELD_CLASS);
	selected_input = null;
	selected_section = null;
	typing_into_field = false;
}

function field_controls(field) {
	const input = field_input(field);
	if (input) {
		return [input];
	}
	const wrapper = field.$wrapper?.get?.(0);
	return field.grid || !wrapper ? [] : [...wrapper.querySelectorAll(NAVIGATION_CONTROL)];
}

export function get_form_controls(frm, tab, section = null, editable_only = true) {
	const fields = section?.fields_list || frm.layout?.fields_list || [];
	return fields
		.filter((field) => (!tab || !field.tab || field.tab === tab) && (!editable_only || field.disp_status === "Write"))
		.flatMap(field_controls)
		.filter((input) =>
			input?.matches(NAVIGATION_CONTROL) &&
			!input.matches(":disabled, [aria-disabled=true]") &&
			(!editable_only || !input.matches("[readonly]")) &&
			!input.closest(".hide-control, [hidden]")
		);
}

function get_section_controls(frm, section) {
	const editable = get_form_controls(frm, null, section).filter(is_visible);
	return editable.length ? editable : get_form_controls(frm, null, section, false).filter(is_visible);
}

export function focus_first_field(frm, tab, section = null) {
	const controls = section
		? get_section_controls(frm, section)
		: get_form_controls(frm, tab).filter(is_visible);
	const targets = get_navigation_targets(frm, tab, section);
	const field = controls.find((control) =>
		control.matches('input, select, textarea, [contenteditable="true"]')
	) || controls[0];
	const first_content_target = targets.find((target) => !target.matches(".section-head"));
	const input = first_content_target || field || targets[0];
	if (input) {
		focus_form_input(input, section);
	}
	return input;
}

export function focus_field_before_heading(frm, tab, heading, from_end = false) {
	const targets = get_navigation_targets(frm, tab);
	const boundary = targets.indexOf(heading);
	if (boundary <= 0) {
		return null;
	}
	const fields = targets.slice(0, boundary).filter((target) => !target.matches(".section-head"));
	const input = from_end ? fields.at(-1) : fields[0];
	if (input) {
		focus_form_input(input, null);
	}
	return input || null;
}

export function focus_named_field(field) {
	if (!field || field.disp_status === "None" || field.df?.hidden || field.df?.hidden_due_to_dependency) {
		return null;
	}
	if (field.section?.is_collapsed?.()) {
		field.section.collapse(false);
	}
	const editable = field_input(field);
	const wrapper = field.$wrapper?.get?.(0);
	const input = field.disp_status === "Write" &&
		!editable?.matches(":disabled, [readonly], [aria-disabled=true]") && is_visible(editable)
		? editable
		: wrapper?.querySelector(".control-value");
	if (!is_visible(input)) {
		return null;
	}
	focus_form_input(input, null);
	return input;
}

function focus_form_input(input, section) {
	reset_field_navigation();
	selected_input = input;
	selected_section = section;
	input.classList.add(FIELD_CLASS);
	if (input.tabIndex < 0 && !input.hasAttribute("tabindex")) {
		input.setAttribute("tabindex", "-1");
	}
	input.focus({ preventScroll: true });
	input.scrollIntoView({ block: "nearest", inline: "nearest" });
	if (input.matches('input[type="text"], input[type="search"], textarea')) {
		input.select();
	}
}

function return_to_section_heading(input, section) {
	const heading = section?.head?.get?.(0) ||
		input?.closest?.(".form-section, .form-dashboard-section")?.querySelector(":scope > .section-head");
	input?.blur?.();
	if (!heading || !is_visible(heading)) {
		return;
	}
	if (!heading.hasAttribute("tabindex")) {
		heading.setAttribute("tabindex", "-1");
	}
	heading.focus({ preventScroll: true });
	heading.scrollIntoView({ block: "center", inline: "nearest" });
}

function find_horizontal_form_input(inputs, current_input, direction) {
	const current_column = current_input.closest(".form-column");
	const current_section = current_input.closest(".form-section, .form-dashboard-section");
	if (!current_column || !current_section) {
		return null;
	}

	const section_inputs = inputs.filter(
		(input) => input.closest(".form-section, .form-dashboard-section") === current_section
	);
	const columns = [
		...new Set(section_inputs.map((input) => input.closest(".form-column")).filter(Boolean)),
	].sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left);
	const current_column_index = columns.indexOf(current_column);
	const next_column = columns[current_column_index + direction];
	if (!next_column) {
		return null;
	}

	const current_rect = current_input.getBoundingClientRect();
	const current_center_y = current_rect.top + current_rect.height / 2;
	return section_inputs
		.filter((input) => input.closest(".form-column") === next_column)
		.sort((left, right) => {
			const left_rect = left.getBoundingClientRect();
			const right_rect = right.getBoundingClientRect();
			const left_distance = Math.abs(left_rect.top + left_rect.height / 2 - current_center_y);
			const right_distance = Math.abs(right_rect.top + right_rect.height / 2 - current_center_y);
			return left_distance - right_distance;
		})[0];
}

function get_navigation_targets(frm, tab, section = null) {
	const controls = new Set(get_form_controls(frm, tab, section));
	const targets = new Set();
	for (const field of section?.fields_list || frm.layout?.fields_list || []) {
		if ((tab && field.tab && field.tab !== tab) || field.disp_status === "None") {
			continue;
		}
		const heading = field.section?.head?.get?.(0);
		if (!section && heading) {
			targets.add(heading);
		}
		const grid = field.grid?.wrapper?.get?.(0);
		if (grid) {
			targets.add(grid);
			continue;
		}
		const inputs = field_controls(field).filter((input) => controls.has(input) || input === selected_input);
		if (inputs.length) {
			inputs.forEach((input) => targets.add(input));
		} else if (field.disp_status === "Read") {
			const read_value = field.$wrapper?.get?.(0)?.querySelector(".control-value");
			if (read_value?.textContent?.trim()) {
				targets.add(read_value);
			}
		}
	}
	return [...targets].filter(is_visible);
}

function scroll_at_field_boundary(input, direction) {
	for (let parent = input.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
		const can_scroll = parent.scrollHeight > parent.clientHeight &&
			/(auto|scroll|overlay)/.test(window.getComputedStyle(parent).overflowY);
		const can_move = direction > 0
			? parent.scrollTop + parent.clientHeight < parent.scrollHeight - 1
			: parent.scrollTop > 0;
		if (can_scroll && can_move) {
			parent.scrollBy({ top: direction * Math.round(parent.clientHeight * 0.65) });
			return;
		}
	}
	window.scrollBy({ top: direction * Math.round(window.innerHeight * 0.65) });
}

export function handle_field_keys(event, frm, tab, select_heading) {
	if (event.isComposing || is_dialog_open() || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
		return;
	}

	const target = document.activeElement;
	const wrapper = frm.wrapper?.get?.(0) || frm.wrapper;
	if (event.key === "Enter" && wrapper?.contains(target) &&
		target?.matches(`${ACTION_CONTROL}, .section-head.collapsible`) &&
		!target.matches(":disabled, [aria-disabled=true], [readonly]") &&
		is_visible(target)) {
		consume_key(event);
		if (!event.repeat) {
			target.click();
		}
		return;
	}

	if (!selected_input) {
		return;
	}
	if (event.key === "Escape") {
		const return_section = selected_section;
		reset_field_navigation();
		if (!has_open_autocomplete(target)) {
			consume_key(event);
			return_to_section_heading(target, return_section);
		}
		return;
	}
	if (event.key.length === 1 || event.key === "Backspace" || event.key === "Delete") {
		typing_into_field = true;
		return;
	}
	if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key) ||
		(typing_into_field && (has_open_autocomplete(target) ||
			target?.matches('textarea, [contenteditable="true"]') ||
			(["ArrowLeft", "ArrowRight"].includes(event.key) && target?.matches('input[type="text"], input[type="search"]'))))) {
		return;
	}

	const inputs = get_navigation_targets(frm, tab, selected_section);
	const index = inputs.indexOf(target);
	if (index < 0) {
		reset_field_navigation();
		return;
	}

	consume_key(event);
	const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
	const direction = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1;
	const next = horizontal
		? find_horizontal_form_input(inputs, target, direction)
		: inputs[index + direction];
	if (next) {
		if (!horizontal && next.matches(".section-head.collapsible") && select_heading?.(next)) {
			reset_field_navigation();
			return;
		}
		focus_form_input(next, selected_section);
	} else if (!horizontal) {
		scroll_at_field_boundary(target, direction);
	}
}
