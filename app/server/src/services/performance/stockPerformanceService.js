// How each stock you hold has actually performed over a chosen window, with the momentum picture.
//
// WHAT THIS IS, AND IS NOT: the performance of the STOCKS — total return (price plus dividends,
// split/bonus-adjusted) from the window's start to today — for what you hold now. It is not your
// P&L: it ignores when you bought and what you paid. Portfolio Evolution answers "what did my
// money make"; this answers "which of my holdings are pulling their weight".
//
// Everything is computed from one daily-price source (stockHistoryService) for every holding, so
// an ETF or an off-index stock gets the same return, RSI and EMA treatment as a Nifty 50 name.
const { openDatabase, allAsync, closeAsync } = require('../../db/connection');
const history = require('../market/stockHistoryService');
const scrip = require('../market/iciciScripMasterService');
const PF = require('../../config/portfolios');

const PERIOD_MONTHS = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 };
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

function monthsBack(iso, m) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - m);
  return d.toISOString().slice(0, 10);
}

// Last element with date <= target (series ascending). null if none.
function onOrBefore(series, target) {
  let hit = null;
  for (const b of series) { if (b.date <= target) hit = b; else break; }
  return hit;
}

function ema(values, n) {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < values.length; i += 1) e = values[i] * k + e * (1 - k);
  return e;
}

