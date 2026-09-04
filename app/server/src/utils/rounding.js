function round2(n) { return Math.round(n * 100) / 100; }
function round1Pct(n) { return Math.round(n * 1000) / 10; }

module.exports = { round2, round1Pct };
