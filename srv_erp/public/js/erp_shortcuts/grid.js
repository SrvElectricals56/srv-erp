import {
	handle_grid_surface_keys, open_grid_row_editor, open_grid_settings, reset_grid_surfaces,
} from "./grid_surfaces.js";
import { consume_key, has_open_autocomplete, is_alt_key, is_dialog_open, is_editable_element, is_visible } from "./shared.js";

const CELL_CLASS = "srv-erp-grid-keyboard-cell";
const ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
const CONTROL = 'input:not([type="hidden"]), select, textarea, button, [contenteditable="true"]';
let selection = null;
let pointer_grid = null;

function element(wrapper) {
	return wrapper?.get?.(0);
}

function clear_selection() {
	selection?.cell?.classList.remove(CELL_CLASS);
	selection = null;
}

export function reset_grid_navigation() {
	clear_selection();
	pointer_grid = null;
	reset_grid_surfaces();
}

export function get_desk_grids() {
	const frm = window.cur_frm;
	const dialog = window.cur_dialog;
	const row_form = frappe.ui?.form?.get_open_grid_form?.()?.grid_form;
	const controls = [
		...(frm?.layout?.fields_list || []), ...Object.values(frm?.fields_dict || {}),
		...(row_form?.layout?.fields_list || []), ...Object.values(dialog?.fields_dict || {}),
	];
	return [...new Set(controls.map((field) => field?.grid).filter(Boolean))];
}

function is_grid_in_current_surface(grid) {
	const wrapper = element(grid?.wrapper);
	if (!is_visible(wrapper)) {
		return false;
	}
	return !is_dialog_open() || Boolean(window.cur_dialog?.$wrapper?.get?.(0)?.contains(wrapper));
}

function get_grid_from_target(target) {
	const row_element = target?.closest?.(".grid-row");
	const row = row_element ? $(row_element).data("grid_row") : null;
	if (row?.grid) {
		return row.grid;
	}
	const root = target?.closest?.(".grid-field");
	const section = target?.closest?.(".section-head")?.closest(".form-section, .form-dashboard-section");
	const candidates = get_desk_grids().filter((grid) => {
		const wrapper = element(grid?.wrapper);
		return wrapper && is_visible(wrapper) && (wrapper === root || section?.contains(wrapper));
	});
	return candidates.length === 1 ? candidates[0] : null;
}

export function track_grid_pointer(event) {
	clear_selection();
	pointer_grid = get_grid_from_target(event.target);
}

export function get_active_grid(target) {
	const grid = get_grid_from_target(target) ||
		(!is_editable_element(target) ? selection?.grid || pointer_grid : null);
	return is_grid_in_current_surface(grid) ? grid : null;
}

function rows_on_page(grid) {
	return (grid.grid_rows || []).filter((row) => row?.doc && is_visible(element(row.wrapper)));
}

function cells_for(row) {
	if (!row) {
		return [];
	}
	const cells = (row.columns_list || []).filter((column) => !column.df?.hidden && is_visible(element(column)));
	return cells.length ? cells.map((column) => ({ node: element(column), name: column.df.fieldname })) :
		is_visible(element(row.row)) ? [{ node: element(row.row), name: null }] : [];
}

function focus_cell(grid, row, preferred_column, column_index = 0) {
	const cells = cells_for(row);
	const cell = cells.find((candidate) => candidate.name === preferred_column) ||
		cells[Math.min(column_index, cells.length - 1)];
	if (!cell) {
		return;
	}
	clear_selection();
	const inline_row = frappe.ui?.form?.editable_row;
	if (inline_row?.grid === grid) {
		document.activeElement?.blur();
		inline_row.toggle_editable_row(false);
	}
	cell.node.classList.add(CELL_CLASS);
	if (!cell.node.hasAttribute("tabindex")) {
		cell.node.setAttribute("tabindex", "-1");
	}
	selection = { grid, row, cell: cell.node, fieldname: cell.name, editor: null };
	cell.node.focus({ preventScroll: true });
	cell.node.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function can_add_row(grid) {
	return grid.is_editable() && !grid.cannot_add_rows && !grid.df?.cannot_add_rows && !grid.filter_applied;
}

function focus_first_cell(grid) {
	const open = frappe.ui?.form?.get_open_grid_form?.();
	if (open?.grid === grid) {
		open_grid_row_editor(open);
		return;
	}
	const pagination = grid.grid_pagination;
	if (pagination?.page_index > 1) {
		pagination.go_to_page(1);
	}
	const row = rows_on_page(grid)[0];
	if (row) {
		focus_cell(grid, row);
	} else {
		const add = element(grid.wrapper)?.querySelector(".grid-add-row:not(:disabled)");
		if (can_add_row(grid) && is_visible(add)) {
			add.focus({ preventScroll: true });
		}
	}
}

export function focus_grid_from_target(target) {
	const grid = get_grid_from_target(target);
	if (!is_grid_in_current_surface(grid)) {
		return false;
	}
	focus_first_cell(grid);
	return true;
}

function selected_row(grid, target) {
	const row_element = target?.closest?.(".grid-row");
	const focused_row = row_element ? $(row_element).data("grid_row") : null;
	if (focused_row?.doc && focused_row.grid === grid) {
		return focused_row;
	}
	return selection?.grid === grid ? selection.row : rows_on_page(grid)[0];
}

function is_final_row(grid, row) {
	const rows = rows_on_page(grid);
	const pagination = grid.grid_pagination;
	return row === rows.at(-1) &&
		(!pagination || pagination.page_index >= pagination.total_pages);
}

function add_row(grid, fieldname, column_index) {
	const previous_count = grid.get_data().length;
	const doc = grid.add_new_row(null, null, false, null, true);
	const next = (doc?.name && grid.get_row(doc.name)) ||
		(grid.get_data().length > previous_count ? rows_on_page(grid).at(-1) : null);
	if (next) {
		focus_cell(grid, next, fieldname, column_index);
	}
}

function move_cell(event, current) {
	const { grid, row, fieldname } = current;
	const columns = cells_for(row);
	const column = Math.max(columns.findIndex((cell) => cell.name === fieldname), 0);
	if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
		const next = columns[column + (event.key === "ArrowLeft" ? -1 : 1)];
		if (next) {
			focus_cell(grid, row, next.name);
		}
		return;
	}

	const step = event.key === "ArrowUp" ? -1 : 1;
	const rows = rows_on_page(grid);
	const next = rows[rows.indexOf(row) + step];
	if (next) {
		focus_cell(grid, next, fieldname, column);
		return;
	}

	const pagination = grid.grid_pagination;
	const page = (pagination?.page_index || 1) + step;
	if (pagination && page >= 1 && page <= pagination.total_pages) {
		pagination.go_to_page(page);
		const target = step > 0 ? rows_on_page(grid)[0] : rows_on_page(grid).at(-1);
		focus_cell(grid, target, fieldname, column);
	} else if (step > 0 && !event.repeat && is_final_row(grid, row) && can_add_row(grid)) {
		add_row(grid, fieldname, column);
	}
}

