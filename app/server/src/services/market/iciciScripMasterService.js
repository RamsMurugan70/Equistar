// ICICI broker code -> NSE symbol, from ICICI's own published security master.
//
// THE PROBLEM: ICICI reports holdings under its private codes (APOHOS, COALIN, VATWAB) while
// every price source keys on NSE symbols (APOLLOHOSP, COALINDIA, WABAG). The hand-written map in
// portfolioService covers one owner's book, twenty-odd codes, and cannot keep up with a second
// participant: every stock bought is a new code, and the failure is silent — the holding renders,
// just unpriced. One participant's ICICI account had 38 of 50 holdings unmapped.
//
// ICICI publishes the entire mapping. SecurityMaster.zip -> NSEScripMaster.txt carries ShortName
// (their code), ExchangeCode (the NSE symbol), ISIN and company name for ~5,900 instruments;
// BSEScripMaster.txt covers what trades only on BSE. Neither needs a session or API key. Ported from the Equix/Core server, where all 20 hand-maintained
// mappings were re-derived from it and every one matched.
//
// WHERE IT LIVES: this participant's own database (`main.`), like the price cache, because the
// shared market file belongs to the hub. It is refreshed at most once every 20 hours.
const https = require('https');
const zlib = require('zlib');
const { openDatabase, allAsync, runAsync, closeAsync } = require('../../db/connection');

const URL = 'https://directlink.icicidirect.com/NewSecurityMaster/SecurityMaster.zip';
const MAX_AGE_HOURS = 20;

// Held in memory so resolution stays synchronous once primed.
let CODE_TO_NSE = new Map();
let NSE_CODES = new Set();
let NAMES = new Map();

// `exchange` is NSE for rows from the NSE master and BSE for the BSE-only remainder. A BSE-only
// stock (NSDL, which cannot list on the exchange that part-owns it, is the live example) is absent
// from the NSE file entirely, so without the BSE file its holding had no symbol at all.
async function ensureTable(db) {
  await runAsync(db, `CREATE TABLE IF NOT EXISTS main.icici_scrip_master (
    short_name    TEXT PRIMARY KEY,
    exchange_code TEXT NOT NULL,
    series        TEXT,
    isin          TEXT,
    company_name  TEXT,
    exchange      TEXT NOT NULL DEFAULT 'NSE',
    updated_at    TEXT NOT NULL)`);
}

