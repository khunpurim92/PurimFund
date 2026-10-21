// ดึงข้อมูลกองทุนรวมทั้งตลาดจาก SEC Open Data (ก.ล.ต.) → data/funds.json + data/discovery.json
// ใช้: SEC_API_KEY=xxxx node scripts/fetch-funds.mjs
// ไม่มี dependency (Node 20+)
import fs from "node:fs/promises";
import path from "node:path";

const KEY = process.env.SEC_API_KEY;
const BASE = process.env.SEC_API_BASE || "https://api.sec.or.th";
const OUT_DIR = process.env.OUT_DIR || "data";
const MIN_GAP_MS = 70;          // ก.ล.ต. จำกัด ~5,000 ครั้ง / 5 นาที (เฉลี่ยห่าง ≥ 60ms)
const MAX_MB = 60;              // GitHub รับไฟล์ไม่เกิน 100MB
const GH = !!process.env.GITHUB_ACTIONS;
if (!KEY) { console.error("❌ ไม่พบ SEC_API_KEY"); process.exit(1); }

const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = () => Math.round((Date.now() - t0) / 1000);
const note = (title, msg) => { console.log(`[${title}] ${msg}`); if (GH) console.log(`::notice title=${title}::${String(msg).replace(/\r?\n/g, " ").slice(0, 900)}`); };
const cut = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
let calls = 0, nextSlot = 0;
const errors = [];

