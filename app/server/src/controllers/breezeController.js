const breezeService        = require('../services/breeze/breezeService');
const importsService       = require('../services/imports/importsService');
const brokerageRepository  = require('../repositories/brokerageRepository');
const PF = require('../config/portfolios');

// ── OAuth Callback (Breeze redirects here with ?apisession=<token>) ──────────
async function handleCallback(req, res) {
  const { apisession, status } = req.query;

  if (!apisession) {
    return res.send(callbackPage({
      success: false,
      message: `Breeze login failed: ${req.query.message || 'No session token received'}`,
    }));
  }

  try {
    await breezeService.generateSession(apisession);
    res.send(callbackPage({ success: true, message: 'Connected to Breeze (ICICI Direct) successfully! You can close this tab.' }));
  } catch (err) {
    res.send(callbackPage({ success: false, message: `Session generation failed: ${err.message}` }));
  }
}

function callbackPage({ success, message }) {
  const colour = success ? '#16a34a' : '#dc2626';
  const icon   = success ? '✅' : '❌';
  const appUrl = '/brokers';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Breeze Connect — ZTA</title>
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
    <h2>${success ? 'Breeze Connected' : 'Connection Failed'}</h2>
    <p>${message}</p>
    <a href="${appUrl}">Go to Portfolio →</a>
    ${success ? '<div class="countdown">Redirecting in <span id="cd">3</span>s…</div>' : ''}
  </div>
</body>
</html>`;
}

// ── REST handlers ─────────────────────────────────────────────────────────────

// An ICICI Direct Breeze session is valid for ONE DAY — it dies at midnight IST, so every
// one of these endpoints starts failing each morning until the user logs in again. That is a
// routine, expected, user-actionable state, not a server fault, and it must not surface as a
// bare "500 Request failed": that tells the user nothing and looks like the app is broken.
//
// Breeze does not have ONE message for this. The same dead session came back as "Invalid User
// Details" on one call and "Unauthorized User" on the next, minutes apart — so this matches a
// family of strings rather than a single one. None of them says "expired" to a reader; all of
// them are translated here into a 401 carrying sessionExpired:true so the UI can say so
// plainly and offer the reconnect link.
const SESSION_DEAD = /invalid user details|unauthori[sz]ed user|session\s*(has\s*)?expired|public key does not exist|invalid session|invalid session token/i;

function sendBreezeError(res, next, err) {
  const msg = String(err?.message || '');
  if (SESSION_DEAD.test(msg)) {
    const status = breezeService.getSessionStatus();
    return res.status(401).json({
      error: 'Breeze session expired — reconnect to ICICI Direct to see live positions.',
      sessionExpired: true,
      expiredAt: status?.expiresAt || null,
      loginUrl: (() => { try { return breezeService.getLoginUrl(); } catch { return null; } })(),
      detail: msg,
    });
  }
  return next(err);
}

async function getStatus(req, res, next) {
  try {
    res.json(breezeService.getSessionStatus());
  } catch (err) { next(err); }
}

async function getLoginUrl(req, res, next) {
  try {
    res.json({ loginUrl: breezeService.getLoginUrl() });
  } catch (err) { next(err); }
}

async function generateSession(req, res, next) {
  try {
    const { sessionToken } = req.body;
    if (!sessionToken) return res.status(400).json({ error: 'sessionToken is required' });
    const result = await breezeService.generateSession(sessionToken.trim());
    res.json(result);
  } catch (err) { next(err); }
}

async function getHoldings(req, res, next) {
  try {
    const holdings = await breezeService.fetchHoldings();
    res.json({ holdings, fetchedAt: new Date().toISOString(), count: holdings.length });
  } catch (err) { sendBreezeError(res, next, err); }
}


// The F&O endpoints that used to sit here — positions, position watch, and the premium-ladder
// monitor — are deliberately absent from EquiStar. Participants have an equity book and no
// options subscription, and the strategy logic behind those screens is not theirs to receive.

async function getPledgeSummary(_req, res, next) {
  try {
    res.json(await breezeService.fetchPledgeSummary());
  } catch (err) { sendBreezeError(res, next, err); }
}

async function saveHoldings(req, res, next) {
  try {
    const { holdings, snapshotDate, portfolio = PF.ICICI } = req.body;
    if (!holdings?.length) return res.status(400).json({ error: 'No holdings to save' });

    const date     = snapshotDate || new Date().toISOString().slice(0, 10);
    const fileName = `breeze-${portfolio.toLowerCase()}-${date}.json`;

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
    const today = new Date().toISOString().slice(0, 10);
    // Default to a recent window (last 7 days) so this week's trades show up —
    // and pull across ALL segments (cash + F&O) unless a specific exchange is asked.
    const from = req.query.from || new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const to   = req.query.to   || today;
    const exch = req.query.exchange;
    const orders = exch
      ? await breezeService.fetchOrders(from, to, exch)
      : await breezeService.fetchAllOrders(from, to);
    res.json({ orders, from, to, exchange: exch || 'ALL', fetchedAt: new Date().toISOString(), count: orders.length });
  } catch (err) { sendBreezeError(res, next, err); }
}

async function saveOrders(req, res, next) {
  try {
    const { orders, portfolio = PF.ICICI } = req.body;
    if (!orders?.length) return res.status(400).json({ error: 'No orders to save' });
    // Dedup-append: skip any order already in the DB (matched on
    // date/symbol/side/qty/price/exchange) and insert only the new ones —
    // non-destructive, so re-importing an overlapping window is safe.
    const mapped = orders.map((o) => ({
      tradeDate: o.trade_date || new Date().toISOString().slice(0, 10),
      tradeId:   null,            // Breeze order_id exceeds JS safe-int → rely on tuple match
      // Kept as TEXT for the same reason tradeId is null: 202608181400030309 is ~2.0e17, past
      // Number.MAX_SAFE_INTEGER, so as a number it silently loses precision. As a string it is
      // exact — and its trailing digits are a monotonic intraday sequence, which is the only
      // reliable way to order same-day fills (Breeze sends no trade_time). Without it FIFO
      // falls back to import order and reports intraday round trips with the side reversed.
      brokerOrderId: o.order_id ? String(o.order_id) : null,
      symbol:    o.symbol,
      side:      o.side,
      quantity:  o.quantity,
      price:     o.price,
      exchange:  o.exchange,
      charges:   o.charges || 0,
    }));
    const fileName = `breeze-orders-${portfolio.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`;
    const result = await importsService.importMissingOrders({ portfolio, fileName, orders: mapped });

    // Aggregate brokerage by date+exchange and persist to daily_brokerage table.
    // Only F&O exchanges carry meaningful charges in the Breeze trade response.
    const brokerageMap = new Map(); // key: "date|exchange"
    for (const o of orders) {
      if (!o.charges || o.charges <= 0) continue;
      const exch = String(o.exchange || '').toUpperCase();
      const key  = `${o.trade_date || ''}|${exch}`;
      const prev = brokerageMap.get(key) || {
        trade_date: o.trade_date, exchange: exch,
        brokerage: 0, stt: 0, other_charges: 0, total_charges: 0, trade_count: 0,
      };
      const raw = o._raw_charges || {};
      prev.brokerage    += raw.brokerage   || 0;
      prev.stt          += raw.stt         || 0;
      prev.other_charges+= raw.other_taxes || 0;
      prev.total_charges+= o.charges || 0;
      prev.trade_count  += 1;
      brokerageMap.set(key, prev);
    }
    const brokerageResults = [];
    for (const [, data] of brokerageMap) {
      try {
        await brokerageRepository.upsertDailyBrokerage(
          data.trade_date, portfolio, data.exchange, data,
        );
        brokerageResults.push({ date: data.trade_date, exchange: data.exchange, total: data.total_charges });
      } catch (e) {
        console.error('Failed to save daily brokerage:', e.message);
      }
    }

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
      brokerageSaved: brokerageResults,
    });
  } catch (err) { next(err); }
}

async function revokeToken(req, res, next) {
  try {
    res.json(breezeService.revokeToken());
  } catch (err) { next(err); }
}


// Backfill broker_order_id onto historically-imported orders. UPDATE, not insert — a re-import
// would be deduped away and change nothing. Pass ?dryRun=1 to see the match counts first.
async function backfillOrderIds(req, res, next) {
  try {
    const { from = '2026-05-19', to, portfolio = PF.ICICI, dryRun } = req.query;
    const end = to || new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const svc = require('../services/imports/orderIdBackfillService');
    res.json(await svc.backfillOrderIds({
      from, to: end, portfolio, dryRun: dryRun === '1' || dryRun === 'true',
    }));
  } catch (err) { sendBreezeError(res, next, err); }
}

module.exports = {
  backfillOrderIds,
  handleCallback,
  getStatus,
  getLoginUrl,
  generateSession,
  getHoldings,
  getPledgeSummary,
  saveHoldings,
  getOrders,
  saveOrders,
  revokeToken,
};
