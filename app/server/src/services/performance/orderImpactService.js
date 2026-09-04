// "Did the trades I made in this period turn out well?"
//
// Not a P&L report. P&L asks what a position earned; this asks whether each DECISION was
// timed well, judged by what the price did afterwards:
//
//   BUY  — measured forward from the fill. Bought and it fell → negative.
//   SELL — measured in reverse. Sold and it fell → POSITIVE, because the fall was avoided.
//
// The sell inversion is the whole point. A conventional report shows a sale as a realised gain
// and stops; it cannot tell you the sale was a mistake because the stock doubled afterwards.
//
// ── TWO HORIZONS, ANSWERING DIFFERENT QUESTIONS ──────────────────────────────
// 'now'  — every fill marked to today. Best for recent periods. Has a neat property: a full
//          round trip inside the period reconciles EXACTLY to its realised P&L (buy 10@100,
//          sell 10@120, now 110 → +100 and +100 = 10×(120−100)), because the end price cancels.
//          Completed trades are scored on what happened; only open exposure is marked to today.
// '1m'/'3m'/'6m' — each fill judged over a FIXED window from its own trade date. This makes
//          periods comparable: a 2024 buy is no longer being graded on two years of drift while
//          a recent one gets two weeks. The round-trip identity does NOT hold here, by design —
//          each decision is scored on its own window, not against a shared endpoint.
//          Fills too recent for the window to have elapsed are reported as "not matured" and
//          excluded rather than scored on a partial window.
//
// ── TOTAL RETURN, NOT PRICE RETURN ───────────────────────────────────────────
// A share price drops by roughly the dividend on its ex-date. Comparing raw prices therefore
// credits a seller for a fall that was really a payout, and penalises a holder for a drop whose
// cash they received. Both are backwards. So the end price is (price + dividends since the
// fill): a buyer collected them, a seller gave them up, and each is scored accordingly.
//
// Prices are also SPLIT/BONUS adjusted — comparing a pre-split fill to a post-split quote
// fabricates a collapse that never happened, hitting exactly the long-held positions a
// rotation review cares about most.
const https = require('https');
const { openDatabase, allAsync, closeAsync } = require('../../db/connection');
const { resolveNseSymbol } = require('../portfolio/portfolioService');
const corpActions = require('../market/corpActionsService');

const EQUITY_EXCHANGES = new Set(['NSE', 'BSE']);
const round2 = (v) => Math.round(v * 100) / 100;
const round1 = (v) => Math.round(v * 10) / 10;
const HORIZON_MONTHS = { '1m': 1, '3m': 3, '6m': 6, '12m': 12 };

const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return dt.toISOString().slice(0, 10);
}

// ── Yahoo daily candles ───────────────────────────────────────────────────────
function yahooChart(symbol, params) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: 'query1.finance.yahoo.com',
        path: `/v8/finance/chart/${encodeURIComponent(symbol)}.NS?${params}`,
        method: 'GET', timeout: 12000,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const r = JSON.parse(body)?.chart?.result?.[0];
            const ts = r?.timestamp || [];
            const cl = r?.indicators?.quote?.[0]?.close || [];
            const out = [];
            for (let i = 0; i < ts.length; i += 1) {
              if (cl[i] != null) {
                out.push({ date: new Date((ts[i] + 19800) * 1000).toISOString().slice(0, 10), close: cl[i] });
              }
            }
            resolve(out);
          } catch { resolve([]); }
        });
      });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.end();
  });
}

const dailyHistory = (symbol, fromDate, toDate) => yahooChart(symbol,
  `period1=${Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1000)}`
  + `&period2=${Math.floor(Date.parse(`${toDate}T00:00:00Z`) / 1000) + 86400}&interval=1d`);

// First close ON or AFTER the target — the horizon date can land on a weekend or holiday.
function priceOnOrAfter(history, date) {
  for (const h of history) if (h.date >= date) return h;
  return null;
}

