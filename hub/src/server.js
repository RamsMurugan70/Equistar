// EquiStar hub: the only thing on the public port.
//
// WHAT IT DOES. Signs a participant in, starts their instance if it is not running, and forwards
// everything else to that instance. Participants never address an instance directly — the ports
// listen on 127.0.0.1 only — so the routing decision is made once, here, from the session, and
// cannot be talked out of by a crafted URL.
//
// WHAT IT DELIBERATELY DOES NOT DO. It holds no portfolio data of any kind. If this process were
// fully compromised the attacker would have a list of names and the ability to start processes;
// the trading data lives in files only the instances open.
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const http = require('http');
const httpProxy = require('http-proxy');
const config = require('./config');
const db = require('./db');
const accounts = require('./accounts');
const instances = require('./instances');
const scanner = require('./scanner');

const app = express();
app.disable('x-powered-by');
// JSON PARSING ONLY ON THE HUB'S OWN ROUTES, never globally.
//
// Applied app-wide it silently breaks every POST that gets proxied: body-parser reads the
// request stream to the end, and http-proxy then forwards a request whose body has already been
// consumed. The instance waits for a body that will never arrive and the call hangs until it
// times out — no error anywhere, on either side. Saving broker keys was the first casualty.
app.use('/hub/api', express.json({ limit: '256kb' }));
app.use(cookieParser(config.sessionSecret || undefined));

const COOKIE = 'equistar_sid';
const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.cookieSecure,
  signed: !!config.sessionSecret,
  maxAge: config.sessionDays * 864e5,
  path: '/',
};

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  if (config.isProd) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ── Who is asking ────────────────────────────────────────────────────────────
app.use(async (req, _res, next) => {
  const sid = (config.sessionSecret ? req.signedCookies?.[COOKIE] : req.cookies?.[COOKIE]) || null;
  try {
    req.participant = sid ? await accounts.sessionUser(sid) : null;
    req.sessionId = req.participant ? sid : null;
  } catch { req.participant = null; }
  next();
});

const requireAuth = (req, res, next) => (req.participant
  ? next()
  : res.status(401).json({ error: 'Sign in first.', code: 'UNAUTHENTICATED' }));

const requireAdmin = (req, res, next) => (req.participant?.role === 'admin'
  ? next()
  : res.status(403).json({ error: 'Admins only.', code: 'FORBIDDEN' }));

const fail = (res, e) => res.status(
  { BAD_LOGIN: 401, DISABLED: 403, NOT_FOUND: 404, TAKEN: 409, WEAK: 400 }[e.code] || 400,
).json({ error: e.message, code: e.code || 'ERROR' });

// ── Session ──────────────────────────────────────────────────────────────────
app.post('/hub/api/login', async (req, res) => {
  try {
    const { sessionId, participant } = await accounts.authenticate(
      req.body?.loginId, req.body?.password,
      { userAgent: req.get('user-agent'), ip: req.ip });
    res.cookie(COOKIE, sessionId, cookieOptions);
    res.json({ participant });
  } catch (e) { fail(res, e); }
});

app.post('/hub/api/logout', async (req, res) => {
  if (req.sessionId) await accounts.endSession(req.sessionId);
  res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined });
  res.json({ ok: true });
});

app.get('/hub/api/me', (req, res) => {
  if (!req.participant) return res.json({ participant: null });
  return res.json({ participant: accounts.shape(req.participant) });
});

app.post('/hub/api/password', requireAuth, async (req, res) => {
  try {
    await accounts.changePassword(req.participant.id, req.body?.currentPassword, req.body?.newPassword);
    // SIGNED OUT ON PURPOSE, and the page then asks them to sign in again with the new password.
    //
    // Partly because a password change should not leave the session it was made from alive —
    // that is the same reason a reset ends every session. Mostly because typing the new password
    // once more, immediately, while it is still in mind, is what fixes it in memory. A
    // participant who sets a password and is carried straight into the app has never actually
    // used it, and comes back tomorrow with nothing to type.
    if (req.sessionId) await accounts.endSession(req.sessionId);
    res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined });
    res.json({ ok: true, signedOut: true });
  } catch (e) { fail(res, e); }
});

