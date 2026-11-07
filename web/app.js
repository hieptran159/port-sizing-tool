"use strict";
/* Port-sizing tool - ban JS thuan, chay client-side, khong can server.
 * Logic tinh toan la ban dich 1-1 tu port_sizing.py / bom_import.py (Python) - xem file .py
 * de doi chieu neu can. Sua tham so o file .yaml (rules.yaml/card_catalog.yaml), khong sua o day. */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let parsedRules = null; // ket qua applyRules() gan nhat, dung cho size/inventory dropdown
let cards = [];
let inventory = [];

// Role nao co "danh muc model" (validate + trich dan), va truong custom-port tuong ung cua role do.
// Them role moi vao day neu sau nay can "model" cho role khac.
const MODEL_CATALOG_KEY = { server: "server_models", san_storage: "san_storage_models" };
const CUSTOM_PORT_FIELD = {
  server: { field: "data_ports", portKey: "data", uiId: "inv-data-ports" },
  san_storage: { field: "controller_ports", portKey: "controller_port", uiId: "inv-controller-ports" },
};

// Nhan hien thi tieng Viet (chi de hien thi - key trong rules.yaml giu nguyen)
const ROLE_LABELS = {
  server: "Máy chủ", san_storage: "SAN Storage", network_switch: "Switch LAN",
  mgmt_switch: "Switch quản lý (OOB)", san_switch: "SAN Switch",
};
const PORT_LABELS = {
  mgmt_hw: "Quản lý phần cứng (iDRAC/iLO)", mgmt_os: "Quản lý OS", data: "Data (LAN)",
  fc_hba: "FC HBA", iscsi_data: "iSCSI", controller_port: "Port controller",
  uplink: "Uplink", peer_link: "Peer-link", downlink: "Downlink",
};
const roleLabel = (r) => ROLE_LABELS[r] || r;
const portLabel = (p) => PORT_LABELS[p] || p;
const modelLabel = (m, id) => (m && m.model_name ? `${m.vendor ? m.vendor + " " : ""}${m.model_name}` : id);

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

document.querySelectorAll("nav button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll("section").forEach((s) => s.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  });
});

// ---------------------------------------------------------------------------
// Engine - dich tu port_sizing.py
// ---------------------------------------------------------------------------

function ceilDiv(a, b) {
  return Math.ceil(a / b);
}

/** Parse + validate raw rules YAML text -> {roles, connections, server_models}. Nem Error neu sai. */
function parseRules(text) {
  const raw = jsyaml.load(text) || {};
  if (!raw.roles) throw new Error("rules.yaml thiếu mục 'roles:'");
  const roles = {};
  for (const [name, r] of Object.entries(raw.roles)) {
    if (r.kind !== "leaf" && r.kind !== "pair") {
      throw new Error(`role ${name}: kind phải là 'leaf' hoặc 'pair', không phải ${r.kind}`);
    }
    roles[name] = {
      name,
      kind: r.kind,
      ports: r.ports || {},
      protocol_variants: r.protocol_variants || {},
      own_ports: r.own_ports || {},
      spare_percent: r.spare_percent || 0,
      max_ports_per_unit: r.max_ports_per_unit || null,
      media: r.media || null, // loai day/connector THAM KHAO cho role pair - xem ghi chu trong rules.yaml
    };
  }
  const connections = raw.connections || [];
  for (const c of connections) {
    if (!(c.from_role in roles)) throw new Error(`connection tham chiếu role không tồn tại: ${c.from_role}`);
    if (!(c.to_role in roles)) throw new Error(`connection tham chiếu role không tồn tại: ${c.to_role}`);
  }
  const server_models = raw.server_models || {};
  const san_storage_models = raw.san_storage_models || {};
  const san_switch_models = raw.san_switch_models || {};
  return { roles, connections, server_models, san_storage_models, san_switch_models };
}

function leafPortTotals(rules, inv) {
  const totals = {};
  for (const item of inv) {
    const spec = rules.roles[item.role];
    if (!spec) throw new Error(`Danh sách thiết bị dùng role không có trong cấu hình: ${item.role}`);
    if (spec.kind !== "leaf") throw new Error(`${roleLabel(item.role)} được tính tự động, không khai báo trong danh sách thiết bị`);

    const catalogKey = MODEL_CATALOG_KEY[item.role];
    if (item.model) {
      if (!catalogKey) throw new Error(`${roleLabel(item.role)} chưa có danh mục model — để trống ô Model`);
      const catalog = rules[catalogKey] || {};
      if (!(item.model in catalog)) {
        const valid = Object.keys(catalog).sort().join(", ") || `(chưa có model nào trong ${catalogKey})`;
        throw new Error(`Model ${item.model} không có trong ${catalogKey}. Các model hợp lệ: ${valid}`);
      }
    }

    const ports = { ...spec.ports };
    const customField = CUSTOM_PORT_FIELD[item.role];
    if (customField && item[customField.field] != null && item[customField.field] !== "") {
      ports[customField.portKey] = Number(item[customField.field]);
    }
    if (item.protocol) {
      const variant = spec.protocol_variants[item.protocol];
      if (!variant) throw new Error(`${roleLabel(item.role)} không hỗ trợ kiểu kết nối ${item.protocol}`);
      Object.assign(ports, variant);
    }

    const roleTotals = (totals[item.role] = totals[item.role] || {});
    for (const [portType, count] of Object.entries(ports)) {
      roleTotals[portType] = (roleTotals[portType] || 0) + count * item.qty;
    }
  }
  return totals;
}

/** Danh sach {role, id, entry} cho moi model duoc dung trong inventory (server + san_storage), de
 * hien thi nguon tra cuu / audit trail. */
function usedModels(rules, inv) {
  const seen = {};
  for (const item of inv) {
    if (!item.model) continue;
    const catalogKey = MODEL_CATALOG_KEY[item.role];
    if (!catalogKey) continue;
    const entry = (rules[catalogKey] || {})[item.model];
    if (entry) seen[`${item.role}:${item.model}`] = entry;
  }
  return Object.values(seen);
}

function protocolPresent(inv, protocol) {
  return inv.some((i) => i.protocol === protocol);
}

/** results[role] = {kind:"leaf", ports:{...}} hoac {kind:"pair", downlink_ports_per_unit, own_ports_per_unit,
 * total_ports_per_unit, physical_units, warnings}. */
function computeSizing(rules, inv) {
  const leafTotals = leafPortTotals(rules, inv);

  const upstreamTotals = {};
  for (const conn of rules.connections) {
    if (conn.requires_protocol && !protocolPresent(inv, conn.requires_protocol)) continue;
    const amount = (leafTotals[conn.from_role] || {})[conn.from_port] || 0;
    if (!amount) continue;
    const bucket = (upstreamTotals[conn.to_role] = upstreamTotals[conn.to_role] || {});
    bucket[conn.to_port] = (bucket[conn.to_port] || 0) + amount;
  }

  const results = {};
  for (const [roleName, spec] of Object.entries(rules.roles)) {
    if (spec.kind === "leaf") {
      if (leafTotals[roleName]) results[roleName] = { kind: "leaf", ports: leafTotals[roleName] };
      continue;
    }
    const downlinks = upstreamTotals[roleName] || {};
    const warnings = [];
    let perUnitDownlink = 0;
    for (const [portType, amount] of Object.entries(downlinks)) {
      if (amount % 2 !== 0) {
        warnings.push(
          `${roleLabel(roleName)} — ${portLabel(portType)}: tổng ${amount} port (số lẻ) không chia đều cho cặp dự phòng, ` +
            `một bên sẽ dư 1 port. Nên kiểm tra lại thiết kế.`
        );
      }
      perUnitDownlink += ceilDiv(amount, 2);
    }
    perUnitDownlink = Math.ceil(perUnitDownlink * (1 + spec.spare_percent / 100));
    const ownTotal = Object.values(spec.own_ports).reduce((a, b) => a + b, 0);
    const totalPerUnit = perUnitDownlink + ownTotal;
    let physicalUnits = 2;
    if (spec.max_ports_per_unit) physicalUnits = 2 * ceilDiv(totalPerUnit, spec.max_ports_per_unit);

    results[roleName] = {
      kind: "pair",
      downlink_ports_per_unit: perUnitDownlink,
      own_ports_per_unit: ownTotal,
      total_ports_per_unit: totalPerUnit,
      physical_units: physicalUnits,
      warnings,
    };
  }
  return results;
}

// ---------------------------------------------------------------------------
// BOM scan - dich tu bom_import.py
// ---------------------------------------------------------------------------

function resolveCardPorts(catalog, text) {
  const lower = text.toLowerCase();
  const matches = catalog.filter((c) => lower.includes(c.match.toLowerCase()));
  return matches.length === 1 ? matches[0] : null;
}

/** Parser CSV toi gian, ho tro truong co dau ngoac kep va dau phay ben trong. Tra ve 2D array
 * (raw text tung cell) - CHUA gia dinh dong 0 la header, de parseTabularRows2D() tu tim header
 * thuc su (BOM quote/export thuc te thuong co vai dong metadata truoc header, xem BOM1.xlsx). */
function parseCsvRaw2D(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let line = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      row.__rowNum__ = line++; // so dong that trong file (0-based), giong SheetJS - dung de trich dan "dong N"
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); row.__rowNum__ = line; rows.push(row); }
  return rows;
}

/** Tim dong header thuc su trong 20 dong dau: dong co 1 cell khop "product #"/"part number" VA
 * 1 cell khop "qty"/"quantity". Cac BOM export that (Cisco/HPE CTO quote) thuong co vai dong
 * metadata (ngay export, ma co hoi...) truoc khi toi header, khong the gia dinh dong 0 la header. */
function findHeaderRowIndex(rows2D) {
  for (let i = 0; i < Math.min(rows2D.length, 20); i++) {
    const cells = (rows2D[i] || []).map((c) => String(c ?? "").trim().toLowerCase());
    const hasProduct = cells.some((c) => c === "product #" || c === "product#" || c.includes("part number") || c.includes("part no"));
    const hasQty = cells.some((c) => c === "qty" || c === "quantity");
    if (hasProduct && hasQty) return i;
  }
  return -1;
}

function colIndexByHeader(headerRow, candidates) {
  const norm = headerRow.map((c) => String(c ?? "").trim().toLowerCase());
  for (const cand of candidates) {
    const idx = norm.findIndex((c) => c === cand || c.includes(cand));
    if (idx !== -1) return idx;
  }
  return -1;
}

/** Dien giai 1 bang 2D thanh danh sach dong "component" muc {part_number, description, qty, group}.
 *
 * Neu tim thay header voi cot "Start Date" (kieu BOM export Cisco/HPE CTO - xem BOM1.xlsx): moi
 * dong SAU header duoc phan loai theo cot Start Date co du lieu hay khong -
 *   - RONG  -> day la dong "group/bundle" (1 he thong, VD "He thong may chu ung dung" x4 bo) -
 *              KHONG phai 1 component vat ly, chi ghi nhan so luong bundle (group qty) de nhan
 *              vao cac component thuoc bundle do, cho toi khi gap group row tiep theo.
 *   - CO GIA TRI -> day la 1 component that (part number/description/qty rieng), qty thuc te =
 *              qty cua dong nay NHAN VOI qty cua group dang mo (vi group lap lai N bo giong nhau).
 *
 * Neu KHONG co cot Start Date (BOM don gian, phang, khong phan cap) thi coi moi dong la 1 item
 * doc lap (qty giu nguyen, khong nhan).
 *
 * Neu khong tim thay header dang nay o 20 dong dau, fallback ve kieu don gian nhat: dong 0 la
 * header voi cot "description"/"part_number"/"qty" (dung cho file .csv tu tay dien nhu truoc gio). */
