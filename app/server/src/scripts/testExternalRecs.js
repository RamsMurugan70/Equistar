// replaceStrategy: upsert, preserve history, prune what the source dropped.
//
// This function DELETES rows, so the rules it follows are worth pinning down. Runs against a
// throwaway database file — it never touches the real one.
const path = require('path');
const fs = require('fs');

const TMP = path.join(require('os').tmpdir(), `zta-extrecs-test-${Date.now()}.db`);
process.env.DB_PATH = TMP;

const repo = require('../repositories/externalRecsRepository');
const { openDatabase, allAsync, runAsync, closeAsync } = require('../db/connection');

let pass = 0; let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); } else {
    fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const SRC = 'test-source';
const pick = (symbol, action = 'Added', over = {}) => ({
  symbol, exchange: 'NSE', code: symbol, company: `${symbol} Ltd`,
  action, priceAdded: 100, returnPct: action === 'Removed' ? 5 : null,
  isLive: action === 'Added', stockUrl: `https://x/${symbol}`, ...over,
});

async function rows(strategy) {
  const db = openDatabase();
  try {
    return await allAsync(db,
      'SELECT * FROM external_recommendations WHERE source = ? AND strategy = ? ORDER BY symbol',
      [SRC, strategy]);
  } finally { await closeAsync(db); }
}
async function wipe(strategy) {
  const db = openDatabase();
  try {
    await runAsync(db, 'DELETE FROM external_recommendations WHERE source = ? AND strategy = ?',
      [SRC, strategy]);
  } finally { await closeAsync(db); }
}
const symbolsOf = (rs) => rs.map((r) => r.symbol).sort().join(',');

(async () => {
  // Creates the table. ensureSchema is internal, and the helpers below query directly, so
  // something has to run through the repository first on a fresh file.
  await repo.replaceStrategy(SRC, '__schema__', []);

  // ── Insert ──────────────────────────────────────────────────────────────────
  console.log('\nFirst sync');
  {
    const S = 'S1';
    await wipe(S);
    const r = await repo.replaceStrategy(SRC, S, [pick('AAA'), pick('BBB'), pick('CCC')]);
    check('inserts every pick', r.inserted === 3, JSON.stringify(r));
    check('nothing to update', r.updated === 0);
    check('nothing to prune on an empty table', r.removed === 0);
    check('all three stored', symbolsOf(await rows(S)) === 'AAA,BBB,CCC');
  }

  // ── Prune ───────────────────────────────────────────────────────────────────
  console.log('\nPruning what the source dropped');
  {
    const S = 'S2';
    await wipe(S);
    await repo.replaceStrategy(SRC, S, ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map((s) => pick(s)));
    // 4 of 5 still listed = 80% coverage, comfortably over the 60% floor.
    const r = await repo.replaceStrategy(SRC, S, ['AAA', 'BBB', 'CCC', 'DDD'].map((s) => pick(s)));
    check('drops the row the source stopped listing', r.removed === 1, JSON.stringify(r));
    check('keeps the rest', symbolsOf(await rows(S)) === 'AAA,BBB,CCC,DDD');
    check('no skip reported', r.pruneSkipped === 0);
  }

  // ── The guard ───────────────────────────────────────────────────────────────
  console.log('\nRefusing to prune on a partial scrape');
  {
    const S = 'S3';
    await wipe(S);
    const ten = ['A','B','C','D','E','F','G','H','I','J'].map((s) => pick(s));
    await repo.replaceStrategy(SRC, S, ten);
    // Only 2 of 10 — 20% coverage. This is what a half-rendered table looks like.
    const r = await repo.replaceStrategy(SRC, S, [pick('A'), pick('B')]);
    check('deletes nothing', r.removed === 0, JSON.stringify(r));
    check('reports how many it kept back', r.pruneSkipped === 8, JSON.stringify(r));
    check('all ten survive', (await rows(S)).length === 10);
  }

  console.log('\nThe 60% floor, either side of it');
  {
    const S = 'S4';
    const ten = ['A','B','C','D','E','F','G','H','I','J'];
    await wipe(S);
    await repo.replaceStrategy(SRC, S, ten.map((s) => pick(s)));
    // Exactly 6 of 10 = 0.6, which is >= the floor, so it prunes.
    const at = await repo.replaceStrategy(SRC, S, ten.slice(0, 6).map((s) => pick(s)));
    check('exactly at the floor still prunes', at.removed === 4, JSON.stringify(at));

    await wipe(S);
    await repo.replaceStrategy(SRC, S, ten.map((s) => pick(s)));
    // 5 of 10 = 0.5, below the floor.
    const below = await repo.replaceStrategy(SRC, S, ten.slice(0, 5).map((s) => pick(s)));
    check('just under the floor does not', below.removed === 0, JSON.stringify(below));
  }

  // ── History preserved ───────────────────────────────────────────────────────
  console.log('\nHistory survives a re-sync');
  {
    const S = 'S5';
    await wipe(S);
    await repo.replaceStrategy(SRC, S, [pick('AAA'), pick('BBB')]);
    const before = (await rows(S)).find((r) => r.symbol === 'AAA').first_seen_at;
    await new Promise((r) => setTimeout(r, 15));

    const r2 = await repo.replaceStrategy(SRC, S, [pick('AAA'), pick('BBB'), pick('CCC')]);
    const after = (await rows(S)).find((x) => x.symbol === 'AAA');
    check('first_seen_at is NOT restamped', after.first_seen_at === before,
      `${before} -> ${after.first_seen_at}`);
    check('captured_at IS restamped', after.captured_at > before);
    check('the new pick is inserted, not confused for an update', r2.inserted === 1 && r2.updated === 2,
      JSON.stringify(r2));
  }

  console.log('\nAdded → Removed transition');
  {
    const S = 'S6';
    await wipe(S);
    await repo.replaceStrategy(SRC, S, [pick('AAA'), pick('BBB')]);
    check('no removed_at while live', (await rows(S)).every((r) => !r.removed_at));

    await repo.replaceStrategy(SRC, S, [pick('AAA'), pick('BBB', 'Removed')]);
    const bbb = (await rows(S)).find((r) => r.symbol === 'BBB');
    check('removed_at stamped on the flip', Boolean(bbb.removed_at));
    check('action recorded', bbb.action === 'Removed');
    check('a removed pick is NOT pruned — it is still listed', (await rows(S)).length === 2);

    // Re-added: removed_at clears and first_seen_at restarts, because it is a new position.
    await repo.replaceStrategy(SRC, S, [pick('AAA'), pick('BBB', 'Added')]);
    const back = (await rows(S)).find((r) => r.symbol === 'BBB');
    check('re-adding clears removed_at', back.removed_at === null);
  }

  // ── Isolation ───────────────────────────────────────────────────────────────
  console.log('\nOne strategy never prunes another');
  {
    await wipe('S7a'); await wipe('S7b');
    await repo.replaceStrategy(SRC, 'S7a', [pick('AAA'), pick('BBB')]);
    await repo.replaceStrategy(SRC, 'S7b', [pick('CCC'), pick('DDD')]);
    await repo.replaceStrategy(SRC, 'S7a', [pick('AAA'), pick('BBB'), pick('EEE')]);
    check('the other strategy is untouched', symbolsOf(await rows('S7b')) === 'CCC,DDD');
  }

  console.log('\nEmpty payload');
  {
    const S = 'S8';
    await wipe(S);
    await repo.replaceStrategy(SRC, S, [pick('AAA'), pick('BBB')]);
    // Zero picks means the scrape found nothing — never a reason to empty the table.
    const r = await repo.replaceStrategy(SRC, S, []);
    check('an empty sync deletes nothing', r.removed === 0, JSON.stringify(r));
    check('rows survive', (await rows(S)).length === 2);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.unlinkSync(TMP); } catch { /* best effort */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  ERROR:', e.message); process.exit(1); });
