const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// This participant's own Kite Connect keys — see the same note in breezeService. Held in module
// memory so the synchronous header and login-URL builders below need no change.
const credentials = require('../brokers/credentialsService');

let creds = { apiKey: '', apiSecret: '' };

async function refreshCredentials() {
  const c = await credentials.get('zerodha').catch(() => null);
  creds = { apiKey: c?.apiKey || '', apiSecret: c?.apiSecret || '' };
  return { configured: !!creds.apiKey };
}

refreshCredentials().catch(() => {});
const BASE_HOST  = 'api.kite.trade';

// Persist the daily session so server restarts don't force a re-login
// PER-INSTANCE, NOT PER-INSTALLATION. This used to resolve to one file under the app directory,
// which on a shared server means every participant reads and writes the same broker session — the
// first person to connect would hand their live trading session to all twenty-five. It now sits
// beside that participant's own database, in a directory only their process is given.
const SESSION_DIR = process.env.INSTANCE_DATA_DIR
  || path.join(__dirname, '..', '..', '..', 'data');
const SESSION_FILE = path.join(SESSION_DIR, 'kite_session.json');

let session = {
  accessToken: null,
  loginAt:     null,   // ISO string
  expiresAt:   null,   // ISO string  (6:00 AM next day)
};

function saveSession() {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session), 'utf8');
  } catch (_e) { /* non-fatal */ }
}

function loadSession() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (raw && raw.expiresAt && new Date() < new Date(raw.expiresAt)) {
      session = raw;
      console.log(`◇ Kite session restored from disk (expires ${session.expiresAt})`);
    }
  } catch (_e) { /* no saved session */ }
}

loadSession();

function sessionExpiry() {
  // Kite tokens expire at 6:00 AM IST the following day
  const now = new Date();
  const exp = new Date(now);
  exp.setDate(exp.getDate() + 1);
  exp.setHours(6, 0, 0, 0);
  return exp.toISOString();
}

function isTokenValid() {
  if (!session.accessToken) return false;
  if (!session.expiresAt)   return false;
  return new Date() < new Date(session.expiresAt);
}

