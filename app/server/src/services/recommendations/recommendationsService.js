const recommendationsRepository = require('../../repositories/recommendationsRepository');
const nseService = require('../market/nseService');

// Common alias fixes for recommendation symbols (advisor may use short codes)
const REC_SYMBOL_ALIASES = {
  GROW:   'GROWW',
  BAJAJFIN: 'BAJFINANCE',
  HDFC:   'HDFCBANK',
  SBI:    'SBIN',
  IOC:    'IOC',
};

async function getRecommendations() {
  const rows = await recommendationsRepository.listRecommendations();

  // Enrich active recommendations with live price data
  const enriched = await Promise.all(rows.map(async (rec) => {
    if (rec.status !== 'Active' && rec.status !== 'active') return rec;
    try {
      const resolvedSymbol = REC_SYMBOL_ALIASES[rec.symbol] || rec.symbol;
      const snap = await nseService.fetchMomentumSnapshot(resolvedSymbol);
      const currentPrice = snap.currentPrice;
      const entryPrice   = Number(rec.cmp || 0);
      const targetPrice  = Number(rec.target_price || 0);
      const gainFromEntry  = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : null;
      const upsideToTarget = targetPrice > 0 ? ((targetPrice - currentPrice) / currentPrice) * 100 : null;
      const targetHit      = targetPrice > 0 && currentPrice >= targetPrice;
      return {
        ...rec,
        current_price:    currentPrice,
        gain_from_entry:  gainFromEntry,
        upside_to_target: upsideToTarget,
        target_hit:       targetHit,
        trend_status:     snap.trendStatus,
        price_as_of:      snap.asOf || '',
      };
    } catch {
      return { ...rec, current_price: null, gain_from_entry: null, upside_to_target: null };
    }
  }));

  return { rows: enriched };
}

// Add a recommendation (manual entry or one-click from the Nifty 500 Top 25).
async function addRecommendation(input) {
  const symbol = String(input.symbol || '').trim().toUpperCase();
  if (!symbol) throw new Error('Symbol is required.');
  const actionType = String(input.actionType || 'BUY').trim().toUpperCase();

  // CMP: use provided value, else fetch live (best-effort)
  let cmp = Number(input.cmp) || null;
  if (!cmp) {
    try {
      const snap = await nseService.fetchMomentumSnapshot(REC_SYMBOL_ALIASES[symbol] || symbol);
      cmp = snap.currentPrice || null;
    } catch { /* leave null */ }
  }

  return recommendationsRepository.insertRecommendation({
    recommendationDate: input.recommendationDate || new Date().toISOString().slice(0, 10),
    advisor:    String(input.advisor || 'Self').trim(),
    symbol,
    actionType,
    cmp,
    targetPrice: Number(input.targetPrice) || null,
    stopLoss:    Number(input.stopLoss) || null,
    timeframe:   String(input.timeframe || '').trim() || null,
    status:      'Active',
    notes:       String(input.notes || '').trim() || null,
  });
}

// ── Auto-recommend from Top-25 buys ───────────────────────────────────────────
// When broker orders are imported, any EQUITY BUY whose symbol appeared in a
// recent daily Nifty-500 Top 25 list becomes a recommendation automatically:
// entry = actual buy price, target = +20%, timeframe = 6M.
const TOP25_LOOKBACK_DAYS = 7;
const AUTO_TARGET_PCT     = 20;
const AUTO_TIMEFRAME      = '6M';

function _isEquityOrder(o) {
  const ex = String(o.exchange || '').toUpperCase();
  if (['NFO', 'BFO', 'MCX'].includes(ex)) return false;
  const s = String(o.symbol || '').toUpperCase().replace(/\s+/g, '');
  return !(/\d/.test(s) && /(CE|PE|FUT)$/.test(s));   // exclude option/future contracts
}

async function autoRecommendFromTop25Buys(orders) {
  const universeScoresRepository = require('../../repositories/universeScoresRepository');
  const { resolveNseSymbol } = require('../portfolio/portfolioService');

  const buys = (orders || []).filter(
    (o) => String(o.side).toUpperCase() === 'BUY' && Number(o.quantity) > 0 && _isEquityOrder(o)
  );
  if (!buys.length) return { created: [], skipped: 0 };

  // Recent Top-25 membership: symbol → best (lowest-rank) recent appearance
  const since = new Date(Date.now() - TOP25_LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
  const topRows = await universeScoresRepository.listDailyTops(since, TOP25_LOOKBACK_DAYS);
  const topBySymbol = new Map();
  for (const t of topRows) {
    const prev = topBySymbol.get(t.symbol);
    if (!prev || t.rank < prev.rank) topBySymbol.set(t.symbol, t);
  }
  if (!topBySymbol.size) return { created: [], skipped: 0 };

  const created = [];
  let skipped = 0;
  const seenThisBatch = new Set();   // collapse multiple fills of one stock

  for (const o of buys) {
    const nse = resolveNseSymbol(String(o.symbol || '').trim().toUpperCase());
    const hit = topBySymbol.get(nse);
    if (!hit || seenThisBatch.has(nse)) continue;
    seenThisBatch.add(nse);

    const price = Number(o.price) || null;
    const result = await recommendationsRepository.insertRecommendation({
      recommendationDate: o.trade_date || o.tradeDate || new Date().toISOString().slice(0, 10),
      advisor:    'Top25 Auto',
      symbol:     nse,
      actionType: 'BUY',
      cmp:        price,
      targetPrice: price ? Math.round(price * (1 + AUTO_TARGET_PCT / 100) * 100) / 100 : null,
      stopLoss:   null,
      timeframe:  AUTO_TIMEFRAME,
      status:     'Active',
      notes:      `Auto from order import: bought ${o.quantity} @ ₹${price} on ${o.trade_date || o.tradeDate}; ` +
                  `in Top 25 #${hit.rank} on ${hit.scan_date} (score ${hit.combined_score}). Target +${AUTO_TARGET_PCT}% in ${AUTO_TIMEFRAME}.`,
    });
    if (result.duplicate) skipped += 1;
    else created.push({ symbol: nse, entry: price, target: price ? Math.round(price * 1.2 * 100) / 100 : null, topRank: hit.rank, topDate: hit.scan_date });
  }
  return { created, skipped };
}

module.exports = {
  getRecommendations,
  addRecommendation,
  autoRecommendFromTop25Buys,
};
