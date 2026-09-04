// Shared "latest scan per symbol" SQL fragments for universe_scores. Two scopes are needed:
// globally latest (any universe) and latest within a specific universe — callers pick via
// the alias they join against (`u` in both cases).
const LATEST_SCAN_GLOBAL = `scan_date = (SELECT MAX(scan_date) FROM universe_scores WHERE symbol = u.symbol)`;
const LATEST_SCAN_BY_UNIVERSE = `scan_date = (SELECT MAX(scan_date) FROM universe_scores WHERE symbol = u.symbol AND universe = u.universe)`;

module.exports = { LATEST_SCAN_GLOBAL, LATEST_SCAN_BY_UNIVERSE };
