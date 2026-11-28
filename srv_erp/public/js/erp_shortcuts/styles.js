const HINT_STYLE_ID = "srv-erp-home-shortcut-hints";

export function inject_shortcut_styles() {
	if (document.getElementById(HINT_STYLE_ID)) {
		return;
	}

	const style = document.createElement("style");
	style.id = HINT_STYLE_ID;
	style.textContent = `
		:root {
			--srv-erp-shortcut-hint-size: 9px;
			--srv-erp-shortcut-hint-line-height: 13px;
			--srv-erp-shortcut-hint-weight: 500;
		}
			html:not(.srv-erp-keyboard-labels-visible) [class*="srv-erp-"][class*="shortcut-hint"],
			html:not(.srv-erp-keyboard-labels-visible) .srv-erp-global-primary-hint,
			html:not(.srv-erp-keyboard-labels-visible) .srv-erp-global-close-hint,
			html:not(.srv-erp-keyboard-labels-visible) .srv-erp-grid-row-commit-hint,
			html:not(.srv-erp-keyboard-labels-visible) .srv-erp-grid-remove-shortcut-hint,
			html:not(.srv-erp-keyboard-labels-visible) .srv-erp-user-menu-hint {
				display: none !important;
			}
			html:not(.srv-erp-keyboard-labels-visible) .srv-erp-shortcut-letter {
				color: inherit !important;
				font-weight: inherit;
				text-transform: none !important;
				text-decoration: none;
			}
			.shortcut-widget-box .widget-title .srv-erp-shortcut-letter {
				color: var(--blue-600, #2490ef) !important;
				font-weight: 800;
				text-transform: uppercase;
				text-decoration: underline 2px currentColor;
				text-underline-offset: 3px;
			}
		.page-head .srv-erp-home-title-host {
			position: relative;
		}
		.page-head .srv-erp-home-title-host > .srv-erp-home-title {
			position: absolute;
			inset-block-start: 50%;
			inset-inline-start: var(--srv-erp-home-title-inline-start, 0);
			z-index: 1;
			font-weight: 700;
			transform: translateY(-50%);
			white-space: nowrap;
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
			font-size: var(--srv-erp-shortcut-hint-size);
			line-height: var(--srv-erp-shortcut-hint-line-height);
			font-weight: var(--srv-erp-shortcut-hint-weight);
			color: var(--text-muted);
			white-space: nowrap;
		}
		.list-row-container.srv-erp-list-row-keyboard-active {
			background: var(--bg-blue) !important;
			box-shadow: inset 0 0 0 1px var(--text-on-blue);
		}
		.page-head .srv-erp-list-add-shortcut {
			display: inline-flex;
			flex-direction: column;
			align-items: flex-end;
		}
		.srv-erp-user-menu-hint,
		.srv-erp-grid-shortcut-hint {
			margin-inline-start: 6px;
			font-size: var(--srv-erp-shortcut-hint-size);
			line-height: var(--srv-erp-shortcut-hint-line-height);
			font-weight: var(--srv-erp-shortcut-hint-weight);
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
			font-size: var(--srv-erp-shortcut-hint-size);
			line-height: var(--srv-erp-shortcut-hint-line-height);
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
			background: var(--bg-blue) !important;
			box-shadow: inset 0 0 0 1px var(--text-on-blue);
			outline: none;
		}
		.srv-erp-grid-surface-keyboard-active {
			background-color: var(--control-bg) !important;
			color: var(--text-color) !important;
			box-shadow: inset 0 0 0 2px var(--gray-500) !important;
			outline: none !important;
			border-radius: var(--border-radius, 6px);
		}
		.srv-erp-grid-surface-keyboard-active svg,
		.srv-erp-grid-surface-keyboard-active i {
			color: var(--text-color) !important;
			fill: currentColor;
		}
		.srv-erp-global-primary-action,
		.srv-erp-dialog-close-action,
		.srv-erp-grid-row-commit-action {
			display: inline-flex !important;
			align-items: center;
			justify-content: center;
			gap: 5px;
		}
		.srv-erp-global-primary-hint,
		.srv-erp-global-close-hint,
		.srv-erp-grid-row-commit-hint,
		.srv-erp-grid-remove-shortcut-hint {
			font-size: var(--srv-erp-shortcut-hint-size);
			line-height: var(--srv-erp-shortcut-hint-line-height);
			font-weight: var(--srv-erp-shortcut-hint-weight);
			white-space: nowrap;
		}
		.srv-erp-global-primary-hint,
		.srv-erp-grid-row-commit-hint {
			color: inherit;
			opacity: 0.82;
		}
		.srv-erp-global-close-hint,
		.srv-erp-grid-remove-shortcut-hint {
			color: var(--text-muted);
		}
		.srv-erp-grid-settings-row .remove-field {
			display: inline-flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			line-height: 1;
		}
		.srv-erp-form-field-keyboard:focus {
			outline: 1px solid var(--gray-500);
			outline-offset: 1px;
		}
		.form-tabs-list .form-tabs {
			scrollbar-width: none;
			-ms-overflow-style: none;
		}
		.form-tabs-list .form-tabs::-webkit-scrollbar {
			display: none;
			width: 0;
			height: 0;
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
			display: block;
		}
		.srv-erp-form-tab-shortcut-hint {
			display: block;
			padding: 2px 12px 3px;
			text-align: end;
			color: var(--text-muted);
			font-size: var(--srv-erp-shortcut-hint-size);
			line-height: var(--srv-erp-shortcut-hint-line-height);
			font-weight: var(--srv-erp-shortcut-hint-weight);
			white-space: nowrap;
		}
		.form-layout .section-head.srv-erp-form-section-keyboard-active {
			text-decoration: underline;
			text-underline-offset: 4px;
		}
		.form-layout .section-head.collapsible:focus-visible {
			background: var(--bg-blue);
			box-shadow: inset 0 -2px 0 var(--text-on-blue);
			outline: none;
		}
		.form-layout .srv-erp-section-continuation-hidden {
			display: none !important;
		}
		.form-layout .form-section.srv-erp-section-parent-promoted {
			display: flex !important;
		}
		.form-layout .form-section.srv-erp-section-parent-promoted > .section-body {
			display: none !important;
		}
		.form-control.srv-erp-form-field-keyboard:focus:not([type="checkbox"]):not([type="radio"]) {
			border-radius: var(--border-radius);
			background-color: var(--control-bg);
			box-shadow: inset 0 0 0 1px var(--dark-border-color);
		}
		.form-layout .srv-erp-form-section-shortcut-hint {
			display: block;
			margin-top: 2px;
			font-size: var(--srv-erp-shortcut-hint-size);
			line-height: var(--srv-erp-shortcut-hint-line-height);
			font-weight: var(--srv-erp-shortcut-hint-weight);
			color: var(--text-muted);
			white-space: nowrap;
		}
		.srv-erp-unsaved-dialog .modal-footer .btn:focus-visible {
			background: var(--bg-blue);
			color: var(--text-on-blue);
			box-shadow: 0 0 0 2px var(--text-on-blue);
			outline: none;
		}
			.modal.show .srv-erp-dialog-keyboard-active:focus {
				outline: 2px solid var(--gray-500) !important;
				outline-offset: 2px;
				border-radius: var(--border-radius, 6px);
			}
			.modal.show .form-control.srv-erp-dialog-keyboard-active:focus {
				background-color: var(--control-bg);
				box-shadow: inset 0 0 0 1px var(--dark-border-color) !important;
			}
	`;
	document.head.appendChild(style);
}
