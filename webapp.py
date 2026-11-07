#!/usr/bin/env python3
"""Giao dien web local cho port-sizing-tool - sua rules/card_catalog/inventory va chay
size/scan-bom qua trinh duyet, khong can nho cu phap CLI/YAML.

Chay local (khong can mang ngoai, khong can dang nhap):
    python webapp.py
Mo http://127.0.0.1:5000
"""
from __future__ import annotations

import csv
import io
import json
import re
from pathlib import Path

import yaml
from flask import Flask, redirect, render_template_string, request, url_for
from werkzeug.utils import secure_filename

import bom_import
import port_sizing

HERE = Path(__file__).parent
RULES_PATH = HERE / "rules.yaml"
CATALOG_PATH = HERE / "card_catalog.yaml"

app = Flask(__name__)


# --------------------------------------------------------------------------
# Layout
# --------------------------------------------------------------------------

LAYOUT = """
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>{{ title }}</title>
<style>
  body { font-family: system-ui, Arial, sans-serif; margin: 2rem auto; max-width: 960px; color: #222; }
  nav { margin-bottom: 1rem; }
  nav a { margin-right: 1rem; text-decoration: none; color: #06c; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.15rem; margin-top: 1.5rem; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0 1.5rem; }
  th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; font-size: 14px; vertical-align: top; }
  th { background: #f0f0f0; }
  textarea { width: 100%; font-family: Consolas, monospace; font-size: 13px; box-sizing: border-box; }
  .warn { color: #a60; font-weight: bold; }
  .err { color: #c00; background: #fee; padding: .6rem; border: 1px solid #c00; border-radius: 4px; }
  .ok-msg { color: #060; background: #efe; padding: .6rem; border: 1px solid #060; border-radius: 4px; }
  .badge-ok { color: #060; font-weight: bold; }
  .badge-unresolved { color: #a60; font-weight: bold; }
  input[type=text], input[type=number], select { padding: 4px; }
  form.row { display: inline; }
  button { cursor: pointer; padding: 3px 10px; }
  .muted { color: #777; font-size: 13px; }
  fieldset { margin: 1rem 0; padding: .8rem; }
</style>
</head>
<body>
<h1>Port Sizing Tool</h1>
<nav>
  <a href="/">Dashboard</a> |
  <a href="/rules">Rules (YAML)</a> |
  <a href="/cards">Card catalog</a> |
  <a href="/inventory">Inventory</a> |
  <a href="/size">Run: size</a> |
  <a href="/scan-bom">Run: scan-bom</a>
</nav>
<hr>
{{ body|safe }}
</body>
</html>
"""


def layout(title: str, body: str) -> str:
    return render_template_string(LAYOUT, title=title, body=body)


def render(tpl: str, **ctx) -> str:
    """Render 1 fragment Jinja rieng (co the dung {% %}/{{ }}), roi boc vao layout chung."""
    return render_template_string(tpl, **ctx)


# --------------------------------------------------------------------------
# Helpers doc/ghi file
# --------------------------------------------------------------------------

def list_files(suffix: str, exclude: set[str] = frozenset()) -> list[str]:
    return sorted(p.name for p in HERE.glob(f"*{suffix}") if p.name not in exclude)


NON_INVENTORY_YAML = {"rules.yaml", "card_catalog.yaml"}


def list_inventory_files() -> list[str]:
    """Chi liet ke *.yaml co key top-level "inventory" - loai cac file config/tham khao khac."""
    names = []
    for p in sorted(HERE.glob("*.yaml")):
        if p.name in NON_INVENTORY_YAML:
            continue
        try:
            raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError:
            continue
        if isinstance(raw, dict) and "inventory" in raw:
            names.append(p.name)
    return names


def load_cards_raw() -> list[dict]:
    raw = yaml.safe_load(CATALOG_PATH.read_text(encoding="utf-8")) or {}
    return raw.get("cards") or []


def save_cards_raw(cards: list[dict]) -> None:
    header = (
        "# Bang tra cuu NIC/HBA card -> so port. Sua qua giao dien web (/cards) hoac tay.\n"
        "# match: chuoi con tim trong description/part_number cua dong BOM (khong phan biet hoa/thuong)\n"
        "# ports: so port CHINH XAC (tra tu tai lieu hang cua CARD, khong phai server)\n"
        "# type: nic hoac hba | source: link tai lieu xac nhan\n\n"
    )
    CATALOG_PATH.write_text(header + yaml.safe_dump({"cards": cards}, allow_unicode=True, sort_keys=False), encoding="utf-8")