// ── Current price, cheapest source first ──────────────────────────────────────
async function latestPrices(symbols) {
  const out = new Map();
  if (!symbols.length) return out;
  const { LATEST_SCAN_GLOBAL } = require('../../repositories/universeScoresLatestScan');

  const db = openDatabase();
  try {
    const rows = await allAsync(db,
      `SELECT symbol, cmp, scan_date FROM universe_scores u
        WHERE symbol IN (${symbols.map(() => '?').join(',')}) AND ${LATEST_SCAN_GLOBAL}`, symbols);
    for (const r of rows) {
      if (r.cmp != null) out.set(r.symbol.toUpperCase(), { price: r.cmp, asOf: r.scan_date, source: 'scan' });
    }
    const snaps = await allAsync(db,
      `SELECT payload_json, snapshot_date FROM portfolio_snapshots
        WHERE id IN (SELECT MAX(id) FROM portfolio_snapshots GROUP BY portfolio)`);
    for (const s of snaps) {
      let holdings = [];
      try { holdings = JSON.parse(s.payload_json)?.portfolio || []; } catch { /* skip */ }
      for (const h of holdings) {
        const sym = String(resolveNseSymbol(h.instrument) || h.instrument || '').toUpperCase();
        const ltp = Number(h.ltp);
        if (sym && ltp > 0 && !out.has(sym)) {
          out.set(sym, { price: round2(ltp), asOf: s.snapshot_date, source: 'holdings' });
        }
      }
    }
  } finally { await closeAsync(db); }

  const missing = symbols.filter((s) => !out.has(s));
  const BATCH = 6;
  for (let i = 0; i < missing.length; i += BATCH) {
    const slice = missing.slice(i, i + BATCH);
    const got = await Promise.all(slice.map((s) => yahooChart(s, 'range=5d&interval=1d')));
    slice.forEach((s, j) => {
      const last = got[j]?.[got[j].length - 1];
      if (last) out.set(s, { price: round2(last.close), asOf: last.date, source: 'yahoo' });
    });
  }
  return out;
}

