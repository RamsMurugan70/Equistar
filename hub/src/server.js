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
    res.json({ ok: true });
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
const proxy = httpProxy.createProxyServer({ xfwd: true, ws: false });
proxy.on('error', (err, _req, res) => {
  if (res && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Your app is not responding (${err.message}).`, code: 'INSTANCE_DOWN' }));
  }
});

app.use(async (req, res) => {
  if (!req.participant) {
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