def load_inventory_raw(path: Path) -> list[dict]:
    if not path.exists():
        return []
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return raw.get("inventory") or []


def save_inventory_raw(path: Path, items: list[dict]) -> None:
    header = "# Inventory - sua qua giao dien web (/inventory) hoac tay. Xem rules.yaml de biet role/model hop le.\n\n"
    path.write_text(header + yaml.safe_dump({"inventory": items}, allow_unicode=True, sort_keys=False), encoding="utf-8")


MODEL_FIELD_ORDER = ("vendor", "model_name", "form_factor", "mgmt_hw", "ocp_slots", "has_onboard_lom", "pcie_slots_max", "source")


def add_server_model_to_rules_text(text: str, model_id: str, data: dict) -> str:
    """Chen 1 model moi vao muc 'server_models:' bang thao tac TEXT (khong parse+dump lai toan bo
    rules.yaml), de khong lam mat cac comment giai thich o phan roles/connections."""
    lines = text.splitlines()
    idx = next((i for i, l in enumerate(lines) if l.strip() == "server_models:" and not l.startswith((" ", "\t"))), None)
    if idx is None:
        raise ValueError("Khong tim thay muc 'server_models:' trong rules.yaml")

    insert_at = len(lines)
    for i in range(idx + 1, len(lines)):
        line = lines[i]
        if line.strip() == "":
            continue
        if not line.startswith((" ", "\t")):
            insert_at = i
            break

    block = [f"  {model_id}:"]
    for key in MODEL_FIELD_ORDER:
        val = data[key]
        if isinstance(val, bool):
            val_str = "true" if val else "false"
        elif isinstance(val, str):
            val_str = json.dumps(val)  # double-quoted YAML scalar hop le, khong dinh "..." nhu yaml.dump
        else:
            val_str = str(val)
        block.append(f"    {key}: {val_str}")

    lines[insert_at:insert_at] = block
    return "\n".join(lines) + ("\n" if text.endswith("\n") else "")


def safe_path_in_here(name: str) -> Path:
    """Chi cho phep truy cap file NAM TRONG thu muc tool (khong cho ../, duong dan tuyet doi)."""
    candidate = (HERE / secure_filename(name)).resolve()
    if HERE.resolve() not in candidate.parents and candidate != HERE.resolve():
        raise ValueError("Ten file khong hop le")
    return candidate


# --------------------------------------------------------------------------
# Dashboard
# --------------------------------------------------------------------------

@app.route("/")
def dashboard():
    try:
        rules = port_sizing.load_rules(RULES_PATH)
        rules_ok = True
        rules_err = ""
    except Exception as exc:  # noqa: BLE001 - hien loi cho nguoi dung, khong crash trang
        rules, rules_ok, rules_err = None, False, str(exc)

    cards = load_cards_raw()
    inventory_files = list_inventory_files()
    bom_files = list_files(".csv")

    body = render(
        """
        {% if not rules_ok %}
          <p class="err">rules.yaml dang loi, khong parse duoc: {{ rules_err }}</p>
        {% else %}
          <p>rules.yaml OK - {{ rules.roles|length }} role, {{ rules.server_models|length }} server model.</p>
        {% endif %}
        <p>card_catalog.yaml: {{ cards|length }} entry.</p>
        <h2>File inventory (*.yaml, tru rules.yaml)</h2>
        <ul>
          {% for f in inventory_files %}
            <li><a href="/inventory?file={{ f }}">{{ f }}</a>
                &middot; <a href="/size?inventory={{ f }}">chay size</a></li>
          {% endfor %}
        </ul>
        <h2>File BOM (*.csv)</h2>
        <ul>
          {% for f in bom_files %}
            <li>{{ f }} &middot; <a href="/scan-bom?bom={{ f }}">chay scan-bom</a></li>
          {% endfor %}
          {% if not bom_files %}<li class="muted">Chua co file .csv nao trong thu muc.</li>{% endif %}
        </ul>
        """,
        rules_ok=rules_ok, rules_err=rules_err, rules=rules, cards=cards,
        inventory_files=inventory_files, bom_files=bom_files,
    )
    return layout("Dashboard", body)


# --------------------------------------------------------------------------
# /rules - sua rules.yaml (raw YAML)
# --------------------------------------------------------------------------

