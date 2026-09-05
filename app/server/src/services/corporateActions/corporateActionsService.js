const https = require('https');
const { openDatabase, allAsync, runAsync, getAsync, closeAsync } = require('../../db/connection');
const { onlyWhenOwned } = require('../../db/marketSchema');

// ── Schema ────────────────────────────────────────────────────────────────────
const ensureSchema = onlyWhenOwned(async () => {
  const db = openDatabase();
  try {
    await runAsync(db, `
      CREATE TABLE IF NOT EXISTS corporate_actions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol            TEXT NOT NULL,
        isin              TEXT,
        company           TEXT,
        action_type       TEXT NOT NULL,
        subject           TEXT NOT NULL,
        ex_date           TEXT,
        record_date       TEXT,
        face_value        TEXT,
        source            TEXT DEFAULT 'NSE',
        fetched_at        TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, subject, ex_date)
      )
    `);
    await runAsync(db, `CREATE INDEX IF NOT EXISTS idx_ca_symbol  ON corporate_actions (symbol)`);
    await runAsync(db, `CREATE INDEX IF NOT EXISTS idx_ca_ex_date ON corporate_actions (ex_date)`);
  } finally {
    await closeAsync(db);
  }
});

ensureSchema().catch((e) => console.error('corporateActions ensureSchema:', e.message));

// ── NSE fetcher ───────────────────────────────────────────────────────────────
function _parseDate(str) {
  // NSE returns "25-May-2026" → "2026-05-25"
  if (!str || str === '-') return null;
  try {
    const months = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
    const [d, m, y] = str.split('-');
    const mm = months[m];
    if (!mm) return null;
    return `${y}-${String(mm).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  } catch { return null; }
}

function _classifyAction(subject) {
  const s = (subject || '').toLowerCase();
  if (s.includes('split') || s.includes('sub-division')) return 'SPLIT';
  if (s.includes('bonus'))   return 'BONUS';
  if (s.includes('buyback') || s.includes('buy back')) return 'BUYBACK';
  if (s.includes('rights'))  return 'RIGHTS';
  if (s.includes('dividend') || s.includes('interim') || s.includes('final div')) return 'DIVIDEND';
  if (s.includes('merger') || s.includes('amalgam')) return 'MERGER';
  return 'OTHER';
}

async function _fetchNseCookies() {
  return new Promise((resolve) => {
    const req = https.get('https://www.nseindia.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 10000,
    }, (res) => {
      const cookies = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
      res.resume();
      resolve(cookies);
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

async function _fetchNseActions(fromDate, toDate, cookies) {
  const fmt = (d) => `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;
  const path = `/api/corporates-corporateActions?index=equities&from_date=${fmt(fromDate)}&to_date=${fmt(toDate)}`;

  return new Promise((resolve) => {
    const req = https.get({
      host: 'www.nseindia.com', path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.nseindia.com/companies-listing/corporate-filings-actions',
        'Cookie': cookies,
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

// ── Public: fetch & store corporate actions for the last N days ───────────────
async function refreshCorporateActions(days = 45) {
  const cookies = await _fetchNseCookies();
  if (!cookies) throw new Error('Could not get NSE session cookies');

  await new Promise((r) => setTimeout(r, 2000)); // wait for cookies to settle

  const today   = new Date();
  const fromDay = new Date(today - days * 24 * 60 * 60 * 1000);
  const rows    = await _fetchNseActions(fromDay, today, cookies);

  if (!Array.isArray(rows) || !rows.length) return { fetched: 0, saved: 0 };

  const db = openDatabase();
  let saved = 0;
  try {
    for (const r of rows) {
      if (!r.symbol || !r.subject) continue;
      const exDate  = _parseDate(r.exDate);
      const recDate = _parseDate(r.recDate);
      const type    = _classifyAction(r.subject);
      try {
        await runAsync(db,
          `INSERT OR IGNORE INTO corporate_actions
            (symbol, isin, company, action_type, subject, ex_date, record_date, face_value, source, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'NSE', CURRENT_TIMESTAMP)`,
          [r.symbol?.toUpperCase(), r.isin || null, r.comp || null,
           type, r.subject, exDate, recDate, r.faceVal || null]
        );
        saved++;
      } catch { /* duplicate — ignore */ }
    }
  } finally {
    await closeAsync(db);
  }
  return { fetched: rows.length, saved };
}

// ── Public: get actions for held symbols (upcoming + recent) ──────────────────
async function getActionsForSymbols(symbols, daysBefore = 14, daysAfter = 30) {
  if (!symbols || !symbols.length) return [];
  const db = openDatabase();
  try {
    const today    = new Date().toISOString().slice(0, 10);
    const upcoming = new Date(Date.now() + daysBefore * 86400000).toISOString().slice(0, 10);
    const since    = new Date(Date.now() - daysAfter  * 86400000).toISOString().slice(0, 10);
    const ph       = symbols.map(() => '?').join(', ');
    return await allAsync(db,
      `SELECT symbol, company, action_type, subject, ex_date, record_date, face_value
         FROM corporate_actions
        WHERE UPPER(symbol) IN (${ph})
          AND ex_date IS NOT NULL
          AND ex_date >= ?
          AND ex_date <= ?
        ORDER BY ex_date ASC`,
      [...symbols.map((s) => s.toUpperCase()), since, upcoming]
    );
  } finally {
    await closeAsync(db);
  }
}

// ── Public: get all recent actions for held symbols (for insights card) ───────
async function getInsightActions(heldSymbols) {
  if (!heldSymbols?.length) return { upcoming: [], recent: [] };
  const today  = new Date().toISOString().slice(0, 10);
  const future = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
  const past   = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const ph     = heldSymbols.map(() => '?').join(', ');
  const db     = openDatabase();
  try {
    const rows = await allAsync(db,
      `SELECT symbol, company, action_type, subject, ex_date, record_date, face_value
         FROM corporate_actions
        WHERE UPPER(symbol) IN (${ph})
          AND ex_date IS NOT NULL
          AND ex_date >= ?
          AND ex_date <= ?
        ORDER BY ex_date ASC`,
      [...heldSymbols.map((s) => s.toUpperCase()), past, future]
    );
    const upcoming = rows.filter((r) => r.ex_date >= today);
    const recent   = rows.filter((r) => r.ex_date < today);
    return { upcoming, recent };
  } finally {
    await closeAsync(db);
  }
}

module.exports = { refreshCorporateActions, getActionsForSymbols, getInsightActions };