/* ── HTTP (ใช้ร่วมกันหลาย worker โดยเว้นช่วงเท่ากัน) ── */
async function slot() { const now = Date.now(), at = Math.max(now, nextSlot); nextSlot = at + MIN_GAP_MS; if (at > now) await sleep(at - now); }
async function get(p, params = {}) {
  const u = new URL(BASE + p);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  for (let attempt = 0; attempt < 7; attempt++) {
    await slot(); calls++;
    let res;
    try { res = await fetch(u, { headers: { "Ocp-Apim-Subscription-Key": KEY, Accept: "application/json" } }); }
    catch (e) { console.warn(`  ⚠️ network error (${e.message}) ${p}`); await sleep(2000 * (attempt + 1)); continue; }
    if (res.status === 204) return { items: [], next_cursor: null };
    if ([421, 429, 500, 502, 503, 504].includes(res.status)) {
      const ra = Number(res.headers.get("retry-after")) || 5 * (attempt + 1);
      console.warn(`  ⏳ ${res.status} ${p} — รอ ${ra}s`); await sleep(ra * 1000); continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${p}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error(`retry เกินกำหนด: ${p}`);
}
async function all(p, params, label, { quiet = false, maxPages = 5000 } = {}) {
  const out = []; let cursor = "", page = 0; const seen = new Set();
  do {
    const j = await get(p, { ...params, page_size: 100, next_cursor: cursor });
    const items = Array.isArray(j) ? j : j.items || [];
    out.push(...items);
    cursor = Array.isArray(j) ? null : j.next_cursor;
    page++;
    if (cursor && seen.has(cursor)) { console.warn(`  ⚠️ cursor ซ้ำ หยุดที่ ${label}`); break; }
    if (cursor) seen.add(cursor);
    if (page >= maxPages) { console.warn(`  ⚠️ เกิน ${maxPages} หน้า หยุดที่ ${label}`); break; }
    if (!quiet && page % 50 === 0) console.log(`  … ${label}: ${out.length} แถว`);
  } while (cursor);
  if (!quiet) note(label, `${out.length} rows, ${page} pages, ${secs()}s`);
  return out;
}
async function tryAll(p, params, label, opt) {
  try { return await all(p, params, label, opt); }
  catch (e) { console.error(`❌ ${label}: ${e.message}`); errors.push(`${label}: ${e.message}`); return []; }
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }

/* ── จัดประเภท ── */
const has = (s, re) => re.test(s || "");
function classify(f) {
  const t = [f.policy, ...f.spec, f.th, f.en, f.code].join(" | ");
  if (has(t, /money\s*market|ตลาดเงิน/i)) return "moneymarket";
  if (has(t, /property|reit|อสังหา|infrastructure|โครงสร้างพื้นฐาน|ทรัสต์เพื่อการลงทุน/i)) return "property";
  if (has(t, /gold|ทองคำ|commodit|สินค้าโภคภัณฑ์|\boil\b|น้ำมัน/i)) return "commodity";
  if (has(f.policy, /mixed|ผสม|balanced|asset\s*allocation/i) || has(t, /กองทุนรวมผสม|mixed fund|balanced fund/i)) return "mixed";
  if (has(f.policy, /fixed\s*income|bond|ตราสารหนี้|debt/i) || has(t, /กองทุนรวมตราสารหนี้|fixed income fund|bond fund/i)) return "bond";
  if (has(f.policy, /equity|ตราสารทุน|หุ้น/i) || has(t, /equity|ตราสารทุน|หุ้น/i)) {
    return has(t, /feeder|ฟีดเดอร์|foreign|ต่างประเทศ|\bfif\b|global|world|asia|china|japan|india|vietnam|\bus\b|usa|u\.s\.|america|europe|nasdaq|s&p|เวียดนาม|จีน|ญี่ปุ่น|อินเดีย|สหรัฐ|ยุโรป|โลก|เอเชีย/i) ? "global_equity" : "th_equity";
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
const riskNum = (rs) => { const m = String(rs || "").match(/RS(\d+)/i); return m ? (m[1] === "81" ? 8.1 : Number(m[1])) : null; };
function periodKey(s) {
  s = String(s || "").toLowerCase();
  if (/ytd|ตั้งแต่ต้นปี|year\s*to\s*date/.test(s)) return "ytd";
  if (/inception|จัดตั้ง/.test(s)) return "si";
  const m = s.match(/(\d+)\s*(ปี|y|year|เดือน|m|month)/);
  if (!m) return null;
  return m[1] + (/^(เดือน|m|month)/.test(m[2]) ? "m" : "y");
}
const isBenchmark = (s) => /benchmark|ดัชนีชี้วัด|เกณฑ์มาตรฐาน|ตัวชี้วัด/i.test(s || "");
const isVol = (s) => /sd|standard deviation|ความผันผวน|ส่วนเบี่ยงเบน|percentile|เปอร์เซ็นไทล์|volatil/i.test(s || "");
const isFundReturn = (s) => !isBenchmark(s) && !isVol(s);
const isTER = (s) => /total|รวมทั้งหมด|ค่าใช้จ่ายรวม|\bter\b/i.test(s || "");
const isMgmt = (s) => /management|การจัดการ/i.test(s || "");
const isSeller = (r) => r && (/^s$|sell|ผู้สนับสนุน|ตัวแทนขาย|distribut/i.test(String(r.entity_type || "").trim()) || /sell|ผู้สนับสนุนการขาย|distribut/i.test(String(r.entity_type_desc || r.entity_type_name || "")));
const numv = (v) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Math.round(Number(v) * 100) / 100);

/* ── ดึงข้อมูล ── */
const amcs = await all("/v2/fund/general-info/amcs", {}, "บลจ.");
const profiles = await all("/v2/fund/general-info/profiles", { fund_status: "Registered" }, "รายชื่อกองทุน");
const projIds = [...new Set(profiles.map((p) => p.proj_id).filter(Boolean))];

const R = {};
await Promise.all([
  tryAll("/v2/fund/general-info/specifications", {}, "ลักษณะพิเศษ").then((x) => (R.specs = x)),
  tryAll("/v2/fund/general-info/mutual-fund-fees", {}, "ค่าธรรมเนียม").then((x) => (R.fees = x)),
  tryAll("/v2/fund/factsheet/fees", { latest: "true" }, "ค่าธรรมเนียม factsheet").then((x) => (R.ffees = x)),
  tryAll("/v2/fund/factsheet/risk-spectrum", { latest: "true" }, "ระดับความเสี่ยง").then((x) => (R.risks = x)),
  tryAll("/v2/fund/factsheet/performance", { latest: "true" }, "ผลการดำเนินงาน").then((x) => (R.perfs = x)),
  tryAll("/v2/fund/factsheet/urls", {}, "ลิงก์ factsheet").then((x) => (R.urls = x)),
]);

/* ผู้สนับสนุนการขาย: ลองกรองที่ API ก่อน → ถ้าไม่ได้ ดึงทั้งหมดแล้วกรองเอง → ถ้ายังไม่ได้ ดึงรายกอง */
let sellers = [], sellerMode = "";
const etypes = {};
const tally = (rows) => rows.forEach((r) => { const k = `${r.entity_type ?? "?"}${r.entity_type_desc ? ":" + cut(r.entity_type_desc, 30) : ""}`; etypes[k] = (etypes[k] || 0) + 1; });
sellers = await tryAll("/v2/fund/general-info/involve-parties", { entity_type: "S" }, "ผู้ขาย (กรอง S)");
if (sellers.length) sellerMode = "filter-S";
else {
  let sample = [];
  try { const j = await get("/v2/fund/general-info/involve-parties", { page_size: 100 }); sample = j.items || []; } catch (e) { errors.push("involve sample: " + e.message); }
  tally(sample);
  note("involve-parties ตัวอย่าง", `${sample.length} rows; entity types: ${JSON.stringify(etypes)}; keys: ${Object.keys(sample[0] || {}).join(",")}`);
  if (sample.length) {
    const rows = await tryAll("/v2/fund/general-info/involve-parties", {}, "ผู้เกี่ยวข้องทั้งหมด");
    tally(rows); sellers = rows.filter(isSeller); sellerMode = "all-then-filter";
  } else {
    const rows = [];
    await pool(projIds, 4, async (id, k) => {
      try { rows.push(...(await all("/v2/fund/general-info/involve-parties", { proj_id: id }, "involve " + id, { quiet: true, maxPages: 20 }))); }
      catch (e) { if (errors.length < 30) errors.push(`involve ${id}: ${e.message}`); }
      if (k % 250 === 0) console.log(`  … ผู้ขายรายกอง ${k}/${projIds.length} (${secs()}s)`);
    });
    tally(rows); sellers = rows.filter(isSeller); sellerMode = "per-fund";
  }
}
note("ผู้สนับสนุนการขาย", `${sellers.length} rows via ${sellerMode}; entity types: ${JSON.stringify(etypes).slice(0, 600)}`);

/* ── รวมข้อมูลรายกอง ── */
const amcName = Object.fromEntries(amcs.map((a) => [a.unique_id, a.comp_name_th || a.comp_name_en || a.unique_id]));
const F = new Map();
for (const p of profiles) {
  if (!p.proj_id) continue;
  let f = F.get(p.proj_id);
  if (!f) {
    f = { id: p.proj_id, code: (p.proj_abbr_name || p.proj_id).trim(), th: p.proj_name_th || "", en: p.proj_name_en || "", amc: amcName[p.unique_id] || p.unique_id || "",
      policy: p.policy_desc || "", since: (p.init_date || p.regis_date || "").slice(0, 10) || null, classes: [], spec: [], fees: {}, ffees: [], rs: null, rsAt: "", perf: [], perfAt: "", sa: new Set(), url: null };
    F.set(p.proj_id, f);
  }
  const c = (p.fund_class_name || "").trim();
  if (c && !f.classes.includes(c)) f.classes.push(c);
}
for (const s of R.specs) { const f = F.get(s.proj_id); if (f && s.spec_desc && !f.spec.includes(s.spec_desc)) f.spec.push(s.spec_desc); }
for (const r of R.fees) {
  const f = F.get(r.proj_id); if (!f) continue;
  const c = (r.fund_class_name || "main").trim() || "main";
  (f.fees[c] ||= []).push([cut(r.fee_type_desc, 70), numv(r.rate), cut(r.rate_unit, 30)]);
}
const ffLatest = {};
for (const r of R.ffees) if (!ffLatest[r.proj_id] || (r.start_date || "") > ffLatest[r.proj_id]) ffLatest[r.proj_id] = r.start_date || "";
for (const r of R.ffees) { const f = F.get(r.proj_id); if (f && (r.start_date || "") === ffLatest[r.proj_id] && f.ffees.length < 10 && !f.ffees.some((x) => x[0] === cut(r.fee_type_desc, 70))) f.ffees.push([cut(r.fee_type_desc, 70), numv(r.rate), numv(r.actual_value)]); }
for (const r of R.risks) { const f = F.get(r.proj_id); if (f && (!f.rs || (r.start_date || "") >= f.rsAt)) { f.rs = riskNum(r.risk_spectrum); f.rsAt = r.start_date || ""; } }
const perfLatest = {};
for (const r of R.perfs) if (!perfLatest[r.proj_id] || (r.start_date || "") > perfLatest[r.proj_id]) perfLatest[r.proj_id] = r.start_date || "";
/* ผลการดำเนินงาน: แยก กองทุน / ตัวชี้วัด / ค่าเฉลี่ยกลุ่ม / ความผันผวน และผลตอบแทนรายปีปฏิทิน */
const perfKind = (t) => /ผลตอบแทนกองทุน|fund return/i.test(t) ? "r" : /ผลตอบแทนตัวชี้วัด|benchmark return/i.test(t) ? "b" : /ค่าเฉลี่ยในกลุ่ม|peer/i.test(t) ? "pg" : /ความผันผวนของกองทุน|fund (sd|volatil)/i.test(t) ? "sd" : /ความผันผวนของตัวชี้วัด/i.test(t) ? "bsd" : null;
for (const r of R.perfs) {
  const f = F.get(r.proj_id); if (!f || (r.start_date || "") !== perfLatest[r.proj_id]) continue;
  f.perfAt = r.start_date || "";
  const kind = perfKind(r.performance_type_desc || ""), v = numv(r.performance_value), per = String(r.reference_period || "").trim();
  if (!kind || v == null) continue;
  f.pf ||= { r: {}, b: {}, pg: {}, sd: {}, cal: {}, bcal: {} };
  if (/^\d{4}$/.test(per)) { if (kind === "r") f.pf.cal[per] = v; else if (kind === "b") f.pf.bcal[per] = v; continue; }
  const k = periodKey(per); if (!k) continue;
  if (kind === "bsd") continue;
  if (f.pf[kind][k] === undefined) f.pf[kind][k] = v;
}
const agentIdx = new Map(), agents = [];
for (const r of sellers) {
  const f = F.get(r.proj_id); if (!f) continue;
  const name = cut(r.entity_name_th || r.entity_name_en || "", 90);
  if (!name) continue;
  if (!agentIdx.has(name)) { agentIdx.set(name, agents.length); agents.push(name); }
  f.sa.add(agentIdx.get(name));
}
for (const u of R.urls) { const f = F.get(u.proj_id); if (f && !f.url) f.url = u.pdf_factsheet || u.amc_url_factsheet || null; }

const out = [];
for (const f of F.values()) {
  const feeRows = f.fees[f.classes[0]] || Object.values(f.fees)[0] || [];
  /* ค่าที่เก็บจริงจาก factsheet ก่อน ถ้าไม่มีใช้เพดานจากหนังสือชี้ชวน */
  const fTer = f.ffees.find((x) => isTER(x[0]) && (x[2] ?? x[1]) != null), fMg = f.ffees.find((x) => isMgmt(x[0]) && (x[2] ?? x[1]) != null);
  const gTer = feeRows.find((x) => isTER(x[0]) && x[1] != null), gMg = feeRows.find((x) => isMgmt(x[0]) && x[1] != null);
  const ter = fTer ? fTer[2] ?? fTer[1] : null, terMax = gTer ? gTer[1] : null;
  const mf = fMg ? fMg[2] ?? fMg[1] : gMg ? gMg[1] : null;
  const pf = f.pf || { r: {}, b: {}, pg: {}, sd: {}, cal: {}, bcal: {} };
  const lastYears = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[0] - a[0]).slice(0, 6));
  out.push({
    id: f.id, c: f.code, th: cut(f.th, 140), en: cut(f.en, 140), amc: f.amc, cls: f.classes.slice(0, 8),
    a: classify(f), tax: taxType(f), rs: f.rs, pol: cut(f.policy, 60), sp: f.spec.slice(0, 6).map((s) => cut(s, 80)), since: f.since,
    ter, terMax, mf, r: pf.r, b: pf.b, pg: pf.pg, sd: pf.sd, cal: lastYears(pf.cal), bcal: lastYears(pf.bcal), perfAt: f.perfAt || null,
    ff: f.ffees,
    sa: [...f.sa].sort((a, b) => a - b), url: f.url ? cut(f.url, 300) : null,
  });
}
out.sort((a, b) => a.c.localeCompare(b.c));

/* ── discovery: สรุปค่าจริงจาก API ไว้ปรับปรุงการจัดประเภท ── */
const count = (arr, n = 60) => { const m = {}; for (const x of arr) if (x != null && x !== "") m[x] = (m[x] || 0) + 1; return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n)); };
const fieldBytes = {}; for (const f of out) for (const [k, v] of Object.entries(f)) fieldBytes[k] = (fieldBytes[k] || 0) + JSON.stringify(v).length;
const discovery = {
  generatedAt: new Date().toISOString(), calls, seconds: secs(), errors: errors.slice(0, 40), sellerMode, entityTypes: etypes,
  totals: { funds: out.length, amcs: amcs.length, agents: agents.length, profiles: profiles.length, ...Object.fromEntries(Object.entries(R).map(([k, v]) => [k, v.length])), sellers: sellers.length },
  coverage: { withRisk: out.filter((f) => f.rs).length, withTER: out.filter((f) => f.ter != null).length, withTerMax: out.filter((f) => f.terMax != null).length, withPeer1y: out.filter((f) => f.pg["1y"] != null).length, withMgmt: out.filter((f) => f.mf != null).length, with1y: out.filter((f) => f.r["1y"] != null).length, with5y: out.filter((f) => f.r["5y"] != null).length, withSellers: out.filter((f) => f.sa.length).length, withUrl: out.filter((f) => f.url).length },
  fieldMB: Object.fromEntries(Object.entries(fieldBytes).map(([k, v]) => [k, +(v / 1048576).toFixed(2)]).sort((a, b) => b[1] - a[1])),
  assetClass: count(out.map((f) => f.a)), taxType: count(out.map((f) => f.tax)),
  policy_desc: count(out.map((f) => f.pol)), spec_desc: count(out.flatMap((f) => f.sp)),
  performance_type_desc: count(R.perfs.map((r) => r.performance_type_desc)), reference_period: count(R.perfs.map((r) => r.reference_period)),
  fee_type_desc: count(R.fees.map((r) => r.fee_type_desc)), factsheet_fee_type_desc: count(R.ffees.map((r) => r.fee_type_desc)), risk_spectrum: count(R.risks.map((r) => r.risk_spectrum)),
  samples: { fee: R.fees.slice(0, 3), ffee: R.ffees.slice(0, 3), perf: R.perfs.slice(0, 4), seller: sellers.slice(0, 3), profile: profiles.slice(0, 2) },
  topAgents: Object.fromEntries(agents.map((n, i) => [n, out.filter((f) => f.sa.includes(i)).length]).sort((a, b) => b[1] - a[1]).slice(0, 60)),
  otherSamples: out.filter((f) => f.a === "other").slice(0, 25).map((f) => `${f.c} | ${f.pol} | ${f.sp.join(", ")}`),
};