// ── Admin ────────────────────────────────────────────────────────────────────
app.get('/hub/api/participants', requireAuth, requireAdmin, async (_req, res) => {
  res.json({ participants: await accounts.list() });
});

app.post('/hub/api/participants', requireAuth, requireAdmin, async (req, res) => {
  try {
    // The generated password comes back once, here, and is never stored in readable form. If the
    // admin loses it before handing it over, the fix is a reset, not a lookup.
    res.json(await accounts.create({
      loginId: req.body?.loginId,
      displayName: req.body?.displayName,
      role: req.body?.role === 'admin' ? 'admin' : 'participant',
    }, req.participant.login_id));
  } catch (e) { fail(res, e); }
});

app.post('/hub/api/participants/:loginId/reset', requireAuth, requireAdmin, async (req, res) => {
  try { res.json(await accounts.resetPassword(req.params.loginId, req.participant.login_id)); }
  catch (e) { fail(res, e); }
});

// Set a password directly, without the forced-change ceremony. Unlike /reset this leaves the
// admin knowing a working password for that account — see the note on setPasswordDirect.
app.post('/hub/api/participants/:loginId/password', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await accounts.setPasswordDirect(
      req.params.loginId,
      req.body?.password,
      { mustChange: !!req.body?.mustChange },
      req.participant.login_id));
  } catch (e) { fail(res, e); }
});

app.post('/hub/api/participants/:loginId/disabled', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await accounts.setDisabled(
      req.params.loginId, !!req.body?.disabled, req.participant.login_id));
  } catch (e) { fail(res, e); }
});

app.delete('/hub/api/participants/:loginId', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (req.params.loginId === req.participant.login_id) {
      return res.status(400).json({ error: 'You cannot delete the account you are signed in as.', code: 'SELF' });
    }
    return res.json(await accounts.remove(req.params.loginId, req.participant.login_id));
  } catch (e) { return fail(res, e); }
});

app.post('/hub/api/participants/:loginId/stop', requireAuth, requireAdmin, (req, res) => {
  res.json({ stopped: instances.stop(String(req.params.loginId).toLowerCase()) });
});

// The one shared scan. Admin-triggered rather than scheduled, and it is the reason 25 instances
// do not each hit Yahoo for the same 500 symbols.
app.get('/hub/api/scan', requireAuth, requireAdmin, (_req, res) => res.json(scanner.status()));
app.post('/hub/api/scan', requireAuth, requireAdmin, (req, res) => {
  try { res.status(202).json(scanner.start(req.participant.login_id)); }
  catch (e) { fail(res, e); }
});

app.get('/hub/api/audit', requireAuth, requireAdmin, async (_req, res) => {
  res.json({ entries: await db.all('SELECT * FROM audit_log ORDER BY at DESC LIMIT 100') });
});

// ── Static hub UI ────────────────────────────────────────────────────────────
app.use('/hub', express.static(path.join(__dirname, '..', 'web')));

// ── Everything else goes to the participant's own instance ───────────────────
/**
 * Whether this participant has finished naming their accounts.
 *
 * Asked of their own instance rather than tracked in the hub: the answer lives in their database
 * and the instance is the only thing that opens it. A second copy of that fact in hub.db would
 * be one more thing to keep in step, and wrong the first time somebody edited one and not the
 * other.
 *
 * A failure answers "yes, complete" so a hiccup here cannot lock somebody out of their own app.
 */
function instanceSetupComplete(participant) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1', port: participant.instance_port, path: '/api/broker-setup',
      timeout: 4000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(!!JSON.parse(body).setupComplete); } catch { resolve(true); }
      });
    });
    req.on('error', () => resolve(true));
    req.on('timeout', () => { req.destroy(); resolve(true); });
  });
}

