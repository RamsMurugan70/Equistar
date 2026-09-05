// The setup a participant does before the app is any use to them: naming their two accounts and
// entering their own broker API keys.
//
// Neither has an equivalent in the desktop app. That one had two portfolios named after the two
// people whose money they held, and read one developer's API keys from a .env file.
const express = require('express');
const credentials = require('../services/brokers/credentialsService');
const accounts = require('../services/brokers/accountsService');
const catalog = require('../services/brokers/catalog');
const PF = require('../config/portfolios');
const breezeService = require('../services/breeze/breezeService');
const kiteService = require('../services/kite/kiteService');

const router = express.Router();

const serviceFor = (broker) => (broker === 'zerodha' ? kiteService : breezeService);

/** Everything both screens need: names, keys, sessions, and the guidance around them. */
async function state(req) {
  const [names, stored, configured] = await Promise.all([
    accounts.load(), credentials.status(), accounts.isConfigured(),
  ]);
  const sessions = {
    icicidirect: breezeService.getSessionStatus(),
    zerodha: kiteService.getSessionStatus(),
  };
  return {
    // Whether the first-run setup has been done. The hub reads this to decide where to send
    // someone after they sign in.
    setupComplete: configured,
    anyConnected: Object.values(sessions).some((s) => s?.connected),
    brokers: stored.map((s) => ({
      ...catalog.get(s.broker),
      ...s,
      accountName: names[s.broker],
      redirectUrl: catalog.redirectUrlFor(req, s.broker),
      session: sessions[s.broker] || null,
    })),
  };
}

router.get('/', async (req, res, next) => {
  try { res.json(await state(req)); } catch (e) { next(e); }
});

/**
 * Names the two accounts. Rewrites any existing rows to match — the name is the key a
 * participant's history is stored under, not a label pointing at it.
 */
router.post('/names', async (req, res, next) => {
  try {
    await accounts.setNames({
      icicidirect: req.body?.icicidirect,
      zerodha: req.body?.zerodha,
    });
    // Every downstream reader takes the names from here, so this has to happen before the
    // response — otherwise the next request still sees the old ones.
    await PF.refresh();
    return res.json(await state(req));
  } catch (e) {
    if (['BAD_NAME', 'DUPLICATE_NAME'].includes(e.code)) {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    return next(e);
  }
});

router.post('/:broker', async (req, res, next) => {
  try {
    const { broker } = req.params;
    if (!catalog.get(broker)) return res.status(400).json({ error: `Unknown broker "${broker}".` });
    await credentials.save(broker, req.body?.apiKey, req.body?.apiSecret);
    // Reload the client's cached copy immediately, so "save then connect" works without a
    // restart — which is the sequence every participant will follow.
    await serviceFor(broker).refreshCredentials();
    return res.json(await state(req));
  } catch (e) {
    if (e.code === 'MISSING_FIELDS') return res.status(400).json({ error: e.message, code: e.code });
    return next(e);
  }
});

router.delete('/:broker', async (req, res, next) => {
  try {
    const { broker } = req.params;
    if (!catalog.get(broker)) return res.status(400).json({ error: `Unknown broker "${broker}".` });
    await credentials.forget(broker);
    await serviceFor(broker).refreshCredentials();
    return res.json(await state(req));
  } catch (e) { return next(e); }
});

module.exports = router;
