const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const holdingScoresRepository = require('../../repositories/holdingScoresRepository');
const portfolioRepository = require('../../repositories/portfolioRepository');
const PF = require('../../config/portfolios');

const ENGINES = require('../../config/engines');

const SCORER_PATH = ENGINES.script('portfolio_health.py');

// NO DEFAULT CSV. The desktop app scanned its owner's Downloads folder for a file named after
// their demat account number and scored whatever it found. On a shared server
// that is wrong twice over: there is no such folder, and if there were, one participant's
// holdings file would be picked up and scored as everybody's. A caller must now name the file it
// wants scored, and holdings captured from the broker are the normal path anyway.
const DEFAULT_CSV = null;

// ── Run portfolio_health.py and return parsed JSON ──────────────────────────
function runScorerOnce(csvPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'python',
      [SCORER_PATH, csvPath, '--json'],
      { timeout: 180_000, maxBuffer: 5 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(`Scorer failed: ${error.message}\n${stderr}`));
        }
        try {
          // stdout may have progress lines before the JSON — find the JSON object
          const jsonStart = stdout.indexOf('{');
          if (jsonStart === -1) throw new Error('No JSON in scorer output');
          const parsed = JSON.parse(stdout.slice(jsonStart));
          resolve(parsed);
        } catch (parseErr) {
          reject(new Error(`Failed to parse scorer output: ${parseErr.message}`));
        }
      }
    );
  });
}