function parseTabularRows2D(rows2D) {
  const headerIdx = findHeaderRowIndex(rows2D);

  if (headerIdx === -1) {
    const header = (rows2D[0] || []).map((h) => String(h ?? "").trim().toLowerCase());
    return rows2D.slice(1)
      .map((r, i) => [r, (r && r.__rowNum__ != null ? r.__rowNum__ : i + 1) + 1])
      .filter(([r]) => (r || []).some((c) => String(c ?? "").trim() !== ""))
      .map(([r, rowNo]) => {
        const obj = Object.fromEntries(header.map((h, i) => [h, String(r[i] ?? "").trim()]));
        obj.qty = Number(obj.qty) || 1;
        obj.unit_qty = obj.qty; obj.group_qty = 1; obj.row_no = rowNo;
        obj.group = null;
        return obj;
      });
  }

  const header = rows2D[headerIdx];
  const productCol = colIndexByHeader(header, ["product #", "product#", "part number", "part no"]);
  const descCol = colIndexByHeader(header, ["product description", "description"]);
  const qtyCol = colIndexByHeader(header, ["qty", "quantity"]);
  const startDateCol = colIndexByHeader(header, ["start date"]);

  const results = [];
  let groupLabel = null;
  let groupQty = 1;

  for (let i = headerIdx + 1; i < rows2D.length; i++) {
    const row = rows2D[i] || [];
    if (!row.some((c) => String(c ?? "").trim() !== "")) continue; // dong trong, bo qua

    const partVal = productCol !== -1 ? String(row[productCol] ?? "").trim() : "";
    const rowQty = qtyCol !== -1 ? Number(row[qtyCol]) || 0 : 0;
    const hasStartDate = startDateCol !== -1 && String(row[startDateCol] ?? "").trim() !== "";

    if (startDateCol !== -1 && !hasStartDate) {
      groupLabel = partVal || null; // group row: ten bundle nam o cot "Product #"
      groupQty = rowQty || 1;
      continue;
    }

    const multiplier = startDateCol !== -1 ? groupQty : 1;
    results.push({
      part_number: partVal,
      description: descCol !== -1 ? String(row[descCol] ?? "").trim() : "",
      qty: (rowQty || 1) * multiplier,
      unit_qty: rowQty || 1,
      group_qty: multiplier,
      row_no: (row.__rowNum__ != null ? row.__rowNum__ : i) + 1, // so dong trong file Excel/CSV (1-based)
      group: startDateCol !== -1 ? groupLabel : null,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Phan loai type cho tung dong BOM - dong nao khop card_catalog (nic/hba) thi dung type cua
// catalog; dong con lai duoc phan loai bang tu khoa trong chinh mo ta part (mo ta cua HPE/Cisco...
// da chuan hoa/tu giai thich - vd "...Processor for HPE", "...Memory Kit", "...Fan Kit" - khong
// can tra cuu ngoai, doc thang tu ten part). Thu tu quan trong: cac mau CU THE (license/support/
// battery/fan/...) duoc kiem TRUOC cac mau CHUNG (storage/server) de tranh nhan nham (vd 1 dong
// "...Storage Controller Enablement CABLE KIT" phai la "cable", khong phai "storage_controller").
// ---------------------------------------------------------------------------

const TYPE_KEYWORD_RULES = [
  { type: "license", patterns: [/\bltu\b/i, /\blicense\b/i] },
  { type: "support", patterns: [/tech care/i, /\bsupport\b/i, /\bsupp\b/i] },
  { type: "service", patterns: [/\bsvc\b/i, /\bstartup\b/i, /learning credits/i] },
  { type: "battery", patterns: [/\bbattery\b/i] },
  { type: "fan", patterns: [/fan kit/i] },
  { type: "heatsink", patterns: [/heat sink/i] },
  { type: "rail", patterns: [/rail kit/i] },
  { type: "chassis_component", patterns: [/backplane/i, /drive cage/i, /riser kit/i, /dimm blank/i] },
  { type: "cable", patterns: [/\bcable\b/i] },
  { type: "power_cord", patterns: [/power cord/i] },
  { type: "memory", patterns: [/memory kit/i] },
  { type: "hba", patterns: [/\bhba\b/i] },
  { type: "nic", patterns: [/ethernet.*adapter/i, /sfp.*adapter/i] },
  { type: "transceiver", patterns: [/transceiver/i] },
  { type: "cpu", patterns: [/\bprocessor\b/i, /\bxeon\b/i] },
  { type: "storage_drive", patterns: [/\bssd\b/i, /\bhdd\b/i] },
  { type: "gpu", patterns: [/\bgpu\b/i, /\baccelerator\b/i] },
  { type: "psu", patterns: [/power supply/i] },
  { type: "storage_controller", patterns: [/storage controller/i, /raid controller/i] },
  { type: "switch", patterns: [/fibre channel switch/i, /\bswitch\b/i] },
  { type: "backup_device", patterns: [/storeonce/i] },
  { type: "storage_array", patterns: [/\bstorage\b/i] },
  { type: "server_chassis", patterns: [/configure-to-order server/i, /\bserver\b/i] },
  { type: "config", patterns: [/fio.*kit/i, /configuration tracking/i, /enablement kit/i, /localization/i] },
];

const TYPE_LABELS = {
  nic: "NIC (mạng)", hba: "HBA (FC)", cpu: "CPU", memory: "RAM",
  storage_drive: "Ổ cứng/SSD", storage_controller: "Bộ điều khiển RAID", gpu: "GPU",
  psu: "Nguồn (PSU)", power_cord: "Dây nguồn", fan: "Quạt", heatsink: "Tản nhiệt",
  rail: "Rail/khung gắn", battery: "Pin", transceiver: "Module quang",
  cable: "Cáp kết nối", chassis_component: "Linh kiện khung máy",
  switch: "Switch", storage_array: "Thiết bị lưu trữ",
  backup_device: "Thiết bị backup", server_chassis: "Khung máy chủ",
  license: "License/LTU", support: "Hỗ trợ/bảo hành", service: "Dịch vụ (triển khai/đào tạo)",
  config: "Mã cấu hình", unknown: "Chưa xác định",
};

function classifyComponentType(text) {
  for (const rule of TYPE_KEYWORD_RULES) {
    if (rule.patterns.some((p) => p.test(text))) return rule.type;
  }
  return "unknown";
}

function scanBomRows(catalog, rows) {
  return rows.map((row) => {
    const text = `${row.description || ""} ${row.part_number || ""}`.trim();
    const resolved = resolveCardPorts(catalog, text);
    return { row, resolved, type: resolved ? resolved.type : classifyComponentType(text) };
  });
}

// ---------------------------------------------------------------------------
// YAML dump nho (khong can jsyaml.dump vi muon giu thu tu/format on dinh)
// ---------------------------------------------------------------------------

function yamlEscape(s) {
  s = String(s);
  return /[:#\-\[\]{}",]|^\s|\s$/.test(s) || s === "" ? JSON.stringify(s) : s;
}

const MODEL_FIELD_ORDER = {
  server_models: ["vendor", "model_name", "form_factor", "mgmt_hw", "ocp_slots", "has_onboard_lom", "pcie_slots_max", "source"],
  san_storage_models: ["vendor", "model_name", "form_factor", "mgmt_hw", "controllers", "source"],
  san_switch_models: ["vendor", "model_name", "form_factor", "mgmt_hw", "total_ports", "source"],
};

/** Chen 1 model moi vao muc "<sectionName>:" (server_models hoac san_storage_models) bang thao tac
 * TEXT (khong parse+dump lai ca rules text), giong add_server_model_to_rules_text() trong webapp.py
 * - de khong mat comment o cho khac. */
function addModelToRulesText(text, sectionName, modelId, data) {
  const fieldOrder = MODEL_FIELD_ORDER[sectionName];
  if (!fieldOrder) throw new Error(`Không biết thứ tự trường cho mục "${sectionName}"`);

  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l.trim() === `${sectionName}:` && !/^[ \t]/.test(l));
  if (idx === -1) throw new Error(`Không tìm thấy mục '${sectionName}:' trong rules.yaml`);

  let insertAt = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (!/^[ \t]/.test(line)) { insertAt = i; break; }
  }

  const block = [`  ${modelId}:`];
  for (const key of fieldOrder) {
    const val = data[key];
    let valStr;
    if (typeof val === "boolean") valStr = val ? "true" : "false";
    else if (typeof val === "string") valStr = JSON.stringify(val);
    else valStr = String(val);
    block.push(`    ${key}: ${valStr}`);
  }
  lines.splice(insertAt, 0, ...block);
  return lines.join("\n");
}

function cardsToYaml() {
  let out = "cards:\n";
  for (const c of cards) {
    out += `- match: ${yamlEscape(c.match)}\n  ports: ${c.ports}\n  type: ${c.type}\n  source: ${yamlEscape(c.source)}\n`;
  }
  return out;
}

function inventoryToYaml() {
  let out = "inventory:\n";
  for (const it of inventory) {
    out += `  - role: ${yamlEscape(it.role)}\n    qty: ${it.qty}\n`;
    if (it.protocol) out += `    protocol: ${yamlEscape(it.protocol)}\n`;
    if (it.model) out += `    model: ${yamlEscape(it.model)}\n`;
    if (it.data_ports != null && it.data_ports !== "") out += `    data_ports: ${it.data_ports}\n`;
  }
  return out;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/yaml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function loadFileInto(textareaId) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".yaml,.yml";
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    file.text().then((text) => { document.getElementById(textareaId).value = text; });
  };
  input.click();
}

// ---------------------------------------------------------------------------
// Rules tab
// ---------------------------------------------------------------------------

function applyRules() {
  const text = document.getElementById("rules-text").value;
  const msg = document.getElementById("rules-msg");
  try {
    parsedRules = parseRules(text);
    msg.innerHTML = '<p class="ok-msg">Đã áp dụng cấu hình: ' + Object.keys(parsedRules.roles).length +
      " loại thiết bị, " + Object.keys(parsedRules.server_models).length + " model máy chủ, " +
      Object.keys(parsedRules.san_storage_models).length + " model SAN storage, " +
      Object.keys(parsedRules.san_switch_models).length + " model SAN switch.</p>";
  } catch (e) {
    parsedRules = null;
    msg.innerHTML = `<p class="err">Lỗi: ${e.message}</p>`;
  }
  refreshDashboard();
  refreshGenerateDropdowns();
  refreshInventoryDropdowns();
  renderInventoryLiveSize();
}

function addServerModel() {
  const msg = document.getElementById("model-msg");
  const modelId = document.getElementById("model-id").value.trim();

  if (!/^[a-z0-9_]+$/.test(modelId)) {
    msg.innerHTML = '<p class="err">Mã model chỉ gồm chữ thường, số, gạch dưới — VD: dell_r960.</p>';
    return;
  }
  if (parsedRules && modelId in parsedRules.server_models) {
    msg.innerHTML = `<p class="err">Mã model "${modelId}" đã tồn tại.</p>`;
    return;
  }

  const data = {
    vendor: document.getElementById("model-vendor").value.trim() || "(chưa rõ)",
    model_name: document.getElementById("model-name").value.trim() || modelId,
    form_factor: document.getElementById("model-form-factor").value.trim() || "(chưa rõ)",
    mgmt_hw: Number(document.getElementById("model-mgmt-hw").value || 1),
    ocp_slots: Number(document.getElementById("model-ocp-slots").value || 0),
    has_onboard_lom: document.getElementById("model-has-lom").checked,
    pcie_slots_max: Number(document.getElementById("model-pcie-slots").value || 0),
    source: document.getElementById("model-source").value.trim() || "(tự khai báo — chưa có nguồn)",
  };

  const textarea = document.getElementById("rules-text");
  try {
    textarea.value = addModelToRulesText(textarea.value, "server_models", modelId, data);
    applyRules();
    msg.innerHTML = `<p class="ok-msg">Đã thêm model "${modelId}". Nhớ bấm "Tải xuống rules.yaml" để lưu ra file.</p>`;
    document.getElementById("model-id").value = "";
  } catch (e) {
    msg.innerHTML = `<p class="err">Lỗi: ${e.message}</p>`;
  }
}

function addSanStorageModel() {
  const msg = document.getElementById("san-model-msg");
  const modelId = document.getElementById("san-model-id").value.trim();

  if (!/^[a-z0-9_]+$/.test(modelId)) {
    msg.innerHTML = '<p class="err">Mã model chỉ gồm chữ thường, số, gạch dưới — VD: dell_powerstore500.</p>';
    return;
  }
  if (parsedRules && modelId in parsedRules.san_storage_models) {
    msg.innerHTML = `<p class="err">Mã model "${modelId}" đã tồn tại.</p>`;
    return;
  }

  const data = {
    vendor: document.getElementById("san-model-vendor").value.trim() || "(chưa rõ)",
    model_name: document.getElementById("san-model-name").value.trim() || modelId,
    form_factor: document.getElementById("san-model-form-factor").value.trim() || "(chưa rõ)",
    mgmt_hw: Number(document.getElementById("san-model-mgmt-hw").value || 1),
    controllers: Number(document.getElementById("san-model-controllers").value || 2),
    source: document.getElementById("san-model-source").value.trim() || "(tự khai báo — chưa có nguồn)",
  };

  const textarea = document.getElementById("rules-text");
  try {
    textarea.value = addModelToRulesText(textarea.value, "san_storage_models", modelId, data);
    applyRules();
    msg.innerHTML = `<p class="ok-msg">Đã thêm model "${modelId}". Nhớ bấm "Tải xuống rules.yaml" để lưu ra file.</p>`;
    document.getElementById("san-model-id").value = "";
  } catch (e) {
    msg.innerHTML = `<p class="err">Lỗi: ${e.message}</p>`;
  }
}

function addSanSwitchModel() {
  const msg = document.getElementById("sansw-model-msg");
  const modelId = document.getElementById("sansw-model-id").value.trim();

  if (!/^[a-z0-9_]+$/.test(modelId)) {
    msg.innerHTML = '<p class="err">Mã model chỉ gồm chữ thường, số, gạch dưới — VD: cisco_mds9124v.</p>';
    return;
  }
  if (parsedRules && modelId in parsedRules.san_switch_models) {
    msg.innerHTML = `<p class="err">Mã model "${modelId}" đã tồn tại.</p>`;
    return;
  }

  const data = {
    vendor: document.getElementById("sansw-model-vendor").value.trim() || "(chưa rõ)",
    model_name: document.getElementById("sansw-model-name").value.trim() || modelId,
    form_factor: document.getElementById("sansw-model-form-factor").value.trim() || "(chưa rõ)",
    mgmt_hw: Number(document.getElementById("sansw-model-mgmt-hw").value || 1),
    total_ports: Number(document.getElementById("sansw-model-total-ports").value || 24),
    source: document.getElementById("sansw-model-source").value.trim() || "(tự khai báo — chưa có nguồn)",
  };

  const textarea = document.getElementById("rules-text");
  try {
    textarea.value = addModelToRulesText(textarea.value, "san_switch_models", modelId, data);
    applyRules();
    msg.innerHTML = `<p class="ok-msg">Đã thêm model "${modelId}". Nhớ bấm "Tải xuống rules.yaml" để lưu ra file.</p>`;
    document.getElementById("sansw-model-id").value = "";
  } catch (e) {
    msg.innerHTML = `<p class="err">Lỗi: ${e.message}</p>`;
  }
}

/** Nhap file .json (dang {id: {vendor, model_name, ...}}) - CHI THEM model chua co, khong ghi de
 * model da ton tai (tranh mat du lieu da xac minh). Key bat dau bang "_" bi bo qua (cho phep dat
 * "_comment" trong file JSON de ghi chu, vi JSON khong ho tro comment). */
function importModelsJson(sectionName) {
  const msg = document.getElementById("model-db-msg");
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    file.text().then((text) => {
      let obj;
      try {
        obj = JSON.parse(text);
      } catch (e) {
        msg.innerHTML = `<p class="err">File JSON không hợp lệ: ${e.message}</p>`;
        return;
      }
      const existing = (parsedRules && parsedRules[sectionName]) || {};
      const fieldOrder = MODEL_FIELD_ORDER[sectionName];
      const textarea = document.getElementById("rules-text");
      let currentText = textarea.value;
      let added = 0, skipped = 0;
      for (const [id, entry] of Object.entries(obj)) {
        if (id.startsWith("_")) continue;
        if (id in existing) { skipped++; continue; }
        const data = {};
        for (const key of fieldOrder) {
          if (entry[key] !== undefined) data[key] = entry[key];
          else if (key === "has_onboard_lom") data[key] = false;
          else if (key === "mgmt_hw") data[key] = 1;
          else if (key === "source") data[key] = "(từ file nhập — chưa có nguồn)";
          else data[key] = "(chưa rõ)";
        }
        try {
          currentText = addModelToRulesText(currentText, sectionName, id, data);
          added++;
        } catch (e) {
          msg.innerHTML = `<p class="err">Lỗi khi thêm "${id}": ${e.message}</p>`;
          return;
        }
      }
      textarea.value = currentText;
      applyRules();
      msg.innerHTML = `<p class="ok-msg">Đã nhập ${sectionName}: thêm ${added} model mới, bỏ qua ${skipped} model đã có.</p>`;
    });
  };
  input.click();
}

// ---------------------------------------------------------------------------
// Cards tab
// ---------------------------------------------------------------------------

function renderCardsTable() {
  let html = '<table><tr><th>Chuỗi nhận diện</th><th>Số port</th><th>Loại</th><th>Nguồn tài liệu</th><th></th></tr>';
  cards.forEach((c, i) => {
    html += `<tr><td>${c.match}</td><td>${c.ports}</td><td>${TYPE_LABELS[c.type] || c.type}</td>
      <td><a href="${c.source}" target="_blank">${c.source}</a></td>
      <td><button class="danger" onclick="deleteCard(${i})">Xoá</button></td></tr>`;
  });
  html += "</table>";
  document.getElementById("cards-table").innerHTML = html;
}

function addCard() {
  const match = document.getElementById("card-match").value.trim();
  const ports = Number(document.getElementById("card-ports").value);
  const type = document.getElementById("card-type").value;
  const source = document.getElementById("card-source").value.trim();
  if (!match || !ports || !source) { alert("Vui lòng nhập đủ chuỗi nhận diện, số port và nguồn tài liệu."); return; }
  cards.push({ match, ports, type, source });
  document.getElementById("card-match").value = "";
  document.getElementById("card-source").value = "";
  renderCardsTable();
}

function deleteCard(i) {
  cards.splice(i, 1);
  renderCardsTable();
}

function loadCardsFromFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".yaml,.yml";
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    file.text().then((text) => {
      const raw = jsyaml.load(text) || {};
      cards = raw.cards || [];
      renderCardsTable();
    });
  };
  input.click();
}

