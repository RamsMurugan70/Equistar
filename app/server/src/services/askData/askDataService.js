// "Ask the Data" — natural-language → SQL over the app DB via Gemini.
// HARD read-only: the DB is opened OPEN_READONLY *and* the generated SQL is
// validated to be a single SELECT before execution. The model never sees any
// secrets (broker keys live in JSON files, not the DB).
const sqlite3 = require('sqlite3');
const config = require('../../config/env');

// LLM provider: 'ollama' (offline/local) or 'gemini' (cloud). Set ASK_LLM_PROVIDER in .env.
const PROVIDER     = (process.env.ASK_LLM_PROVIDER || 'gemini').toLowerCase();
const GEMINI_KEY   = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_URL   = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
const OLLAMA_URL   = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';
const ROW_CAP      = 200;

// Tables exposed to the assistant + short hints to improve SQL quality.
const TABLE_HINTS = {
  orders:            "Executed broker trades (fills). Columns: portfolio (Rams/Geetha), trade_date (YYYY-MM-DD), symbol, side (BUY/SELL), quantity, price, exchange. " +
                     "F&O vs equity: use the EXCHANGE column — F&O = exchange IN ('NFO','BFO','MCX'); equity = exchange IN ('NSE','BSE'). " +
                     "Do NOT detect F&O by 'symbol LIKE %CE%/%PE%' — equities like RELIANCE/FINPIPE/BAJFINANCE end in CE/PE and would be wrongly matched. " +
                     "Gross F&O P&L = SUM(CASE WHEN side='SELL' THEN quantity*price ELSE -quantity*price END), filtered to exchange IN ('NFO','BFO'). " +
                     "Equity buy/sell are not netted the same way (positions may still be open).",
  recommendations:   'Tracked recommendations. recommendation_date, advisor, symbol, action_type, cmp (entry), target_price, stop_loss, timeframe, status (Active/...), notes.',
  holding_scores:    'Daily portfolio health scores. score_date, portfolio, symbol, name, combined_score (0-100), technical_score, fundamental_score, momentum_score, rating, rsi, r1m/r3m/r6m, ema_ladder (STRONG_UPTREND/PULLBACK/DISTRIBUTION/DOWNTREND/MIXED), ema50_slope, is_etf, cmp, qty.',
  universe_scores:   "Daily full scan across 4 universes, distinguished by `universe` (NIFTY500 default, or MIDCAP/SMALLCAP/MICROCAP). scan_date, universe, symbol, name, industry, combined_score, technical/fundamental/momentum_score, r1w/r1m/r3m/r6m, ema_ladder, ema50_slope, cmp. Universe rank = order by combined_score DESC within a (scan_date, universe) pair — ALWAYS filter by universe or you'll mix unrelated stock universes.",
  universe_top_daily:"Frozen daily Top-25 list per universe (see universe_scores). scan_date, universe, rank (1=best), symbol, name, combined_score, ema_ladder, r1w/r1m/r3m/r6m, cmp. Filter by universe='NIFTY500' unless asked about small/mid/micro-cap.",
  portfolio_summary: 'Portfolio value snapshots. summary_date, portfolio, total_invested, total_value, stock_count.',
};

let _schemaCache = null;

function _openRO() {
  return new sqlite3.Database(config.dbPath, sqlite3.OPEN_READONLY);
}

function _all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (e, r) => (e ? reject(e) : resolve(r))));
}

async function _schemaText() {
  if (_schemaCache) return _schemaCache;
  const db = _openRO();
  try {
    const tables = Object.keys(TABLE_HINTS);
    const parts = [];
    for (const t of tables) {
      try {
        const cols = await _all(db, `PRAGMA table_info(${t})`);
        if (!cols.length) continue;
        const colList = cols.map((c) => `${c.name} ${c.type || ''}`.trim()).join(', ');
        parts.push(`TABLE ${t} (${colList})\n  -- ${TABLE_HINTS[t]}`);
      } catch { /* skip missing table */ }
    }
    _schemaCache = parts.join('\n\n');
    return _schemaCache;
  } finally {
    db.close();
  }
}

function isConfigured() { return PROVIDER === 'ollama' ? true : !!GEMINI_KEY; }
function providerInfo() {
  return PROVIDER === 'ollama'
    ? { provider: 'ollama', model: OLLAMA_MODEL, url: OLLAMA_URL, offline: true }
    : { provider: 'gemini', model: GEMINI_MODEL, offline: false };
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Local/offline model via Ollama (http://localhost:11434) ──────────────────
async function _ollama(prompt) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 180000);   // CPU inference can be slow
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, keep_alive: '30m', options: { temperature: 0 } }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? 'Local model timed out (CPU inference is slow). Try a smaller model like qwen2.5-coder:3b.'
      : `Cannot reach Ollama at ${OLLAMA_URL}. Is it running? (run: ollama serve)`);
  } finally { clearTimeout(t); }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    if (res.status === 404) throw new Error(`Model "${OLLAMA_MODEL}" not found. Pull it: ollama pull ${OLLAMA_MODEL}`);
    throw new Error(`Ollama error ${res.status}: ${txt.slice(0, 160)}`);
  }
  const json = await res.json();
  return json?.response || '';
}