@app.route("/rules", methods=["GET", "POST"])
def edit_rules():
    message = ""
    content = RULES_PATH.read_text(encoding="utf-8")

    if request.method == "POST":
        action = request.form.get("action", "save_raw")

        if action == "save_raw":
            content = request.form["content"]
            tmp = RULES_PATH.with_suffix(".yaml.tmp")
            tmp.write_text(content, encoding="utf-8")
            try:
                port_sizing.load_rules(tmp)
            except Exception as exc:  # noqa: BLE001
                tmp.unlink(missing_ok=True)
                message = f'<p class="err">Chua luu - rules.yaml khong hop le: {exc}</p>'
            else:
                tmp.replace(RULES_PATH)
                message = '<p class="ok-msg">Da luu rules.yaml.</p>'
                content = RULES_PATH.read_text(encoding="utf-8")

        elif action == "add_model":
            model_id = request.form.get("model_id", "").strip()
            try:
                if not re.fullmatch(r"[a-z0-9_]+", model_id):
                    raise ValueError("model id chi gom chu thuong/so/gach duoi, vd dell_r960")
                existing = yaml.safe_load(content) or {}
                if model_id in (existing.get("server_models") or {}):
                    raise ValueError(f'model id "{model_id}" da ton tai')
                data = {
                    "vendor": request.form.get("vendor", "").strip() or "(chua ro)",
                    "model_name": request.form.get("model_name", "").strip() or model_id,
                    "form_factor": request.form.get("form_factor", "").strip() or "(chua ro)",
                    "mgmt_hw": int(request.form.get("mgmt_hw") or 1),
                    "ocp_slots": int(request.form.get("ocp_slots") or 0),
                    "has_onboard_lom": bool(request.form.get("has_onboard_lom")),
                    "pcie_slots_max": int(request.form.get("pcie_slots_max") or 0),
                    "source": request.form.get("source", "").strip() or "(tu khai bao - chua co nguon)",
                }
                new_content = add_server_model_to_rules_text(content, model_id, data)
                tmp = RULES_PATH.with_suffix(".yaml.tmp")
                tmp.write_text(new_content, encoding="utf-8")
                port_sizing.load_rules(tmp)  # validate truoc khi ghi de file thuc
            except Exception as exc:  # noqa: BLE001
                message = f'<p class="err">Chua them - loi: {exc}</p>'
            else:
                tmp.replace(RULES_PATH)
                content = RULES_PATH.read_text(encoding="utf-8")
                message = f'<p class="ok-msg">Da them model "{model_id}" va luu rules.yaml.</p>'

    body = render(
        """
        {{ message|safe }}
        <form method="post">
          <input type="hidden" name="action" value="save_raw">
          <textarea name="content" rows="34">{{ content }}</textarea><br><br>
          <button type="submit">Luu rules.yaml</button>
        </form>

        <h2>Them model server moi (tu khai bao)</h2>
        <p class="muted">Model tu them KHONG duoc kiem tra lai tu tai lieu hang - so lieu do ban tu dien,
          "mgmt_hw"/"data" cua no van dung mac dinh cua role "server" (sua qua field "data_ports" o tab Inventory).</p>
        <form method="post">
          <input type="hidden" name="action" value="add_model">
          <fieldset>
            <label>id (chu thuong/so/gach duoi) <input type="text" name="model_id" placeholder="vd: dell_r960" required></label><br><br>
            <label>vendor <input type="text" name="vendor" placeholder="vd: Dell"></label>
            <label>model_name <input type="text" name="model_name" placeholder="vd: PowerEdge R960"></label>
            <label>form_factor <input type="text" name="form_factor" placeholder="1U/2U/4U..."></label><br><br>
            <label>mgmt_hw <input type="number" name="mgmt_hw" value="1" min="0"></label>
            <label>ocp_slots <input type="number" name="ocp_slots" min="0" value="0"></label>
            <label>pcie_slots_max <input type="number" name="pcie_slots_max" min="0" value="0"></label><br><br>
            <label><input type="checkbox" name="has_onboard_lom"> has_onboard_lom</label><br><br>
            <label>source (optional) <input type="text" name="source" size="60" placeholder="link tai lieu (neu co)"></label><br><br>
            <button type="submit">Them model</button>
          </fieldset>
        </form>
        """,
        message=message, content=content,
    )
    return layout("Rules", body)


# --------------------------------------------------------------------------
# /cards - bang tra cuu NIC/HBA (structured)
# --------------------------------------------------------------------------