// ---------------------------------------------------------------------------
// Inventory tab
// ---------------------------------------------------------------------------

function renderInventoryTable() {
  if (!inventory.length) { document.getElementById("inventory-table").innerHTML = '<p class="muted">Chưa có thiết bị nào.</p>'; renderInventoryLiveSize(); return; }
  let html = '<table><tr><th>Loại thiết bị</th><th>Số lượng</th><th>Kết nối</th><th>Model</th><th>Port data</th><th>Port controller</th><th></th></tr>';
  inventory.forEach((it, i) => {
    html += `<tr><td>${roleLabel(it.role)}</td><td>${it.qty}</td><td>${(it.protocol || "").toUpperCase()}</td>
      <td>${it.model || ""}</td><td>${it.data_ports ?? ""}</td><td>${it.controller_ports ?? ""}</td>
      <td><button class="danger" onclick="deleteInventoryItem(${i})">Xoá</button></td></tr>`;
  });
  html += "</table>";
  document.getElementById("inventory-table").innerHTML = html;
  renderInventoryLiveSize();
}

function refreshInventoryDropdowns() {
  const roleSel = document.getElementById("inv-role");
  const prevRole = roleSel.value; // giu lua chon hien tai - khong de viec them model (goi applyRules) reset ve role dau tien
  roleSel.innerHTML = "";
  if (!parsedRules) {
    document.getElementById("inv-model").innerHTML = '<option value="">— Không chọn —</option>';
    return;
  }
  for (const [name, r] of Object.entries(parsedRules.roles)) {
    if (r.kind === "leaf") roleSel.innerHTML += `<option value="${name}">${roleLabel(name)}</option>`;
  }
  if ([...roleSel.options].some((o) => o.value === prevRole)) roleSel.value = prevRole;
  updateInvModelDropdown();
}

/** Model dropdown phu thuoc role dang chon (server -> server_models, san_storage -> san_storage_models). */
function updateInvModelDropdown() {
  const role = document.getElementById("inv-role").value;
  const modelSel = document.getElementById("inv-model");
  modelSel.innerHTML = '<option value="">— Không chọn —</option>';
  if (!parsedRules) return;
  const catalogKey = MODEL_CATALOG_KEY[role];
  if (!catalogKey) return;
  for (const name of Object.keys(parsedRules[catalogKey] || {})) {
    modelSel.innerHTML += `<option value="${name}">${modelLabel(parsedRules[catalogKey][name], name)}</option>`;
  }
}

function addInventoryItem() {
  const role = document.getElementById("inv-role").value;
  const qty = Number(document.getElementById("inv-qty").value);
  const protocol = document.getElementById("inv-protocol").value.trim();
  const model = document.getElementById("inv-model").value;
  if (!role || !qty) { alert("Chọn loại thiết bị và nhập số lượng (cấu hình phải hợp lệ — xem mục Cấu hình & model)."); return; }
  const item = { role, qty };
  if (protocol) item.protocol = protocol;
  if (model) item.model = model;

  const customField = CUSTOM_PORT_FIELD[role];
  if (customField) {
    const raw = document.getElementById(customField.uiId).value;
    if (raw) item[customField.field] = Number(raw);
  }

  inventory.push(item);
  document.getElementById("inv-protocol").value = "";
  document.getElementById("inv-data-ports").value = "";
  document.getElementById("inv-controller-ports").value = "";
  renderInventoryTable();
}

