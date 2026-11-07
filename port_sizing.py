#!/usr/bin/env python3
"""Port-sizing calculator cho server / LAN switch / SAN switch / SAN storage.

Rule nghiep vu (port profile theo role, cach ghep noi, % du phong, port/switch toi da)
nam trong file YAML rieng (mac dinh rules.yaml), khong hard-code trong file nay - sua
tham so thi sua YAML, khong can dong code.

Day la module logic - dung qua CLI thong nhat: `python app.py size --inventory ...`
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


# --------------------------------------------------------------------------
# Rule config
# --------------------------------------------------------------------------

@dataclass
class RoleSpec:
    name: str
    kind: str  # "leaf" (trong inventory) hoac "pair" (cap redundant, duoc tinh ra)
    ports: dict[str, int] = field(default_factory=dict)
    protocol_variants: dict[str, dict[str, int]] = field(default_factory=dict)
    own_ports: dict[str, int] = field(default_factory=dict)
    spare_percent: float = 0.0
    max_ports_per_unit: int | None = None


@dataclass
class ConnectionRule:
    from_role: str
    from_port: str
    to_role: str
    to_port: str
    requires_protocol: str | None = None


@dataclass
class ServerModel:
    """Metadata THAT tra tu tai lieu chinh hang - chi de validate/trich dan, khong dung de tinh port."""

    vendor: str
    model_name: str
    form_factor: str
    mgmt_hw: int
    ocp_slots: int
    has_onboard_lom: bool
    pcie_slots_max: int
    source: str


@dataclass
class Rules:
    roles: dict[str, RoleSpec]
    connections: list[ConnectionRule]
    server_models: dict[str, ServerModel] = field(default_factory=dict)


def load_rules(path: Path) -> Rules:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    roles: dict[str, RoleSpec] = {}
    for name, r in raw["roles"].items():
        kind = r.get("kind")
        if kind not in ("leaf", "pair"):
            raise ValueError(f"role {name!r}: kind phai la 'leaf' hoac 'pair', khong phai {kind!r}")
        roles[name] = RoleSpec(
            name=name,
            kind=kind,
            ports=r.get("ports", {}),
            protocol_variants=r.get("protocol_variants", {}),
            own_ports=r.get("own_ports", {}),
            spare_percent=float(r.get("spare_percent", 0.0)),
            max_ports_per_unit=r.get("max_ports_per_unit"),
        )
    connections = [ConnectionRule(**c) for c in raw.get("connections", [])]
    for c in connections:
        if c.from_role not in roles:
            raise ValueError(f"connection tham chieu role khong ton tai: {c.from_role!r}")
        if c.to_role not in roles:
            raise ValueError(f"connection tham chieu role khong ton tai: {c.to_role!r}")
    server_models = {name: ServerModel(**m) for name, m in raw.get("server_models", {}).items()}
    return Rules(roles=roles, connections=connections, server_models=server_models)


# --------------------------------------------------------------------------
# Inventory
# --------------------------------------------------------------------------

@dataclass
class InventoryItem:
    role: str
    qty: int
    protocol: str | None = None
    model: str | None = None          # key trong rules.server_models (VD: "dell_r660") - de validate + trich dan
    data_ports: int | None = None      # so port data thuc te theo OCP/NIC card se dat hang; None = dung gia tri mac dinh trong rules.ports


def load_inventory(path: Path) -> list[InventoryItem]:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    return [InventoryItem(**item) for item in raw["inventory"]]


# --------------------------------------------------------------------------
# Engine
# --------------------------------------------------------------------------

def ceil_div(a: int, b: int) -> int:
    return -(-a // b)


def leaf_port_totals(rules: Rules, inventory: list[InventoryItem]) -> dict[str, dict[str, int]]:
    """Tong port sinh ra tu cac role kind=leaf (server, storage...), truoc khi chia cho cap redundant."""
    totals: dict[str, dict[str, int]] = {}
    for item in inventory:
        spec = rules.roles.get(item.role)
        if spec is None:
            raise ValueError(f"inventory dung role khong ton tai trong rules: {item.role!r}")
        if spec.kind != "leaf":
            raise ValueError(f"role {item.role!r} la kind='{spec.kind}', khong duoc khai bao trong inventory")
        if item.model and item.model not in rules.server_models:
            valid = ", ".join(sorted(rules.server_models)) or "(chua co model nao trong rules.yaml)"
            raise ValueError(f"model {item.model!r} khong ton tai trong server_models. Cac model hop le: {valid}")

        ports = dict(spec.ports)
        if item.data_ports is not None:
            ports["data"] = item.data_ports
        if item.protocol:
            variant = spec.protocol_variants.get(item.protocol)
            if variant is None:
                raise ValueError(f"role {item.role!r} khong co protocol_variant {item.protocol!r}")
            ports.update(variant)  # cong them, khong thay the data/mgmt da xac dinh o tren

        role_totals = totals.setdefault(item.role, {})
        for port_type, count in ports.items():
            role_totals[port_type] = role_totals.get(port_type, 0) + count * item.qty
    return totals


def used_server_models(rules: Rules, inventory: list[InventoryItem]) -> list[ServerModel]:
    """Danh sach model/nguon da dung trong inventory, de audit trail so lieu lay tu dau."""
    seen: dict[str, ServerModel] = {}
    for item in inventory:
        if item.model:
            seen[item.model] = rules.server_models[item.model]
    return list(seen.values())


def protocol_present(inventory: list[InventoryItem], protocol: str) -> bool:
    return any(item.protocol == protocol for item in inventory)


@dataclass
class PairResult:
    role: str
    downlink_ports_per_unit: int
    own_ports_per_unit: int
    total_ports_per_unit: int
    physical_units: int
    warnings: list[str] = field(default_factory=list)


def compute(rules: Rules, inventory: list[InventoryItem]) -> dict[str, dict[str, int] | PairResult]:
    leaf_totals = leaf_port_totals(rules, inventory)

    # gom tat ca luong port tung role "pair" nhan duoc, theo tung to_port
    upstream_totals: dict[str, dict[str, int]] = {}
    for conn in rules.connections:
        if conn.requires_protocol and not protocol_present(inventory, conn.requires_protocol):
            continue
        amount = leaf_totals.get(conn.from_role, {}).get(conn.from_port, 0)
        if amount == 0:
            continue
        bucket = upstream_totals.setdefault(conn.to_role, {})
        bucket[conn.to_port] = bucket.get(conn.to_port, 0) + amount

    results: dict[str, dict[str, int] | PairResult] = {}
    for role_name, spec in rules.roles.items():
        if spec.kind == "leaf":
            if role_name in leaf_totals:
                results[role_name] = dict(leaf_totals[role_name])
            continue

        downlinks = upstream_totals.get(role_name, {})
        warnings: list[str] = []
        per_unit_downlink = 0
        for port_type, amount in downlinks.items():
            if amount % 2 != 0:
                warnings.append(
                    f"{role_name}.{port_type}: tong {amount} port (so le) khong chia deu duoc cho "
                    f"cap redundant - mot ben se du 1 port, kiem tra lai thiet ke."
                )
            per_unit_downlink += ceil_div(amount, 2)

        per_unit_downlink = math.ceil(per_unit_downlink * (1 + spec.spare_percent / 100))
        own_total = sum(spec.own_ports.values())
        total_per_unit = per_unit_downlink + own_total

        physical_units = 2
        if spec.max_ports_per_unit:
            physical_units = 2 * ceil_div(total_per_unit, spec.max_ports_per_unit)

        results[role_name] = PairResult(
            role=role_name,
            downlink_ports_per_unit=per_unit_downlink,
            own_ports_per_unit=own_total,
            total_ports_per_unit=total_per_unit,
            physical_units=physical_units,
            warnings=warnings,
        )
    return results


def apply_spare_override(rules: Rules, spare_percent: float) -> None:
    for spec in rules.roles.values():
        if spec.kind == "pair":
            spec.spare_percent = spare_percent


# --------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------

def render_text(results: dict[str, dict[str, int] | PairResult], models: list[ServerModel]) -> str:
    lines: list[str] = []
    for role, res in results.items():
        if isinstance(res, dict):
            ports = ", ".join(f"{k}={v}" for k, v in res.items())
            lines.append(f"[{role}] (leaf, tu inventory)  {ports}")
        else:
            lines.append(
                f"[{role}] (pair) => {res.physical_units} thiet bi vat ly, moi thiet bi can "
                f"{res.total_ports_per_unit} port "
                f"(downlink+spare={res.downlink_ports_per_unit}, own_ports={res.own_ports_per_unit})"
            )
            for w in res.warnings:
                lines.append(f"    !! {w}")
    if models:
        lines.append("")
        lines.append("Server model dung trong inventory (nguon tra cuu):")
        for m in models:
            lines.append(f"  - {m.vendor} {m.model_name} ({m.form_factor}) -- {m.source}")
    return "\n".join(lines)


def render_json(results: dict[str, dict[str, int] | PairResult], models: list[ServerModel]) -> str:
    out: dict[str, Any] = {}
    for role, res in results.items():
        if isinstance(res, dict):
            out[role] = {"kind": "leaf", "ports": res}
        else:
            out[role] = {
                "kind": "pair",
                "physical_units": res.physical_units,
                "total_ports_per_unit": res.total_ports_per_unit,
                "downlink_ports_per_unit": res.downlink_ports_per_unit,
                "own_ports_per_unit": res.own_ports_per_unit,
                "warnings": res.warnings,
            }
    out["_server_models_used"] = [
        {"vendor": m.vendor, "model_name": m.model_name, "form_factor": m.form_factor, "source": m.source}
        for m in models
    ]
    return json.dumps(out, indent=2, ensure_ascii=False)
