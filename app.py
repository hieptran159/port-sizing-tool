#!/usr/bin/env python3
"""Ung dung port-sizing - 1 entry point gop chung tat ca cong cu trong thu muc nay.

Subcommands:
    size       Tinh so port can thiet (server/LAN switch/SAN switch/SAN storage) tu 1 file inventory.
    scan-bom   Quet file BOM/quote CSV de xac dinh so port NIC/HBA qua card_catalog.yaml.

Vi du:
    python app.py size --inventory example_inventory.yaml
    python app.py size --inventory example_inventory.yaml --format json --spare-percent 30
    python app.py scan-bom --bom quote_export.csv
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import bom_import
import port_sizing

HERE = Path(__file__).parent


def cmd_size(args: argparse.Namespace) -> int:
    try:
        rules = port_sizing.load_rules(args.rules)
        inventory = port_sizing.load_inventory(args.inventory)
        if args.spare_percent is not None:
            port_sizing.apply_spare_override(rules, args.spare_percent)
        results = port_sizing.compute(rules, inventory)
        models = port_sizing.used_server_models(rules, inventory)
    except (ValueError, KeyError, FileNotFoundError) as exc:
        print(f"Loi: {exc}", file=sys.stderr)
        return 1

    render = port_sizing.render_json if args.format == "json" else port_sizing.render_text
    print(render(results, models))
    return 0


def cmd_scan_bom(args: argparse.Namespace) -> int:
    if not args.bom.exists():
        print(f"Loi: khong tim thay file BOM {args.bom}", file=sys.stderr)
        return 1
    catalog = bom_import.load_catalog(args.catalog)
    lines = bom_import.scan_bom(catalog, args.bom)
    print(bom_import.render_report(lines))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="app.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_size = sub.add_parser("size", help="Tinh so port can thiet tu 1 file inventory")
    p_size.add_argument("--inventory", required=True, type=Path, help="File YAML danh sach thiet bi (BOM sizing)")
    p_size.add_argument("--rules", type=Path, default=HERE / "rules.yaml", help="File YAML rule sizing (mac dinh rules.yaml canh app.py)")
    p_size.add_argument("--format", choices=["text", "json"], default="text")
    p_size.add_argument("--spare-percent", type=float, default=None, help="Ghi de spare_percent cua TAT CA role pair")
    p_size.set_defaults(func=cmd_size)

    p_scan = sub.add_parser("scan-bom", help="Quet file BOM/quote CSV de xac dinh so port NIC/HBA")
    p_scan.add_argument("--bom", required=True, type=Path, help="File CSV xuat tu BOM/quote")
    p_scan.add_argument("--catalog", type=Path, default=HERE / "card_catalog.yaml", help="File YAML tra cuu card (mac dinh card_catalog.yaml canh app.py)")
    p_scan.set_defaults(func=cmd_scan_bom)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
