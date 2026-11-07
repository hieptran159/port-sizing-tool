#!/usr/bin/env python3
"""Quet file BOM (CSV xuat tu quote/BOM hang) va tu dong xac dinh so port NIC/HBA qua card_catalog.yaml.

card_catalog.yaml dang RONG (chua co du lieu thuc). Dong BOM khong khop entry nao trong catalog
se duoc bao "chua xac dinh duoc" - tool KHONG tu doan so port, ban dien tay data_ports cho dong
do hoac bo sung entry (voi nguon xac minh) vao card_catalog.yaml roi chay lai.

CSV dau vao can it nhat 1 trong 2 cot "description" hoac "part_number", va nen co "qty".

Day la module logic - dung qua CLI thong nhat: `python app.py scan-bom --bom ...`
"""
from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass
class CardCatalogEntry:
    match: str
    ports: int
    type: str  # "nic" hoac "hba"
    source: str


def load_catalog(path: Path) -> list[CardCatalogEntry]:
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return [CardCatalogEntry(**c) for c in raw.get("cards") or []]


def resolve_ports(catalog: list[CardCatalogEntry], text: str) -> CardCatalogEntry | None:
    """Tim 1 entry catalog khop voi text (substring, khong phan biet hoa/thuong).
    Tra None neu khong khop entry nao, hoac khop nhieu hon 1 (ambiguous - can nguoi kiem tra tay,
    khong tu doan chon 1 trong so do)."""
    text_lower = text.lower()
    matches = [c for c in catalog if c.match.lower() in text_lower]
    return matches[0] if len(matches) == 1 else None


@dataclass
class BomLine:
    row: dict[str, str]
    resolved: CardCatalogEntry | None


def scan_bom(catalog: list[CardCatalogEntry], bom_path: Path) -> list[BomLine]:
    with bom_path.open(newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    lines: list[BomLine] = []
    for row in rows:
        text = row.get("description") or row.get("part_number") or ""
        lines.append(BomLine(row=row, resolved=resolve_ports(catalog, text)))
    return lines


def render_report(lines: list[BomLine]) -> str:
    out: list[str] = []
    for line in lines:
        desc = line.row.get("description") or line.row.get("part_number") or "(khong ro)"
        qty = line.row.get("qty", "?")
        if line.resolved:
            out.append(
                f"OK   qty={qty:>3}  {desc!r} -> {line.resolved.ports} port ({line.resolved.type}, "
                f"nguon: {line.resolved.source})"
            )
        else:
            out.append(f"???  qty={qty:>3}  {desc!r} -> CHUA XAC DINH duoc port")
    unresolved = sum(1 for line in lines if line.resolved is None)
    if unresolved:
        out.append(
            f"\n{unresolved}/{len(lines)} dong chua xac dinh duoc port. Dien tay data_ports cho "
            f"cac dong nay, hoac bo sung entry (co nguon xac minh) vao card_catalog.yaml roi chay lai."
        )
    return "\n".join(out)