// ── Low-level HTTPS request helper ───────────────────────────────────────────
function kiteRequest({ method, path, body, accessToken }) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? new URLSearchParams(body).toString() : '';
    const headers = {
      'X-Kite-Version': '3',
      'Content-Type':   'application/x-www-form-urlencoded',
    };
    if (accessToken) {
      headers['Authorization'] = `token ${creds.apiKey}:${accessToken}`;
    }
    if (bodyStr) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(
      { hostname: BASE_HOST, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.status === 'error') {
              reject(new Error(`Kite API error: ${parsed.message} (${parsed.error_type})`));
            } else {
              resolve(parsed.data ?? parsed);
            }
          } catch {
            reject(new Error(`Kite parse error: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

function getLoginUrl() {
  return `https://kite.zerodha.com/connect/login?api_key=${creds.apiKey}&v=3`;
}

function getSessionStatus() {
  return {
    connected:    isTokenValid(),
    loginAt:      session.loginAt,
    expiresAt:    session.expiresAt,
    hasApiKey:    !!creds.apiKey,
  };
}

async function exchangeToken(requestToken) {
  await refreshCredentials();
  if (!creds.apiKey || !creds.apiSecret) {
    throw Object.assign(
      new Error('Add your Zerodha API key and secret on the Brokers page first.'),
      { code: 'NOT_CONFIGURED' });
  }
  const checksum = crypto
    .createHash('sha256')
    .update(creds.apiKey + requestToken + creds.apiSecret)
    .digest('hex');

  const data = await kiteRequest({
    method: 'POST',
    path:   '/session/token',
    body:   { api_key: creds.apiKey, request_token: requestToken, checksum },
  });

  session = {
    accessToken: data.access_token,
    loginAt:     new Date().toISOString(),
    expiresAt:   sessionExpiry(),
  };
  saveSession();

  return { connected: true, loginAt: session.loginAt, expiresAt: session.expiresAt };
}

async function fetchHoldings() {
  if (!isTokenValid()) {
    throw new Error('Kite session expired or not connected. Please exchange a new request token.');
  }

  const raw = await kiteRequest({
    method:      'GET',
    path:        '/portfolio/holdings',
    accessToken: session.accessToken,
  });

  // Map Kite holding → app portfolio holding format (richer than CSV)
  //
  // PLEDGED SHARES LIVE IN A SEPARATE FIELD, and leaving it out reports them as sold.
  //
  // When holdings are pledged with Zerodha for margin, the shares move OUT of `quantity` and
  // into `collateral_quantity`. They are still owned — they are simply encumbered. A fully
  // pledged holding therefore arrives as `quantity: 0, collateral_quantity: 500`, and summing
  // only quantity + t1_quantity reported it as a zero position: the stock appeared to have
  // vanished from the portfolio, which is exactly how it was noticed.
  //
  // The three quantities added here are the only ones that do not overlap:
  //   quantity            settled, in demat, unencumbered
  //   t1_quantity         bought but not yet settled into demat
  //   collateral_quantity pledged with the broker as margin collateral
  //
  // The rest of Kite's quantity fields are views OF those, not additions to them —
  // `opening_quantity` is the day's starting figure, `realised_quantity` and `used_quantity`
  // are subsets, and `authorised_quantity` is the part of `quantity` released for sale via
  // TPIN. Adding any of them would double-count.
  //
  // The ICICI path already solves the same problem a different way, because Breeze exposes no
  // collateral field: it takes the larger of the demat and portfolio quantities and flags the
  // difference as pledged. Both now set the same `pledged` flag, which is persisted and shown.
  const qtyOf = (h) => (h.quantity || 0) + (h.t1_quantity || 0) + (h.collateral_quantity || 0);

  return (raw || []).map((h) => {
    const qty        = qtyOf(h);
    const avgCost    = h.average_price || 0;
    const ltp        = h.last_price    || 0;
    const collateral = h.collateral_quantity || 0;
    return {
      instrument: h.tradingsymbol,
      exchange:   h.exchange,
      isin:       h.isin,
      qty,
      avgCost,
      ltp,
      invested:   qty * avgCost,
      curVal:     qty * ltp,
      // COMPUTED, NOT TAKEN FROM KITE. Kite's own `pnl` is struck on the unpledged quantity,
      // so on a pledged holding it would contradict the invested and current values beside it
      // — the row would show a large position with a P&L belonging to a smaller one. For an
      // unpledged holding this is the identical number.
      pnl:        qty * (ltp - avgCost),
      dayChg:     h.day_change_percentage || 0,
      netChg:     avgCost > 0 ? (((ltp - avgCost) / avgCost) * 100) : 0,
      // Same flag the ICICI path sets, so the UI tags both alike and a stored capture can tell
      // "quantity 0 because pledged" from "quantity 0 because sold".
      pledged:      collateral > 0,
      collateralQty: collateral,
    };
  });
}

// Today's EXECUTED trades (fills) — real prices, unlike the raw order book.
async function fetchOrders() {
  if (!isTokenValid()) {
    throw new Error('Kite session expired or not connected. Please exchange a new request token.');
  }
  const raw = await kiteRequest({
    method:      'GET',
    path:        '/trades',
    accessToken: session.accessToken,
  });
  return (raw || []).map((t) => {
    const ts = t.fill_timestamp || t.exchange_timestamp || t.order_timestamp || '';
    const tradeDate = String(ts).slice(0, 10) || new Date().toISOString().slice(0, 10);
    return {
      trade_date: tradeDate,
      symbol:     t.tradingsymbol,
      side:       String(t.transaction_type || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      quantity:   Number(t.quantity || t.filled_quantity || 0),
      price:      Number(t.average_price || t.price || 0),
      exchange:   t.exchange || 'NSE',
      // Kept as TEXT: Zerodha ids run past Number.MAX_SAFE_INTEGER (1767585101908550572 in the
      // Console tradebook), so as numbers they silently lose their last digits. Carrying the id
      // lets an import recognise a fill it already has instead of relying on the
      // date/symbol/side/qty/price tuple — which cannot separate two genuinely identical fills
      // in the same second, and which matched nothing when the same trades arrived once
      // aggregated by a legacy import and once as individual fills.
      trade_id:   t.trade_id != null ? String(t.trade_id) : null,
      order_id:   t.order_id != null ? String(t.order_id) : null,
    };
  }).filter((o) => o.symbol && o.quantity > 0);
}

// Order book (today) — includes cancelled / rejected / open orders that never
// produced a fill. Used to explain an empty trade import.
async function fetchOrderBookSummary() {
  if (!isTokenValid()) return [];
  let raw;
  try {
    raw = await kiteRequest({ method: 'GET', path: '/orders', accessToken: session.accessToken });
  } catch { return []; }
  return (raw || []).map((o) => ({
    symbol:   o.tradingsymbol,
    side:     String(o.transaction_type || '').toUpperCase(),
    status:   o.status,                                   // COMPLETE / CANCELLED / REJECTED / OPEN ...
    quantity: Number(o.quantity || 0),
    filled:   Number(o.filled_quantity || 0),
    exchange: o.exchange || 'NSE',
  }));
}

async function revokeToken() {
  if (session.accessToken) {
    try {
      await kiteRequest({
        method:      'DELETE',
        path:        `/session/token?api_key=${creds.apiKey}&access_token=${session.accessToken}`,
        accessToken: session.accessToken,
      });
    } catch (_) { /* ignore errors on revoke */ }
  }
  session = { accessToken: null, loginAt: null, expiresAt: null };
  try { fs.unlinkSync(SESSION_FILE); } catch (_e) { /* already gone */ }
  return { connected: false };
}

module.exports = {
  refreshCredentials,
  getLoginUrl,
  getSessionStatus,
  exchangeToken,
  fetchHoldings,
  fetchOrders,
  fetchOrderBookSummary,
  revokeToken,
};
