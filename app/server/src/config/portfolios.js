// What this participant's two accounts are called.
//
// WHY THIS FILE EXISTS. The desktop app had its owner's two portfolio names — 'Rams' and
// 'Geetha' — written as string literals in fifty places across thirteen files: default
// parameters, allow-lists, even a DEFAULT in a CREATE TABLE. Shipped as-is, every participant's
// app would go looking for a stranger's portfolios, find nothing, and show an empty screen with
// no explanation.
//
// ONE PORTFOLIO PER BROKER, which is not an arbitrary choice — the controllers already assume it.
// breezeController defaults its saves to the ICICI portfolio and kiteController to the Zerodha
// one, so this keeps a pairing that was already load-bearing and merely makes it visible.
//
// MUTABLE, AND SYNCHRONOUS ANYWAY. The names now come from the participant's own database, set
// on the first-run setup screen — but fifty call sites read them synchronously, and making them
// async would ripple through the whole app for no benefit. So they are held in module memory and
// refreshed when they change. One process serves one participant, so a module-level value IS
// that participant's setting.
const accounts = require('../services/brokers/accountsService');

const state = {
  ICICI: process.env.PORTFOLIO_ICICI || 'ICICI',
  ZERODHA: process.env.PORTFOLIO_ZERODHA || 'Zerodha',
};

async function refresh() {
  try {
    const names = await accounts.load();
    state.ICICI = names.icicidirect;
    state.ZERODHA = names.zerodha;
  } catch (e) {
    // The env defaults above are already in place, so a failure here narrows the answer rather
    // than breaking it — the app still works, under the broker's own names.
    console.warn(`⚠ could not read account names: ${e.message}`);
  }
  return { ...state };
}

// Fire-and-forget at load. A participant who has not run setup yet keeps the defaults, which is
// exactly what the setup screen is about to replace.
refresh().catch(() => {});

module.exports = {
  // Getters, not values: `const { ICICI } = require(...)` would capture whatever was set at the
  // moment of import, which for anything loaded before refresh() completes is the default. Every
  // read goes through here instead, so a rename takes effect everywhere at once.
  get ICICI() { return state.ICICI; },
  get ZERODHA() { return state.ZERODHA; },
  get ALL() { return [state.ICICI, state.ZERODHA]; },
  isKnown: (name) => [state.ICICI, state.ZERODHA].includes(name),
  refresh,
};