await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(OUT_DIR, "discovery.json"), JSON.stringify(discovery, null, 1));
const payload = JSON.stringify({ updated: new Date().toISOString(), source: "SEC Open Data (api.sec.or.th)", agents, funds: out });
const mb = Buffer.byteLength(payload) / 1048576;
note("coverage", JSON.stringify(discovery.coverage));
note("ขนาดแต่ละฟิลด์ (MB)", JSON.stringify(discovery.fieldMB));
note("fee types", JSON.stringify(Object.keys(discovery.fee_type_desc).slice(0, 12)));
note("perf types/periods", JSON.stringify(Object.keys(discovery.performance_type_desc).slice(0, 8)) + " / " + JSON.stringify(Object.keys(discovery.reference_period).slice(0, 10)));
if (out.length < 100) { console.error(`❌ ได้กองทุนแค่ ${out.length} กอง — ไม่บันทึก funds.json`); if (GH) console.log(`::error title=ข้อมูลไม่พอ::${out.length} funds`); process.exit(1); }
if (mb > MAX_MB) { console.error(`❌ funds.json ${mb.toFixed(1)}MB เกิน ${MAX_MB}MB — บันทึกเฉพาะ discovery.json`); if (GH) console.log(`::error title=ไฟล์ใหญ่เกิน::${mb.toFixed(1)}MB ${JSON.stringify(discovery.fieldMB)}`); process.exit(0); }
await fs.writeFile(path.join(OUT_DIR, "funds.json"), payload);
note("สรุป", `${out.length} funds, ${agents.length} agents, ${mb.toFixed(2)} MB, ${calls} calls, ${secs()}s`);
if (errors.length) for (const e of errors.slice(0, 10)) { console.log("⚠️", e); if (GH) console.log(`::warning title=endpoint error::${cut(e, 300)}`); }
