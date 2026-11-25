import { consume_key, has_open_autocomplete, is_visible } from "./shared.js";

const INPUTS = 'input:not([type="hidden"]), select, textarea, [contenteditable="true"]';
const ACTIONS = 'button, a[href], input[type="checkbox"], input[type="radio"], .add-new-fields, .remove-field';
const ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
let settings_dialog = null;
let column_picker = null;
let expects_column_picker = false;
let edited_row = null;

function dialog_element(dialog) {
	return dialog?.$wrapper?.get?.(0);
}

function can_focus(element) {
	return is_visible(element) && !element.matches(":disabled, [aria-disabled=true], [readonly]");
}

function focus_control(element) {
	if (!element) {
		return;
	}
	if (element.tabIndex < 0 && !element.hasAttribute("tabindex")) {
		element.setAttribute("tabindex", "-1");
	}
	element.focus({ preventScroll: true });
	element.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function controls_for(scope, dialog) {
	const selector = dialog
		? `.modal-body ${INPUTS.split(", ").join(", .modal-body ")}, .modal-footer button, .add-new-fields, .remove-field`
		: `${INPUTS}, button`;
	return [...scope.querySelectorAll(selector)].filter(can_focus);
}

function focus_settings(dialog, preferred) {
	const scope = dialog_element(dialog);
	if (scope && is_visible(scope)) {
		focus_control([...scope.querySelectorAll(preferred)].find(can_focus) || controls_for(scope, true)[0]);
	}
}

export function reset_grid_surfaces() {
	settings_dialog = null;
	column_picker = null;
	expects_column_picker = false;
	edited_row = null;
}

export function bind_grid_settings_events() {
	document.addEventListener("click", (event) => {
		const link = event.target.closest?.(".add-new-fields");
		if (link && dialog_element(settings_dialog)?.contains(link)) {
			expects_column_picker = true;
		}
	}, true);
	$(document).on("frappe.ui.Dialog:shown.srv_grid_navigation", () => {
		const dialog = window.cur_dialog;
		if (dialog === settings_dialog && dialog) {
			focus_settings(dialog, ".column-width");
		} else if (expects_column_picker && dialog?.fields_dict?.fields?.df?.fieldtype === "MultiCheck") {
			expects_column_picker = false;
			column_picker = dialog;
			focus_settings(dialog, ".unit-checkbox input");
			dialog.$wrapper.one("hidden.bs.modal", () => {
				column_picker = null;
				focus_settings(settings_dialog, ".add-new-fields");
			});
		}
	});
}

export function open_grid_settings(grid, on_close) {
	const header = grid.header_row;
	if (!header?.configure_columns_button?.length) {
		return;
	}
	header.configure_dialog_for_columns_selector();
	settings_dialog = header.grid_settings_dialog;
	column_picker = null;
	expects_column_picker = false;
	focus_settings(settings_dialog, ".column-width");
	const dialog = settings_dialog;
	dialog?.$wrapper.one("hidden.bs.modal", () => {
		if (settings_dialog === dialog) {
			settings_dialog = null;
			column_picker = null;
			expects_column_picker = false;
			on_close?.();
		}
	});
}

function row_editor_scope(row) {
	return row?.grid_form?.form_area?.get?.(0);
}

export function open_grid_row_editor(row) {
	if (!row?.doc) {
		return;
	}
	edited_row = row;
	row.toggle_view(true, () => {
		const scope = row_editor_scope(row);
		if (scope && !scope.contains(document.activeElement)) {
			focus_control(controls_for(scope, false)[0]);
		}
	});
}

function center(element) {
	const rect = element.getBoundingClientRect();
	return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function next_control(controls, target, arrow) {
	const index = controls.indexOf(target);
	if (index < 0) {
		return controls[0];
	}

	const origin = center(target);
	const horizontal = arrow === "ArrowLeft" || arrow === "ArrowRight";
	const step = arrow === "ArrowLeft" || arrow === "ArrowUp" ? -1 : 1;
	let nearest;
	let best = Infinity;
	for (const control of controls) {
		if (control === target) {
			continue;
		}
		const position = center(control);
		const along = step * (horizontal ? position.x - origin.x : position.y - origin.y);
		const across = Math.abs(horizontal ? position.y - origin.y : position.x - origin.x);
		if (along > 4 && across <= Math.max(along * 2, 28) && along + across * 3 < best) {
			best = along + across * 3;
			nearest = control;
		}
	}
	return nearest || controls[index + step];
}

export function handle_grid_surface_keys(event) {
	const dialog = window.cur_dialog;
	const edit_scope = row_editor_scope(edited_row);
	const is_grid_dialog = Boolean(dialog && (dialog === settings_dialog || dialog === column_picker));
	const scope = is_grid_dialog ? dialog_element(dialog) :
		!dialog || dialog_element(dialog)?.contains(edit_scope) ? edit_scope : null;
	if (!scope || !is_visible(scope) ||
		(event.target !== document.body && !scope.contains(event.target) && !is_grid_dialog)) {
		return false;
	}

	if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
		return false;
	}
	if (event.key === "Escape" || !["Enter", ...ARROWS].includes(event.key) ||
		has_open_autocomplete(event.target)) {
		return false;
	}
	const controls = controls_for(scope, is_grid_dialog);
	const current = controls.includes(event.target) ? event.target : null;
	if (!current && event.target !== document.body && event.target !== scope) {
		return false;
	}

	if (event.key === "Enter" && current?.matches('[contenteditable="true"], textarea')) {
		return false;
	}
	consume_key(event);
	if (event.key === "Enter") {
		if (!event.repeat && current?.matches(ACTIONS)) {
			current.click();
		} else if (!event.repeat) {
			focus_control(controls[current ? controls.indexOf(current) + 1 : 0]);
		}
	} else {
		focus_control(next_control(controls, current, event.key));
	}
	return true;
}
