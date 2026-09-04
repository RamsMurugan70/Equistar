const repo = require('../repositories/brokerTipsRepository');
const breezeService = require('../services/breeze/breezeService');

// Fetch live price for a symbol via Breeze (best-effort, silently skipped if unavailable)
async function fetchLivePrice(symbol, exchange) {
  try {
    return await breezeService.fetchEquityLtp(symbol, exchange || 'NSE');
  } catch {
    return null;
  }
}

// Enrich tips with live price + calculated metrics
async function enrichTips(tips) {
  return Promise.all(tips.map(async (t) => {
    const livePrice = await fetchLivePrice(t.symbol, t.exchange).catch(() => null);
    const currentPrice = livePrice;

    let pctToTarget  = null;
    let pctToStop    = null;
    let unrealizedPnl = null;
    let unrealizedPct = null;

    const base = t.avg_buy_price || t.rec_price;

    if (currentPrice && t.target_price > 0) {
      pctToTarget = Math.round(((t.target_price - currentPrice) / currentPrice) * 10000) / 100;
    }
    if (currentPrice && t.stop_loss > 0) {
      pctToStop = Math.round(((currentPrice - t.stop_loss) / t.stop_loss) * 10000) / 100;
    }
    if (currentPrice && base > 0) {
      const qty = t.net_qty || 0;
      unrealizedPnl = qty > 0 ? Math.round((currentPrice - base) * qty * 100) / 100 : null;
      unrealizedPct = Math.round(((currentPrice - base) / base) * 10000) / 100;
    }

    return {
      ...t,
      current_price:  currentPrice,
      pct_to_target:  pctToTarget,
      pct_to_stop:    pctToStop,
      unrealized_pnl: unrealizedPnl,
      unrealized_pct: unrealizedPct,
    };
  }));
}

async function list(req, res, next) {
  try {
    const { status, portfolio } = req.query;
    const tips = await repo.listTips({ status, portfolio });
    const enriched = await enrichTips(tips);
    res.json({ tips: enriched });
  } catch (e) { next(e); }
}

async function add(req, res, next) {
  try {
    const { symbol, exchange, broker, rec_date, action, rec_price, target_price, stop_loss, horizon, portfolio, notes } = req.body;
    if (!symbol || !broker || !rec_date) {
      return res.status(400).json({ error: 'symbol, broker and rec_date are required' });
    }
    const id = await repo.addTip({ symbol, exchange, broker, rec_date, action, rec_price, target_price, stop_loss, horizon, portfolio, notes });
    res.json({ ok: true, id });
  } catch (e) { next(e); }
}

async function update(req, res, next) {
  try {
    await repo.updateTip(req.params.id, req.body);
    res.json({ ok: true });
  } catch (e) { next(e); }
}

async function remove(req, res, next) {
  try {
    await repo.deleteTip(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
}

module.exports = { list, add, update, remove };