/** Ket qua size tinh NGAY tren tab Inventory (khong can qua tab "Run: size" rieng), tu dong cap
 * nhat moi khi them/xoa dong. Day chinh la "trang gen port khi nhap server/san-storage". */
function renderInventoryLiveSize() {
  const out = document.getElementById("inventory-live-size");
  if (!out) return;
  if (!parsedRules) {
    out.innerHTML = '<p class="muted">Cấu hình chưa hợp lệ — vào mục "Cấu hình &amp; model" và bấm "Áp dụng".</p>';
    return;
  }
  if (!inventory.length) {
    out.innerHTML = '<p class="muted">Thêm thiết bị ở trên để xem số port cần dùng.</p>';
    return;
  }
  try {
    const results = computeSizing(parsedRules, inventory);
    const models = usedModels(parsedRules, inventory);
    out.innerHTML = renderSizeResults(results, models);
  } catch (e) {
    out.innerHTML = `<p class="err">Lỗi: ${e.message}</p>`;
  }
}

function deleteInventoryItem(i) {
  inventory.splice(i, 1);
  renderInventoryTable();
}

function loadInventoryFromFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".yaml,.yml";
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    file.text().then((text) => {
      const raw = jsyaml.load(text) || {};
      inventory = raw.inventory || [];
      renderInventoryTable();
    });
  };
  input.click();
}

// ---------------------------------------------------------------------------
// Generate tab - chon nhanh 1 server + 1 storage + 1 san-sw tu danh muc model da co,
// sinh ngay so port va loai day can dung. Day inventory RIENG, khong dinh vao tab Inventory.
// ---------------------------------------------------------------------------

function refreshGenerateDropdowns() {
  const serverSel = document.getElementById("gen-server-model");
  const storageSel = document.getElementById("gen-storage-model");
  const sanswSel = document.getElementById("gen-sansw-model");
  if (!serverSel) return; // trang chua render xong (goi lan dau truoc DOMContentLoaded)
  serverSel.innerHTML = '<option value="">— Không chọn —</option>';
  storageSel.innerHTML = '<option value="">— Không chọn —</option>';
  sanswSel.innerHTML = '<option value="">— Không chọn (dùng số port mặc định) —</option>';
  if (!parsedRules) return;
  for (const [id, m] of Object.entries(parsedRules.server_models)) serverSel.innerHTML += `<option value="${id}">${modelLabel(m, id)}</option>`;
  for (const [id, m] of Object.entries(parsedRules.san_storage_models)) storageSel.innerHTML += `<option value="${id}">${modelLabel(m, id)}</option>`;
  for (const [id, m] of Object.entries(parsedRules.san_switch_models)) sanswSel.innerHTML += `<option value="${id}">${modelLabel(m, id)}${m.total_ports ? ` — ${m.total_ports} port` : ""}</option>`;
}

