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

// ── Public: backfill the historical record, year by year ──────────────────────
//
// WHY THIS EXISTS. refreshCorporateActions above keeps a rolling 45-day window, so the table
// only ever knew about the recent past — it began at 2026-05-11 while the oldest orders on file
// are from 2019. Every split and bonus before that date was invisible, which is not a cosmetic
// gap: FIFO then matches a post-split sell quantity against pre-split buy lots and concludes
// more shares were sold than were ever bought. The scale factors were always computed correctly
// (see market/corpActionsService priceScaleFactor); they were simply never given the rows.
//
// A YEAR PER REQUEST. NSE serves a full calendar year in one call (2,325 rows for 2021), and
// chunking finer only multiplies requests against a rate-limited endpoint. Chunking coarser
// than a year was not tested and is not assumed.
//
// Idempotent: UNIQUE(symbol, subject, ex_date) plus INSERT OR IGNORE, so a re-run adds only
// what is missing and a half-finished run can simply be repeated.
//
// NSE, NOT YAHOO, and the difference is not academic. Yahoo reports BAJFINANCE's 16-Jun-2025
// event as a bare 2.0 split; NSE returns "Face Value Split ... From Rs 2/- To Re 1/-" AND
// "Bonus 4:1" as two rows, which multiply to the true 10x. A Yahoo backfill would write a 2x
// adjustment and be wrong by a factor of five on every lot held across that date.
async function backfillCorporateActions({ fromYear = 2019, toYear = null, onProgress = null } = {}) {
  const endYear = toYear || new Date().getFullYear();
  if (fromYear > endYear) throw new Error(`fromYear ${fromYear} is after toYear ${endYear}`);

  let cookies = await _fetchNseCookies();
  if (!cookies) throw new Error('Could not get NSE session cookies');
  await new Promise((r) => setTimeout(r, 2000));

  const perYear = [];
  let totalFetched = 0;
  let totalSaved = 0;

  for (let year = fromYear; year <= endYear; year += 1) {
    const from = new Date(Date.UTC(year, 0, 1));
    // Only the CALENDAR year stops at today — not merely the last year of the loop. Keying this
    // off `endYear` instead meant `--to 2019` asked NSE for 01-01-2019 to today and got all
    // seven years back in one response, which still imported correctly but made the per-year
    // counts meaningless as a check on coverage.
    const to = year === new Date().getFullYear()
      ? new Date()
      : new Date(Date.UTC(year, 11, 31));

    let rows = await _fetchNseActions(from, to, cookies);

    // An empty year part-way through a long run usually means the session was dropped, not
    // that the year was genuinely quiet. Re-handshake once and retry before believing it.
    if (!Array.isArray(rows) || !rows.length) {
      cookies = await _fetchNseCookies();
      await new Promise((r) => setTimeout(r, 2000));
      rows = await _fetchNseActions(from, to, cookies);
    }

    let saved = 0;
    if (Array.isArray(rows) && rows.length) {
      const db = openDatabase();
      try {
        await runAsync(db, 'BEGIN TRANSACTION');
        for (const r of rows) {
          if (!r.symbol || !r.subject) continue;
          const result = await runAsync(db,
            `INSERT OR IGNORE INTO corporate_actions
              (symbol, isin, company, action_type, subject, ex_date, record_date, face_value, source, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'NSE', CURRENT_TIMESTAMP)`,
            [String(r.symbol).toUpperCase(), r.isin || null, r.comp || null,
              _classifyAction(r.subject), r.subject,
              _parseDate(r.exDate), _parseDate(r.recDate), r.faceVal || null]
          );
          // Counted from what the write actually changed, not from rows seen, so the reported
          // figure distinguishes "added" from "already had it" instead of flattering the run.
          if (result?.changes) saved += result.changes;
        }
        await runAsync(db, 'COMMIT');
      } catch (e) {
        await runAsync(db, 'ROLLBACK').catch(() => {});
        throw e;
      } finally {
        await closeAsync(db);
      }
    }

    const fetched = Array.isArray(rows) ? rows.length : 0;
    totalFetched += fetched;
    totalSaved += saved;
    perYear.push({ year, fetched, saved });
    if (onProgress) onProgress({ year, fetched, saved });

    // Deliberate pause between calls. This is someone else's public endpoint and the whole
    // backfill is a handful of requests — there is no reason to be impolite about it.
    if (year < endYear) await new Promise((r) => setTimeout(r, 3000));
  }

  return { fromYear, toYear: endYear, fetched: totalFetched, saved: totalSaved, perYear };
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

module.exports = {
  refreshCorporateActions, backfillCorporateActions, getActionsForSymbols, getInsightActions,
};
