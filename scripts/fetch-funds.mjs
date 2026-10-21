// ดึงข้อมูลกองทุนรวมทั้งตลาดจาก SEC Open Data (ก.ล.ต.) → data/funds.json
// ใช้: SEC_API_KEY=xxxx node scripts/fetch-funds.mjs
// ไม่มี dependency (Node 20+)
import fs from "node:fs/promises";
import path from "node:path";

const KEY = process.env.SEC_API_KEY;
const BASE = process.env.SEC_API_BASE || "https://api.sec.or.th";
const OUT_DIR = process.env.OUT_DIR || "data";
const MIN_GAP_MS = 80; // ก.ล.ต. จำกัด ~5,000 ครั้ง / 5 นาที
if (!KEY) { console.error("❌ ไม่พบ SEC_API_KEY"); process.exit(1); }

const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0, lastAt = 0;
const errors = [];

async function get(p, params = {}) {
  const u = new URL(BASE + p);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  for (let attempt = 0; attempt < 7; attempt++) {
    const wait = lastAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now(); calls++;
    let res;
    try {
      res = await fetch(u, { headers: { "Ocp-Apim-Subscription-Key": KEY, Accept: "application/json" } });
    } catch (e) {
      console.warn(`  ⚠️ network error (${e.message}) ${p} — retry`);
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (res.status === 204) return { items: [], next_cursor: null };
    if ([421, 429, 500, 502, 503, 504].includes(res.status)) {
      const ra = Number(res.headers.get("retry-after")) || 5 * (attempt + 1);
      console.warn(`  ⏳ ${res.status} ${p} — รอ ${ra}s`);
      await sleep(ra * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${p}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
  throw new Error(`retry เกินกำหนด: ${p}`);
}

async function all(p, params, label) {
  const out = [];
  let cursor = "", page = 0;
  const seen = new Set();
  do {
    const j = await get(p, { ...params, page_size: 100, next_cursor: cursor });
    const items = Array.isArray(j) ? j : j.items || [];
    out.push(...items);
    cursor = Array.isArray(j) ? null : j.next_cursor;
    page++;
    if (cursor && seen.has(cursor)) { console.warn(`  ⚠️ cursor ซ้ำ หยุดที่ ${label}`); break; }
    if (cursor) seen.add(cursor);
    if (page % 25 === 0) console.log(`  … ${label}: ${out.length} แถว`);
  } while (cursor);
  console.log(`✓ ${label}: ${out.length} แถว (${page} หน้า)`);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=${label}::${out.length} rows, ${page} pages, ${Math.round((Date.now() - t0) / 1000)}s elapsed`);
  return out;
}

async function tryAll(p, params, label) {
  try { return await all(p, params, label); }
  catch (e) { console.error(`❌ ${label}: ${e.message}`); errors.push(`${label}: ${e.message}`); return []; }
}

/* ── จัดประเภท ── */
const has = (s, re) => re.test(s || "");
function classify(f) {
  const t = [f.policy, ...f.spec, f.th, f.en, f.code].join(" | ");
  if (has(t, /money\s*market|ตลาดเงิน/i)) return "moneymarket";
  if (has(t, /property|reit|อสังหา|infrastructure|โครงสร้างพื้นฐาน|ทรัสต์เพื่อการลงทุน/i)) return "property";
  if (has(t, /gold|ทองคำ|commodit|สินค้าโภคภัณฑ์|oil|น้ำมัน/i)) return "commodity";
  if (has(f.policy, /mixed|ผสม|balanced|asset\s*allocation/i) || has(t, /กองทุนรวมผสม|mixed fund|balanced fund/i)) return "mixed";
  if (has(f.policy, /fixed\s*income|bond|ตราสารหนี้|debt/i) || has(t, /กองทุนรวมตราสารหนี้|fixed income fund|bond fund/i)) return "bond";
  if (has(f.policy, /equity|ตราสารทุน|หุ้น/i) || has(t, /equity|ตราสารทุน|หุ้น/i)) {
    return has(t, /foreign|ต่างประเทศ|\bfif\b|global|world|asia|china|japan|india|vietnam|us\b|usa|u\.s\.|america|europe|nasdaq|s&p|เวียดนาม|จีน|ญี่ปุ่น|อินเดีย|สหรัฐ|ยุโรป|โลก|เอเชีย/i)
      ? "global_equity" : "th_equity";
  }
  if (has(t, /fixed income|bond|ตราสารหนี้/i)) return "bond";
  return "other";
}
function taxType(f) {
  const t = [f.code, ...f.classes, f.th, f.en, ...f.spec].join(" ");
  if (/thai\s*esg\s*x|thaiesgx|tesgx/i.test(t)) return "ThaiESGX";
  if (/thai\s*esg|thaiesg|tesg|ไทยเพื่อความยั่งยืน/i.test(t)) return "ThaiESG";
  if (/\bssf|-ssf|ssfx|เพื่อการออม/i.test(t)) return "SSF";
  if (/\brmf|-rmf|เลี้ยงชีพ/i.test(t)) return "RMF";
  if (/\bltf|-ltf|ระยะยาว/i.test(t)) return "LTF";
  return null;
}
function riskNum(rs) {
  const m = String(rs || "").match(/RS(\d+)/i);
  if (!m) return null;
  return m[1] === "81" ? 8.1 : Number(m[1]);
}
function periodKey(s) {
  s = String(s || "").toLowerCase();
  if (/ytd|ตั้งแต่ต้นปี/.test(s)) return "ytd";
  if (/inception|จัดตั้ง/.test(s)) return "si";
  const m = s.match(/(\d+)\s*(ปี|y|year|เดือน|m|month)/);
  if (!m) return null;
  return m[1] + (/(เดือน|m)/.test(m[2]) && !/y/.test(m[2]) ? "m" : "y");
}
const isBenchmark = (s) => /benchmark|ดัชนีชี้วัด|เกณฑ์มาตรฐาน|ตัวชี้วัด/i.test(s || "");
const isFundReturn = (s) => !isBenchmark(s) && /return|ผลตอบแทน|ผลการดำเนินงาน|กองทุน/i.test(s || "") && !/sd|standard deviation|ความผันผวน|ส่วนเบี่ยงเบน|percentile|เปอร์เซ็นไทล์/i.test(s || "");

/* ── main ── */
const amcs = await all("/v2/fund/general-info/amcs", {}, "บลจ.");
const profiles = await all("/v2/fund/general-info/profiles", { fund_status: "Registered" }, "รายชื่อกองทุน");
const specs = await tryAll("/v2/fund/general-info/specifications", {}, "ลักษณะพิเศษ");
const fees = await tryAll("/v2/fund/general-info/mutual-fund-fees", {}, "ค่าธรรมเนียม");
const risks = await tryAll("/v2/fund/factsheet/risk-spectrum", { latest: "true" }, "ระดับความเสี่ยง");
const perfs = await tryAll("/v2/fund/factsheet/performance", { latest: "true" }, "ผลการดำเนินงาน");
const sellers = await tryAll("/v2/fund/general-info/involve-parties", { entity_type: "S" }, "ผู้สนับสนุนการขาย");
const urls = await tryAll("/v2/fund/factsheet/urls", {}, "ลิงก์ factsheet");

const amcName = Object.fromEntries(amcs.map((a) => [a.unique_id, a.comp_name_th || a.comp_name_en || a.unique_id]));
const F = new Map();
for (const p of profiles) {
  if (!p.proj_id) continue;
  let f = F.get(p.proj_id);
  if (!f) {
    f = { id: p.proj_id, code: (p.proj_abbr_name || p.proj_id).trim(), th: p.proj_name_th || "", en: p.proj_name_en || "",
      amc: amcName[p.unique_id] || p.unique_id || "", policy: p.policy_desc || "", style: p.management_style || "",
      since: (p.init_date || p.regis_date || "").slice(0, 10) || null, classes: [], spec: [], fees: {}, rs: null, rsAt: "", perf: [], perfAt: "", sa: new Set(), url: null };
    F.set(p.proj_id, f);
  }
  const c = (p.fund_class_name || "").trim();
  if (c && !f.classes.includes(c)) f.classes.push(c);
}
for (const s of specs) { const f = F.get(s.proj_id); if (f && s.spec_desc && !f.spec.includes(s.spec_desc)) f.spec.push(s.spec_desc); }
for (const r of fees) {
  const f = F.get(r.proj_id); if (!f) continue;
  const c = (r.fund_class_name || "main").trim() || "main";
  (f.fees[c] ||= []).push([r.fee_type_desc || "", r.rate ?? null, r.rate_unit || "", r.fee_other_desc || ""]);
}
for (const r of risks) {
  const f = F.get(r.proj_id); if (!f) continue;
  if (!f.rs || (r.start_date || "") >= f.rsAt) { f.rs = riskNum(r.risk_spectrum); f.rsAt = r.start_date || ""; }
}
const perfLatest = {};
for (const r of perfs) { const sd = r.start_date || ""; if (!perfLatest[r.proj_id] || sd > perfLatest[r.proj_id]) perfLatest[r.proj_id] = sd; }
for (const r of perfs) {
  const f = F.get(r.proj_id); if (!f || (r.start_date || "") !== perfLatest[r.proj_id]) continue;
  f.perfAt = r.start_date || "";
  if (!f.perf.some((x) => x[0] === r.performance_type_desc && x[1] === r.reference_period))
    f.perf.push([r.performance_type_desc || "", r.reference_period || "", r.performance_value ?? null]);
}
const agentIdx = new Map(), agents = [];
for (const r of sellers) {
  const f = F.get(r.proj_id); if (!f) continue;
  const name = (r.entity_name_th || r.entity_name_en || "").replace(/\s+/g, " ").trim();
  if (!name) continue;
  if (!agentIdx.has(name)) { agentIdx.set(name, agents.length); agents.push(name); }
  f.sa.add(agentIdx.get(name));
}
for (const u of urls) { const f = F.get(u.proj_id); if (f && !f.url) f.url = u.pdf_factsheet || u.amc_url_factsheet || null; }

const num = (v) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
const out = [];
for (const f of F.values()) {
  const firstFees = f.fees[f.classes[0]] || Object.values(f.fees)[0] || [];
  const ter = firstFees.find((x) => /รวมทั้งหมด|total expense/i.test(x[0]));
  const mgmt = firstFees.find((x) => /การจัดการ|management/i.test(x[0]));
  const ret = {};
  for (const [type, period, val] of f.perf) {
    if (!isFundReturn(type)) continue;
    const k = periodKey(period);
    if (k && ret[k] === undefined) ret[k] = num(val);
  }
  out.push({
    id: f.id, c: f.code, th: f.th, en: f.en, amc: f.amc, cls: f.classes,
    a: classify(f), tax: taxType(f), rs: f.rs, pol: f.policy, sp: f.spec, since: f.since,
    ter: ter ? num(ter[1]) : null, mf: mgmt ? num(mgmt[1]) : null,
    r: ret, perf: f.perf.map(([t, p, v]) => [t, p, num(v)]), perfAt: f.perfAt || null,
    fee: Object.fromEntries(Object.entries(f.fees).slice(0, 4).map(([c, rows]) => [c, rows.slice(0, 14).map(([t, r, u, o]) => [t, num(r), u, o])])),
    sa: [...f.sa].sort((a, b) => a - b), url: f.url,
  });
}
out.sort((a, b) => a.c.localeCompare(b.c));

/* ── sanity check: อย่าเขียนทับข้อมูลเดิมด้วยข้อมูลที่พัง ── */
if (out.length < 100) { console.error(`❌ ได้กองทุนแค่ ${out.length} กอง — ไม่บันทึก`); process.exit(1); }

const count = (arr) => { const m = {}; for (const x of arr) if (x != null && x !== "") m[x] = (m[x] || 0) + 1; return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 80)); };
const discovery = {
  generatedAt: new Date().toISOString(), calls, seconds: Math.round((Date.now() - t0) / 1000), errors,
  totals: { funds: out.length, amcs: amcs.length, agents: agents.length, profiles: profiles.length, specs: specs.length, fees: fees.length, risks: risks.length, perfs: perfs.length, sellers: sellers.length, urls: urls.length },
  coverage: { withRisk: out.filter((f) => f.rs).length, withTER: out.filter((f) => f.ter != null).length, with1y: out.filter((f) => f.r["1y"] != null).length, withSellers: out.filter((f) => f.sa.length).length, withUrl: out.filter((f) => f.url).length },
  assetClass: count(out.map((f) => f.a)), taxType: count(out.map((f) => f.tax)),
  policy_desc: count(out.map((f) => f.pol)), spec_desc: count(out.flatMap((f) => f.sp)),
  performance_type_desc: count(perfs.map((r) => r.performance_type_desc)), reference_period: count(perfs.map((r) => r.reference_period)),
  fee_type_desc: count(fees.map((r) => r.fee_type_desc)), risk_spectrum: count(risks.map((r) => r.risk_spectrum)),
  topAgents: Object.fromEntries(agents.map((n, i) => [n, out.filter((f) => f.sa.includes(i)).length]).sort((a, b) => b[1] - a[1]).slice(0, 60)),
  otherSamples: out.filter((f) => f.a === "other").slice(0, 25).map((f) => `${f.c} | ${f.pol} | ${f.sp.join(", ")}`),
};

await fs.mkdir(OUT_DIR, { recursive: true });
const payload = { updated: new Date().toISOString(), source: "SEC Open Data (api.sec.or.th)", agents, funds: out };
await fs.writeFile(path.join(OUT_DIR, "funds.json"), JSON.stringify(payload));
await fs.writeFile(path.join(OUT_DIR, "discovery.json"), JSON.stringify(discovery, null, 1));
const size = (await fs.stat(path.join(OUT_DIR, "funds.json"))).size;
console.log(`\n✅ บันทึก ${out.length} กอง · ผู้ขาย ${agents.length} ราย · ${(size / 1024 / 1024).toFixed(2)} MB · ${calls} requests · ${discovery.seconds}s`);
console.log("coverage:", JSON.stringify(discovery.coverage));
console.log("asset:", JSON.stringify(discovery.assetClass), "tax:", JSON.stringify(discovery.taxType));
if (errors.length) console.log("⚠️ errors:", errors);
if (process.env.GITHUB_ACTIONS) {
  console.log(`::notice title=สรุป::${out.length} funds, ${agents.length} agents, ${(size / 1024 / 1024).toFixed(2)} MB, ${calls} calls, ${discovery.seconds}s`);
  console.log(`::notice title=coverage::${JSON.stringify(discovery.coverage)} asset=${JSON.stringify(discovery.assetClass)} tax=${JSON.stringify(discovery.taxType)}`);
  for (const e of errors) console.log(`::warning title=endpoint error::${e.replace(/\n/g, " ")}`);
}