function runGenerate() {
  const out = document.getElementById("generate-result");
  if (!parsedRules) { out.innerHTML = '<p class="err">Cấu hình chưa hợp lệ — vào mục "Cấu hình &amp; model" và bấm "Áp dụng" trước.</p>'; return; }

  const rules = JSON.parse(JSON.stringify(parsedRules)); // ban sao rieng, khong dinh viec ghi de max_ports_per_unit vao parsedRules goc
  const genInventory = [];

  const serverModel = document.getElementById("gen-server-model").value;
  const serverQty = Number(document.getElementById("gen-server-qty").value || 0);
  const serverProtocol = document.getElementById("gen-server-protocol").value;
  if (serverQty > 0 && serverModel) {
    const item = { role: "server", qty: serverQty, model: serverModel };
    if (serverProtocol) item.protocol = serverProtocol;
    genInventory.push(item);
  }

  const storageModel = document.getElementById("gen-storage-model").value;
  const storageQty = Number(document.getElementById("gen-storage-qty").value || 0);
  if (storageQty > 0 && storageModel) genInventory.push({ role: "san_storage", qty: storageQty, model: storageModel });

  const sanswModelId = document.getElementById("gen-sansw-model").value;
  if (sanswModelId && rules.san_switch_models[sanswModelId]) {
    const sw = rules.san_switch_models[sanswModelId];
    if (sw.total_ports) rules.roles.san_switch.max_ports_per_unit = Number(sw.total_ports);
  }

  if (!genInventory.length) {
    out.innerHTML = '<p class="err">Hãy chọn model và nhập số lượng lớn hơn 0 cho ít nhất máy chủ hoặc storage.</p>';
    return;
  }

  try {
    const results = computeSizing(rules, genInventory);
    lastGenerateLinks = linkCountsFromResults(results);
    const models = usedModels(rules, genInventory);
    let html = `<div class="card"><h2>Kết quả</h2>${renderSizeResults(results, models)}</div>`;

    html += '<div class="card"><h2>Loại dây / đầu nối (tham khảo)</h2><table><tr><th>Kết nối tới</th><th>Loại dây / đầu nối</th></tr>';
    for (const roleName of ["network_switch", "mgmt_switch", "san_switch"]) {
      const spec = rules.roles[roleName];
      if (spec && spec.media && results[roleName]) {
        html += `<tr><td>${roleLabel(roleName)}</td><td>${spec.media}</td></tr>`;
      }
    }
    html += "</table>";

    if (sanswModelId && rules.san_switch_models[sanswModelId]) {
      const sw = rules.san_switch_models[sanswModelId];
      html += `<p>SAN switch đã chọn: <b>${sw.vendor} ${sw.model_name}</b> (${sw.total_ports} port FC/switch) — ` +
        `<a href="${sw.source}" target="_blank">nguồn</a></p>`;
    }

    html += '</div><p class="hint">Tiếp theo: vào mục "Cáp &amp; tủ rack" và bấm "Lấy số dây từ kết quả Tạo nhanh" để tính số mét dây.</p>';
    out.innerHTML = html;
  } catch (e) {
    out.innerHTML = `<p class="err">Lỗi: ${e.message}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Cap / Rack - tinh so met day giua cac tu rack.
//
// Mo hinh: tu dat theo hang (row) x vi tri trong hang (pos). Chieu dai 1 soi day phu thuoc
// khoang cach (so tu) giua tu nguon va tu dich, KHONG do tu toa do vat ly - vi day thuc te
// di len khay cap tren dau tu, vong qua, xuong tu dich, cong them doan du (service loop) o 2
// dau; nen dung bang kinh nghiem thi cong (nguoi dung cung cap) lam goc:
//   - cung tu            : intra_m (mac dinh 5m)
//   - cach 1 tu (ke nhau): adjacent_m (mac dinh 10m)
//   - moi tu xa them     : + per_rack_step_m (mac dinh 2.5m) -> cach 2 tu = 12.5m (~12-13m)
//   - khac hang (qua loi di): + row_cross_m cho moi hang vuot qua (mac dinh 6m: loi di ~1.2m
//                            + len/xuong khay + vong qua dau hang)
// Sau do lam tron LEN do dai chuan co ban tren thi truong (day duc san), cong % du phong.
// ---------------------------------------------------------------------------

let lastGenerateLinks = null;
let cableLinks = []; // [{desc, media, src, dst, qty}]

const CABLE_MEDIA = {
  copper: { label: "Đồng (RJ45 Cat6/6A)", maxM: 90, maxNote: "Cat6A tối đa 100m/kênh (90m dây cố định + 10m dây nhảy)" },
  fiber: { label: "Quang (LC-LC MMF OM4)", maxM: 100, maxNote: "OM4: 32GFC/25GbE-SR khoảng 100m, OM3 chỉ khoảng 70m" },
  dac: { label: "DAC/twinax (SFP28/QSFP)", maxM: 5, maxNote: "DAC thụ động thường ≤5m; xa hơn nên dùng AOC hoặc quang" },
};

function linkCountsFromResults(results) {
  const p = (role, key) => ((results[role] && results[role].ports) || {})[key] || 0;
  return {
    lan: p("server", "data") + p("server", "iscsi_data"),
    mgmt: p("server", "mgmt_hw") + p("server", "mgmt_os") + p("san_storage", "mgmt_hw"),
    fc: p("server", "fc_hba") + p("san_storage", "controller_port"),
  };
}

function readCableParams() {
  const num = (id, d) => { const v = Number(document.getElementById(id).value); return Number.isFinite(v) && v >= 0 ? v : d; };
  const list = (id) => document.getElementById(id).value.split(/[,\s]+/).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  return {
    rows: Math.max(1, Math.floor(num("cab-rows", 1))),
    perRow: Math.max(1, Math.floor(num("cab-per-row", 4))),
    intra_m: num("cab-intra", 5),
    adjacent_m: num("cab-adjacent", 10),
    per_rack_step_m: num("cab-step", 2.5),
    row_cross_m: num("cab-row-cross", 6),
    spare_percent: num("cab-spare", 10),
    std: { copper: list("cab-std-copper"), fiber: list("cab-std-fiber"), dac: list("cab-std-dac") },
  };
}

function rackName(row, pos) {
  return `${String.fromCharCode(65 + row)}${String(pos + 1).padStart(2, "0")}`; // A01, A02, B01...
}

function parseRackName(name) {
  return { row: name.charCodeAt(0) - 65, pos: Number(name.slice(1)) - 1 };
}

/** Chieu dai uoc tinh (m) cho 1 soi day giua 2 tu, theo bang kinh nghiem o tren. */
function cableLengthM(src, dst, p) {
  const a = parseRackName(src), b = parseRackName(dst);
  const rowDiff = Math.abs(a.row - b.row);
  const posDiff = Math.abs(a.pos - b.pos);
  if (rowDiff === 0 && posDiff === 0) return p.intra_m;
  // khac hang nhung cung vi tri van phai di len khay, qua loi -> tinh it nhat nhu tu ke nhau
  const steps = Math.max(posDiff, 1);
  return p.adjacent_m + (steps - 1) * p.per_rack_step_m + rowDiff * p.row_cross_m;
}

/** Lam tron LEN do dai chuan gan nhat; vuot dai lon nhat thi tra null (phai cat/bam day theo met). */
function roundToStandard(lengthM, stdList) {
  const hit = stdList.find((s) => s >= lengthM - 1e-9);
  return hit === undefined ? null : hit;
}

function computeCablePlan(links, p) {
  const lines = links.map((l) => {
    const raw = cableLengthM(l.src, l.dst, p);
    const stdList = p.std[l.media] || [];
    const std = stdList.length ? roundToStandard(raw, stdList) : null; // list rong = bam/cat theo met thuc
    const qtyWithSpare = Math.ceil(l.qty * (1 + p.spare_percent / 100));
    const unitLen = std ?? Math.ceil(raw);
    const media = CABLE_MEDIA[l.media];
    const warnings = [];
    if (raw > media.maxM) warnings.push(`${raw}m vượt giới hạn ${media.maxM}m — ${media.maxNote}`);
    if (std === null && stdList.length) warnings.push("Vượt độ dài đúc sẵn lớn nhất — phải đặt dây theo mét hoặc hàn nối");
    return { ...l, raw, std, qtyWithSpare, totalM: unitLen * qtyWithSpare, warnings };
  });

  const bySku = {}; // "fiber|10" -> so soi
  const byMedia = {};
  for (const l of lines) {
    const key = `${l.media}|${l.std ?? "theo mét " + Math.ceil(l.raw)}`;
    bySku[key] = (bySku[key] || 0) + l.qtyWithSpare;
    byMedia[l.media] = (byMedia[l.media] || 0) + l.totalM;
  }
  return { lines, bySku, byMedia };
}

function allRackNames(p) {
  const names = [];
  for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.perRow; c++) names.push(rackName(r, c));
  return names;
}

function renderRackLayout() {
  const p = readCableParams();
  let html = '<table class="rack-grid">';
  for (let r = 0; r < p.rows; r++) {
    html += "<tr>";
    for (let c = 0; c < p.perRow; c++) html += `<td>${rackName(r, c)}</td>`;
    html += "</tr>";
    if (r < p.rows - 1) html += `<tr><td colspan="${p.perRow}" class="muted aisle">lối đi</td></tr>`;
  }
  document.getElementById("cab-layout").innerHTML = html + "</table>";
  // tu khong con ton tai (giam so tu) thi keo ve tu dau tien de khong tinh sai
  const names = allRackNames(p);
  for (const l of cableLinks) {
    if (!names.includes(l.src)) l.src = names[0];
    if (!names.includes(l.dst)) l.dst = names[0];
  }
  renderCableLinks();
}

function addCableLink(desc = "Tuyến mới", media = "copper", qty = 1, explain = null) {
  const first = rackName(0, 0);
  cableLinks.push({ desc, media, src: first, dst: first, qty, explain, origQty: qty });
  renderCableLinks();
}

function updateCableLink(i, field, value) {
  cableLinks[i][field] = field === "qty" ? Math.max(0, Number(value) || 0) : value;
  if (field === "qty" && cableLinks[i].explain) renderCableLinks(); // cap nhat ghi chu "ban da sua so soi"
  else renderCablePlan();
}

function deleteCableLink(i) {
  cableLinks.splice(i, 1);
  renderCableLinks();
}

function importLinksFromGenerate() {
  const msg = document.getElementById("cab-msg");
  if (!lastGenerateLinks) {
    msg.innerHTML = '<p class="err">Chưa có kết quả — vào mục "Tạo nhanh" và bấm "Tính port &amp; loại dây" trước.</p>';
    return;
  }
  const g = lastGenerateLinks;
  if (g.lan) addCableLink("Máy chủ data/iSCSI → switch LAN", "fiber", g.lan);
  if (g.mgmt) addCableLink("Quản lý (iLO/iDRAC/OS/storage) → switch quản lý", "copper", g.mgmt);
  if (g.fc) addCableLink("FC (HBA + controller storage) → SAN switch", "fiber", g.fc);
  msg.innerHTML = '<p class="ok-msg">Đã thêm tuyến từ kết quả Tạo nhanh — chọn tủ nguồn/tủ đích cho từng dòng.</p>';
}

/** Ket qua scan BOM -> danh sach tuyen {desc, media, qty}, gom theo (he thong x loai ket noi) de
 * nguoi dung gan tu rack cho tung he thong. Moi port card = 1 soi:
 *   - HBA -> FC -> SAN switch, luon quang.
 *   - NIC -> switch LAN; dong neu mo ta co BASE-T/RJ45, con lai (SFP/SFP28/QSFP) tinh la quang.
 *   - Day quan ly (dong -> switch quan ly), so day/thiet bi theo MGMT_PER_DEVICE: may chu 1 (iLO/iDRAC),
 *     storage 2 (1/controller), switch 1, backup 1. So thiet bi trong 1 he thong = qty LON NHAT trong
 *     cac dong cung loai (khong cong don) - vi 1 thiet bi co the co nhieu dong cung loai (vd StoreOnce
 *     "Base System" + "System Supp"). ponytail: he thong co 2 model storage khac nhau se bi dem thieu. */
const MGMT_PER_DEVICE = {
  server_chassis: { n: 1, label: "Máy chủ (iLO/iDRAC)" },
  storage_array: { n: 2, label: "Storage (2 controller)" },
  switch: { n: 1, label: "Switch" },
  backup_device: { n: 1, label: "Thiết bị backup" },
};

function linksFromBomLines(lines) {
  const acc = {}; // key -> link
  const devices = {}; // "group|type" -> {group, type, qty} (qty = so thiet bi, lay max)
  // explain: {rule, items:[{row, text, qty, source?}]} - giai thich tung so hang, hien o bang tuyen cap
  const add = (group, kind, desc, media, qty, rule, item) => {
    if (!qty) return;
    const key = `${group}|${kind}|${media}`;
    acc[key] = acc[key] || { desc: (group ? group + " — " : "") + desc, media, qty: 0, explain: { rule, items: [] } };
    acc[key].qty += qty;
    acc[key].explain.items.push(item);
  };
  const where = (r) => `Dòng ${r.row_no ?? "?"}${r.group ? ` (hệ thống "${r.group}")` : ""}: ${[r.part_number, r.description].filter(Boolean).join(" — ")}`;
  const qtyText = (r, unit) => r.group_qty > 1 ? `${r.qty} ${unit} (${r.unit_qty} ${unit}/hệ thống × ${r.group_qty} hệ thống)` : `${r.qty} ${unit}`;
  for (const l of lines) {
    const r = l.row;
    const qty = Number(r.qty) || 0;
    const group = r.group || "";
    const text = `${r.description || ""} ${r.part_number || ""}`;
    if (l.resolved && (l.type === "hba" || l.type === "nic")) {
      const total = l.resolved.ports * qty;
      const item = { where: where(r), calc: `${l.resolved.ports} port/card × ${qtyText(r, "card")} = ${total} sợi`,
        source: l.resolved.source, sourceLabel: `số port của "${l.resolved.match}" theo danh mục card` };
      if (l.type === "hba") {
        add(group, "fc", "FC (HBA) → SAN switch", "fiber", total, "Mỗi port HBA = 1 sợi quang FC nối lên SAN switch (chia đều 2 fabric A/B).", item);
      } else {
        const copper = /base-?t|rj-?45/i.test(text);
        add(group, "lan", `LAN (NIC ${copper ? "RJ45" : "SFP"}) → switch LAN`, copper ? "copper" : "fiber", total,
          copper ? "Mỗi port NIC = 1 sợi tới switch LAN. Mô tả card có BASE-T/RJ45 → dây đồng."
                 : "Mỗi port NIC = 1 sợi tới switch LAN. Mô tả card không có BASE-T/RJ45 (loại SFP/SFP28/QSFP) → tính dây quang.", item);
      }
    } else if (MGMT_PER_DEVICE[l.type]) {
      const k = `${group}|${l.type}`;
      const d = (devices[k] = devices[k] || { group, type: l.type, qty: 0, best: null, rows: [] });
      d.rows.push(r);
      if (qty > d.qty) { d.qty = qty; d.best = r; }
    }
  }
  for (const d of Object.values(devices)) {
    const m = MGMT_PER_DEVICE[d.type];
    const total = d.qty * m.n;
    const rule = `Mỗi thiết bị loại "${m.label}" cần ${m.n} dây quản lý (đồng) tới switch quản lý. Số thiết bị = số lượng lớn nhất trong các dòng cùng loại của hệ thống (không cộng dồn).`;
    add(d.group, "mgmt", `Quản lý ${m.label} → switch quản lý`, "copper", total, rule,
      { where: where(d.best), calc: `${qtyText(d.best, "thiết bị")} × ${m.n} dây quản lý/thiết bị = ${total} sợi` });
    const link = acc[`${d.group}|mgmt|copper`];
    for (const r of d.rows) if (r !== d.best && link) {
      link.explain.items.push({ where: where(r), calc: "bỏ qua — cùng loại thiết bị trong hệ thống này, không cộng dồn" });
    }
  }
  return Object.values(acc);
}

function importLinksFromBom() {
  const msg = document.getElementById("cab-msg");
  if (!lastBomLines.length) {
    msg.innerHTML = '<p class="err">Chưa có kết quả — vào mục "Đọc file BOM" và đọc file trước.</p>';
    return;
  }
  const links = linksFromBomLines(lastBomLines);
  if (!links.length) {
    msg.innerHTML = '<p class="err">File BOM không có card mạng/HBA hay máy chủ nào nhận diện được.</p>';
    return;
  }
  for (const l of links) addCableLink(l.desc, l.media, l.qty, l.explain);
  msg.innerHTML = `<p class="ok-msg">Đã thêm ${links.length} tuyến từ file BOM (mỗi port card = 1 sợi, dây quản lý: máy chủ 1, storage 2, switch 1, backup 1 mỗi thiết bị) — chọn tủ nguồn/tủ đích cho từng dòng.</p>`;
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Khoi "Cach tinh" (bam de mo) duoi moi tuyen lay tu BOM: quy tac + tung dong BOM dong gop. */
function renderCableExplain(l) {
  const e = l.explain;
  const counted = e.items.filter((it) => !it.calc.startsWith("bỏ qua"));
  let html = `<details class="explain"><summary>Cách tính ${l.origQty} sợi (${counted.length} dòng BOM)</summary>
    <p>${esc(e.rule)}</p><ol>`;
  for (const it of e.items) {
    html += `<li><span class="muted">${esc(it.where)}</span><br><b>${esc(it.calc)}</b>`;
    if (it.source) html += ` — <a href="${esc(it.source)}" target="_blank">${esc(it.sourceLabel)}</a>`;
    html += "</li>";
  }
  html += "</ol>";
  if (counted.length > 1) html += `<p>Tổng: ${counted.map((it) => it.calc.match(/= (\d+) sợi/)[1]).join(" + ")} = <b>${l.origQty} sợi</b></p>`;
  if (l.qty !== l.origQty) html += `<p class="warn">Bạn đã sửa số sợi thành ${l.qty} (BOM tính ra ${l.origQty}).</p>`;
  return html + '<p class="muted">Chưa cộng dự phòng — % dự phòng được cộng ở bảng "Chi tiết từng tuyến".</p></details>';
}

function renderCableLinks() {
  const names = allRackNames(readCableParams());
  const opt = (sel) => names.map((n) => `<option ${n === sel ? "selected" : ""}>${n}</option>`).join("");
  let html = "<table><tr><th>Mô tả</th><th>Loại dây</th><th>Tủ nguồn</th><th>Tủ đích</th><th>Số sợi</th><th></th></tr>";
  cableLinks.forEach((l, i) => {
    const mediaOpts = Object.entries(CABLE_MEDIA).map(([k, m]) => `<option value="${k}" ${k === l.media ? "selected" : ""}>${m.label}</option>`).join("");
    html += `<tr>
      <td><input type="text" value="${l.desc.replace(/"/g, "&quot;")}" onchange="updateCableLink(${i},'desc',this.value)" style="width:100%;min-width:16rem"></td>
      <td><select onchange="updateCableLink(${i},'media',this.value)">${mediaOpts}</select></td>
      <td><select onchange="updateCableLink(${i},'src',this.value)">${opt(l.src)}</select></td>
      <td><select onchange="updateCableLink(${i},'dst',this.value)">${opt(l.dst)}</select></td>
      <td><input type="number" min="0" value="${l.qty}" onchange="updateCableLink(${i},'qty',this.value)" style="width:5rem"></td>
      <td><button class="danger" onclick="deleteCableLink(${i})">Xoá</button></td></tr>`;
    if (l.explain) html += `<tr class="explain-row"><td colspan="6">${renderCableExplain(l)}</td></tr>`;
  });
  document.getElementById("cab-links").innerHTML = cableLinks.length ? html + "</table>" : '<p class="muted">Chưa có tuyến nào. Bấm "Lấy số dây từ kết quả Tạo nhanh" hoặc "+ Thêm tuyến".</p>';
  renderCablePlan();
}

function renderCablePlan() {
  const out = document.getElementById("cab-result");
  if (!cableLinks.length) { out.innerHTML = ""; return; }
  const p = readCableParams();
  const plan = computeCablePlan(cableLinks, p);

  let html = `<div class="card"><h2>Chi tiết từng tuyến (đã cộng ${p.spare_percent}% dự phòng)</h2>
    <div class="table-wrap"><table><tr><th>Mô tả</th><th>Tuyến</th><th>Ước tính</th><th>Dây đúc sẵn</th><th>Số sợi</th><th>Tổng mét</th></tr>`;
  for (const l of plan.lines) {
    html += `<tr><td>${l.desc}</td><td style="white-space:nowrap">${l.src} &rarr; ${l.dst}</td><td>${l.raw}m</td>
      <td>${l.std === null ? "-" : l.std + "m"}</td><td>${l.qtyWithSpare}</td><td><b>${l.totalM}m</b></td></tr>`;
    for (const w of l.warnings) html += `<tr><td colspan="6" class="warn">⚠ ${l.desc}: ${w}</td></tr>`;
  }
  html += '</table></div></div><div class="card"><h2>Tổng hợp đặt hàng</h2><table><tr><th>Loại dây</th><th>Độ dài</th><th>Số sợi</th></tr>';
  const skuOrder = ([a], [b]) => {
    const [ma, la] = a.split("|"), [mb, lb] = b.split("|");
    return ma.localeCompare(mb) || (parseFloat(la.replace(/\D+/, "")) - parseFloat(lb.replace(/\D+/, "")));
  };
  for (const [key, qty] of Object.entries(plan.bySku).sort(skuOrder)) {
    const [media, len] = key.split("|");
    const lenLabel = Number.isNaN(Number(len)) ? len : `${len}m`;
    html += `<tr><td>${CABLE_MEDIA[media].label}</td><td>${lenLabel}</td><td>${qty}</td></tr>`;
  }
  html += '</table><div class="stats">';
  html += Object.entries(plan.byMedia).map(([m, total]) => `<div class="stat"><b>${total}m</b><span>${CABLE_MEDIA[m].label}</span></div>`).join("");
  out.innerHTML = html + "</div></div>";
}

// ---------------------------------------------------------------------------
// Run: size
// ---------------------------------------------------------------------------

function runSize() {
  const out = document.getElementById("size-result");
  if (!parsedRules) { out.innerHTML = '<p class="err">Cấu hình chưa hợp lệ — vào mục "Cấu hình &amp; model" và bấm "Áp dụng" trước.</p>'; return; }

  const rules = JSON.parse(JSON.stringify(parsedRules)); // ban sao rieng de spare-override khong dinh vao parsedRules goc
  const spareRaw = document.getElementById("spare-override").value;
  if (spareRaw !== "") {
    for (const spec of Object.values(rules.roles)) if (spec.kind === "pair") spec.spare_percent = Number(spareRaw);
  }

  try {
    const results = computeSizing(rules, inventory);
    const models = usedModels(rules, inventory);
    out.innerHTML = `<div class="card"><h2>Kết quả</h2>${renderSizeResults(results, models)}</div>`;
  } catch (e) {
    out.innerHTML = `<p class="err">Lỗi: ${e.message}</p>`;
  }
}

function renderSizeResults(results, models) {
  let leafHtml = "", pairHtml = "", warnHtml = "";
  for (const [role, res] of Object.entries(results)) {
    if (res.kind === "leaf") {
      const total = Object.values(res.ports).reduce((a, b) => a + b, 0);
      leafHtml += `<div class="result-card leaf"><h3>${roleLabel(role)}</h3><div class="kind">Thiết bị đầu cuối</div>
        <div class="big">${total} <small>port</small></div><dl>`;
      for (const [k, v] of Object.entries(res.ports)) leafHtml += `<dt>${portLabel(k)}</dt><dd>${v}</dd>`;
      leafHtml += "</dl></div>";
    } else {
      pairHtml += `<div class="result-card pair"><h3>${roleLabel(role)}</h3><div class="kind">Cặp dự phòng A/B</div>
        <div class="big">${res.physical_units} <small>thiết bị × ${res.total_ports_per_unit} port</small></div><dl>
        <dt>Port nối thiết bị (+dự phòng)</dt><dd>${res.downlink_ports_per_unit}</dd>
        <dt>Port riêng (quản lý/uplink)</dt><dd>${res.own_ports_per_unit}</dd></dl></div>`;
      for (const w of res.warnings) warnHtml += `<p class="warn">⚠ ${w}</p>`;
    }
  }
  let html = "";
  if (pairHtml) html += `<h3>Switch cần dùng</h3><div class="result-grid">${pairHtml}</div>`;
  if (leafHtml) html += `<h3>Port phía thiết bị</h3><div class="result-grid">${leafHtml}</div>`;
  html += warnHtml;
  if (models.length) {
    html += "<h3>Model đã dùng (nguồn tra cứu)</h3><ul>";
    for (const m of models) html += `<li>${m.vendor} ${m.model_name} (${m.form_factor}) — <a href="${m.source}" target="_blank">nguồn</a></li>`;
    html += "</ul>";
  }
  return html;
}

// ---------------------------------------------------------------------------
// Run: scan-bom
// ---------------------------------------------------------------------------

// Filter theo type dang ap dung cho ket qua scan-bom hien tai. Mac dinh chi hien NIC/HBA (phan
// lien quan truc tiep den tinh port) - cac loai khac (CPU/RAM/cable/license/...) chiem da so dong
// trong 1 BOM thuc te va gay roi neu hien het, nen an mac dinh, bat len qua checkbox khi can xem.
let lastBomLines = [];
let bomAllTypes = [];
let bomTypeFilter = new Set(["nic", "hba"]);

/** Entry point cho 1 lan SCAN MOI (file/paste vua doc) - reset filter ve mac dinh. */
function renderBomLines(lines) {
  lastBomLines = lines;
  bomAllTypes = [...new Set(lines.map((l) => l.type))].sort();
  bomTypeFilter = new Set(["nic", "hba"]);
  return renderBomFilterAndTable();
}

/** Ve lai filter UI + bang, dung bomTypeFilter HIEN TAI (khong reset) - dung khi doi filter tren
 * cung 1 ket qua scan, tranh mat lua chon nguoi dung vua bam. */
function renderBomFilterAndTable() {
  let filterHtml = '<div class="card"><div class="bom-filter"><b>Lọc theo loại linh kiện</b><div class="actions">';
  filterHtml += `<button onclick="setBomTypeFilter(['nic','hba'])">Chỉ NIC/HBA</button>`;
  filterHtml += `<button onclick="setBomTypeFilter(bomAllTypes)">Chọn tất cả</button>`;
  filterHtml += `<button onclick="setBomTypeFilter([])">Bỏ chọn hết</button></div>`;
  for (const t of bomAllTypes) {
    const checked = bomTypeFilter.has(t) ? "checked" : "";
    filterHtml += `<label><input type="checkbox" value="${t}" ${checked} onchange="toggleBomTypeFilter('${t}', this.checked)"> ${TYPE_LABELS[t] || t}</label> `;
  }
  filterHtml += "</div>";
  return filterHtml + '<div id="bom-table-container" class="table-wrap">' + renderBomTable(lastBomLines) + "</div></div>";
}

function renderBomTable(lines) {
  const filtered = lines.filter((l) => bomTypeFilter.has(l.type));
  const hasGroup = filtered.some((l) => l.row.group);
  let html = `<p class="muted">Đang hiện ${filtered.length}/${lines.length} dòng theo bộ lọc.</p>`;
  html += '<table><tr><th>Trạng thái</th><th>Loại</th>' + (hasGroup ? "<th>Hệ thống</th>" : "") +
    '<th>Mô tả / mã part</th><th>SL</th><th>Port/card</th><th>Tổng port</th><th>Nguồn</th></tr>';
  for (const l of filtered) {
    const text = l.row.description || l.row.part_number || "";
    const qty = l.row.qty ?? "?";
    const groupCell = hasGroup ? `<td>${l.row.group || ""}</td>` : "";
    const typeLabel = TYPE_LABELS[l.type] || l.type;
    if (l.resolved) {
      const totalPorts = l.resolved.ports * Number(qty || 0);
      html += `<tr><td><span class="badge-ok">Đã nhận diện</span></td><td>${typeLabel}</td>${groupCell}<td>${text}</td><td>${qty}</td>
        <td>${l.resolved.ports}</td><td><b>${totalPorts}</b></td>
        <td><a href="${l.resolved.source}" target="_blank">nguồn</a></td></tr>`;
    } else {
      const note = l.type === "unknown" ? "Chưa xác định được loại — cần kiểm tra tay" : "Không phải card mạng (không tính port)";
      html += `<tr><td><span class="badge-unresolved">${l.type === "unknown" ? "Chưa rõ" : "Bỏ qua"}</span></td><td>${typeLabel}</td>${groupCell}<td>${text}</td><td>${qty}</td>
        <td colspan="3" class="muted">${note}</td></tr>`;
    }
  }
  return html + "</table>";
}

function toggleBomTypeFilter(type, checked) {
  if (checked) bomTypeFilter.add(type); else bomTypeFilter.delete(type);
  document.getElementById("bom-table-container").innerHTML = renderBomTable(lastBomLines);
}

function setBomTypeFilter(types) {
  bomTypeFilter = new Set(types);
  document.getElementById("scanbom-result").innerHTML = renderBomFilterAndTable();
}

/** Doc buffer .xlsx/.xls (chi lay sheet dau) -> 2D array (raw cell, KHONG gia dinh dong 0 la
 * header - xem parseTabularRows2D). Tach rieng de self-test goi truc tiep voi buffer tao trong
 * bo nho (khong can File thuc). */
function xlsxBufferToRaw2D(buffer) {
  const wb = XLSX.read(buffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  // blankrows:true de chi so mang = vi tri dong that (dong trong duoc parseTabularRows2D tu bo qua),
  // gan __rowNum__ (0-based, tinh tu dong 1 cua sheet) de trich dan "Dong N" khop Excel.
  const start = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]).s.r : 0;
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", blankrows: true });
  rows.forEach((r, i) => { r.__rowNum__ = start + i; });
  return rows;
}

/** Doc file BOM (.csv hoac .xlsx/.xls, chi lay sheet dau) -> array component-row {part_number,
 * description, qty, group}, qty DA nhan theo group neu file co cau truc bundle/component (xem
 * parseTabularRows2D). Ho tro ca kieu BOM export CTO thuc te (Cisco/HPE) lan CSV don gian tu tay dien. */
async function parseTabularFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv")) return parseTabularRows2D(parseCsvRaw2D(await file.text()));
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return parseTabularRows2D(xlsxBufferToRaw2D(await file.arrayBuffer()));
  throw new Error("Chỉ hỗ trợ file .csv, .xlsx, .xls");
}

async function runScanBomFile() {
  const fileInput = document.getElementById("bom-file");
  const out = document.getElementById("scanbom-result");
  const file = fileInput.files[0];
  if (!file) { out.innerHTML = '<p class="err">Hãy chọn file trước.</p>'; return; }
  try {
    const rows = await parseTabularFile(file);
    out.innerHTML = renderBomLines(scanBomRows(cards, rows));
  } catch (e) {
    out.innerHTML = `<p class="err">Lỗi đọc file: ${e.message}</p>`;
  }
}

function runScanBomPaste() {
  const text = document.getElementById("bom-paste").value;
  const out = document.getElementById("scanbom-result");
  if (!text.trim()) { out.innerHTML = '<p class="err">Hãy dán nội dung CSV trước.</p>'; return; }
  const lines = scanBomRows(cards, parseTabularRows2D(parseCsvRaw2D(text)));
  out.innerHTML = renderBomLines(lines);
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function refreshDashboard() {
  const el = document.getElementById("dashboard-summary");
  if (!parsedRules) {
    el.innerHTML = '<p class="err">Cấu hình chưa hợp lệ — vào mục "Cấu hình &amp; model" và bấm "Áp dụng".</p>';
    return;
  }
  const stat = (n, label) => `<div class="stat"><b>${n}</b><span>${label}</span></div>`;
  el.innerHTML = `<div class="stats" style="margin-bottom:1.1rem">
    ${stat(Object.keys(parsedRules.server_models).length, "Model máy chủ")}
    ${stat(Object.keys(parsedRules.san_storage_models).length, "Model SAN storage")}
    ${stat(Object.keys(parsedRules.san_switch_models).length, "Model SAN switch")}
    ${stat(cards.length, "Card mạng/HBA đã biết")}
    ${stat(inventory.length, "Dòng trong danh sách thiết bị")}</div>`;
}

// ---------------------------------------------------------------------------
// Self-test - doi chieu voi test_port_sizing.py / test_bom_import.py (Python)
// ---------------------------------------------------------------------------

function runSelfTest() {
  const out = [];
  const assertEq = (name, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    out.push(a === e ? `OK   ${name}` : `FAIL ${name}: got ${a}, want ${e}`);
  };

  try {
    const rules = parseRules(document.getElementById("default-rules-yaml").textContent);
    const inv = (jsyaml.load(document.getElementById("default-inventory-yaml").textContent) || {}).inventory;
    const results = computeSizing(rules, inv);

    // Khop voi test_example_inventory trong test_port_sizing.py (2 server iscsi dell_r660 + 1 san_storage)
    assertEq("network_switch.total_ports_per_unit", results.network_switch.total_ports_per_unit, 9);
    assertEq("network_switch.physical_units", results.network_switch.physical_units, 2);
    assertEq("mgmt_switch.total_ports_per_unit", results.mgmt_switch.total_ports_per_unit, 5);
    assertEq("mgmt_switch.warnings.length (storage mgmt_hw=2 -> tong 6 chan)", results.mgmt_switch.warnings.length, 0);
    assertEq("san_switch.total_ports_per_unit", results.san_switch.total_ports_per_unit, 4);
    assertEq("server.ports", results.server.ports, { mgmt_hw: 2, mgmt_os: 2, data: 4, iscsi_data: 4 });

    // Khop voi TestSplitLogic trong test_port_sizing.py
    const miniRules = {
      roles: {
        device: { kind: "leaf", ports: { link: 1 }, protocol_variants: {}, own_ports: {}, spare_percent: 0, max_ports_per_unit: null },
        upstream: { kind: "pair", ports: {}, protocol_variants: {}, own_ports: { mgmt_hw: 1 }, spare_percent: 0, max_ports_per_unit: null },
      },
      connections: [{ from_role: "device", from_port: "link", to_role: "upstream", to_port: "downlink" }],
      server_models: {},
    };
    const evenRes = computeSizing(miniRules, [{ role: "device", qty: 4 }]).upstream;
    assertEq("split chan (4) - downlink", evenRes.downlink_ports_per_unit, 2);
    assertEq("split chan (4) - warnings", evenRes.warnings.length, 0);
    const oddRes = computeSizing(miniRules, [{ role: "device", qty: 3 }]).upstream;
    assertEq("split le (3) - downlink", oddRes.downlink_ports_per_unit, 2);
    assertEq("split le (3) - warnings", oddRes.warnings.length, 1);
  } catch (e) {
    out.push(`FAIL (exception): ${e.message}`);
  }

  // Khop voi test_bom_import.py
  const testCatalog = [{ match: "57414", ports: 2, type: "nic", source: "test" }];
  const found = resolveCardPorts(testCatalog, "Broadcom 57414 Dual Port 25GbE OCP NIC");
  out.push(found && found.ports === 2 ? "OK   bom resolve match" : "FAIL bom resolve match");
  out.push(resolveCardPorts(testCatalog, "unknown card") === null ? "OK   bom resolve no-match" : "FAIL bom resolve no-match");
  const ambiguousCatalog = [
    { match: "NIC", ports: 2, type: "nic", source: "a" },
    { match: "25GbE NIC", ports: 4, type: "nic", source: "b" },
  ];
  out.push(resolveCardPorts(ambiguousCatalog, "Some 25GbE NIC card") === null ? "OK   bom resolve ambiguous" : "FAIL bom resolve ambiguous");

  // addModelToRulesText - khop voi test_webapp.py (ban Python), ca 2 muc server_models/san_storage_models
  try {
    const sampleText = "server_models:\n  existing_model:\n    vendor: X\n\nsan_storage_models:\n  existing_storage:\n    vendor: Y\n\nconnections:\n  - a: 1\n";
    const inserted = addModelToRulesText(sampleText, "server_models", "dell_r960", {
      vendor: "Dell", model_name: "PowerEdge R960", form_factor: "4U",
      mgmt_hw: 1, ocp_slots: 2, has_onboard_lom: false, pcie_slots_max: 10, source: "https://example.com/r960",
    });
    let reparsed = jsyaml.load(inserted);
    assertEq("addModelToRulesText(server_models) - giu model cu + them model moi",
      Object.keys(reparsed.server_models).sort(), ["dell_r960", "existing_model"]);
    assertEq("addModelToRulesText(server_models) - khong dinh vao san_storage_models",
      Object.keys(reparsed.san_storage_models).sort(), ["existing_storage"]);
    assertEq("addModelToRulesText(server_models) - khong lam mat connections", reparsed.connections.length, 1);

    const inserted2 = addModelToRulesText(sampleText, "san_storage_models", "dell_powerstore500", {
      vendor: "Dell", model_name: "PowerStore 500", form_factor: "2U", mgmt_hw: 1, controllers: 2,
      source: "https://example.com/powerstore500",
    });
    reparsed = jsyaml.load(inserted2);
    assertEq("addModelToRulesText(san_storage_models) - them dung muc",
      Object.keys(reparsed.san_storage_models).sort(), ["dell_powerstore500", "existing_storage"]);

    const sampleText2 = sampleText.replace("connections:", "san_switch_models:\n  existing_switch:\n    vendor: Z\n\nconnections:");
    const inserted3 = addModelToRulesText(sampleText2, "san_switch_models", "cisco_mds9124v", {
      vendor: "Cisco", model_name: "MDS 9124V", form_factor: "1U", mgmt_hw: 1, total_ports: 24,
      source: "https://example.com/mds9124v",
    });
    reparsed = jsyaml.load(inserted3);
    assertEq("addModelToRulesText(san_switch_models) - them dung muc",
      Object.keys(reparsed.san_switch_models).sort(), ["cisco_mds9124v", "existing_switch"]);
  } catch (e) {
    out.push(`FAIL addModelToRulesText: ${e.message}`);
  }

  // Generate: override max_ports_per_unit cua san_switch theo model chon, khong dinh vao parsedRules goc
  try {
    const rules = parseRules(document.getElementById("default-rules-yaml").textContent);
    const originalMax = rules.roles.san_switch.max_ports_per_unit;
    const copy = JSON.parse(JSON.stringify(rules));
    copy.san_switch_models.test_switch = { vendor: "T", model_name: "Test Switch", form_factor: "1U", mgmt_hw: 1, total_ports: 12, source: "s" };
    copy.roles.san_switch.max_ports_per_unit = Number(copy.san_switch_models.test_switch.total_ports);
    assertEq("generate: san_switch max_ports_per_unit doi theo model chon", copy.roles.san_switch.max_ports_per_unit, 12);
    assertEq("generate: khong dinh vao rules goc", rules.roles.san_switch.max_ports_per_unit, originalMax);
    // role pair co media THAM KHAO, dung hien thi loai day o Generate/Inventory
    out.push(rules.roles.san_switch.media ? "OK   san_switch co field media" : "FAIL san_switch thieu field media");
    out.push(rules.roles.mgmt_switch.media ? "OK   mgmt_switch co field media" : "FAIL mgmt_switch thieu field media");
    out.push(rules.roles.network_switch.media ? "OK   network_switch co field media" : "FAIL network_switch thieu field media");
  } catch (e) {
    out.push(`FAIL generate max_ports_per_unit override: ${e.message}`);
  }

  // San storage model validate + controller_ports override - khop voi TestServerModelOverride (test_port_sizing.py)
  try {
    const rules = parseRules(document.getElementById("default-rules-yaml").textContent);
    let threw = false;
    try { computeSizing(rules, [{ role: "san_storage", qty: 1, model: "khong_ton_tai" }]); } catch { threw = true; }
    out.push(threw ? "OK   san_storage model khong ton tai -> throw" : "FAIL san_storage model khong ton tai -> khong throw");

    // them 1 san_storage_models de test override (chi trong bo nho, khong dinh vao rules text)
    rules.san_storage_models.test_array = { vendor: "T", model_name: "Test Array", form_factor: "2U", mgmt_hw: 1, controllers: 2, source: "s" };
    const r = computeSizing(rules, [{ role: "san_storage", qty: 1, model: "test_array", controller_ports: 8 }]);
    assertEq("san_storage controller_ports override", r.san_storage.ports.controller_port, 8);
  } catch (e) {
    out.push(`FAIL san_storage model/override: ${e.message}`);
  }

  // Excel (.xlsx) round-trip qua SheetJS, kieu BOM don gian (khong co Start Date -> khong phan cap)
  try {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([["Description", "Qty"], ["Emulex LPe36002 Dual Port 32Gb FC HBA", "8"]]);
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    const rows = parseTabularRows2D(xlsxBufferToRaw2D(buf));
    assertEq("xlsx round-trip - so dong", rows.length, 1);
    assertEq("xlsx round-trip - qty giu nguyen (khong co group)", rows[0].qty, 8);
    const bomLines = scanBomRows(cards, rows);
    assertEq("xlsx round-trip - scan ra dung port", bomLines[0].resolved && bomLines[0].resolved.ports, 2);
  } catch (e) {
    out.push(`FAIL xlsx round-trip: ${e.message}`);
  }

  // BOM kieu Cisco/HPE CTO thuc te (group/bundle + component, header khong nam o dong 0) - khop
  // cau truc BOM1.xlsx: group row (khong co Start Date) nhan qty vao cac component ben duoi, cho
  // toi khi gap group row tiep theo.
  try {
    const matrix = [
      ["", "", "", "", ""],
      ["Export Date: 2026-01-01", "", "", "", ""],
      ["", "Product #", "Product Description", "Start Date", "Qty"],
      ["", "He thong test", "", "", 3],
      ["", "CARD-A", "Test Card mang SN1620E", "01/01/2025", 1],
      ["", "CARD-B", "Test Card mang BCM57414", "01/01/2025", 2],
      ["", "He thong test 2", "", "", 2],
      ["", "CARD-A", "Test Card mang SN1620E", "01/01/2025", 1],
    ];
    const rows = parseTabularRows2D(matrix);
    assertEq("BOM nhom - so dong component", rows.length, 3);
    assertEq("BOM nhom - qty component1 = qty_don_vi x qty_group (1x3)", rows[0].qty, 3);
    assertEq("BOM nhom - qty component2 = qty_don_vi x qty_group (2x3)", rows[1].qty, 6);
    assertEq("BOM nhom - group thu 2 tinh dung (1x2)", rows[2].qty, 2);
    assertEq("BOM nhom - gan dung ten group", rows[0].group, "He thong test");
    const bomLines = scanBomRows(cards, rows);
    assertEq("BOM nhom - tong port dung (SN1620E: 2 port/unit x qty3)",
      bomLines[0].resolved.ports * bomLines[0].row.qty, 6);
  } catch (e) {
    out.push(`FAIL BOM nhom (group/component): ${e.message}`);
  }

  // classifyComponentType - cac case de nham (uu tien mau cu the truoc mau chung), khop 66 part
  // number thuc trong BOM1.xlsx
  try {
    assertEq("classify: Processor -> cpu", classifyComponentType("Intel Xeon 6530P 2.3GHz 32-core 225W Processor for HPE"), "cpu");
    assertEq("classify: Memory Kit -> memory", classifyComponentType("HPE 64GB Dual Rank DDR5 Registered Smart FIO Memory Kit"), "memory");
    assertEq("classify: Battery+Cable Kit -> battery (khong phai cable)", classifyComponentType("HPE 96W Smart Storage Lithium-ion Battery with 145mm Cable Kit"), "battery");
    assertEq("classify: Storage Controller Enablement Cable Kit -> cable (khong phai storage_controller)", classifyComponentType("HPE ProLiant DL360 Gen11 Storage Controller Enablement Cable Kit"), "cable");
    assertEq("classify: Storage Controller (khong co Cable) -> storage_controller", classifyComponentType("HPE MR408i-p Gen11 x8 Lanes 4GB Cache PCI SPDM Plug-in Storage Controller"), "storage_controller");
    assertEq("classify: GPU Power Cable Kit -> cable (khong phai gpu)", classifyComponentType("HPE ProLiant DL380/DL560 Gen11 2U GPU Power Cable Kit"), "cable");
    assertEq("classify: Accelerator -> gpu", classifyComponentType("NVIDIA L40S 48GB PCIe Accelerator"), "gpu");
    assertEq("classify: SFP Adapter LTU -> license (khong phai nic)", classifyComponentType("HPE StoreOnce Gen5 10/25Gb SFP Adapter LTU"), "license");
    assertEq("classify: SFP Adapter (khong co LTU) -> nic", classifyComponentType("HPE StoreOnce Gen5 10/25Gb 2-port SFP Adapter"), "nic");
    assertEq("classify: Fibre Channel Switch -> switch", classifyComponentType("HPE SN6700B 64Gb 56/24 24-port 32Gb Short Wave SFP28 Integrated Fibre Channel Switch"), "switch");
    assertEq("classify: Fibre Channel Storage (khong Controller) -> storage_array", classifyComponentType("HPE MSA 2070 32Gb Fibre Channel SFF Storage"), "storage_array");
    assertEq("classify: StoreOnce Base System -> backup_device", classifyComponentType("HPE StoreOnce 3720 24TB Base System"), "backup_device");
    assertEq("classify: Configure-to-order Server -> server_chassis", classifyComponentType("HPE ProLiant Compute DL360 Gen12 8SFF NC Configure-to-order Server"), "server_chassis");
    assertEq("classify: Tech Care Service -> support (khong phai service)", classifyComponentType("HPE 3Y Tech Care Basic Service"), "support");
    assertEq("classify: Startup SVC -> service", classifyComponentType("HPE Technical Installation Startup SVC"), "service");
    assertEq("classify: khong khop gi -> unknown", classifyComponentType("Mot dong linh tinh khong co tu khoa nao ca"), "unknown");
  } catch (e) {
    out.push(`FAIL classifyComponentType: ${e.message}`);
  }

  // Cap / Rack - khop bang kinh nghiem thi cong: noi tu 5m, 2 tu gan nhau 10m, 3 tu ke nhau 12-13m
  try {
    const p = { intra_m: 5, adjacent_m: 10, per_rack_step_m: 2.5, row_cross_m: 6, spare_percent: 10,
      std: { copper: [1, 2, 3, 5, 7, 10, 15, 20, 30], fiber: [1, 2, 3, 5, 10, 15, 20, 30, 50], dac: [1, 2, 3, 5] } };
    assertEq("cable: cung tu = 5m", cableLengthM("A01", "A01", p), 5);
    assertEq("cable: 2 tu ke nhau = 10m", cableLengthM("A01", "A02", p), 10);
    assertEq("cable: 3 tu ke nhau (cach 2 tu) = 12.5m", cableLengthM("A01", "A03", p), 12.5);
    assertEq("cable: 12.5m lam tron len day chuan 15m", roundToStandard(12.5, p.std.fiber), 15);
    assertEq("cable: chieu nguoc lai bang nhau", cableLengthM("A03", "A01", p), 12.5);
    assertEq("cable: khac hang cung vi tri = ke nhau + 1 lan qua loi", cableLengthM("A01", "B01", p), 16);
    assertEq("cable: vuot do dai chuan lon nhat -> null", roundToStandard(60, p.std.fiber), null);
    const plan = computeCablePlan([{ desc: "t", media: "dac", src: "A01", dst: "A04", qty: 10 }], p);
    assertEq("cable: du phong 10% -> 11 soi", plan.lines[0].qtyWithSpare, 11);
    out.push(plan.lines[0].warnings.length ? "OK   cable: DAC 15m -> canh bao vuot 5m" : "FAIL cable: DAC 15m khong canh bao");
  } catch (e) {
    out.push(`FAIL cable/rack: ${e.message}`);
  }

  // Cap tu BOM: gom theo he thong, HBA->quang, NIC BASE-T->dong, NIC SFP->quang, server chassis->1 day mgmt/may
  try {
    const links = linksFromBomLines([
      { row: { group: "HT1", qty: 3, description: "HBA" }, resolved: { ports: 2 }, type: "hba" },
      { row: { group: "HT1", qty: 3, description: "BCM5719 1Gb 4-port BASE-T" }, resolved: { ports: 4 }, type: "nic" },
      { row: { group: "HT1", qty: 3, description: "BCM57414 10/25Gb SFP28" }, resolved: { ports: 2 }, type: "nic" },
      { row: { group: "HT1", qty: 3, description: "DL360 Configure-to-order Server" }, resolved: null, type: "server_chassis" },
      { row: { group: "HT2", qty: 1, description: "HBA" }, resolved: { ports: 2 }, type: "hba" },
      { row: { group: "HT1", qty: 6, description: "Memory Kit" }, resolved: null, type: "memory" },
    ]);
    assertEq("cable tu BOM: so tuyen", links.length, 5);
    const l2 = linksFromBomLines([
      { row: { group: "SAN", qty: 1, description: "MSA 2070 Storage" }, resolved: null, type: "storage_array" },
      { row: { group: "SW", qty: 2, description: "SN6700B Switch" }, resolved: null, type: "switch" },
      { row: { group: "BK", qty: 1, description: "StoreOnce Base System" }, resolved: null, type: "backup_device" },
      { row: { group: "BK", qty: 1, description: "StoreOnce accessory" }, resolved: null, type: "backup_device" },
    ]).map((l) => [l.desc.split(" — ")[0], l.qty]);
    assertEq("cable tu BOM: mgmt storage 2/thiet bi, switch 1, backup 1 (khong cong don dong trung)", l2, [["SAN", 2], ["SW", 2], ["BK", 1]]);
    const ex = linksFromBomLines([
      { row: { group: "HT", qty: 6, unit_qty: 2, group_qty: 3, row_no: 12, part_number: "P1", description: "HBA SN1620E" }, resolved: { ports: 2, match: "SN1620E", source: "s" }, type: "hba" },
      { row: { group: "HT", qty: 3, unit_qty: 1, group_qty: 3, row_no: 15, part_number: "P2", description: "HBA khac" }, resolved: { ports: 2, match: "X", source: "s" }, type: "hba" },
    ])[0];
    assertEq("cable tu BOM: explain co 2 dong, tong 18", [ex.qty, ex.explain.items.length], [18, 2]);
    assertEq("cable tu BOM: explain ghi dong + nhan qty theo he thong", ex.explain.items[0].where.startsWith("Dòng 12") && ex.explain.items[0].calc, "2 port/card × 6 card (2 card/hệ thống × 3 hệ thống) = 12 sợi");
    assertEq("BOM nhom - so dong trong file (row_no)", parseTabularRows2D([["", "Product #", "Product Description", "Start Date", "Qty"], ["", "G", "", "", 2], ["", "A", "d", "x", 1]])[0].row_no, 3);
    assertEq("classify: StoreOnce System Supp -> support", classifyComponentType("HPE StoreOnce 3720 24TB System Supp"), "support");
    assertEq("cable tu BOM: HT1 FC = 6 soi quang", links.filter((l) => l.desc.startsWith("HT1") && l.desc.includes("FC")).map((l) => [l.media, l.qty]), [["fiber", 6]]);
    assertEq("cable tu BOM: NIC BASE-T -> dong 12", links.filter((l) => l.media === "copper" && l.desc.includes("RJ45")).map((l) => l.qty), [12]);
    assertEq("cable tu BOM: mgmt = so may chu", links.filter((l) => l.desc.includes("iLO")).map((l) => l.qty), [3]);
  } catch (e) {
    out.push(`FAIL cable tu BOM: ${e.message}`);
  }

  const failCount = out.filter((l) => l.startsWith("FAIL")).length;
  const summary = failCount ? `<p class="err">${failCount} kiểm tra THẤT BẠI (FAIL)</p>` : `<p class="ok-msg">Tất cả ${out.length} kiểm tra đều đạt (PASS)</p>`;
  document.getElementById("selftest").innerHTML = summary + "<pre>" + out.join("\n") + "</pre>";
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("rules-text").value = document.getElementById("default-rules-yaml").textContent.trim();
  cards = (jsyaml.load(document.getElementById("default-cards-yaml").textContent) || {}).cards || [];
  inventory = (jsyaml.load(document.getElementById("default-inventory-yaml").textContent) || {}).inventory || [];
  renderCardsTable();
  renderInventoryTable();
  applyRules();
  renderRackLayout();
  runSelfTest();
});
