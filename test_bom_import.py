"""Self-check cho bom_import.py. Chay: python test_bom_import.py"""
from __future__ import annotations

import csv
import tempfile
import unittest
from pathlib import Path

from bom_import import CardCatalogEntry, resolve_ports, scan_bom


class TestResolvePorts(unittest.TestCase):
    def setUp(self) -> None:
        self.catalog = [CardCatalogEntry(match="57414", ports=2, type="nic", source="test-source")]

    def test_match_found(self) -> None:
        entry = resolve_ports(self.catalog, "Broadcom 57414 Dual Port 25GbE OCP NIC")
        assert entry is not None
        self.assertEqual(entry.ports, 2)

    def test_case_insensitive(self) -> None:
        self.assertIsNotNone(resolve_ports(self.catalog, "broadcom 57414 nic"))

    def test_no_match_returns_none(self) -> None:
        self.assertIsNone(resolve_ports(self.catalog, "Some unknown card XYZ"))

    def test_ambiguous_match_returns_none(self) -> None:
        catalog = [
            CardCatalogEntry(match="NIC", ports=2, type="nic", source="a"),
            CardCatalogEntry(match="25GbE NIC", ports=4, type="nic", source="b"),
        ]
        # ca 2 entry deu la substring cua text nay -> ambiguous, khong tu doan
        self.assertIsNone(resolve_ports(catalog, "Some 25GbE NIC card"))


class TestScanBom(unittest.TestCase):
    def test_scan_csv_flags_unresolved(self) -> None:
        catalog = [CardCatalogEntry(match="57414", ports=2, type="nic", source="test-source")]
        with tempfile.TemporaryDirectory() as tmp:
            bom_path = Path(tmp) / "bom.csv"
            with bom_path.open("w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=["description", "qty"])
                writer.writeheader()
                writer.writerow({"description": "Broadcom 57414 Dual Port NIC", "qty": "8"})
                writer.writerow({"description": "Unknown Card ABC", "qty": "2"})
            lines = scan_bom(catalog, bom_path)

        self.assertEqual(len(lines), 2)
        assert lines[0].resolved is not None
        self.assertEqual(lines[0].resolved.ports, 2)
        self.assertIsNone(lines[1].resolved)

    def test_empty_catalog_flags_everything(self) -> None:
        """card_catalog.yaml thuc te dang rong - phai bao unresolved het, khong crash."""
        with tempfile.TemporaryDirectory() as tmp:
            bom_path = Path(tmp) / "bom.csv"
            with bom_path.open("w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=["description", "qty"])
                writer.writeheader()
                writer.writerow({"description": "Broadcom 57414 Dual Port NIC", "qty": "8"})
            lines = scan_bom([], bom_path)
        self.assertTrue(all(line.resolved is None for line in lines))


if __name__ == "__main__":
    unittest.main()