// Wilder's RSI(14) — the standard definition, so the number matches what a charting tool shows.
function rsi14(values) {
  const n = 14;
  if (values.length <= n) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i += 1) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  for (let i = n + 1; i < values.length; i += 1) {
    const d = values[i] - values[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

// Same five labels the rest of the app uses for the EMA ladder, so a badge means one thing.
function ladder(p, e20, e50, e200) {
  if ([p, e20, e50, e200].some((v) => v == null)) return null;
  if (p > e20 && e20 > e50 && e50 > e200) return 'STRONG_UPTREND';
  if (e50 > e200 && p < e20 && p >= e50) return 'PULLBACK';
  if (e50 > e200 && p < e50) return 'DISTRIBUTION';
  if (p < e200 && e50 < e200) return 'DOWNTREND';
  return 'MIXED';
}

// Percentile rank of v within vals (0..1), ties averaged. A list of one ranks in the middle.
function pctRank(vals, v) {
  if (!vals.length) return null;
  if (vals.length === 1) return 0.5;
  const below = vals.filter((x) => x < v).length;
  const equal = vals.filter((x) => x === v).length;
  return (below + (equal - 1) / 2) / (vals.length - 1);
}

// Why a holding has no price — stated per holding, because "unpriced" covers two very different
// things: a scrip with genuinely no market, and a broker code mapped to the wrong symbol (which
// hides a real position and is a bug to fix).
function explainNoData(symbol, instrument, meta, ps, fromIcici) {
  const dead = ps.deadScripInfo(instrument) || ps.deadScripInfo(symbol);
  if (dead) return { kind: dead.status, reason: `${dead.name ? `${dead.name}: ` : ''}${dead.note}` };
  if (meta?.status === 'ERROR') {
    return { kind: 'FETCH_FAILED', reason: `The price source did not answer (${meta.detail || 'error'}). Retried automatically.` };
  }
  const code = instrument && instrument.toUpperCase() !== symbol ? ` (broker code ${instrument})` : '';
  // Sovereign Gold Bonds are listed and do trade, so "delisted" would be false. Yahoo simply
  // carries no history for government bonds under any ticker.
  if (/^SGB/.test(symbol)) {
    return { kind: 'NOT_COVERED',
      reason: `Sovereign Gold Bond${code}: listed, but the price source has no history for government bonds.` };
  }
  const unlisted = fromIcici && scrip.isUnknown(instrument) ? ' ICICI\'s own security master does not list this code either.' : '';
  return { kind: 'NOT_LISTED',
    reason: `Yahoo has no NSE or BSE listing for ${symbol}${code}.${unlisted} Either delisted, or the broker code maps to the wrong symbol.` };
}

// Broker code -> the symbol prices are fetched under. The verified hand map in portfolioService
// wins; an ICICI code it does not know is looked up in ICICI's published security master. Only
// ever applied to the ICICI account: a Zerodha holding is already an NSE symbol, and reading it
// as an ICICI code could only turn a right answer into a wrong one.
function resolverFor(ps) {
  return (pf, instrument) => {
    const raw = String(instrument || '').toUpperCase();
    const hand = String(ps.resolveNseSymbol(instrument) || instrument).toUpperCase();
    if (hand !== raw || pf !== PF.ICICI) return hand;
    return scrip.getMapped(raw) || raw;
  };
}

// WAS IT HELD WHEN THE WINDOW OPENED? Read straight from the holdings snapshot on or before the
// window start — not inferred from order lots. FIFO open-lot dates flag long-held positions as
// "bought mid-period" whenever the lot history is incomplete (IPO allotments, bonus shares,
// holdings that predate the order feed), which is the common case. When no snapshot reaches back
// that far the answer is genuinely unknown, and is returned as null rather than guessed.
async function holdingsAtStart(pfs, windowStart, resolve) {
  const out = new Map();                  // pf -> { date, set } | null
  const db = openDatabase();
  try {
    for (const pf of pfs) {
      const snaps = await allAsync(db,
        `SELECT snapshot_date, payload_json FROM portfolio_snapshots
          WHERE portfolio = ? AND snapshot_date <= ? ORDER BY snapshot_date DESC, id DESC LIMIT 5`,
        [pf, windowStart]);
      let found = null;
      for (const s of snaps) {
        let rows = [];
        try { rows = JSON.parse(s.payload_json).portfolio || []; } catch { rows = []; }
        const set = new Set(rows.filter((h) => (Number(h.qty) || 0) > 0).map((h) => resolve(pf, h.instrument)));
        // An empty capture is a failed capture, not proof of an empty account.
        if (set.size) { found = { date: s.snapshot_date, set }; break; }
      }
      out.set(pf, found);
    }
  } finally { await closeAsync(db); }
  return out;
}

async function namesFor(symbols) {
  const names = new Map();
  if (!symbols.length) return names;
  const marks = symbols.map(() => '?').join(',');
  const db = openDatabase();
  try {
    // Best-effort, most authoritative last: every source is optional.
    const sources = [
      `SELECT symbol, name FROM holding_scores WHERE symbol IN (${marks}) AND name IS NOT NULL`,
      `SELECT symbol, MAX(name) AS name FROM universe_scores WHERE symbol IN (${marks}) GROUP BY symbol`,
      `SELECT symbol, name FROM nse_symbol_master WHERE symbol IN (${marks})`,
    ];
    for (const sql of sources) {
      try {
        for (const r of await allAsync(db, sql, symbols)) if (r.name) names.set(r.symbol, r.name);
      } catch { /* table absent in this database */ }
    }
  } finally { await closeAsync(db); }
  return names;
}

async function getStockPerformance({ period = '3M', portfolio = 'both' } = {}) {
  const months = PERIOD_MONTHS[period] || 3;
  const today = istToday();
  const windowStart = monthsBack(today, months);
  const all = PF.ALL;
  const pfs = all.includes(portfolio) ? [portfolio] : all;

  const ps = require('../portfolio/portfolioService');
  const [held, master] = await Promise.all([
    ps.getCurrentHoldingSymbols(),
    pfs.includes(PF.ICICI) ? scrip.ensureFresh() : null,
  ]);
  const resolve = resolverFor(ps);

  // Merge the selected portfolios' current holdings by NSE symbol.
  const bySym = new Map();
  for (const pf of pfs) {
    const h = held[pf];
    if (!h) continue;
    for (const v of Object.values(h.holdingsBySymbol || {})) {
      const sym = resolve(pf, v.instrument);
      const cur = bySym.get(sym) || { symbol: sym, value: 0, portfolios: [], instrument: String(v.instrument || sym).toUpperCase(), fromIcici: false };
      cur.value += Number(v.currentValue) || 0;
      if (!cur.portfolios.includes(pf)) cur.portfolios.push(pf);
      if (pf === PF.ICICI) cur.fromIcici = true;
      bySym.set(sym, cur);
    }
  }
  const totalValue = [...bySym.values()].reduce((t, x) => t + x.value, 0);

  const atStart = await holdingsAtStart(pfs, windowStart, resolve);
  for (const h of bySym.values()) {
    const known = h.portfolios.map((pf) => atStart.get(pf)).filter(Boolean);
    h.heldFullPeriod = known.length === 0 ? null : known.some((x) => x.set.has(h.symbol));
  }

  const symbols = [...bySym.keys()];
  const [{ history: hist, meta }, names] = await Promise.all([
    history.getHistory([...symbols, history.NIFTY_KEY]),
    namesFor(symbols),
  ]);
  const nifty = hist.get(history.NIFTY_KEY) || [];
  const niftyEnd = nifty[nifty.length - 1] || null;
  // THE window's Nifty figure: from the bar on or before the window start to the latest bar.
  // It depends on the period alone — never on which holdings are selected — so it is identical
  // for every portfolio choice, and every full-window row is compared against this same number.
  const niftyBase = onOrBefore(nifty, windowStart);
  const niftyWindow = niftyBase && niftyEnd ? (niftyEnd.close / niftyBase.close - 1) * 100 : null;

  const rows = [];
  for (const h of bySym.values()) {
    const series = hist.get(h.symbol) || [];
    const row = {
      symbol: h.symbol,
      brokerCode: h.instrument !== h.symbol ? h.instrument : null,
      name: names.get(h.symbol) || scrip.getName(h.instrument) || scrip.getName(h.symbol),
      portfolios: h.portfolios,
      value: Math.round(h.value),
      weightPct: totalValue > 0 ? r1((h.value / totalValue) * 100) : null,
      // Bought inside the window: the stock's return is still the stock's, but you did not own
      // it for all of it, so it is flagged rather than presented as your experience. null = no
      // holdings record reaches back to the window start, so it cannot be told.
      heldFullPeriod: h.heldFullPeriod,
    };
    if (series.length < 2) {
      rows.push({ ...row, noData: true, ...explainNoData(h.symbol, h.instrument, meta.get(h.symbol), ps, h.fromIcici) });
      continue;
    }

    const last = series[series.length - 1];
    let base = onOrBefore(series, windowStart);
    const partialHistory = !base;
    if (!base) base = series[0];            // listed during the window
    const inWindow = series.filter((b) => b.date >= base.date);
    const adj = series.map((b) => b.adjclose);

    const ret = (last.adjclose / base.adjclose - 1) * 100;

    // Nifty over the same dates, anchored on the WINDOW START — not on this stock's own first
    // bar. Keying it off each stock's base bar let a thinly-traded name shift Nifty by a few
    // tenths, and the headline changed with whichever row happened to sort first. Only a stock
    // listed mid-window uses its own start, since it has no earlier price to compare from; and a
    // stock whose last bar is older than Nifty's (suspended) ends where its prices end.
    const nb = partialHistory ? onOrBefore(nifty, base.date) : niftyBase;
    const ne = onOrBefore(nifty, last.date) || niftyEnd;
    const niftyRet = nb && ne ? (ne.close / nb.close - 1) * 100 : null;

    // Volatility and drawdown INSIDE the window only.
    const dr = [];
    for (let i = 1; i < inWindow.length; i += 1) dr.push(inWindow[i].adjclose / inWindow[i - 1].adjclose - 1);
    const mean = dr.reduce((a, b) => a + b, 0) / (dr.length || 1);
    const sd = Math.sqrt(dr.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(dr.length - 1, 1));
    const periodVol = sd * Math.sqrt(dr.length) * 100;
    let peak = -Infinity;
    let mdd = 0;
    for (const b of inWindow) {
      peak = Math.max(peak, b.adjclose);
      mdd = Math.min(mdd, b.adjclose / peak - 1);
    }

    const p = last.adjclose;
    const e20 = ema(adj, 20);
    const e50 = ema(adj, 50);
    const e200 = ema(adj, 200);
    const hi52 = Math.max(...adj.slice(-252));

    rows.push({
      ...row,
      asOf: last.date,
      baseDate: base.date,
      partialHistory,
      price: r2(last.close),
      returnPct: r1(ret),
      niftyPct: r1(niftyRet),
      vsNiftyPct: niftyRet == null ? null : r1(ret - niftyRet),
      volPct: r1(periodVol),
      // Return per unit of volatility over the window — a Sharpe-like ratio without annualising,
      // which on a one-month window would only magnify noise.
      riskAdj: periodVol > 0 ? r2(ret / periodVol) : null,
      maxDrawdownPct: r1(mdd * 100),
      rsi: r1(rsi14(adj)),
      ema20Pct: e20 ? r1((p / e20 - 1) * 100) : null,
      ema50Pct: e50 ? r1((p / e50 - 1) * 100) : null,
      ema200Pct: e200 ? r1((p / e200 - 1) * 100) : null,
      emaLadder: ladder(p, e20, e50, e200),
      from52wHighPct: r1((p / hi52 - 1) * 100),
    });
  }

  // ── PERFORMANCE SCORE (0-100) ──────────────────────────────────────────────
  // Ranked WITHIN the list on screen, on purpose. A 1-month and a 1-year return live on wildly
  // different scales, so any fixed mapping of "12% = good" would be right for one period and
  // wrong for the others. Percentile ranks are period-neutral and answer the rebalancing
  // question directly: relative to everything else you hold, how did this one do?
  //   40%  total return over the window
  //   30%  return per unit of volatility — a smooth 10% beats a violent 10%
  //   30%  trend now — the average of price vs its 50- and 200-day EMAs
  // RSI is shown but not scored: a high RSI is strength and overextension at once, so folding it
  // into one number would reward whichever reading happened to be convenient.
  const scored = rows.filter((r) => r.returnPct != null && r.riskAdj != null && r.ema50Pct != null && r.ema200Pct != null);
  const trend = (r) => (r.ema50Pct + r.ema200Pct) / 2;
  const R = scored.map((r) => r.returnPct);
  const RA = scored.map((r) => r.riskAdj);
  const T = scored.map(trend);
  for (const r of scored) {
    const a = pctRank(R, r.returnPct);
    const b = pctRank(RA, r.riskAdj);
    const c = pctRank(T, trend(r));
    r.score = Math.round(100 * (0.4 * a + 0.3 * b + 0.3 * c));
    r.scoreParts = { returnRank: Math.round(a * 100), riskAdjRank: Math.round(b * 100), trendRank: Math.round(c * 100) };
  }

  const priced = rows.filter((r) => r.returnPct != null);
  const pricedValue = priced.reduce((t, r) => t + r.value, 0);
  const basket = pricedValue > 0 ? priced.reduce((t, r) => t + r.returnPct * r.value, 0) / pricedValue : null;

  // Unpriced rows last, then by score.
  rows.sort((a, b) => (a.noData === true) - (b.noData === true) || (b.score ?? -1) - (a.score ?? -1));

  const known = rows.filter((r) => r.heldFullPeriod != null);
  const fetchFailed = rows.filter((r) => r.kind === 'FETCH_FAILED').length;
  const niftyMeta = meta.get(history.NIFTY_KEY);

  return {
    ok: true,
    period,
    portfolio: pfs.length === all.length ? 'both' : pfs[0],
    portfolios: all,
    windowStart,
    asOf: niftyEnd?.date || priced[0]?.asOf || today,
    holdingsAsOf: Object.fromEntries(pfs.map((pf) => [pf, held[pf]?.asOf || null])),
    summary: {
      holdings: rows.length,
      priced: priced.length,
      // What today's basket would have returned had it been held unchanged through the window.
      // Survivorship-biased by construction — it omits everything sold during the window — so it
      // is the STOCKS' performance, never the user's P&L.
      basketReturnPct: r1(basket),
      niftyPct: r1(niftyWindow),
      beatNifty: priced.filter((r) => r.vsNiftyPct != null && r.vsNiftyPct > 0).length,
      // null, not 0, when no holdings snapshot reaches back to the window start.
      holdingStartKnown: known.length > 0,
      holdingStartKnownFor: known.length,
      boughtInWindow: known.length ? known.filter((r) => r.heldFullPeriod === false).length : null,
      holdingsSnapshotAtStart: Object.fromEntries(pfs.map((pf) => [pf, atStart.get(pf)?.date || null])),
    },
    rows,
    noData: rows.filter((r) => r.noData).map((r) => ({ symbol: r.symbol, brokerCode: r.brokerCode, kind: r.kind, reason: r.reason })),
    // The price source itself failing is said out loud, not rendered as an empty table.
    priceSource: {
      ok: fetchFailed === 0 && niftyEnd != null,
      fetchFailed,
      niftyStatus: niftyMeta?.status || null,
      niftyDetail: niftyMeta?.detail || null,
      // null when no ICICI account is in the selection, so the master was not needed.
      iciciMaster: master,
    },
  };
}

module.exports = { getStockPerformance, PERIOD_MONTHS, _internals: { ema, rsi14, pctRank, ladder, onOrBefore } };
