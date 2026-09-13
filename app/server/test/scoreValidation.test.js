// The ranking check, on synthetic scan histories where the right answer is known in advance.
const test = require('node:test');
const assert = require('node:assert');
const { evaluate, spearman, ranks } = require('../src/services/scoring/scoreValidationService');

const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const T0 = Date.parse('2026-01-01T00:00:00Z');

// 120 daily scans of 60 stocks. Stock i grows at a steady rate proportional to `drift(i)`, and its
// score on every scan is `score(i)`. Whether the score predicts returns is fixed by construction.
function history({ score, drift = (i) => i, days = 120, n = 60, ladder = () => 'STRONG_UPTREND' }) {
  const scans = new Map();
  for (let d = 0; d < days; d += 1) {
    const rows = [];
    for (let i = 0; i < n; i += 1) {
      const s = score(i);
      rows.push({ symbol: `S${i}`, cmp: 100 * (1 + drift(i) / 10000) ** d, ema_ladder: ladder(i),
        combined_score: s, technical_score: s, fundamental_score: s, momentum_score: s });
    }
    scans.set(iso(T0 + d * DAY), rows);
  }
  return scans;
}

test('ranks and spearman', () => {
  assert.deepStrictEqual(ranks([10, 30, 20, 20]), [1, 4, 2.5, 2.5]);
  const xs = Array.from({ length: 20 }, (_, i) => i);
  assert.strictEqual(spearman(xs, xs.map((x) => x * x)), 1);
  assert.strictEqual(spearman(xs, xs.map((x) => -x)), -1);
  assert.strictEqual(spearman([1, 2, 3], [1, 2, 3]), null);   // too few to mean anything
});

test('a score that orders future returns correctly is reported as predictive', () => {
  const r = evaluate(history({ score: (i) => i }));
  const m = r.horizons['1M'];
  assert.ok(m.startDates > 0);
  assert.strictEqual(m.factors.combined_score.meanIc, 1);
  assert.strictEqual(m.factors.combined_score.icPositiveShare, 1);
  assert.ok(m.factors.combined_score.spreadPct > 0);
  assert.ok(m.top25.vsUniversePct > 0);
  assert.strictEqual(m.top25.beatUniverseShare, 1);
});

test('a score that orders them backwards is reported as backwards', () => {
  const r = evaluate(history({ score: (i) => -i }));
  assert.strictEqual(r.horizons['1M'].factors.combined_score.meanIc, -1);
  assert.ok(r.horizons['1M'].factors.combined_score.spreadPct < 0);
});

test('independent windows, not start dates, carry the sample size', () => {
  const r = evaluate(history({ score: (i) => i, days: 120 }));
  const m = r.horizons['1M'];
  assert.ok(m.startDates > 80);
  assert.strictEqual(m.independentWindows, 3);                 // ~119 days / 30
  assert.strictEqual(r.horizons['3M'].independentWindows, 1);
});

test('a split inside a window is excluded rather than read as a crash', () => {
  const scans = history({ score: (i) => i });
  const splitDay = iso(T0 + 50 * DAY);
  for (const [date, rows] of scans) {
    if (date >= splitDay) rows.find((r) => r.symbol === 'S59').cmp /= 5;   // best stock, 5:1 split
  }
  const without = evaluate(scans).horizons['1M'];
  const withAction = evaluate(scans, { splits: new Map([['S59', [splitDay]]]) }).horizons['1M'];
  assert.ok(without.factors.combined_score.meanIc < 1, 'the fake crash should have hurt the unadjusted read');
  assert.strictEqual(withAction.factors.combined_score.meanIc, 1);
  assert.ok(withAction.excludedForSplitOrBonus > 0);
});

test('the Top 25 follows the app rule: qualifying trend only', () => {
  // The highest scorers are all in a downtrend, so the Top 25 must come from the rest.
  const scans = history({ score: (i) => i, ladder: (i) => (i >= 40 ? 'DOWNTREND' : 'STRONG_UPTREND') });
  const m = evaluate(scans).horizons['1M'];
  // Stocks 15..39 are the qualifying top 25: below the best drifts, so behind the top fifth.
  assert.ok(m.top25.top25Pct < m.factors.combined_score.topFifthPct);
});

test('a horizon longer than the history has no start dates, not zeros', () => {
  const r = evaluate(history({ score: (i) => i, days: 40 }));
  assert.strictEqual(r.horizons['3M'].startDates, 0);
  assert.strictEqual(r.horizons['3M'].factors.combined_score.meanIc, null);
});
