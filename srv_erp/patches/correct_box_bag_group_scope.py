from srv_erp.patches.convert_box_group_uoms_to_bag import convert_item_uom_rows


def execute():
	# The earlier patch may already be logged after skipping the Concealed tree.
	convert_item_uom_rows()