// Retry with backoff.
//
// WHY: on 2026-08-12 the Rams scan failed with a bare "Command failed" and EMPTY stderr,
// while Geetha succeeded in the same request — then the identical inputs succeeded on a
// manual retry. Not a timeout (the scorer takes ~28s against a 120s limit, now 180s), not
// the working directory, not a missing interpreter; all three were checked. The likeliest
// cause is contention while both portfolios hit the same upstream price/fundamentals
// sources at once, Rams pulling 38 symbols to Geetha's 13.
//
// This matters more than a normal flake: a failed scan leaves the PREVIOUS scores in place
// and the page still looks fully populated, so the failure is invisible. That is exactly how
// this portfolio ran on two-month-old scores — carrying seven sold positions — without
// anything looking wrong.
async function runScorer(csvPath, { attempts = 3, baseDelayMs = 4000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runScorerOnce(csvPath);
    } catch (e) {
      lastErr = e;
      if (attempt === attempts) break;
      const delay = baseDelayMs * attempt;   // 4s, 8s — linear is ample for transient contention
      console.log(`⚠ Scorer attempt ${attempt}/${attempts} failed (${e.message.split('\n')[0]}) — retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── Map scorer row → DB row ──────────────────────────────────────────────────
function toDbRow(portfolio, scoreDate, row) {
  return {
    scoreDate,
    portfolio,
    symbol:           row.Code || row.Name,
    name:             row.Name,
    technicalScore:   row.Tech  ?? null,
    fundamentalScore: row.Fund  ?? null,
    momentumScore:    row.Mom   ?? null,
    combinedScore:    row.Score ?? null,
    rating:           row.Rating || '?',
    rsi:              row.RSI   ?? null,
    r1m:              row.R1M   ?? null,
    r3m:              row.R3M   ?? null,
    r6m:              row.R6M   ?? null,
    isEtf:            row.IsETF ? 1 : 0,
    note:             row.Note  || '',
    cmp:              row.CMP   ?? null,
    qty:              row.Qty   ?? null,
    emaLadder:        row.EmaLadder  ?? null,
    ema50Slope:       row.Ema50Slope ?? null,
    scoreVersion:     'v2-yfinance',
  };
}

function labelScore(value) {
  if (value === null || value === undefined) return 'Pending';
  if (value >= 70) return 'Strong';
  if (value >= 40) return 'Moderate';
  if (value > 0)   return 'Weak';
  return 'Pending';
}

// ── Public API ────────────────────────────────────────────────────────────────
async function refreshCurrentScores(portfolio = PF.ICICI, csvPath) {
  const csv = csvPath || DEFAULT_CSV;
  // Said plainly rather than handing null to execFile, which fails deep inside the scorer with a
  // message about an argument rather than about holdings.
  if (!csv) {
    throw Object.assign(
      new Error(`No holdings to score for ${portfolio}. Capture them from your broker on the `
        + 'Daily Sync page first, or upload a demat CSV.'),
      { code: 'NO_HOLDINGS' });
  }
  const result = await runScorer(csv);

  const scoreDate = result.scoreDate || new Date().toISOString().slice(0, 10);
  const rows = (result.rows || []).map((r) => toDbRow(portfolio, scoreDate, r));

  await holdingScoresRepository.replaceScoresForSnapshots(rows);

  return {
    scoreDate,
    generatedAt: result.generatedAt,
    portfolio,
    inserted: rows.length,
    rows,
  };
}

async function getScoresForDate(scoreDate, portfolio = '') {
  const rows = await holdingScoresRepository.listScoresForDate(scoreDate, portfolio);
  return rows.map((row) => ({
    ...row,
    labels: {
      momentum:    labelScore(Number(row.momentum_score    ?? 0)),
      fundamental: labelScore(Number(row.fundamental_score ?? 0)),
      technical:   labelScore(Number(row.technical_score   ?? 0)),
      combined:    labelScore(Number(row.combined_score     ?? 0)),
    },
  }));
}

// Full-universe Nifty-500 rank map from the latest scan: every scored stock
// ranked by combined score (no trend filter), so each holding gets its true
// position, e.g. RELIANCE #430/500.
async function _nifty500RankMap() {
  try {
    const universeScoresRepository = require('../../repositories/universeScoresRepository');
    const dates = await universeScoresRepository.latestScanDates(1);
    if (!dates.length) return { map: new Map(), total: 0, scanDate: null };
    const urows = await universeScoresRepository.listScanRows(dates[0]);
    const ranked = urows
      .filter((r) => r.combined_score != null)
      .sort((a, b) => b.combined_score - a.combined_score);
    const map = new Map(ranked.map((r, i) => [r.symbol, i + 1]));
    return { map, total: ranked.length, scanDate: dates[0] };
  } catch {
    return { map: new Map(), total: 0, scanDate: null };
  }
}

// Per-holding performance, for the "should I sell or add?" line on Portfolio Health.
//
// Sourced from pickerMatchService because it already does the hard parts: FIFO open-lot
// matching (so sold-and-rebought lots aren't double counted) and taking invested/current
// value from the BROKER SNAPSHOT rather than raw order history — order prices aren't
// split-adjusted, and comparing a pre-split buy against a post-split price produces a wildly
// wrong return (the CUPID/Anand Rathi bug).
//
// Time-normalised return is the point of the exercise: +20% is excellent in two months and
// poor over three years, and a raw P&L column hides that completely.
async function _holdingPerformance() {
  const { getPickerMatches } = require('../recommendations/pickerMatchService');
  const { positions } = await getPickerMatches({});
  const byKey = new Map();

  // Weight is share of invested capital across everything currently held, so a position can
  // be judged on concentration as well as on its own return.
  const totalInvested = positions.reduce((s, p) => s + (Number(p.invested) || 0), 0);
  const DAY = 24 * 3600 * 1000;
  const today = new Date();

  for (const p of positions) {
    const invested = Number(p.invested) || 0;
    const heldDays = p.tradeDate
      ? Math.max(1, Math.round((today - new Date(`${p.tradeDate}T00:00:00Z`)) / DAY))
      : null;
    const heldMonths = heldDays ? heldDays / 30.44 : null;

    // Simple (non-compounded) return per month — the honest reading over short holds, where
    // annualising a few weeks of gain produces an absurd headline number.
    const retPerMonth = (p.returnPct != null && heldMonths && heldMonths >= 0.5)
      ? p.returnPct / heldMonths : null;

    // CAGR only once there's enough time for compounding to mean anything; below a quarter
    // it explodes on noise (a 5% gain in a week annualises to >1000%).
    const cagr = (heldDays && heldDays >= 90 && invested > 0 && p.currentValue != null)
      ? (Math.pow(p.currentValue / invested, 365 / heldDays) - 1) * 100 : null;

    const buys = p.buys || [];
    const lastBuy = buys.length ? buys[buys.length - 1] : null;
    const sinceLastBuyPct = (lastBuy?.price > 0 && p.cmp != null)
      ? ((p.cmp - lastBuy.price) / lastBuy.price) * 100 : null;

    byKey.set(`${p.portfolio}::${p.symbol}`, {
      invested: round2(invested),
      currentValue: p.currentValue != null ? round2(p.currentValue) : null,
      pnl: p.pnl != null ? round2(p.pnl) : null,
      returnPct: p.returnPct,
      heldDays,
      heldMonths: heldMonths != null ? Math.round(heldMonths * 10) / 10 : null,
      retPerMonth: retPerMonth != null ? Math.round(retPerMonth * 100) / 100 : null,
      cagr: cagr != null ? Math.round(cagr * 10) / 10 : null,
      avgCost: p.quantity > 0 ? round2(invested / p.quantity) : null,
      quantity: p.quantity,
      weightPct: totalInvested > 0 ? Math.round((invested / totalInvested) * 1000) / 10 : null,
      firstBuy: p.tradeDate,
      lastBuy: lastBuy?.tradeDate || null,
      lastBuyPrice: lastBuy?.price ?? null,
      sinceLastBuyPct: sinceLastBuyPct != null ? Math.round(sinceLastBuyPct * 10) / 10 : null,
      buyCount: p.tradeCount,
      priced: p.priced !== false,
      source: 'orders',
    });
  }

  // Fallback for holdings the order history doesn't cover — bought before imports began, or
  // acquired outside them. The broker snapshot still knows quantity, invested and P&L, so
  // those are worth showing; what it CANNOT give is a purchase date, so holding period and
  // every time-normalised figure stay null rather than being guessed from nothing.
  try {
    const { getCurrentHoldingSymbols } = require('../portfolio/portfolioService');
    const snaps = await getCurrentHoldingSymbols();
    for (const [pf, snap] of Object.entries(snaps || {})) {
      for (const [sym, h] of Object.entries(snap?.holdingsBySymbol || {})) {
        const key = `${pf}::${sym}`;
        if (byKey.has(key)) continue;
        const invested = Number(h.invested) || 0;
        byKey.set(key, {
          invested: round2(invested),
          currentValue: h.currentValue != null ? round2(h.currentValue) : null,
          pnl: h.pnl != null ? round2(h.pnl) : null,
          returnPct: invested > 0 && h.pnl != null ? Math.round((h.pnl / invested) * 1000) / 10 : null,
          heldDays: null, heldMonths: null, retPerMonth: null, cagr: null,
          avgCost: h.quantity > 0 ? round2(invested / h.quantity) : null,
          quantity: h.quantity,
          weightPct: totalInvested > 0 ? Math.round((invested / totalInvested) * 1000) / 10 : null,
          firstBuy: null, lastBuy: null, lastBuyPrice: null, sinceLastBuyPct: null,
          buyCount: null,
          priced: true,
          // Flagged so the UI can say WHY the time-based columns are blank instead of
          // leaving the reader to assume the data is broken.
          source: 'snapshot-only',
        });
      }
    }
  } catch (e) {
    console.log(`⚠ snapshot fallback for holding performance failed: ${e.message}`);
  }

  return byKey;
}

function round2(n) { return Math.round(n * 100) / 100; }

async function getLatestScores(portfolio = '') {
  const rows = await holdingScoresRepository.listLatestScores(portfolio);
  const scoreDate = rows[0]?.score_date || null;
  const { resolveNseSymbol } = require('../portfolio/portfolioService');
  const n500 = await _nifty500RankMap();

  // Best-effort: a health scan must still render if the broker snapshot is unavailable.
  let perf = new Map();
  try { perf = await _holdingPerformance(); }
  catch (e) { console.log(`⚠ holding performance unavailable: ${e.message}`); }

  // Surface staleness explicitly. A failed scan leaves the previous scores in place and the
  // page still renders fully, so age is the ONLY signal that what you're reading is out of
  // date — this portfolio silently ran on two-month-old scores, listing seven positions that
  // had already been sold.
  const STALE_AFTER_DAYS = 3;
  let scoreAgeDays = null;
  if (scoreDate) {
    const ist = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    scoreAgeDays = Math.round(
      (new Date(`${ist}T00:00:00Z`) - new Date(`${scoreDate}T00:00:00Z`)) / 86400000,
    );
  }

  return {
    scoreDate,
    scoreAgeDays,
    stale: scoreAgeDays != null && scoreAgeDays > STALE_AFTER_DAYS,
    staleAfterDays: STALE_AFTER_DAYS,
    portfolio,
    nifty500ScanDate: n500.scanDate,
    nifty500Total: n500.total || null,
    rows: rows.map((row) => {
      const nse = resolveNseSymbol(row.symbol);
      return {
        ...row,
        nifty500_rank: n500.map.get(nse) ?? null,
        holding: perf.get(`${row.portfolio}::${nse}`) || perf.get(`${row.portfolio}::${String(row.symbol).toUpperCase()}`) || null,
        labels: {
          momentum:    labelScore(Number(row.momentum_score    ?? 0)),
          fundamental: labelScore(Number(row.fundamental_score ?? 0)),
          technical:   labelScore(Number(row.technical_score   ?? 0)),
          combined:    labelScore(Number(row.combined_score     ?? 0)),
        },
      };
    }),
  };
}

// ── Generate a temp ICICI-format CSV from a portfolio DB snapshot ─────────────
async function generateCsvFromSnapshot(portfolioName) {
  const snapshots = await portfolioRepository.listPortfolioSnapshots(portfolioName, 1);
  if (!snapshots.length) throw new Error(`No snapshot found for portfolio "${portfolioName}"`);

  let payload;
  try { payload = JSON.parse(snapshots[0].payload_json); } catch { payload = null; }
  const holdings = payload?.portfolio || [];
  if (!holdings.length) throw new Error(`Snapshot for "${portfolioName}" has no holdings`);

  // Build ICICI demat CSV format
  const header = 'Stock Name,Stock,ISIN,Allocated Quantity,Blocked for Trade,Block For Margin,Current Market Price,% Change,Market Value';
  const lines = holdings.map((h) => {
    const instrument = h.instrument || '';
    const qty = Number(h.qty || 0);
    const ltp = Number(h.ltp || 0);
    return `${instrument},${instrument},,${qty},0,0,${ltp},0,${qty * ltp}`;
  });

  const csv = [header, ...lines].join('\n');
  const tmpPath = path.join(os.tmpdir(), `zta_${portfolioName.toLowerCase()}_holdings.csv`);
  fs.writeFileSync(tmpPath, csv, 'utf8');
  return tmpPath;
}

// ── Refresh scores for all portfolios (Rams from CSV, others from DB snapshot) ─
async function refreshAllScores() {
  const scoreDate = new Date().toISOString().slice(0, 10);
  const results = {};

  // Rams — prefer snapshot CSV (includes pledged holdings); fall back to downloaded ICICI CSV
  try {
    let ramsCsv;
    try { ramsCsv = await generateCsvFromSnapshot(PF.ICICI); } catch { ramsCsv = DEFAULT_CSV; }
    const ramsResult = await refreshCurrentScores(PF.ICICI, ramsCsv);
    results[PF.ICICI] = { inserted: ramsResult.inserted, scoreDate: ramsResult.scoreDate };
  } catch (err) {
    results[PF.ICICI] = { error: err.message };
  }

  // All other portfolios found in snapshots — generate CSV from DB
  const allSnapshots = await portfolioRepository.listPortfolioSnapshots('', 20);
  const otherPortfolios = [...new Set(
    allSnapshots.map((s) => s.portfolio).filter((p) => p && p !== PF.ICICI)
  )];

  for (const portfolio of otherPortfolios) {
    try {
      const csvPath = await generateCsvFromSnapshot(portfolio);
      const result = await runScorer(csvPath);
      const sd = result.scoreDate || scoreDate;
      const rows = (result.rows || []).map((r) => toDbRow(portfolio, sd, r));
      await holdingScoresRepository.replaceScoresForSnapshots(rows);
      results[portfolio] = { inserted: rows.length, scoreDate: sd };
    } catch (err) {
      results[portfolio] = { error: err.message };
    }
  }

  return results;
}

module.exports = {
  refreshCurrentScores,
  refreshAllScores,
  generateCsvFromSnapshot,
  getScoresForDate,
  getLatestScores,
  labelScore,
};
