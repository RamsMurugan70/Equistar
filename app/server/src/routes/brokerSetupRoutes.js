// Where a participant enters their own broker API keys.
//
// This has no equivalent in the desktop app, which read one developer's keys from a .env file.
// It is the third of the three screens EquiStar adds on top of Equix.
const express = require('express');
const credentials = require('../services/brokers/credentialsService');
const breezeService = require('../services/breeze/breezeService');
const kiteService = require('../services/kite/kiteService');

const router = express.Router();

// What each broker needs, and where to get it. Kept on the server so the screen and the help
// text cannot drift apart, and so the redirect URL is generated rather than typed by hand —
// getting one character of it wrong is the single most common reason a Zerodha login fails.
const CATALOG = {
  icicidirect: {
    broker: 'icicidirect',
    label: 'ICICI Direct',
    console: 'https://api.icicidirect.com/apiuser/home',
    keyLabel: 'App Key',
    secretLabel: 'Secret Key',
    steps: [
      'Sign in at api.icicidirect.com and open "View Apps".',
      'Create an app if you have none — any name will do.',
      'Copy the App Key and Secret Key into the boxes below.',
      'Set the app\'s Redirect URL to the address shown below.',
    ],
    // ICICI's session dies at midnight IST, every day, and cannot be renewed without a person.
    dailyNote: 'ICICI logs you out every night. You will reconnect once each morning before '
      + 'syncing — there is no way around this from our side.',
  },
  zerodha: {
    broker: 'zerodha',
    label: 'Zerodha Kite',
    console: 'https://developers.kite.trade/apps',
    keyLabel: 'API Key',
    secretLabel: 'API Secret',
    steps: [
      'Sign in at developers.kite.trade and open "My apps".',
      'Create a Kite Connect app if you have none.',
      'Copy the API Key and API Secret into the boxes below.',
      'Set the app\'s Redirect URL to the address shown below, exactly.',
    ],
    dailyNote: 'Kite access tokens expire each day at around 6am IST, so you will log in to '
      + 'Zerodha once a day before syncing.',
  },
};

/** The address a participant must register with their broker, built from the request. */
function redirectUrlFor(req, broker) {
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  const path = broker === 'zerodha' ? '/api/kite/callback' : '/api/breeze/callback';
  return `${proto}://${host}${path}`;
}

router.get('/', async (req, res, next) => {
  try {
    const stored = await credentials.status();
    const sessions = {
      icicidirect: breezeService.getSessionStatus(),
      zerodha: kiteService.getSessionStatus(),
    };
    res.json({
      brokers: stored.map((s) => ({
        ...s,
        ...CATALOG[s.broker],
        redirectUrl: redirectUrlFor(req, s.broker),
        session: sessions[s.broker] || null,
      })),
    });
  } catch (e) { next(e); }
});

router.post('/:broker', async (req, res, next) => {
  try {
    const { broker } = req.params;
    if (!CATALOG[broker]) return res.status(400).json({ error: `Unknown broker "${broker}".` });
    await credentials.save(broker, req.body?.apiKey, req.body?.apiSecret);
    // Reload the client's cached copy immediately, so "save then connect" works without a
    // restart — which is exactly the sequence every participant will follow.
    if (broker === 'zerodha') await kiteService.refreshCredentials();
    else await breezeService.refreshCredentials();
    return res.json({ saved: true, broker });
  } catch (e) {
    if (e.code === 'MISSING_FIELDS') return res.status(400).json({ error: e.message, code: e.code });
    return next(e);
  }
});

router.delete('/:broker', async (req, res, next) => {
  try {
    const { broker } = req.params;
    if (!CATALOG[broker]) return res.status(400).json({ error: `Unknown broker "${broker}".` });
    await credentials.forget(broker);
    if (broker === 'zerodha') await kiteService.refreshCredentials();
    else await breezeService.refreshCredentials();
    return res.json({ removed: true, broker });
  } catch (e) { return next(e); }
});

module.exports = router;
