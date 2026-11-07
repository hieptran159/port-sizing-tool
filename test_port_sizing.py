"""Self-check cho port_sizing.py. Chay: python test_port_sizing.py"""
from __future__ import annotations

import unittest
from pathlib import Path

from port_sizing import (
    ConnectionRule,
    InventoryItem,
    PairResult,
    RoleSpec,
    Rules,
    compute,
    load_inventory,
    load_rules,
    used_server_models,
)

HERE = Path(__file__).parent


class TestDefaultRules(unittest.TestCase):
    """Tinh tay theo rules.yaml mac dinh, doi chieu voi ket qua engine."""

    def setUp(self) -> None:
        self.rules = load_rules(HERE / "rules.yaml")

    def test_example_inventory(self) -> None:
        inventory = load_inventory(HERE / "example_inventory.yaml")
        results = compute(self.rules, inventory)

        # 2 server iscsi (dell_r660): mgmt_hw=2, mgmt_os=2, data=4, iscsi_data=4
        # 1 san_storage: mgmt_hw=2 (1/controller), controller_port=4

        # network_switch nhan: server.data (4) + server.iscsi_data (4) = 8
        net = results["network_switch"]
        self.assertIsInstance(net, PairResult)
        self.assertEqual(net.downlink_ports_per_unit, 5)  # ceil(8/2)=4, spare 20% -> ceil(4.8)=5
        self.assertEqual(net.own_ports_per_unit, 4)  # mgmt_hw1+uplink2+peer_link1
        self.assertEqual(net.total_ports_per_unit, 9)
        self.assertEqual(net.physical_units, 2)
        self.assertEqual(net.warnings, [])

        # mgmt_switch nhan: server.mgmt_hw(2) + server.mgmt_os(2) + storage.mgmt_hw(2) = 6 (chan)
        mgmt = results["mgmt_switch"]
        self.assertIsInstance(mgmt, PairResult)
        self.assertEqual(mgmt.downlink_ports_per_unit, 4)  # 6/2=3, spare20% -> ceil(3.6)=4
        self.assertEqual(mgmt.own_ports_per_unit, 1)  # uplink=1
        self.assertEqual(mgmt.total_ports_per_unit, 5)
        self.assertEqual(mgmt.physical_units, 2)
        self.assertEqual(mgmt.warnings, [])  # 6 chan -> khong canh bao (so le da test o TestSplitLogic)

        # san_switch nhan: storage.controller_port(4) (khong co fc trong inventory -> fc_hba khong tinh)
        san = results["san_switch"]
        self.assertIsInstance(san, PairResult)
        self.assertEqual(san.downlink_ports_per_unit, 3)  # ceil(4/2)=2, spare20% -> ceil(2.4)=3
        self.assertEqual(san.own_ports_per_unit, 1)
        self.assertEqual(san.total_ports_per_unit, 4)
        self.assertEqual(san.physical_units, 2)

        # server / san_storage la leaf, tra ve dict port tho
        self.assertEqual(results["server"], {"mgmt_hw": 2, "mgmt_os": 2, "data": 4, "iscsi_data": 4})
        self.assertEqual(results["san_storage"], {"mgmt_hw": 2, "controller_port": 4})

    def test_server_models_used_for_audit_trail(self) -> None:
        inventory = load_inventory(HERE / "example_inventory.yaml")
        models = used_server_models(self.rules, inventory)
        names = {m.model_name for m in models}
        self.assertEqual(names, {"PowerEdge R660"})


class TestServerModelOverride(unittest.TestCase):
    """Model chi de validate/trich dan; data_ports moi la thu thuc su thay doi so port."""

    def setUp(self) -> None:
        self.rules = load_rules(HERE / "rules.yaml")

    def test_unknown_model_raises(self) -> None:
        inventory = [InventoryItem(role="server", qty=1, model="khong_ton_tai")]
        with self.assertRaises(ValueError):
            compute(self.rules, inventory)

    def test_data_ports_override_changes_total(self) -> None:
        inventory = [InventoryItem(role="server", qty=1, model="h3c_r4900_g6", data_ports=4)]
        results = compute(self.rules, inventory)
        self.assertEqual(results["server"]["data"], 4)


class TestSplitLogic(unittest.TestCase):
    """Kiem rieng logic chia deu cho cap redundant + warning so le, khong phu thuoc rules.yaml."""

    def _minimal_rules(self, downlink_amount: int) -> tuple[Rules, list[InventoryItem]]:
        roles = {
            "device": RoleSpec(name="device", kind="leaf", ports={"link": 1}),
            "upstream": RoleSpec(name="upstream", kind="pair", own_ports={"mgmt_hw": 1}, spare_percent=0),
        }
        connections = [ConnectionRule(from_role="device", from_port="link", to_role="upstream", to_port="downlink")]
        rules = Rules(roles=roles, connections=connections)
        inventory = [InventoryItem(role="device", qty=downlink_amount)]
        return rules, inventory

    def test_even_split_no_warning(self) -> None:
        rules, inventory = self._minimal_rules(4)
        result = compute(rules, inventory)["upstream"]
        assert isinstance(result, PairResult)
        self.assertEqual(result.downlink_ports_per_unit, 2)
        self.assertEqual(result.warnings, [])

    def test_odd_split_warns(self) -> None:
        rules, inventory = self._minimal_rules(3)
        result = compute(rules, inventory)["upstream"]
        assert isinstance(result, PairResult)
        self.assertEqual(result.downlink_ports_per_unit, 2)  # ceil(3/2)
        self.assertEqual(len(result.warnings), 1)

    def test_max_ports_per_unit_scales_out(self) -> None:
        rules, inventory = self._minimal_rules(200)
        rules.roles["upstream"].max_ports_per_unit = 48
        result = compute(rules, inventory)["upstream"]
        assert isinstance(result, PairResult)
        # per_unit = ceil(200/2) + 1(mgmt) = 101 -> ceil(101/48)=3 units/ben -> 6 vat ly
        self.assertEqual(result.physical_units, 6)


if __name__ == "__main__":
    unittest.main()