function download() {
  return new Promise((resolve, reject) => {
    const req = https.get(URL, { timeout: 120000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Minimal ZIP reader for one member. A dependency for this alone is not worth it and the archive
// layout is fixed; if it ever changes, the parse fails loudly rather than importing nothing.
function unzipMember(buf, wanted) {
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;            // end of central directory
    let off = buf.readUInt32LE(i + 16);
    const count = buf.readUInt16LE(i + 10);
    for (let n = 0; n < count; n += 1) {
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const cmtLen = buf.readUInt16LE(off + 32);
      const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
      const local = buf.readUInt32LE(off + 42);
      const compSize = buf.readUInt32LE(off + 20);
      if (name === wanted) {
        const lNameLen = buf.readUInt16LE(local + 26);
        const lExtraLen = buf.readUInt16LE(local + 28);
        const start = local + 30 + lNameLen + lExtraLen;
        const method = buf.readUInt16LE(local + 8);
        const body = buf.slice(start, start + compSize);
        return method === 0 ? body : zlib.inflateRawSync(body);
      }
      off += 46 + nameLen + extraLen + cmtLen;
    }
  }
  throw new Error(`${wanted} not found in archive`);
}

// The master stores names in capitals; cased down for display, initialisms kept.
const KEEP_UPPER = new Set(['ICICI', 'HDFC', 'SBI', 'IDFC', 'ITC', 'ONGC', 'NTPC', 'GAIL', 'BPCL',
  'HPCL', 'IOC', 'LIC', 'TVS', 'MRF', 'ACC', 'UPL', 'PNB', 'IDBI', 'RBL', 'DLF', 'JSW', 'NMDC',
  'BSE', 'NSE', 'ETF', 'AMC', 'REIT', 'INVIT', 'IT', 'FMCG', 'PSU', 'CSB', 'UTI', 'L&T', 'GE',
  'BEL', 'BEML', 'HAL', 'IRCTC', 'IRFC', 'RVNL', 'NHPC', 'SJVN', 'MOIL', 'KIOCL', 'SGB', 'CPSE']);
const MINOR = new Set(['OF', 'AND', 'THE', 'FOR', 'IN', 'ON', 'AT', 'TO', 'DE', 'A']);

function titleCase(raw) {
  return String(raw || '').trim().split(/\s+/).map((w, i) => {
    const bare = w.replace(/[^A-Za-z&]/g, '').toUpperCase();
    if (KEEP_UPPER.has(bare)) return w.toUpperCase();
    if (i > 0 && MINOR.has(bare)) return w.toLowerCase();
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

const unq = (s) => String(s ?? '').trim().replace(/^"|"$/g, '').trim();

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') { q = !q; cur += ch; } else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

// Rows of one member file as { short, code, series, isin, name }. `codeCol` is the column holding
// the exchange's own ticker: ExchangeCode in the NSE file, ScripID in the BSE file (whose
// ExchangeCode is the numeric scrip code, which no price source keys on).
function readMember(zip, member, codeCol) {
  const lines = unzipMember(zip, member).toString('utf8').split(/\r?\n/).filter((l) => l.trim());
  const hdr = parseCsvLine(lines[0]).map(unq);
  const [iShort, iCode, iSer, iIsin, iName] = ['ShortName', codeCol, 'Series', 'ISINCode', 'CompanyName'].map((n) => hdr.indexOf(n));
  if (iShort < 0 || iCode < 0) throw new Error(`${member} layout changed: ShortName/${codeCol} missing`);
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const r = parseCsvLine(lines[i]);
    const short = unq(r[iShort]).toUpperCase();
    const code = unq(r[iCode]).toUpperCase();
    if (short && code) out.push({ short, code, series: unq(r[iSer]) || null, isin: unq(r[iIsin]) || null, name: unq(r[iName]) || null });
  }
  return out;
}

async function refresh(db) {
  const zip = await download();
  const nse = readMember(zip, 'NSEScripMaster.txt', 'ExchangeCode');
  const seen = new Set(nse.map((r) => r.short));
  // NSE wins wherever both list a code; BSE fills in only what NSE does not carry.
  const bse = readMember(zip, 'BSEScripMaster.txt', 'ScripID').filter((r) => !seen.has(r.short));

  await runAsync(db, 'BEGIN IMMEDIATE');
  try {
    for (const [exchange, rows] of [['NSE', nse], ['BSE', bse]]) {
      for (const r of rows) {
        await runAsync(db, `INSERT INTO main.icici_scrip_master
          (short_name, exchange_code, series, isin, company_name, exchange, updated_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(short_name) DO UPDATE SET exchange_code=excluded.exchange_code, series=excluded.series,
            isin=excluded.isin, company_name=excluded.company_name, exchange=excluded.exchange,
            updated_at=CURRENT_TIMESTAMP`,
        [r.short, r.code, r.series, r.isin, r.name, exchange]);
      }
    }
    await runAsync(db, 'COMMIT');
  } catch (e) {
    await runAsync(db, 'ROLLBACK').catch(() => {});
    throw e;
  }
}

async function prime(db) {
  const rows = await allAsync(db, 'SELECT short_name, exchange_code, company_name FROM main.icici_scrip_master');
  const m = new Map();
  const e = new Set();
  const n = new Map();
  for (const r of rows) {
    const code = String(r.short_name).toUpperCase();
    const exch = String(r.exchange_code).toUpperCase();
    m.set(code, exch);
    e.add(exch);
    if (r.company_name) {
      const nice = titleCase(r.company_name);
      n.set(code, nice);
      if (!n.has(exch)) n.set(exch, nice);
    }
  }
  CODE_TO_NSE = m; NSE_CODES = e; NAMES = n;
  return m.size;
}

let loading = null;

/**
 * Makes sure the master is loaded and no older than 20 hours. Never throws: if ICICI cannot be
 * reached, whatever copy is stored is used, and if there is none, resolution simply returns null.
 * Returns { ok, size, error }.
 */
function ensureFresh() {
  if (!loading) {
    loading = (async () => {
      const db = openDatabase();
      try {
        await ensureTable(db);
        const newest = (await allAsync(db, 'SELECT MAX(updated_at) AS t FROM main.icici_scrip_master'))[0]?.t;
        const ageH = newest ? (Date.now() - Date.parse(`${newest.replace(' ', 'T')}Z`)) / 3600000 : Infinity;
        let error = null;
        let refreshed = false;
        if (!(ageH < MAX_AGE_HOURS)) {
          try { await refresh(db); refreshed = true; } catch (e) { error = e.message; }
        }
        const size = refreshed || !CODE_TO_NSE.size ? await prime(db) : CODE_TO_NSE.size;
        return { ok: size > 0, size, error };
      } catch (e) {
        return { ok: CODE_TO_NSE.size > 0, size: CODE_TO_NSE.size, error: e.message };
      } finally {
        await closeAsync(db).catch(() => {});
      }
    })().finally(() => { setTimeout(() => { loading = null; }, 60000); });
  }
  return loading;
}

// The NSE symbol for an ICICI code, or null. Returns null when the input is ALREADY a live NSE
// symbol, even if another instrument uses the same string as its short name: rewriting a valid
// symbol would be a silent corruption worse than the missing mapping this exists to fix.
function getMapped(code) {
  const s = String(code || '').toUpperCase();
  if (!s || !CODE_TO_NSE.size || NSE_CODES.has(s)) return null;
  return CODE_TO_NSE.get(s) || null;
}

// True when the master is loaded and does not list this code at all.
function isUnknown(code) {
  const s = String(code || '').toUpperCase();
  return CODE_TO_NSE.size > 0 && !CODE_TO_NSE.has(s) && !NSE_CODES.has(s);
}

// Company name for a broker code or an NSE symbol; null when the master does not carry it.
function getName(symbol) {
  return NAMES.get(String(symbol || '').toUpperCase()) || null;
}

module.exports = { ensureFresh, getMapped, getName, isUnknown };