const proxy = httpProxy.createProxyServer({ xfwd: true, ws: false });
proxy.on('error', (err, _req, res) => {
  if (res && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Your app is not responding (${err.message}).`, code: 'INSTANCE_DOWN' }));
  }
});

// A broker sending someone back after login, recognised by path — what happens next has to
// differ from an ordinary page request.
const isBrokerCallback = (p) => /^\/api\/(kite|breeze)\/callback$/.test(p);

// ── Broker callbacks, addressed by participant ───────────────────────────────
//
// THE PARTICIPANT IS NAMED IN THE PATH, NOT IN A COOKIE, and that is the whole point.
//
// The desktop app has no accounts, so its callback is simply open: the broker redirects to it
// and the token is exchanged. EquiStar has to know WHICH of twenty-five people a returning token
// belongs to, and the obvious answer — read their session cookie — is the wrong one. The browser
// is coming back from an external site, and any of a dozen ordinary things stops that cookie
// travelling: a different host spelling (localhost versus 127.0.0.1 are separate origins), a
// stricter SameSite default, a privacy setting, a fresh tab. When it does not travel the token
// is discarded and the person is asked to sign in again, having just signed in at their broker.
//
// Since every participant registers their OWN broker app, each can register their own URL. The
// path identifies them, no cookie is involved, and the flow becomes exactly as robust as the
// desktop app's.
//
// Guessable, deliberately. Reaching it does nothing without a valid request token for that
// participant's own broker app, which requires their broker login — and the worst it could do is
// connect somebody's own account.
// Express 5 dropped inline regex in route params, so the broker is validated in the handler.
app.get('/u/:login/api/:broker/callback', async (req, res) => {
  const login = String(req.params.login || '').toLowerCase();
  if (!['kite', 'breeze'].includes(req.params.broker)) {
    return res.status(404).type('html').send('<p>Unknown broker.</p>');
  }
  const participant = await accounts.byLogin(login).catch(() => null);

  if (!participant || participant.disabled_at || participant.role === 'admin') {
    console.log(`  ! broker callback for unknown participant "${login}"`);
    return res.status(404).type('html').send('<p>No such account.</p>');
  }

  try {
    if (!instances.isUp(participant.login_id)) await instances.start(participant);
  } catch (e) {
    return res.status(503).type('html')
      .send(`<p>Could not start your app: ${e.message}</p>`);
  }

  const hasToken = !!(req.query.request_token || req.query.apisession || req.query.API_Session);
  console.log(`  ◇ ${participant.login_id}: ${req.params.broker} callback`
    + ` — ${hasToken ? 'carrying a token' : 'NO TOKEN in the redirect'}`);

  // Rewritten to the path the instance serves, query string intact.
  req.url = `/api/${req.params.broker}/callback${req.url.slice(req.url.indexOf('?') === -1 ? req.url.length : req.url.indexOf('?'))}`;
  return proxy.web(req, res, { target: `http://127.0.0.1:${participant.instance_port}` });
});

app.use(async (req, res) => {
  if (!req.participant) {
    // A BROKER CALLBACK ARRIVING UNAUTHENTICATED IS NOT A REDIRECT CASE.
    //
    // It carries a single-use request token. Sending it to the sign-in page throws that token
    // away silently, and the person is asked to sign in immediately after signing in at their
    // broker, with no hint that anything was lost. The obvious response is to click the same
    // link again, which now fails at the broker too, because the token is spent.
    //
    // It happens when someone opens the broker's login URL directly instead of pressing Connect
    // inside the app, so their browser holds no EquiStar session for the return trip to land in.
    if (isBrokerCallback(req.path)) {
      const broker = req.path.includes('kite') ? 'Zerodha' : 'ICICI Direct';
      console.log(`  ! ${broker} callback arrived with no EquiStar session — token discarded`);
      return res.status(401).type('html').send(`<!doctype html><meta charset="utf-8">
<title>Sign in first</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f6f5;color:#1b1d28;display:grid;
place-items:center;min-height:100vh;margin:0}.c{background:#fff;border:1px solid #dfe3e2;
border-radius:10px;padding:28px 32px;max-width:460px}h1{font-size:1.15rem;margin:0 0 10px;
color:#b32d19}p{margin:0 0 12px;color:#565a6b;font-size:.93rem;line-height:1.55}
a{color:#05664a}</style>
<div class="c"><h1>${broker} sent you back, but you were not signed in here</h1>
<p>The login worked at ${broker}. EquiStar could not use it, because this browser held no
EquiStar session for it to land in — and the one-time code has now been spent.</p>
<p><strong>Sign in first, then start the connection from inside the app:</strong>
<a href="/hub/">sign in</a>, open <em>Brokers</em>, and press <em>Connect</em> there. Opening the
broker's login link directly will always fail this way.</p></div>`);
    }
    // A browser asking for a page gets the sign-in screen; anything else gets an honest 401
    // rather than an HTML body it cannot parse.
    if (req.method === 'GET' && (req.get('accept') || '').includes('text/html')) {
      return res.redirect('/hub/');
    }
    return res.status(401).json({ error: 'Sign in first.', code: 'UNAUTHENTICATED' });
  }
  if (req.participant.role === 'admin') {
    return res.redirect('/hub/');            // admins manage people; they have no instance
  }
  if (req.participant.must_change_password) {
    return res.redirect('/hub/#change-password');
  }

  try {
    // Started on demand rather than eagerly: an admin adding twenty accounts in a row should not
    // launch twenty processes for people who may not sign in until next week.
    if (!instances.isUp(req.participant.login_id)) await instances.start(req.participant);
  } catch (e) {
    return res.status(503).json({ error: `Could not start your app: ${e.message}`, code: 'INSTANCE_START_FAILED' });
  }

  // FIRST RUN GOES TO BROKER SETUP, not the dashboard. Without a broker connected the app has
  // nothing to show — every screen is a portfolio the participant has not given it yet — and a
  // wall of empty panels teaches them the app is broken rather than unfinished.
  //
  // The redirect is only for a browser asking for a page. XHR keeps its normal answer, or the
  // setup screen could not call the API it needs to complete the setup.
  const wantsPage = req.method === 'GET' && (req.get('accept') || '').includes('text/html');
  if (wantsPage && !req.path.startsWith('/brokers')) {
    const done = await instanceSetupComplete(req.participant).catch(() => true);
    if (!done) return res.redirect('/brokers');
  }

  // Logged because a lost callback is otherwise invisible: nothing in the app records that a
  // broker sent somebody back, so "I connected and nothing happened" had no evidence behind it.
  if (isBrokerCallback(req.path)) {
    const ok = req.query.status !== 'error' && (req.query.request_token || req.query.apisession);
    console.log(`  ◇ ${req.participant.login_id}: broker callback ${req.path}`
      + ` — ${ok ? 'carrying a token' : 'no token in the redirect'}`);
  }

  return proxy.web(req, res, { target: `http://127.0.0.1:${req.participant.instance_port}` });
});

const server = app.listen(config.port, () => {
  db.open();
  console.log(`\n  EquiStar hub on http://localhost:${config.port}  (${config.isProd ? 'production' : 'development'})`);
  console.log(`  data: ${config.dataDir}`);
  console.log(`  instance ports: ${config.instancePortBase}-${config.instancePortMax}`);
  console.log('  no schedulers — the scan and every broker sync are triggered by hand\n');
});

// Children are not detached, but SIGTERM to the hub does not automatically reach them. Without
// this a restart leaves instances holding their ports, and the next start fails on a conflict
// that nothing on screen explains.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n  stopping instances…');
    instances.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

module.exports = app;
