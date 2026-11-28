import { is_visible } from "./shared.js";

const CONTINUATION_HIDDEN_CLASS = "srv-erp-section-continuation-hidden";
const PROMOTED_PARENT_CLASS = "srv-erp-section-parent-promoted";
const ENHANCED_FLAG = "__srv_erp_section_group_enhanced";
const ENHANCED_MODE = "__srv_erp_section_group_mode";
const GROUP_MEMBERS = "__srv_erp_section_group_members";
const GROUP_COLLAPSED = "__srv_erp_section_group_collapsed";
const ORIGINAL_COLLAPSE = "__srv_erp_original_section_collapse";
const ORIGINAL_IS_COLLAPSED = "__srv_erp_original_section_is_collapsed";

function element(wrapper) {
	return wrapper?.get?.(0);
}

function section_pane(section) {
	return element(section?.wrapper)?.closest(".tab-pane") || null;
}

function same_pane(left, right) {
	return section_pane(left) === section_pane(right);
}

function has_content(section) {
	return Boolean(
		section?.df?.body_html ||
		section?.fields_list?.some((field) => field.disp_status !== "None") ||
		element(section?.body)?.children.length
	);
}

function is_natively_available(section) {
	const wrapper = element(section?.wrapper);
	return Boolean(
		wrapper &&
		!section.df?.hidden &&
		!section.df?.hidden_due_to_dependency &&
		!wrapper.matches(".hide-control, .empty-section, [hidden]") &&
		wrapper.style.display !== "none" &&
		has_content(section)
	);
}

function should_promote_parent(parent, members) {
	const wrapper = element(parent?.wrapper);
	return Boolean(
		wrapper &&
		wrapper.matches(".hide-control, .empty-section") &&
		members.slice(1).some(is_natively_available)
	);
}

function build_groups(frm) {
	const sections = frm?.layout?.sections || [];
	for (const section of sections) {
		section[GROUP_MEMBERS] = [section];
		element(section.wrapper)?.classList.remove(PROMOTED_PARENT_CLASS);
	}
	for (let index = 0; index < sections.length; index += 1) {
		const parent = sections[index];
		if (!element(parent?.head) || !parent.df?.label) {
			continue;
		}
		const members = [parent];
		for (let cursor = index + 1; cursor < sections.length; cursor += 1) {
			const candidate = sections[cursor];
			if (!same_pane(parent, candidate) || element(candidate?.head)) {
				break;
			}
			members.push(candidate);
		}
		parent[GROUP_MEMBERS] = members;
		element(parent.wrapper)?.classList.toggle(
			PROMOTED_PARENT_CLASS,
			should_promote_parent(parent, members)
		);
	}
}

function sync_group(section, hidden) {
	const members = section[GROUP_MEMBERS] || [section];
	for (const continuation of members.slice(1)) {
		element(continuation.wrapper)?.classList.toggle(CONTINUATION_HIDDEN_CLASS, hidden);
	}
	const head = element(section.head);
	head?.setAttribute("aria-expanded", String(!hidden));
}

function configure_collapse_behavior(section, promoted_parent) {
	if (!section[ORIGINAL_COLLAPSE]) {
		section[ORIGINAL_COLLAPSE] = section.collapse.bind(section);
		section[ORIGINAL_IS_COLLAPSED] = section.is_collapsed.bind(section);
	}
	const mode = promoted_parent ? "promoted" : "standard";
	if (section[ENHANCED_MODE] === mode) {
		return;
	}

	if (promoted_parent) {
		section[GROUP_COLLAPSED] = false;
		section.is_collapsed = section[ORIGINAL_IS_COLLAPSED];
		section.collapse = section[ORIGINAL_COLLAPSE];
	} else {
		section.is_collapsed = section[ORIGINAL_IS_COLLAPSED];
		section.collapse = (hide) => {
			const should_hide = hide === undefined ? !section.is_collapsed() : Boolean(hide);
			section[ORIGINAL_COLLAPSE](should_hide);
			sync_group(section, section.is_collapsed());
		};
	}
	section[ENHANCED_MODE] = mode;
}

export function is_section_collapsed(section) {
	if (element(section?.wrapper)?.classList.contains(PROMOTED_PARENT_CLASS)) {
		return Boolean(section[GROUP_COLLAPSED]);
	}
	return Boolean(section?.is_collapsed?.());
}

export function set_section_collapsed(section, hide) {
	if (!section) {
		return;
	}
	if (element(section.wrapper)?.classList.contains(PROMOTED_PARENT_CLASS)) {
		const should_hide = hide === undefined ? !is_section_collapsed(section) : Boolean(hide);
		section[GROUP_COLLAPSED] = should_hide;
		sync_group(section, should_hide);
		section.set_icon(should_hide);
		return;
	}
	section.collapse(hide);
}

function enhance_section(section) {
	const head = section?.head;
	const head_element = element(head);
	if (!head_element || !is_section_available(section)) {
		return;
	}

	const promoted_parent = element(section.wrapper)?.classList.contains(PROMOTED_PARENT_CLASS);
	const originally_collapsible = Boolean(section.df.collapsible);
	section.df.collapsible = 1;
	configure_collapse_behavior(section, promoted_parent);

	if (!section[ENHANCED_FLAG]) {
		head.addClass("collapsible");
		head.attr("tabindex", 0);
		section.indicator?.show();
		section.indicator?.attr("aria-hidden", "true");
		section.set_icon(is_section_collapsed(section));

		if (!originally_collapsible || promoted_parent) {
			head.on("click.srv_erp_section_group", (event) => {
				if (!event.target.closest("a, button, input, select, textarea")) {
					set_section_collapsed(section);
				}
			});
		}
		section[ENHANCED_FLAG] = true;
	}

	sync_group(section, is_section_collapsed(section));
}

export function enhance_form_sections(frm) {
	build_groups(frm);
	for (const section of frm?.layout?.sections || []) {
		enhance_section(section);
	}
}

export function get_section_group(section) {
	return section?.[GROUP_MEMBERS] || (section ? [section] : []);
}

export function is_section_available(section) {
	const wrapper = element(section?.wrapper);
	return Boolean(
		wrapper &&
		(wrapper.classList.contains(PROMOTED_PARENT_CLASS) || is_natively_available(section)) &&
		get_section_group(section).some(has_content)
	);
}

export function first_visible_grid_target(section) {
	for (const member of get_section_group(section)) {
		for (const field of member.fields_list || []) {
			const target = element(field?.grid?.wrapper);
			if (target && is_visible(target)) {
				return target;
			}
		}
	}
	return null;
}
