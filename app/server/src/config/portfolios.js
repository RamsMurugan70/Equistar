// What this participant's two accounts are called.
//
// WHY THIS FILE EXISTS. The desktop app this was copied from had its owner's two portfolio names
// — 'Rams' and 'Geetha' — written as string literals in forty places across thirteen files:
// default parameters, allow-lists, even a DEFAULT in a CREATE TABLE. Shipped as-is, every
// workshop participant's app would go looking for a stranger's portfolios, find nothing, and
// show an empty screen with no explanation.
//
// The names are per-instance rather than per-user-row because that is what the whole deployment
// is: one process per participant, so a constant here IS that participant's setting.
//
// ONE PORTFOLIO PER BROKER, which is not an arbitrary choice — the controllers already assume it.
// breezeController defaults its saves to the ICICI portfolio and kiteController to the Zerodha
// one, so naming them after the broker makes an assumption that was already load-bearing
// visible instead of hidden behind a person's name.
const ICICI = process.env.PORTFOLIO_ICICI || 'ICICI';
const ZERODHA = process.env.PORTFOLIO_ZERODHA || 'Zerodha';

module.exports = {
  ICICI,
  ZERODHA,
  // The order matters in a couple of callers that render "both" as a pair of columns.
  ALL: [ICICI, ZERODHA],
  // True when a request's ?portfolio= names one this instance actually has. Callers used to
  // inline `['Rams','Geetha'].includes(x)`, which silently rejected everything once the names
  // were no longer those.
  isKnown: (name) => [ICICI, ZERODHA].includes(name),
};