@app.route("/cards", methods=["GET", "POST"])
def edit_cards():
    cards = load_cards_raw()
    message = ""

    if request.method == "POST":
        action = request.form.get("action")
        if action == "add":
            cards.append({
                "match": request.form["match"].strip(),
                "ports": int(request.form["ports"]),
                "type": request.form["type"],
                "source": request.form["source"].strip(),
            })
            save_cards_raw(cards)
            message = '<p class="ok-msg">Da them entry.</p>'
        elif action == "delete":
            idx = int(request.form["idx"])
            if 0 <= idx < len(cards):
                cards.pop(idx)
                save_cards_raw(cards)
                message = '<p class="ok-msg">Da xoa entry.</p>'
        return redirect(url_for("edit_cards"))

    body = render(
        """
        {{ message|safe }}
        <table>
          <tr><th>match</th><th>ports</th><th>type</th><th>source</th><th></th></tr>
          {% for c in cards %}
          <tr>
            <td>{{ c.match }}</td><td>{{ c.ports }}</td><td>{{ c.type }}</td>
            <td><a href="{{ c.source }}" target="_blank">{{ c.source }}</a></td>
            <td>
              <form class="row" method="post">
                <input type="hidden" name="action" value="delete">
                <input type="hidden" name="idx" value="{{ loop.index0 }}">
                <button type="submit" onclick="return confirm('Xoa entry {{ c.match }}?')">Xoa</button>
              </form>
            </td>
          </tr>
          {% endfor %}
        </table>

        <h2>Them card moi</h2>
        <form method="post">
          <input type="hidden" name="action" value="add">
          <fieldset>
            <label>match (chuoi con trong description/part_number) <input type="text" name="match" required></label><br><br>
            <label>ports <input type="number" name="ports" min="1" required></label>
            <label>type
              <select name="type"><option value="hba">hba</option><option value="nic">nic</option></select>
            </label><br><br>
            <label>source (link tai lieu chinh hang) <input type="text" name="source" size="60" required></label><br><br>
            <button type="submit">Them</button>
          </fieldset>
        </form>
        """,
        message=message, cards=cards,
    )
    return layout("Card catalog", body)


# --------------------------------------------------------------------------
# /inventory - danh sach thiet bi (structured), chon/tao file
# --------------------------------------------------------------------------

