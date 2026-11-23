"""Fresh installation must initialize DSR without requiring a later migration."""

import ast
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import Mock, patch

from srv_erp.smart_dsr import setup


class TestSmartDSRInstallation(unittest.TestCase):
	def test_fresh_install_runs_shared_setup_after_existing_initializers(self):
		# Execute the real hook body with unrelated installation services replaced.
		# This avoids importing or running their production migrations in a unit test.
		source = Path(__file__).parents[1] / "install.py"
		tree = ast.parse(source.read_text())
		hook = next(
			node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "after_install"
		)
		names = {
			node.func.id
			for node in ast.walk(hook)
			if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
		}
		calls = Mock()
		namespace = {name: getattr(calls, name) for name in names}
		exec(compile(ast.Module(body=[hook], type_ignores=[]), str(source), "exec"), namespace)
		with patch.object(setup, "execute") as initialize:
			calls.attach_mock(initialize, "smart_dsr")
			namespace["after_install"]()
			initialize.assert_called_once_with()
		self.assertEqual(calls.mock_calls[-1][0], "smart_dsr")

	def test_vehicle_setup_only_backfills_new_availability_fields(self):
		with ExitStack() as stack:
			db = stack.enter_context(patch.object(setup.frappe, "db", Mock()))
			reload_doc = stack.enter_context(patch.object(setup.frappe, "reload_doc"))
			db.has_column.return_value = False
			setup.setup_vehicle_fields()
			self.assertEqual(db.sql.call_count, 4)
			db.sql.reset_mock()
			db.has_column.return_value = True
			setup.setup_vehicle_fields()
			db.sql.assert_not_called()
			self.assertEqual(reload_doc.call_count, 2)
