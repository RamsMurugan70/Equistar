// What this participant calls their two broker accounts.
//
// Equix had exactly two, named after the two people whose money they held, as string literals in
// fifty places. EquiStar keeps the two — one per broker, which the controllers already assume —
// but lets the participant name them, because "ICICI" and "Zerodha" are the broker's names, not
// the account's, and someone running their own and their spouse's does not think of them that
// way.
//
// STORED PER PARTICIPANT, IN THEIR OWN DATABASE. One process serves one person, so the names are
// loaded once into module memory and every synchronous caller reads them from there — the same
// arrangement as the broker keys, and for the same reason.
//
// RENAMING REWRITES THE DATA. The name is not a label pointing at rows; it IS the key those rows
// are stored under, in ten tables. Changing it without moving the rows would orphan a
// participant's entire history behind a name nothing looks for any more — the holdings would
// simply vanish from the app while sitting untouched in the file.
const { openDatabase, allAsync, getAsync, runAsync, closeAsync } = require('../../db/connection');

// Every table whose `portfolio` column holds one of these names. Derived once from the schema
// and listed explicitly, because a rename that misses a table is silent: that table's rows stop
// being found and nothing reports it.
const PORTFOLIO_TABLES = [
  'orders', 'portfolio_snapshots', 'portfolio_summary', 'holding_scores',
  'cost_basis_overrides', 'broker_tips', 'orders_quarantine', 'capture_ledger',
  'portfolio_snapshots_quarantine', 'snapshot_quality',
];

const BROKERS = ['icicidirect', 'zerodha'];
const FALLBACK = { icicidirect: 'ICICI', zerodha: 'Zerodha' };

let cache = null;

async function ensureSchema(db) {
  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS account_names (
      broker     TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
}

/** { icicidirect: 'Mine', zerodha: 'Geetha' }, falling back to the broker's own name. */
async function load() {
  if (cache) return cache;
  const db = openDatabase();
  try {
    await ensureSchema(db);
    const rows = await allAsync(db, 'SELECT broker, name FROM account_names');
    cache = { ...FALLBACK };
    for (const r of rows) if (BROKERS.includes(r.broker) && r.name) cache[r.broker] = r.name;
    return cache;
  } finally { await closeAsync(db); }
}

/** True once the participant has named at least one account — what the setup gate reads. */
async function isConfigured() {
  const db = openDatabase();
  try {
    await ensureSchema(db);
    const r = await getAsync(db, 'SELECT COUNT(*) AS n FROM account_names');
    return (r?.n || 0) > 0;
  } finally { await closeAsync(db); }
}

function validate(name) {
  const n = String(name || '').trim();
  if (n.length < 1 || n.length > 40) {
    throw Object.assign(new Error('An account name must be 1 to 40 characters.'), { code: 'BAD_NAME' });
  }
  // A name that collides with the other account's would merge two books into one, since the name
  // is the key the rows are stored under.
  return n;
}

/**
 * Sets both names, moving any existing rows to match.
 *
 * @param names { icicidirect, zerodha } — either may be omitted to leave that one alone
 */
async function setNames(names = {}) {
  const current = await load();
  const next = { ...current };
  for (const b of BROKERS) {
    if (names[b] !== undefined && names[b] !== null && String(names[b]).trim() !== '') {
      next[b] = validate(names[b]);
    }
  }
  if (next.icicidirect === next.zerodha) {
    throw Object.assign(
      new Error('The two accounts need different names — they are stored under the name you give them.'),
      { code: 'DUPLICATE_NAME' });
  }

  const db = openDatabase();
  try {
    await ensureSchema(db);
    await runAsync(db, 'BEGIN IMMEDIATE');
    try {
      for (const b of BROKERS) {
        const from = current[b];
        const to = next[b];
        await runAsync(db,
          `INSERT INTO account_names (broker, name, updated_at) VALUES (?,?,?)
           ON CONFLICT (broker) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
          [b, to, new Date().toISOString()]);

        // Move the history. Skipped when the name has not changed, and when the table does not
        // exist yet — a participant who has never synced has no orders table to rewrite.
        if (from !== to) {
          for (const t of PORTFOLIO_TABLES) {
            // eslint-disable-next-line no-await-in-loop
            const exists = await getAsync(db,
              "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?", [t]);
            // eslint-disable-next-line no-await-in-loop
            if (exists) await runAsync(db, `UPDATE ${t} SET portfolio = ? WHERE portfolio = ?`, [to, from]);
          }
        }
      }
      await runAsync(db, 'COMMIT');
    } catch (e) {
      await runAsync(db, 'ROLLBACK').catch(() => {});
      throw e;
    }
  } finally { await closeAsync(db); }

  cache = null;
  return load();
}

module.exports = { load, setNames, isConfigured, BROKERS, FALLBACK, PORTFOLIO_TABLES };
