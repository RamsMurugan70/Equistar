// Tax lots: FIFO over the whole book, with splits and bonuses applied, squared against holdings.
const test = require('node:test');
const assert = require('node:assert');
const { replay, reconcile } = require('../src/services/portfolio/taxLotsService');
const { quantityFactor } = require('../src/services/portfolio/costBasisCoverageService');

const buy = (date, qty) => ({ date, side: 'BUY', qty });
const sell = (date, qty) => ({ date, side: 'SELL', qty });

test('FIFO sells the oldest lots first', () => {
  const r = replay([buy('2023-01-10', 10), buy('2025-06-01', 10), sell('2025-08-01', 12)]);
  assert.deepStrictEqual(r.lots.map((l) => [l.date, l.qty]), [['2025-06-01', 8]]);
  assert.strictEqual(r.earliestDate, '2025-06-01');
});

test('a split restates quantities and keeps the purchase date', () => {
  const f = quantityFactor('SPLIT', 'Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share');
  assert.strictEqual(f, 5);
  // Post-split sells are in new units: 5 old shares became 25, and selling 20 leaves 5 of them.
  const r = replay([buy('2024-01-01', 5), sell('2026-02-01', 20)], [{ exDate: '2026-01-02', actionType: 'SPLIT', factor: f }]);
  assert.deepStrictEqual(r.lots.map((l) => [l.date, l.qty]), [['2024-01-01', 5]]);
  assert.strictEqual(r.unmatchedSellQty, 0);
});

test('bonus shares are a new lot dated on the ex-date, and FIFO sells the originals first', () => {
  const f = quantityFactor('BONUS', 'Bonus 4:1');
  assert.strictEqual(f, 5);
  const r = replay([buy('2024-05-01', 100), sell('2026-04-01', 50)], [{ exDate: '2026-03-09', actionType: 'BONUS', factor: f }]);
  assert.deepStrictEqual(r.lots.map((l) => [l.date, l.qty, l.kind]), [['2024-05-01', 50, 'BUY'], ['2026-03-09', 400, 'BONUS']]);
});

test('an action on a trading day applies before that day\'s trades', () => {
  // The sell on the ex-date is already in post-split units.
  const r = replay([buy('2025-01-01', 1), sell('2025-06-16', 2)], [{ exDate: '2025-06-16', actionType: 'SPLIT', factor: 2 }]);
  assert.strictEqual(r.openQty, 0);
  assert.strictEqual(r.unmatchedSellQty, 0);
});

test('a same-day bonus and split compound to the right total either way round', () => {
  // Bajaj Finance, June 2025: 4:1 bonus and a 1:2 split on one ex-date — ten shares per share.
  const acts = [{ exDate: '2025-06-16', actionType: 'BONUS', factor: 5 }, { exDate: '2025-06-16', actionType: 'SPLIT', factor: 2 }];
  assert.strictEqual(replay([buy('2024-01-01', 14)], acts).openQty, 140);
  assert.strictEqual(replay([buy('2024-01-01', 14)], [...acts].reverse()).openQty, 140);
});

test('an action while nothing is held changes nothing', () => {
  const r = replay([buy('2020-01-01', 5), sell('2020-02-01', 5), buy('2026-01-01', 3)], [{ exDate: '2023-01-01', actionType: 'BONUS', factor: 2 }]);
  assert.deepStrictEqual(r.lots.map((l) => [l.date, l.qty]), [['2026-01-01', 3]]);
});

test('sells beyond the recorded buys are counted, not ignored', () => {
  const r = replay([buy('2025-01-01', 5), sell('2025-02-01', 8)]);
  assert.strictEqual(r.unmatchedSellQty, 3);
  assert.strictEqual(r.openQty, 0);
});

test('an unreadable split or bonus blocks the answer', () => {
  const r = replay([buy('2024-01-01', 10)], [{ exDate: '2025-01-01', actionType: 'SPLIT', factor: null }]);
  assert.strictEqual(r.adjustmentBlocked, true);
  assert.strictEqual(reconcile(r, 10).basis, 'UNADJUSTED');
});

test('reconcile: lots matching the holding stand as they are', () => {
  const r = replay([buy('2023-01-01', 100)]);
  assert.deepStrictEqual([reconcile(r, 100).basis, reconcile(r, 100).earliestDate], ['COMPLETE', '2023-01-01']);
});

test('reconcile: extra shares on record are removed from the OLDEST end', () => {
  // 30 on record, 20 held: 10 were sold off the books, and FIFO would have taken the 2022 lot.
  const r = replay([buy('2022-01-01', 10), buy('2025-11-01', 20)]);
  const c = reconcile(r, 20);
  assert.strictEqual(c.basis, 'TRIMMED');
  assert.strictEqual(c.excessQty, 10);
  assert.strictEqual(c.earliestDate, '2025-11-01');     // later than the book's 2022, never earlier
});

test('reconcile: shares with no purchase record give no date', () => {
  const r = replay([buy('2025-01-01', 10)]);
  const c = reconcile(r, 25);
  assert.deepStrictEqual([c.basis, c.missingQty], ['MISSING_BUYS', 15]);
  assert.strictEqual(reconcile(null, 25).basis, 'NO_ORDERS');
});