@app.route("/inventory", methods=["GET", "POST"])
def edit_inventory():
    filename = request.values.get("file", "example_inventory.yaml")
    try:
        path = safe_path_in_here(filename)
    except ValueError as exc:
        return layout("Inventory", f'<p class="err">{exc}</p>'), 400

    rules = port_sizing.load_rules(RULES_PATH)
    leaf_roles = [name for name, r in rules.roles.items() if r.kind == "leaf"]
    model_ids = list(rules.server_models)

    items = load_inventory_raw(path)
    message = ""

    if request.method == "POST":
        action = request.form.get("action")
        if action == "add":
            item = {"role": request.form["role"], "qty": int(request.form["qty"])}
            if request.form.get("protocol"):
                item["protocol"] = request.form["protocol"]
            if request.form.get("model"):
                item["model"] = request.form["model"]
            if request.form.get("data_ports"):
                item["data_ports"] = int(request.form["data_ports"])
            items.append(item)
            save_inventory_raw(path, items)
            message = '<p class="ok-msg">Da them dong.</p>'
        elif action == "delete":
            idx = int(request.form["idx"])
            if 0 <= idx < len(items):
                items.pop(idx)
                save_inventory_raw(path, items)
                message = '<p class="ok-msg">Da xoa dong.</p>'
        elif action == "new_file":
            new_name = request.form["new_name"].strip()
            if not new_name.endswith(".yaml"):
                new_name += ".yaml"
            new_path = safe_path_in_here(new_name)
            if not new_path.exists():
                save_inventory_raw(new_path, [])
            return redirect(url_for("edit_inventory", file=new_name))
        return redirect(url_for("edit_inventory", file=filename))

    all_files = list_inventory_files()

    body = render(
        """
        <form method="get" class="row">
          File: <select name="file" onchange="this.form.submit()">
            {% for f in all_files %}
              <option value="{{ f }}" {{ 'selected' if f==filename else '' }}>{{ f }}</option>
            {% endfor %}
          </select>
        </form>
        &nbsp;
        <form method="post" class="row">
          <input type="hidden" name="action" value="new_file">
          <input type="text" name="new_name" placeholder="ten_file_moi" required>
          <button type="submit">Tao file inventory moi</button>
        </form>
        &nbsp;<a href="/size?inventory={{ filename }}">Chay size voi file nay</a>

        {{ message|safe }}

        <table>
          <tr><th>role</th><th>qty</th><th>protocol</th><th>model</th><th>data_ports</th><th></th></tr>
          {% for it in items %}
          <tr>
            <td>{{ it.role }}</td><td>{{ it.qty }}</td>
            <td>{{ it.protocol or '' }}</td><td>{{ it.model or '' }}</td><td>{{ it.data_ports if it.data_ports is not none else '' }}</td>
            <td>
              <form class="row" method="post">
                <input type="hidden" name="action" value="delete">
                <input type="hidden" name="idx" value="{{ loop.index0 }}">
                <button type="submit">Xoa</button>
              </form>
            </td>
          </tr>
          {% endfor %}
        </table>

        <h2>Them dong inventory</h2>
        <form method="post">
          <input type="hidden" name="action" value="add">
          <fieldset>
            <label>role
              <select name="role">{% for r in leaf_roles %}<option value="{{ r }}">{{ r }}</option>{% endfor %}</select>
            </label>
            <label>qty <input type="number" name="qty" min="1" value="1" required></label><br><br>
            <label>protocol (optional) <input type="text" name="protocol" placeholder="fc / iscsi / ..."></label><br><br>
            <label>model (optional)
              <select name="model"><option value="">-- khong chon --</option>
                {% for m in model_ids %}<option value="{{ m }}">{{ m }}</option>{% endfor %}
              </select>
            </label><br><br>
            <label>data_ports (optional) <input type="number" name="data_ports" min="1"></label><br><br>
            <button type="submit">Them</button>
          </fieldset>
        </form>
        <p class="muted">role/protocol/model phai khop voi rules.yaml (sua o trang <a href="/rules">Rules</a>).</p>
        """,
        filename=filename, all_files=all_files, items=items, leaf_roles=leaf_roles,
        model_ids=model_ids, message=message,
    )
    return layout(f"Inventory - {filename}", body)


# --------------------------------------------------------------------------
# /size - chay port_sizing.compute() va hien ket qua
# --------------------------------------------------------------------------

@app.route("/size")
def run_size():
    inventory_files = list_inventory_files()
    inv_name = request.args.get("inventory", inventory_files[0] if inventory_files else "")
    spare_raw = request.args.get("spare_percent", "").strip()

    result_html = ""
    if inv_name:
        try:
            path = safe_path_in_here(inv_name)
            rules = port_sizing.load_rules(RULES_PATH)
            inventory = port_sizing.load_inventory(path)
            if spare_raw:
                port_sizing.apply_spare_override(rules, float(spare_raw))
            results = port_sizing.compute(rules, inventory)
            models = port_sizing.used_server_models(rules, inventory)
        except Exception as exc:  # noqa: BLE001
            result_html = f'<p class="err">Loi: {exc}</p>'
        else:
            result_html = render(
                """
                {% for role, res in results.items() %}
                  {% if res is mapping %}
                    <h2>{{ role }} (leaf)</h2>
                    <table><tr>{% for k in res %}<th>{{ k }}</th>{% endfor %}</tr>
                    <tr>{% for v in res.values() %}<td>{{ v }}</td>{% endfor %}</tr></table>
                  {% else %}
                    <h2>{{ role }} (pair)</h2>
                    <table>
                      <tr><th>Thiet bi vat ly</th><th>Port/thiet bi</th><th>Downlink+spare</th><th>Own ports</th></tr>
                      <tr><td>{{ res.physical_units }}</td><td>{{ res.total_ports_per_unit }}</td>
                          <td>{{ res.downlink_ports_per_unit }}</td><td>{{ res.own_ports_per_unit }}</td></tr>
                    </table>
                    {% for w in res.warnings %}<p class="warn">!! {{ w }}</p>{% endfor %}
                  {% endif %}
                {% endfor %}
                {% if models %}
                  <h2>Server model dung (nguon tra cuu)</h2>
                  <ul>{% for m in models %}
                    <li>{{ m.vendor }} {{ m.model_name }} ({{ m.form_factor }}) -
                        <a href="{{ m.source }}" target="_blank">nguon</a></li>
                  {% endfor %}</ul>
                {% endif %}
                """,
                results=results, models=models,
            )

    body = render(
        """
        <form method="get">
          Inventory: <select name="inventory">
            {% for f in inventory_files %}<option value="{{ f }}" {{ 'selected' if f==inv_name else '' }}>{{ f }}</option>{% endfor %}
          </select>
          Spare % override: <input type="number" name="spare_percent" value="{{ spare_raw }}" placeholder="(dung rules.yaml)">
          <button type="submit">Chay</button>
        </form>
        <hr>
        {{ result_html|safe }}
        """,
        inventory_files=inventory_files, inv_name=inv_name, spare_raw=spare_raw, result_html=result_html,
    )
    return layout("Chay: size", body)


