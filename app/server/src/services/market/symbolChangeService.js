// NSE's authoritative record of ticker renames, and nothing else.
//
// WHY THIS IS ITS OWN TABLE AND ITS OWN SERVICE, kept away from the broker-code map in
// portfolioService. The two look similar and are not the same thing:
//
//   A BROKER CODE is a stock's alias RIGHT NOW. ICICI calls Firstsource FIRSOU; NSE calls it
//   FSL; both names are live today and describe the same instrument at the same moment. The
//   mapping is between vocabularies.
//
//   A RENAME is one stock's identity changing OVER TIME. ZOMATO became ETERNAL on 2025-04-09.
//   Before that date the correct symbol is ZOMATO; after it, ETERNAL. The mapping is between
//   two points in the same instrument's history.
//
// Collapsing them into one dictionary loses the date, and the date is the whole content of a
// rename. It also fixes the order of resolution: the broker code must resolve FIRST, because a
// rename is stated in NSE symbols and cannot match a broker's private code. Resolve in the wrong
// order and a renamed stock that also has a broker alias is missed entirely.
//
// This table records what NSE says. It does NOT decide that a rename applies to anyone's book —
// that needs a second, independent confirmation from the book itself, and lives in
// portfolio/symbolRenameService.
const https = require('https');
const { openDatabase, allAsync, runAsync, getAsync, closeAsync } = require('../../db/connection');
const { onlyWhenOwned } = require('../../db/marketSchema');

const CSV_URLS = [
  'https://nsearchives.nseindia.com/content/equities/symbolchange.csv',
  'https://archives.nseindia.com/content/equities/symbolchange.csv',
];

const ensureSchema = onlyWhenOwned(async () => {
  const db = openDatabase();
  try {
    await runAsync(db, `
      CREATE TABLE IF NOT EXISTS nse_symbol_changes (
        old_symbol   TEXT NOT NULL,
        new_symbol   TEXT NOT NULL,
        company      TEXT,
        changed_on   TEXT,
        fetched_at   TEXT,
        PRIMARY KEY (old_symbol, new_symbol, changed_on)
      )`);
    await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_symchange_old ON nse_symbol_changes (old_symbol)');
    await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_symchange_new ON nse_symbol_changes (new_symbol)');
  } finally {
    await closeAsync(db);
  }
});

ensureSchema().catch((e) => console.error('symbolChange ensureSchema:', e.message));

function nseCookies() {
  return new Promise((resolve) => {
    const req = https.get('https://www.nseindia.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000,
    }, (res) => {
      const c = (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
      res.resume();
      resolve(c);
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

function fetchUrl(url, cookie, depth = 0) {
  return new Promise((resolve) => {
    if (depth > 3) return resolve(null);
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
        Accept: '*/*',
        Referer: 'https://www.nseindia.com/',
        Cookie: cookie,
      },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchUrl(res.headers.location, cookie, depth + 1));
      }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// "07-JUL-2008" → "2008-07-07". Returned null rather than guessed when the shape is unfamiliar:
// a rename with a wrong date is worse than one with no date, because the date is what decides
// which side of it a trade belongs to.
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
function parseNseDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[2].toUpperCase()];
  if (!mm) return null;
  return `${m[3]}-${String(mm).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// Minimal CSV split that respects quoted commas — company names in this file contain them.
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

async function refreshSymbolChanges() {
  const cookie = await nseCookies();
  let csv = null;
  for (const url of CSV_URLS) {
    csv = await fetchUrl(url, cookie);
    if (csv && csv.length > 1000) break;
  }
  if (!csv || csv.length < 1000) throw new Error('symbolchange.csv unavailable from NSE');

  const rows = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = splitCsvLine(line);
    if (parts.length < 4) continue;
    const [company, oldSym, newSym, when] = parts;
    // The file carries no header, but skip anything that looks like one anyway.
    if (/^symbol$/i.test(oldSym) || /^old/i.test(oldSym)) continue;
    if (!oldSym || !newSym) continue;
    rows.push({
      company,
      oldSymbol: oldSym.toUpperCase(),
      newSymbol: newSym.toUpperCase(),
      changedOn: parseNseDate(when),
    });
  }
  if (!rows.length) throw new Error('symbolchange.csv parsed to zero rows');

  const now = new Date().toISOString();
  const db = openDatabase();
  let saved = 0;
  try {
    await runAsync(db, 'BEGIN TRANSACTION');
    for (const r of rows) {
      const res = await runAsync(db,
        `INSERT OR IGNORE INTO nse_symbol_changes
           (old_symbol, new_symbol, company, changed_on, fetched_at)
         VALUES (?,?,?,?,?)`,
        [r.oldSymbol, r.newSymbol, r.company || null, r.changedOn, now]);
      if (res?.changes) saved += res.changes;
    }
    await runAsync(db, 'COMMIT');
  } catch (e) {
    await runAsync(db, 'ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await closeAsync(db);
  }
  return { fetched: rows.length, saved };
}

// Every rename NSE knows about, as old → [{ newSymbol, changedOn, company }].
// A ticker can be renamed more than once over the years, so the value is a list and callers
// that want today's name must walk the chain rather than taking the first hop.
async function loadChanges() {
  const db = openDatabase();
  try {
    const rows = await allAsync(db,
      `SELECT old_symbol, new_symbol, company, changed_on FROM nse_symbol_changes`);
    const byOld = new Map();
    for (const r of rows) {
      if (!byOld.has(r.old_symbol)) byOld.set(r.old_symbol, []);
      byOld.get(r.old_symbol).push({
        newSymbol: r.new_symbol, changedOn: r.changed_on, company: r.company,
      });
    }
    return byOld;
  } catch {
    return new Map();   // table not present, or market data not attached
  } finally {
    await closeAsync(db);
  }
}

async function status() {
  const db = openDatabase();
  try {
    const row = await getAsync(db,
      `SELECT COUNT(*) n, MAX(fetched_at) fetched, MIN(changed_on) first, MAX(changed_on) last
         FROM nse_symbol_changes`);
    return {
      rows: row?.n || 0,
      fetchedAt: row?.fetched || null,
      earliestChange: row?.first || null,
      latestChange: row?.last || null,
    };
  } catch {
    return { rows: 0, fetchedAt: null, earliestChange: null, latestChange: null };
  } finally {
    await closeAsync(db);
  }
}

module.exports = { refreshSymbolChanges, loadChanges, status, parseNseDate };
