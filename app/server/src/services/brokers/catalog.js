// What each broker calls its credentials, where a participant gets them, and what to do when the
// connection will not come up.
//
// KEPT ON THE SERVER, NOT IN THE PAGE. Two screens read it — the first-run setup and the Brokers
// tab afterwards — and one field, the redirect URL, can only be built from the address the
// request arrived on, which the browser has no reliable way to know for itself. One description,
// both screens.
//
// THE TIPS ARE THE POINT, not decoration. Every one of them is a failure somebody actually hit
// while getting this working, written down so the next person does not spend an afternoon on it.
// A redirect URL off by one character is the single most common reason a Zerodha login fails,
// and the broker will not say which character.

const CATALOG = {
  icicidirect: {
    broker: 'icicidirect',
    label: 'ICICI Direct',
    connectable: true,
    portalUrl: 'https://api.icicidirect.com/apiuser/home',
    // Said before the steps, because "do I have to pay for this?" is what stops people
    // starting. Breeze is free to every ICICI Direct client.
    costNote: 'Free. The Breeze API costs nothing for ICICI Direct clients, and registering the '
      + 'app below takes about five minutes.',
    keyLabel: 'App Key',
    secretLabel: 'Secret Key',
    callbackPath: '/api/breeze/callback',
    // The one-time setup, done at the broker before anything here can work.
    setupSteps: [
      'Sign in at api.icicidirect.com with your ICICI Direct credentials.',
      'Open "View Apps" and register one. Any name will do — it is only a label on their side.',
      'Set the app\'s Redirect URL to exactly the address shown below.',
      'Copy the App Key and the Secret Key it gives you, and paste them below.',
    ],
    // The daily ritual, which is a different thing from the setup above and catches people out.
    dailyNote: 'ICICI sessions expire the same night. Each trading day you will use Connect, log '
      + 'in at their page, and come back — there is no way to keep it alive from here.',
    tips: [
      ['Connect says the token is invalid',
        'The API session token is single-use and expires the same day. Start the login again and '
        + 'let it hand back a fresh one — yesterday\'s will always be refused.'],
      ['Fetch returns no holdings',
        'ICICI serves demat holdings through a different endpoint than positions. If you hold '
        + 'only mutual funds, or nothing has settled yet, an empty result is correct.'],
      ['Saved keys stop working after a while',
        'Regenerating the app at api.icicidirect.com issues a new secret and silently voids the '
        + 'old one. Re-enter both key and secret here after any regeneration.'],
    ],
  },

  zerodha: {
    broker: 'zerodha',
    label: 'Zerodha Kite',
    connectable: true,
    portalUrl: 'https://developers.kite.trade/apps',
    // FREE, and worth saying plainly. This used to read "a paid subscription of Rs 2,000/month",
    // true until Zerodha made Kite Connect Personal free in 2025 and cut the paid plan to Rs 500.
    // Personal leaves out live and historical MARKET data, which EquiStar never asks Zerodha for:
    // it reads holdings, orders and trades, and prices come from elsewhere. The old note was
    // turning people away from a connection that costs them nothing.
    costNote: 'Free. Choose the "Personal" plan — it covers holdings, orders and trades, which '
      + 'is all EquiStar reads. The paid plan only adds market data this app does not use.',
    keyLabel: 'API Key',
    secretLabel: 'API Secret',
    callbackPath: '/api/kite/callback',
    setupSteps: [
      'Create a Kite Connect app at developers.kite.trade and pick the free "Personal" plan.',
      'Set the app\'s Redirect URL to exactly the address shown below.',
      'Copy the API Key and API Secret from the app, and paste them below.',
    ],
    dailyNote: 'Kite access tokens expire at 06:00 IST the next morning and Zerodha issues no '
      + 'refresh token, so a login here is needed each trading day.',
    tips: [
      ['"Redirect URL mismatch" at the broker',
        'The URL registered in your Kite app must match the one below character for character, '
        + 'including the scheme and the whole path. Copy it rather than typing it.'],
      ['Connected, but trades come back empty',
        'Kite only serves the current day\'s fills through the API. Anything older has to come '
        + 'from a Console tradebook export — a Zerodha limit, not a fault here.'],
      ['Signed out of the broker every morning',
        'Expected. The token dies at 06:00 IST daily and cannot be renewed automatically.'],
      ['Do I need the paid Kite Connect plan?',
        'No. The paid plan adds live and historical market data from Zerodha, which EquiStar does '
        + 'not use — it reads your holdings, orders and trades, and gets prices elsewhere. The '
        + 'free Personal plan is enough.'],
    ],
  },
};

/**
 * The address a participant registers at their broker, built from the live request.
 *
 * CARRIES THE PARTICIPANT'S NAME, so the hub can route the returning token by path instead of
 * by cookie. A browser coming back from an external site does not reliably bring its session
 * cookie — a different host spelling, a stricter SameSite default or a privacy setting is enough
 * to lose it — and when it is lost the token is discarded and the person is told to sign in,
 * having just signed in at their broker. Naming them in the URL removes the cookie from the
 * path entirely. Each participant registers their own broker app, so each gets their own URL.
 */
function redirectUrlFor(req, broker) {
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  const owner = require('../../config/env').instanceOwner;
  const path = CATALOG[broker]?.callbackPath || '';
  // Without an owner this instance was started by hand rather than by the hub; the bare path is
  // then correct, because there is no hub in front to route through.
  return owner ? `${proto}://${host}/u/${owner}${path}` : `${proto}://${host}${path}`;
}

const list = () => Object.values(CATALOG);
const get = (broker) => CATALOG[broker] || null;

module.exports = { CATALOG, list, get, redirectUrlFor };