// Provider dispatcher
async function _llm(prompt) {
  return PROVIDER === 'ollama' ? _ollama(prompt) : _gemini(prompt);
}

async function _gemini(prompt, attempt = 0) {
  if (!GEMINI_KEY) throw new Error('Gemini API key not set. Add GEMINI_API_KEY=AIza… to D:\\AI Projects\\ZTA-Codex\\.env (or set GOOGLE_API_KEY) and restart the backend.');
  const res = await fetch(GEMINI_URL(GEMINI_MODEL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } }),
  });
  if (res.status === 429 || res.status === 503) {
    // Rate-limited / transient — honor RetryInfo, back off, retry up to 3x.
    if (attempt < 3) {
      let delayMs = 1500 * (attempt + 1);
      try {
        const j = await res.clone().json();
        const ri = (j.error?.details || []).find((d) => /RetryInfo/.test(d['@type'] || ''));
        const sec = ri?.retryDelay && parseFloat(ri.retryDelay);
        if (sec) delayMs = Math.min(sec * 1000 + 500, 50000);
      } catch { /* use default backoff */ }
      await _sleep(delayMs);
      return _gemini(prompt, attempt + 1);
    }
    throw new Error('Gemini is rate-limited right now (free-tier per-minute cap). Please wait ~30s and try again.');
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  return json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function _extractSql(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s.replace(/;+\s*$/, '').trim();   // drop trailing semicolons
}

// Hard guardrail: single read-only SELECT only.
function _validateSql(sql) {
  if (!sql) throw new Error('No SQL was generated.');
  if (sql.includes(';')) throw new Error('Only a single statement is allowed.');
  if (!/^(SELECT|WITH)\b/i.test(sql)) throw new Error('Only SELECT queries are allowed.');
  const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|TRIGGER|GRANT)\b/i;
  if (forbidden.test(sql)) throw new Error('Query contains a non-read-only keyword.');
  // Cap rows
  if (!/\blimit\b/i.test(sql)) sql = `${sql} LIMIT ${ROW_CAP}`;
  return sql;
}

async function ask(question) {
  const q = String(question || '').trim();
  if (!q) throw new Error('Question is required.');
  const schema = await _schemaText();

  // 1) NL → SQL
  const sqlPrompt =
    `You are an expert SQLite analyst for a personal stock-trading app. ` +
    `Given the schema and a question, output ONE read-only SQLite SELECT query that answers it. ` +
    `Rules: SELECT only (no writes); single statement; no markdown, no explanation — output ONLY the SQL. ` +
    `Use only the tables/columns below. Dates are TEXT 'YYYY-MM-DD' (use date() funcs). ` +
    `For "latest" data use the MAX(scan_date)/MAX(score_date) within the relevant table. Add a sensible LIMIT.\n` +
    `IMPORTANT domain rules: (1) F&O orders are identified by exchange IN ('NFO','BFO','MCX'), NEVER by symbol LIKE '%CE%'. ` +
    `(2) "Nifty 500 rank" / "universe rank" for a scan_date = position when ordering universe_scores by combined_score DESC for that date. ` +
    `(3) The Top-25 list is universe_top_daily (rank 1 = best). (4) Portfolio holdings & their health are in holding_scores (latest score_date).\n\n` +
    `SCHEMA:\n${schema}\n\nQUESTION: ${q}\n\nSQL:`;
  const rawSql = _extractSql(await _llm(sqlPrompt));
  let sql;
  try {
    sql = _validateSql(rawSql);
  } catch (e) {
    return { ok: false, error: `Could not build a safe query: ${e.message}`, sql: rawSql };
  }

  // 2) Execute (read-only)
  let rows;
  try {
    const db = _openRO();
    try { rows = await _all(db, sql); } finally { db.close(); }
  } catch (e) {
    return { ok: false, error: `Query failed: ${e.message}`, sql };
  }

  const columns = rows.length ? Object.keys(rows[0]) : [];

  // 3) Summarize. The prose summary is a SECOND model call — on slow CPU/offline
  // setups it doubles latency, so it's optional via ASK_SUMMARIZE (default: off
  // for ollama, on for cloud). When off, we return a quick deterministic line.
  const summarize = (process.env.ASK_SUMMARIZE ?? (PROVIDER === 'ollama' ? 'false' : 'true')) === 'true';
  let answer = '';
  if (!rows.length) {
    answer = 'No rows matched.';
  } else if (summarize) {
    try {
      const sample = JSON.stringify(rows.slice(0, 30));
      const sumPrompt =
        `Question: ${q}\nSQL: ${sql}\nResult rows (JSON, up to 30 of ${rows.length}): ${sample}\n\n` +
        `Write a concise 1-3 sentence plain-English answer to the question based ONLY on these rows. ` +
        `Use ₹ for money, % for percentages. No preamble.`;
      answer = (await _llm(sumPrompt)).trim();
    } catch { answer = `${rows.length} row(s) returned — see table below.`; }
  } else {
    answer = `${rows.length} row(s) returned — see table below.`;
  }

  return { ok: true, question: q, answer, sql, columns, rows: rows.slice(0, ROW_CAP), rowCount: rows.length, summarized: summarize };
}

module.exports = { ask, isConfigured, providerInfo };
