import { consume_key, has_open_autocomplete, is_alt_key, is_visible } from "./shared.js";

const INPUTS = 'input:not([type="hidden"]), select, textarea, [contenteditable="true"]';
const ACTIONS = 'button, a[href], input[type="checkbox"], input[type="radio"], .add-new-fields, .remove-field';
const ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
const ACTIVE_CONTROL_CLASS = "srv-erp-grid-surface-keyboard-active";
let settings_dialog = null;
let column_picker = null;
let expects_column_picker = false;
let edited_row = null;
let active_control = null;

function current_dialog() {
	return frappe.ui?.open_dialogs?.at(-1) || window.cur_dialog;
}

function dialog_element(dialog) {
	return dialog?.$wrapper?.get?.(0);
}

function can_focus(element) {
	return is_visible(element) && !element.matches(":disabled, [aria-disabled=true], [readonly]");
}

function focus_control(element) {
	if (!element) {
		return false;
	}
	active_control?.classList.remove(ACTIVE_CONTROL_CLASS);
	if (element.tabIndex < 0 && !element.hasAttribute("tabindex")) {
		element.setAttribute("tabindex", "-1");
	}
	active_control = element;
	element.classList.add(ACTIVE_CONTROL_CLASS);
	element.focus({ preventScroll: true });
	element.scrollIntoView({ block: "nearest", inline: "nearest" });
	return true;
}

function controls_for(scope, dialog) {
	const selector = dialog
		? `.modal-body ${INPUTS.split(", ").join(", .modal-body ")}, .modal-footer button, .add-new-fields, .remove-field`
		: `${INPUTS}, button`;
	return [...scope.querySelectorAll(selector)].filter(can_focus).map((control) => {
		if (control.matches(".add-new-fields, .remove-field")) {
			control.setAttribute("role", "button");
			control.setAttribute("tabindex", "0");
			if (control.matches(".remove-field") && !control.getAttribute("aria-label")) {
				const fieldname = control.dataset.fieldname || __("column");
				control.setAttribute("aria-label", __("Remove {0} column", [fieldname]));
			}
			return control;
		}
		if (control.tabIndex < 0 && !control.hasAttribute("tabindex")) {
			control.setAttribute("tabindex", "-1");
		}
		return control;
	});
}

function top_visible_modal() {
	return [...document.querySelectorAll(".modal.show")].filter(is_visible).at(-1) || null;
}

function focus_settings(dialog, preferred) {
	const scope = dialog_element(dialog);
	if (scope && is_visible(scope)) {
		focus_control([...scope.querySelectorAll(preferred)].find(can_focus) || controls_for(scope, true)[0]);
	}
}

function settings_rows(scope) {
	return [...scope.querySelectorAll(".selected-fields .fields_order")].filter(is_visible);
}

function selected_settings_row(scope, target) {
	const candidate = target?.closest?.(".fields_order") || active_control?.closest?.(".fields_order");
	return candidate && scope.contains(candidate) && is_visible(candidate) ? candidate : null;
}

function remove_settings_row(scope, target) {
	const rows = settings_rows(scope);
	const row = selected_settings_row(scope, target);
	const remove = row?.querySelector(".remove-field");
	if (!row || !is_visible(remove)) {
		return false;
	}
	const index = rows.indexOf(row);
	remove.click();
	window.requestAnimationFrame(() => {
		const refreshed = settings_rows(scope);
		const next_row = refreshed[Math.min(Math.max(index, 0), refreshed.length - 1)];
		focus_control(next_row?.querySelector(".column-width") || scope.querySelector(".add-new-fields"));
	});
	return true;
}

export function decorate_grid_surface_hints() {
	const modal = top_visible_modal();
	if (!modal || !modal.querySelector(".selected-fields, .add-new-fields")) {
		return;
	}
	for (const row of settings_rows(modal)) {
		row.classList.add("srv-erp-grid-settings-row");
		const remove = row.querySelector(".remove-field");
		if (!remove || remove.querySelector(".srv-erp-grid-remove-shortcut-hint")) {
			continue;
		}
		const hint = document.createElement("span");
		hint.className = "srv-erp-grid-remove-shortcut-hint";
		hint.textContent = "Alt+R";
		hint.setAttribute("aria-hidden", "true");
		remove.setAttribute("title", __("Remove selected row (Alt+R)"));
		remove.appendChild(hint);
	}
}

export function reset_grid_surfaces() {
	active_control?.classList.remove(ACTIVE_CONTROL_CLASS);
	active_control = null;
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
		const dialog = current_dialog();
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

function next_settings_control(controls, target, arrow) {
	const index = controls.indexOf(target);
	if (index < 0) {
		return controls[0];
	}
	if (arrow === "ArrowUp" || arrow === "ArrowDown") {
		const step = arrow === "ArrowUp" ? -1 : 1;
		return controls[(index + step + controls.length) % controls.length];
	}
	return next_control(controls, target, arrow);
}

function grid_dialog_surface(target) {
	const modal = target?.closest?.(".modal.show") ||
		(target === document.body ? top_visible_modal() : null);
	if (!modal) {
		return null;
	}
	const settings = modal === dialog_element(settings_dialog) ||
		Boolean(modal.querySelector(".selected-fields, .add-new-fields"));
	const picker = modal === dialog_element(column_picker) ||
		Boolean(settings_dialog && modal.querySelector(".unit-checkbox input"));
	return settings || picker ? { scope: modal, settings } : null;
}

export function handle_grid_surface_keys(event) {
	const dialog = current_dialog();
	const edit_scope = row_editor_scope(edited_row);
	const dialog_surface = grid_dialog_surface(event.target);
	const is_grid_dialog = Boolean(dialog_surface);
	const scope = dialog_surface?.scope ||
		((!dialog || dialog_element(dialog)?.contains(edit_scope)) ? edit_scope : null);
	if (!scope || !is_visible(scope) ||
		(event.target !== document.body && !scope.contains(event.target) && !is_grid_dialog)) {
		return false;
	}

	if (dialog_surface?.settings && is_alt_key(event, "KeyR")) {
		if (event.repeat) {
			consume_key(event);
			return true;
		}
		if (!remove_settings_row(scope, event.target)) {
			return false;
		}
		consume_key(event);
		return true;
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
			const current_index = controls.indexOf(current);
			current.click();
			window.requestAnimationFrame(() => {
				if (top_visible_modal() === scope && is_visible(scope) &&
					!scope.contains(document.activeElement)) {
					const refreshed = controls_for(scope, is_grid_dialog);
					focus_control(refreshed[Math.min(current_index, refreshed.length - 1)]);
				}
			});
		} else if (!event.repeat) {
			focus_control(controls[current ? controls.indexOf(current) + 1 : 0]);
		}
	} else {
		const next = dialog_surface?.settings
			? next_settings_control(controls, current, event.key)
			: next_control(controls, current, event.key);
		focus_control(next);
	}
	return true;
}
