import { consume_key, has_open_autocomplete, is_alt_key, is_visible } from "./shared.js";

const PRIMARY_HINT_CLASS = "srv-erp-global-primary-hint";
const CLOSE_HINT_CLASS = "srv-erp-global-close-hint";
const ROW_HINT_CLASS = "srv-erp-grid-row-commit-hint";
const PAGE_CONFIRM_ACTION = /^(save|update|submit)$/i;

function visible_modal() {
	return [...document.querySelectorAll(".modal.show")].filter(is_visible).at(-1) || null;
}

function action_label(button) {
	if (!button) {
		return "";
	}
	const copy = button.cloneNode(true);
	copy.querySelectorAll(`.${PRIMARY_HINT_CLASS}, .${CLOSE_HINT_CLASS}, .${ROW_HINT_CLASS}`)
		.forEach((hint) => hint.remove());
	return copy.textContent.trim();
}

function primary_button(scope) {
	const modal = scope?.matches?.(".modal.show");
	const selector = modal
		? ".modal-footer .btn-modal-primary:not(:disabled)"
		: ".page-head .primary-action:not(:disabled), .page-head .btn-primary:not(:disabled)";
	return [...(scope?.querySelectorAll(selector) || [])].find((button) =>
		is_visible(button) && !button.classList.contains("disabled") &&
		(modal || PAGE_CONFIRM_ACTION.test(action_label(button)))
	) || null;
}

function close_button(modal) {
	const button = modal?.querySelector(".modal-header .btn-modal-close:not(:disabled)");
	return is_visible(button) ? button : null;
}

function open_grid_row() {
	return [...document.querySelectorAll(".grid-row.grid-row-open")].filter(is_visible).at(-1) || null;
}

function row_commit_button(row) {
	const button = row?.querySelector(".grid-collapse-row:not(:disabled)");
	return is_visible(button) ? button : null;
}

function visible_form_for_save() {
	const frm = window.cur_frm;
	const wrapper = frm?.wrapper?.get?.(0) || frm?.wrapper;
	if (!frm?.doc || !is_visible(wrapper) || frm.save_disabled || ![0, 1].includes(frm.doc.docstatus)) {
		return null;
	}
	return frm.doc.__islocal || frm.is_dirty?.() ? frm : null;
}

function save_form(frm) {
	const save_action = frm.doc.docstatus === 1 ? "Update" : undefined;
	void frm.save(save_action);
}

function add_hint(button, text, class_name) {
	if (!button || button.querySelector(`.${class_name}`)) {
		return;
	}
	const hint = document.createElement("span");
	hint.className = class_name;
	hint.textContent = text;
	hint.setAttribute("aria-hidden", "true");
	button.appendChild(hint);
}

export function decorate_global_action_hints() {
	const modal = visible_modal();
	const primary = primary_button(modal || document);
	if (primary) {
		primary.classList.add("srv-erp-global-primary-action");
		primary.setAttribute("title", __("Confirm primary action (Alt+O)"));
		primary.setAttribute("aria-keyshortcuts", "Alt+O");
		add_hint(primary, "Alt+O", PRIMARY_HINT_CLASS);
	}

	const close = close_button(modal);
	if (close) {
		close.classList.add("srv-erp-global-close-action");
		close.setAttribute("title", __("Close (Esc)"));
		close.setAttribute("aria-keyshortcuts", "Escape");
		add_hint(close, "Esc", CLOSE_HINT_CLASS);
	}
	window.srv_erp_dialog_keyboard?.decorate?.();

	const row_button = row_commit_button(open_grid_row());
	if (row_button) {
		row_button.classList.add("srv-erp-grid-row-commit-action");
		row_button.setAttribute("title", __("Finish editing row (Alt+O or Esc)"));
		add_hint(row_button, "Alt+O · Esc", ROW_HINT_CLASS);
	}
}

export function handle_global_action_keyboard(event) {
	if (visible_modal()) {
		return false;
	}
	if (is_alt_key(event, "KeyO")) {
		const target = primary_button(document) || row_commit_button(open_grid_row());
		const frm = target ? null : visible_form_for_save();
		if (!target && !frm) {
			return false;
		}
		consume_key(event);
		if (!event.repeat) {
			target ? target.click() : save_form(frm);
		}
		return true;
	}

	if (event.key !== "Escape" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
		has_open_autocomplete(event.target)) {
		return false;
	}
	const target = row_commit_button(open_grid_row());
	if (!target) {
		return false;
	}
	consume_key(event);
	if (!event.repeat) {
		target.click();
	}
	return true;
}
