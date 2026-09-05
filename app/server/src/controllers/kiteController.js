const kiteService     = require('../services/kite/kiteService');
const importsService  = require('../services/imports/importsService');
const PF = require('../config/portfolios');

async function handleCallback(req, res) {
  const { request_token, status } = req.query;

  if (status !== 'success' || !request_token) {
    return res.send(callbackPage({
      success: false,
      message: `Kite login failed: ${req.query.message || 'Unknown error'}`,
    }));
  }

  try {
    await kiteService.exchangeToken(request_token);
    res.send(callbackPage({ success: true, message: 'Connected to Kite successfully! You can close this tab.' }));
  } catch (err) {
    res.send(callbackPage({ success: false, message: `Token exchange failed: ${err.message}` }));
  }
}

function callbackPage({ success, message }) {
  const colour  = success ? '#16a34a' : '#dc2626';
  const icon    = success ? '✅' : '❌';
  const appUrl = '/brokers';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Kite Connect — ZTA</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #f9fafb; }
    .card { background: #fff; border-radius: 12px; padding: 40px 48px; box-shadow: 0 4px 24px #0001;
            text-align: center; max-width: 420px; }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h2 { margin: 0 0 10px; color: ${colour}; font-size: 22px; }
    p  { color: #6b7280; font-size: 14px; margin: 0 0 24px; }
    a  { display: inline-block; background: #2563eb; color: #fff; text-decoration: none;
         border-radius: 8px; padding: 10px 24px; font-weight: 600; font-size: 14px; }
    a:hover { background: #1d4ed8; }
    .countdown { font-size: 12px; color: #9ca3af; margin-top: 12px; }
  </style>
  ${success ? `<script>
    let s = 5;
    function tick() {
      const el = document.getElementById('cd');
      if (el) el.textContent = s;
      if (--s < 0) window.location.href = '${appUrl}';
      else setTimeout(tick, 1000);
    }
    window.onload = tick;
  </script>` : ''}
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h2>${success ? 'Kite Connected' : 'Connection Failed'}</h2>
    <p>${message}</p>
    <a href="${appUrl}">Go to Portfolio →</a>
    ${success ? '<div class="countdown">Redirecting in <span id="cd">3</span>s…</div>' : ''}
  </div>
</body>
</html>`;
}

async function getStatus(req, res, next) {
  try {
    res.json(kiteService.getSessionStatus());
  } catch (err) { next(err); }
}

async function getLoginUrl(req, res, next) {
  try {
    res.json({ loginUrl: kiteService.getLoginUrl() });
  } catch (err) { next(err); }
}

async function exchangeToken(req, res, next) {
  try {
    const { requestToken } = req.body;
    if (!requestToken) return res.status(400).json({ error: 'requestToken is required' });
    const result = await kiteService.exchangeToken(requestToken.trim());
    res.json(result);
  } catch (err) { next(err); }
}

async function getHoldings(req, res, next) {
  try {
    const holdings = await kiteService.fetchHoldings();
    res.json({ holdings, fetchedAt: new Date().toISOString(), count: holdings.length });
  } catch (err) { next(err); }
}

async function saveHoldings(req, res, next) {
  try {
    const { holdings, snapshotDate, portfolio = PF.ZERODHA } = req.body;
    if (!holdings?.length) return res.status(400).json({ error: 'No holdings to save' });

    const date     = snapshotDate || new Date().toISOString().slice(0, 10);
    const fileName = `kite-${portfolio.toLowerCase()}-${date}.json`;

    const result = await importsService.importPortfolioSnapshot({
      portfolio,
      snapshotDate: date,
      fileName,
      holdings,
    });
    // Report what was ACTUALLY written, not what was sent.
    //
    // This used to be `result.inserted ?? holdings.length`. The service returns `rowsInserted`,
    // so `result.inserted` was always undefined and the fallback echoed the sent count back —
    // reporting success by assumption. Rows dropped during normalisation (missing instrument,
    // zero qty) vanished silently, and any future write failure would have too.
    res.json({
      saved: true, snapshotDate: date, portfolio,
      inserted: result.rowsInserted ?? result.inserted ?? 0,
      seen: result.rowsSeen ?? holdings.length,
    });
  } catch (err) { next(err); }
}

async function getOrders(req, res, next) {
  try {
    const orders = await kiteService.fetchOrders();   // executed fills only (today)
    // If no fills, surface the order book so the UI can explain WHY (e.g. all
    // orders cancelled / rejected / unfilled).
    let orderBook = [];
    if (orders.length === 0) {
      orderBook = await kiteService.fetchOrderBookSummary();
    }
    res.json({ orders, orderBook, fetchedAt: new Date().toISOString(), count: orders.length });
  } catch (err) { next(err); }
}

async function saveOrders(req, res, next) {
  try {
    const { orders, portfolio = PF.ZERODHA } = req.body;
    if (!orders?.length) return res.status(400).json({ error: 'No orders to save' });
    // Dedup-append: skip orders already in the DB, insert only new ones.
    const mapped = orders.map((o) => ({
      tradeDate: o.trade_date || new Date().toISOString().slice(0, 10),
      tradeId:   o.order_id ? Number(o.order_id) || null : null,
      symbol:    o.symbol,
      side:      o.side,
      quantity:  o.quantity,
      price:     o.price,
      exchange:  o.exchange,
    }));
    const fileName = `kite-orders-${portfolio.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`;
    const result = await importsService.importMissingOrders({ portfolio, fileName, orders: mapped });

    // Auto-create recommendations for equity buys that match a recent Top 25 list
    let autoRecs = { created: [], skipped: 0 };
    try {
      const recommendationsService = require('../services/recommendations/recommendationsService');
      autoRecs = await recommendationsService.autoRecommendFromTop25Buys(orders);
    } catch (e) { console.error('Top25 auto-recommend failed:', e.message); }

    res.json({
      saved: true, portfolio,
      dates: result.tradeDates || [],
      inserted: result.rowsInserted ?? 0,
      skipped:  result.rowsSkipped ?? 0,
      autoRecommendations: autoRecs.created,
      autoRecommendationsSkipped: autoRecs.skipped,
    });
  } catch (err) { next(err); }
}

async function revokeToken(req, res, next) {
  try {
    res.json(await kiteService.revokeToken());
  } catch (err) { next(err); }
}

module.exports = { handleCallback, getStatus, getLoginUrl, exchangeToken, getHoldings, saveHoldings, getOrders, saveOrders, revokeToken };
