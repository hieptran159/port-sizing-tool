"""Self-check cho webapp.py (chi phan logic thuan, khong dong Flask/ghi file thuc).
Chay: python test_webapp.py"""
from __future__ import annotations

import unittest

import yaml

from webapp import add_server_model_to_rules_text

SAMPLE = """roles:
  server:
    kind: leaf
    ports:
      mgmt_hw: 1

server_models:
  existing_model:
    vendor: X
    model_name: "Existing"
    form_factor: "1U"
    mgmt_hw: 1
    ocp_slots: 1
    has_onboard_lom: true
    pcie_slots_max: 2
    source: "https://example.com"

connections:
  - from_role: server
    from_port: mgmt_hw
    to_role: server
    to_port: x
"""

NEW_MODEL_DATA = {
    "vendor": "Dell",
    "model_name": "PowerEdge R960",
    "form_factor": "4U",
    "mgmt_hw": 1,
    "ocp_slots": 2,
    "has_onboard_lom": False,
    "pcie_slots_max": 10,
    "source": "https://example.com/r960",
}


class TestAddServerModelToRulesText(unittest.TestCase):
    def test_inserts_before_connections_and_keeps_rest_intact(self) -> None:
        result = add_server_model_to_rules_text(SAMPLE, "dell_r960", NEW_MODEL_DATA)
        parsed = yaml.safe_load(result)

        self.assertEqual(set(parsed["server_models"]), {"existing_model", "dell_r960"})
        self.assertEqual(parsed["server_models"]["dell_r960"]["vendor"], "Dell")
        self.assertEqual(parsed["server_models"]["dell_r960"]["has_onboard_lom"], False)
        self.assertEqual(len(parsed["connections"]), 1)  # phan connections khong bi dong lai/mat
        self.assertIn("existing_model", result)  # model cu van con nguyen trong text

    def test_missing_server_models_section_raises(self) -> None:
        with self.assertRaises(ValueError):
            add_server_model_to_rules_text("roles:\n  x:\n    kind: leaf\n", "y", NEW_MODEL_DATA)


if __name__ == "__main__":
    unittest.main()