// ── The report ────────────────────────────────────────────────────────────────
async function getOrderImpact({ from, to, portfolio = '', horizon = 'now' } = {}) {
  const hz = HORIZON_MONTHS[horizon] ? horizon : 'now';
  const months = HORIZON_MONTHS[hz] || null;
  const today = istToday();

  const db = openDatabase();
  let rows;
  try {
    const params = [];
    let where = 'WHERE trade_date IS NOT NULL';
    if (from) { where += ' AND trade_date >= ?'; params.push(from); }
    if (to)   { where += ' AND trade_date <= ?'; params.push(to); }
    if (portfolio) { where += ' AND portfolio = ?'; params.push(portfolio); }
    rows = await allAsync(db,
      `SELECT trade_date, portfolio, symbol, side, quantity, price, exchange
         FROM orders ${where} ORDER BY trade_date ASC`, params);
  } finally { await closeAsync(db); }

  // Equity only. An F&O decision expires on its own schedule and cannot be marked against a
  // spot price, so mixing them in would corrupt every total.
  const equity = rows.filter((r) => EQUITY_EXCHANGES.has(String(r.exchange || '').toUpperCase()));

  const bySymbol = new Map();
  for (const r of equity) {
    const sym = String(resolveNseSymbol(r.symbol) || r.symbol || '').toUpperCase();
    if (!sym) continue;
    const qty = Number(r.quantity) || 0;
    const px = Number(r.price) || 0;
    if (qty <= 0 || px <= 0) continue;
    let s = bySymbol.get(sym);
    if (!s) {
      s = { symbol: sym, fills: [], portfolios: new Set(), firstDate: r.trade_date, lastDate: r.trade_date };
      bySymbol.set(sym, s);
    }
    s.portfolios.add(r.portfolio);
    if (r.trade_date < s.firstDate) s.firstDate = r.trade_date;
    if (r.trade_date > s.lastDate) s.lastDate = r.trade_date;
    s.fills.push({ qty, px, date: r.trade_date, side: String(r.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY' });
  }

  const symbols = [...bySymbol.keys()];
  const [prices, caMap, divMap, caFrom, divFrom] = await Promise.all([
    hz === 'now' ? latestPrices(symbols) : Promise.resolve(new Map()),
    corpActions.priceScaleActionsBySymbol(),
    corpActions.dividendsBySymbol(),
    corpActions.coverageFrom(),
    corpActions.dividendCoverageFrom(),
  ]);

  // Horizon mode needs each symbol's daily history to read the price N months after each fill.
  const histories = new Map();
  if (months) {
    const earliest = symbols.reduce((min, s) => {
      const f = bySymbol.get(s).firstDate;
      return !min || f < min ? f : min;
    }, null) || from || today;
    const BATCH = 5;
    for (let i = 0; i < symbols.length; i += BATCH) {
      const slice = symbols.slice(i, i + BATCH);
      const got = await Promise.all(slice.map((s) => dailyHistory(s, earliest, today)));
      slice.forEach((s, j) => histories.set(s, got[j] || []));
    }
  }

  const out = [];
  for (const s of bySymbol.values()) {
    const acts = caMap.get(s.symbol) || [];
    const divs = divMap.get(s.symbol) || [];
    const quote = prices.get(s.symbol);
    const history = histories.get(s.symbol) || [];

    let caBlocked = false;
    let immature = 0;
    let unpricedFills = 0;
    let dividendCredited = 0;

    const agg = { BUY: { qty: 0, val: 0, impact: 0, scoredQty: 0 },
                  SELL: { qty: 0, val: 0, impact: 0, scoredQty: 0 } };

    for (const f of s.fills) {
      // Restate the fill in TODAY's share terms — fills either side of the same split need
      // different treatment, so this is per fill, not per symbol.
      const adj = corpActions.adjustmentFor(acts, f.date);
      if (adj.blocked) caBlocked = true;
      const factor = adj.factor || 1;
      const qty = f.qty / factor;
      const entry = f.px * factor;

      const side = agg[f.side];
      side.qty += qty;
      side.val += qty * entry;

      // Where the decision is judged from.
      let endPrice = null;
      let endDate = null;
      if (months) {
        const target = addMonths(f.date, months);
        if (target > today) { immature += 1; continue; }   // window hasn't elapsed yet
        const hit = priceOnOrAfter(history, target);
        if (!hit) { unpricedFills += 1; continue; }
        endPrice = hit.close; endDate = hit.date;
      } else {
        if (!quote) { unpricedFills += 1; continue; }
        endPrice = quote.price; endDate = quote.asOf || today;
      }

      // Total return: dividends between the fill and the endpoint, in today's share terms.
      const divPerShare = divs
        .filter((d) => d.exDate > f.date && d.exDate <= endDate)
        .reduce((a, d) => a + d.amount * (corpActions.adjustmentFor(acts, d.exDate).factor || 1), 0);
      const endTotal = endPrice + divPerShare;
      dividendCredited += divPerShare * qty * (f.side === 'BUY' ? 1 : -1);

      // A buyer collected those dividends; a seller forfeited them.
      side.impact += f.side === 'BUY' ? qty * (endTotal - entry) : qty * (entry - endTotal);
      side.scoredQty += qty;
    }

    const b = agg.BUY;
    const sl = agg.SELL;
    const scored = b.scoredQty > 0 || sl.scoredQty > 0;
    const buyImpact = b.scoredQty > 0 ? b.impact : null;
    const sellImpact = sl.scoredQty > 0 ? sl.impact : null;
    const totalImpact = scored ? (buyImpact ?? 0) + (sellImpact ?? 0) : null;
    // Capital denominator counts only the fills actually scored, so an immature fill cannot
    // dilute the percentage of the ones that were.
    const scoredCapital = (b.scoredQty > 0 ? b.val * (b.scoredQty / b.qty) : 0)
                        + (sl.scoredQty > 0 ? sl.val * (sl.scoredQty / sl.qty) : 0);

    out.push({
      symbol: s.symbol,
      portfolios: [...s.portfolios],
      firstTrade: s.firstDate,
      lastTrade: s.lastDate,
      buyQty: round2(b.qty), buyValue: round2(b.val), buyAvg: b.qty > 0 ? round2(b.val / b.qty) : null,
      sellQty: round2(sl.qty), sellValue: round2(sl.val), sellAvg: sl.qty > 0 ? round2(sl.val / sl.qty) : null,
      orders: s.fills.length,
      cmp: quote?.price ?? null, cmpAsOf: quote?.asOf ?? null, priceSource: quote?.source ?? null,
      buyImpact: buyImpact != null ? round2(buyImpact) : null,
      sellImpact: sellImpact != null ? round2(sellImpact) : null,
      totalImpact: totalImpact != null ? round2(totalImpact) : null,
      buyReturnPct: b.scoredQty > 0 && b.val > 0 ? round1((b.impact / (b.val * (b.scoredQty / b.qty))) * 100) : null,
      sellReturnPct: sl.scoredQty > 0 && sl.val > 0 ? round1((sl.impact / (sl.val * (sl.scoredQty / sl.qty))) * 100) : null,
      turnover: round2(b.val + sl.val),
      scoredCapital: round2(scoredCapital),
      impactPct: totalImpact != null && scoredCapital > 0 ? round1((totalImpact / scoredCapital) * 100) : null,
      dividendImpact: round2(dividendCredited),
      activity: b.qty > 0 && sl.qty > 0 ? 'ROTATED' : b.qty > 0 ? 'BOUGHT' : 'SOLD',
      corpActionAdjusted: acts.some((a) => a.exDate > s.firstDate),
      corpActionBlocked: caBlocked,
      immatureFills: immature,
      unpricedFills,
      // "Nothing scored" has two very different causes and they must not be conflated: a fill
      // whose horizon has not elapsed yet WILL be scoreable later, whereas one with no price
      // data never will. Reporting a too-recent trade as "no price" would send you looking for
      // a data problem that does not exist.
      status: scored ? 'SCORED' : (immature > 0 && unpricedFills === 0 ? 'NOT_MATURED' : 'NO_PRICE'),
      unpriced: !scored,
    });
  }

  out.sort((a, b) => (b.totalImpact ?? -Infinity) - (a.totalImpact ?? -Infinity));

  const priced = out.filter((r) => !r.unpriced);
  const sum = (f) => priced.reduce((a, r) => a + (r[f] || 0), 0);
  const buyTotal = sum('buyImpact');
  const sellTotal = sum('sellImpact');
  const capital = sum('scoredCapital');

  return {
    ok: true,
    from: from || null,
    to: to || null,
    portfolio: portfolio || null,
    horizon: hz,
    horizonMonths: months,
    // Coverage caveats. A period before these dates is not "action-free", it is action-UNKNOWN,
    // and the UI must be able to say so rather than present it with equal confidence.
    corpActionCoverageFrom: caFrom,
    corpActionCoverageGap: !!(caFrom && from && from < caFrom),
    dividendCoverageFrom: divFrom,
    dividendCoverageGap: !!(divFrom && from && from < divFrom),
    unpricedSymbols: out.filter((r) => r.status === 'NO_PRICE').map((r) => r.symbol),
    notMaturedSymbols: out.filter((r) => r.status === 'NOT_MATURED').map((r) => r.symbol),
    rows: out,
    totals: {
      symbols: out.length,
      scored: out.filter((r) => r.status === 'SCORED').length,
      notMatured: out.filter((r) => r.status === 'NOT_MATURED').length,
      unpriced: out.filter((r) => r.status === 'NO_PRICE').length,
      immatureFills: out.reduce((a, r) => a + r.immatureFills, 0),
      orders: out.reduce((a, r) => a + r.orders, 0),
      buyValue: round2(sum('buyValue')),
      sellValue: round2(sum('sellValue')),
      buyImpact: round2(buyTotal),
      sellImpact: round2(sellTotal),
      totalImpact: round2(buyTotal + sellTotal),
      dividendImpact: round2(sum('dividendImpact')),
      turnover: round2(sum('turnover')),
      scoredCapital: round2(capital),
      impactPct: capital > 0 ? round1(((buyTotal + sellTotal) / capital) * 100) : null,
      goodCalls: priced.filter((r) => (r.totalImpact || 0) > 0).length,
      badCalls: priced.filter((r) => (r.totalImpact || 0) < 0).length,
    },
  };
}

module.exports = { getOrderImpact };