# --------------------------------------------------------------------------
# /scan-bom - chay bom_import.scan_bom() va hien ket qua
# --------------------------------------------------------------------------

@app.route("/scan-bom", methods=["GET", "POST"])
def run_scan_bom():
    bom_files = list_files(".csv")
    result_html = ""
    pasted = ""

    if request.method == "POST":
        upload = request.files.get("upload_file")
        if upload and upload.filename:
            dest = safe_path_in_here(upload.filename)
            upload.save(dest)
            return redirect(url_for("run_scan_bom", bom=dest.name))
        pasted = request.form.get("pasted", "")
        if pasted.strip():
            rows = list(csv.DictReader(io.StringIO(pasted)))
            catalog = bom_import.load_catalog(CATALOG_PATH)
            lines = [
                bom_import.BomLine(row=row, resolved=bom_import.resolve_ports(catalog, row.get("description") or row.get("part_number") or ""))
                for row in rows
            ]
            result_html = _render_bom_lines(lines)

    bom_name = request.args.get("bom", "")
    if bom_name and request.method == "GET":
        try:
            path = safe_path_in_here(bom_name)
            catalog = bom_import.load_catalog(CATALOG_PATH)
            lines = bom_import.scan_bom(catalog, path)
        except Exception as exc:  # noqa: BLE001
            result_html = f'<p class="err">Loi: {exc}</p>'
        else:
            result_html = _render_bom_lines(lines)

    body = render(
        """
        <form method="get">
          File .csv co san: <select name="bom">
            <option value="">--</option>
            {% for f in bom_files %}<option value="{{ f }}" {{ 'selected' if f==bom_name else '' }}>{{ f }}</option>{% endfor %}
          </select>
          <button type="submit">Chay</button>
        </form>

        <h2>Hoac upload file .csv</h2>
        <form method="post" enctype="multipart/form-data">
          <input type="file" name="upload_file" accept=".csv">
          <button type="submit">Upload va chay</button>
        </form>

        <h2>Hoac paste noi dung CSV (cot description/part_number, qty)</h2>
        <form method="post">
          <textarea name="pasted" rows="6" placeholder="description,qty&#10;Emulex LPe36002 Dual Port 32Gb FC HBA,8">{{ pasted }}</textarea><br><br>
          <button type="submit">Chay</button>
        </form>
        <hr>
        {{ result_html|safe }}
        """,
        bom_files=bom_files, bom_name=bom_name, pasted=pasted, result_html=result_html,
    )
    return layout("Chay: scan-bom", body)


def _render_bom_lines(lines: list[bom_import.BomLine]) -> str:
    return render(
        """
        <table>
          <tr><th>Trang thai</th><th>Description/part_number</th><th>Qty</th><th>Port</th><th>Type</th><th>Nguon</th></tr>
          {% for l in lines %}
          <tr>
            {% if l.resolved %}
              <td class="badge-ok">OK</td>
              <td>{{ l.row.get('description') or l.row.get('part_number') }}</td>
              <td>{{ l.row.get('qty', '?') }}</td>
              <td>{{ l.resolved.ports }}</td>
              <td>{{ l.resolved.type }}</td>
              <td><a href="{{ l.resolved.source }}" target="_blank">nguon</a></td>
            {% else %}
              <td class="badge-unresolved">???</td>
              <td>{{ l.row.get('description') or l.row.get('part_number') }}</td>
              <td>{{ l.row.get('qty', '?') }}</td>
              <td colspan="3" class="muted">Chua xac dinh - bo sung vao /cards</td>
            {% endif %}
          </tr>
          {% endfor %}
        </table>
        """,
        lines=lines,
    )


if __name__ == "__main__":
    app.run(debug=True, port=5000)