function activate_cell(current) {
	const { grid, row, fieldname, cell } = current;
	if (!fieldname || !grid.allow_on_grid_editing() || !grid.is_editable()) {
		clear_selection();
		open_grid_row_editor(row);
		return;
	}
	row.toggle_editable_row(true);
	const control = cell.querySelector(CONTROL);
	if (!control || !is_visible(control) || control.matches(":disabled, [aria-disabled=true], [readonly]")) {
		clear_selection();
		open_grid_row_editor(row);
		return;
	}
	if (control.matches('input[type="checkbox"], input[type="radio"], button')) {
		control.click();
		return;
	}
	current.editor = control;
	control.focus({ preventScroll: true });
}

function open_active_grid_settings(grid, target) {
	const restore_row = selected_row(grid, target)?.doc?.name;
	const restore_column = selection?.grid === grid ? selection.fieldname : null;
	const open = frappe.ui?.form?.get_open_grid_form?.();
	if (open?.grid === grid) {
		open.toggle_view(false);
	}
	open_grid_settings(grid, () => {
		if (!is_visible(element(grid.wrapper))) {
			return;
		}
		const row = (restore_row && grid.get_row(restore_row)) || rows_on_page(grid)[0];
		if (row) {
			focus_cell(grid, row, restore_column);
		} else {
			focus_first_cell(grid);
		}
	});
}

export function register_grid_settings_shortcut() {
	frappe.ui.keys.add_shortcut({
		shortcut: "alt+s",
		description: __("Configure Columns for the active table"),
		condition: () => !is_dialog_open() &&
			Boolean(get_active_grid(document.activeElement)?.header_row?.configure_columns_button?.length),
		ignore_inputs: true,
		action: (event) => {
			const grid = get_active_grid(document.activeElement);
			if (grid && !event.repeat) {
				open_active_grid_settings(grid, document.activeElement);
			}
		},
	});
}

function handle_grid_shortcut(event) {
	const start = is_alt_key(event, "KeyM");
	const edit = is_alt_key(event, "KeyE");
	const settings = is_alt_key(event, "KeyS");
	if (!start && !edit && !settings) {
		return false;
	}
	const grid = get_active_grid(event.target);
	if (!grid) {
		return false;
	}

	consume_key(event);
	if (event.repeat) {
		return true;
	}
	if (start) {
		focus_first_cell(grid);
	} else if (edit) {
		const row = selected_row(grid, event.target);
		clear_selection();
		open_grid_row_editor(row);
	} else {
		open_active_grid_settings(grid, event.target);
	}
	return true;
}

export function handle_grid_keyboard(event) {
	if (handle_grid_surface_keys(event) || handle_grid_shortcut(event)) {
		return true;
	}
	if (!selection || !is_visible(selection.cell) || !selection.cell.contains(event.target) ||
		!is_grid_in_current_surface(selection.grid) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
		return false;
	}

	const current = selection;
	if (current.editor && has_open_autocomplete(current.editor)) {
		return false;
	}
	if (event.key === "Escape") {
		consume_key(event);
		if (current.editor) {
			focus_cell(current.grid, current.row, current.fieldname);
		} else {
			clear_selection();
		}
		return true;
	}
	if (ARROWS.includes(event.key)) {
		if (current.editor && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
			return false;
		}
		consume_key(event);
		move_cell(event, current);
		return true;
	}
	if (event.key !== "Enter" || current.editor?.matches("textarea, [contenteditable=true]")) {
		return false;
	}

	consume_key(event);
	if (!event.repeat) {
		const { grid, row, fieldname } = current;
		const cells = cells_for(row);
		const last_cell = cells.at(-1)?.name === fieldname;
		if (last_cell && is_final_row(grid, row) && can_add_row(grid)) {
			add_row(grid, fieldname, cells.length - 1);
		} else if (current.editor) {
			const next = cells[cells.findIndex((cell) => cell.name === fieldname) + 1];
			if (next) {
				focus_cell(grid, row, next.name);
			} else {
				move_cell({ key: "ArrowDown", repeat: false }, current);
			}
		} else {
			activate_cell(current);
		}
	}
	return true;
}
