const HINT_STYLE_ID = "srv-erp-home-shortcut-hints";

export function inject_shortcut_styles() {
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
		.standard-sidebar-item.srv-erp-sidebar-keyboard-active {
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
		.srv-erp-user-menu-hint,
		.srv-erp-grid-shortcut-hint {
			margin-inline-start: 6px;
			font-size: 10px;
			font-weight: 400;
			color: var(--text-muted);
		}
		.srv-erp-grid-icon-shortcut {
			flex-direction: column;
			align-items: center;
			justify-content: center;
			line-height: 1;
		}
		.grid-static-col.srv-erp-grid-icon-shortcut {
			padding-block: 2px !important;
		}
		.srv-erp-grid-icon-shortcut > .srv-erp-grid-shortcut-hint {
			margin-inline-start: 0;
			font-size: 9px;
			line-height: 11px;
			white-space: nowrap;
		}
		.srv-erp-user-menu-hint {
			vertical-align: middle;
		}
		.grid-field.srv-erp-grid-shortcuts-active .srv-erp-grid-shortcut-hint {
			color: var(--text-color);
		}
		.grid-field.srv-erp-form-field-keyboard:focus {
			outline: 1px solid var(--text-muted);
			outline-offset: 2px;
		}
		.srv-erp-grid-keyboard-cell {
			outline: 2px solid var(--text-muted);
			outline-offset: -2px;
		}
		.srv-erp-form-field-keyboard:focus {
			outline: 1px solid var(--gray-500);
			outline-offset: 1px;
		}
		.form-tabs-list .form-tabs .nav-item .nav-link[role="tab"] {
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			min-height: 48px;
			padding: 7px 14px;
			margin: 0 2px;
			border-bottom: 2px solid transparent;
			background-color: transparent;
		}
		.form-tabs-list .form-tabs .nav-item .nav-link[role="tab"]:hover {
			color: var(--text-color);
		}
		.form-tabs-list .form-tabs .nav-item .nav-link[role="tab"].active {
			border-bottom: 2px solid var(--text-color);
		}
		.form-tabs-list .form-tabs .nav-item .nav-link[role="tab"]:focus-visible {
			outline: none;
			box-shadow: none;
			border-bottom: 3px solid var(--text-color);
		}
		.form-tabs-list.srv-erp-tab-navigation {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.srv-erp-tab-navigation > .form-tabs {
			flex: 1;
			min-width: 0;
		}
		.srv-erp-form-tab-shortcut-hint {
			flex: 0 0 auto;
			padding-inline-end: 12px;
			color: var(--text-muted);
			font-size: 11px;
			line-height: 1.25;
			white-space: nowrap;
		}
		.form-layout .section-head.srv-erp-form-section-keyboard-active {
			text-decoration: underline;
			text-underline-offset: 4px;
		}
		.form-control.srv-erp-form-field-keyboard:focus:not([type="checkbox"]):not([type="radio"]) {
			border-radius: var(--border-radius);
			background-color: var(--control-bg);
			box-shadow: inset 0 0 0 1px var(--dark-border-color);
		}
		.form-layout .srv-erp-form-section-shortcut-hint,
		.form-layout .srv-erp-form-field-shortcut-hint {
			display: block;
			margin-top: 2px;
			font-size: 8px;
			line-height: 10px;
			font-weight: 400;
			color: var(--gray-500);
			white-space: nowrap;
		}
	`;
	document.head.appendChild(style);
}
