// This participant's own broker API keys.
//
// WHY THIS EXISTS. The desktop app read its keys from environment variables — one developer, one
// set of credentials, set once in a .env file. That cannot work here: twenty-five participants
// each have their own ICICI and Zerodha developer apps, and nobody but them should be able to
// read their secret. So the keys live in the participant's own database, encrypted, and are
// entered through a screen rather than a file on the server.
//
// ENCRYPTED, NOT JUST SEPARATED. The per-instance file split already stops one participant
// reading another's. Encryption is for the case where the file itself is taken — a stolen backup,
// a mislaid volume — because an API secret in the clear is enough to place trades on someone's
// account. The key comes from CREDENTIAL_KEY in the hub's environment and is never written to
// any database, so a copy of the file alone is not enough to use it.
const { openDatabase, allAsync, getAsync, runAsync, closeAsync } = require('../../db/connection');
const vault = require('../security/vault');

const BROKERS = ['icicidirect', 'zerodha'];

// Read on nearly every broker call, so it is cached in memory. Invalidated on write; a process
// restart clears it anyway, and each process serves exactly one person.
let cache = null;

async function ensureSchema(db) {
  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS broker_credentials (
      broker         TEXT PRIMARY KEY,
      api_key_enc    TEXT NOT NULL,
      api_secret_enc TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    )`);
}

async function load() {
  if (cache) return cache;
  const db = openDatabase();
  try {
    await ensureSchema(db);
    const rows = await allAsync(db, 'SELECT * FROM broker_credentials');
    cache = new Map();
    for (const r of rows) {
      try {
        cache.set(r.broker, {
          apiKey: vault.decrypt(r.api_key_enc),
          apiSecret: vault.decrypt(r.api_secret_enc),
          updatedAt: r.updated_at,
        });
      } catch (e) {
        // A row that will not decrypt is reported, not thrown past: the rest of the app should
        // still work, and the participant needs to be told to re-enter rather than shown a crash.
        console.warn(`⚠ stored ${r.broker} credentials could not be read: ${e.message}`);
      }
    }
    return cache;
  } finally { await closeAsync(db); }
}

/** Decrypted keys for a broker, or null. Only the broker clients should call this. */
async function get(broker) {
  const m = await load();
  return m.get(broker) || null;
}

async function save(broker, apiKey, apiSecret) {
  if (!BROKERS.includes(broker)) throw new Error(`Unknown broker "${broker}".`);
  const key = String(apiKey || '').trim();
  const secret = String(apiSecret || '').trim();
  if (!key || !secret) {
    throw Object.assign(new Error('Both the API key and the API secret are required.'),
      { code: 'MISSING_FIELDS' });
  }
  const db = openDatabase();
  try {
    await ensureSchema(db);
    await runAsync(db,
      `INSERT INTO broker_credentials (broker, api_key_enc, api_secret_enc, updated_at)
       VALUES (?,?,?,?)
       ON CONFLICT (broker) DO UPDATE SET
         api_key_enc = excluded.api_key_enc,
         api_secret_enc = excluded.api_secret_enc,
         updated_at = excluded.updated_at`,
      [broker, vault.encrypt(key), vault.encrypt(secret), new Date().toISOString()]);
  } finally { await closeAsync(db); }
  cache = null;
  return { broker, saved: true };
}

async function forget(broker) {
  const db = openDatabase();
  try {
    await ensureSchema(db);
    await runAsync(db, 'DELETE FROM broker_credentials WHERE broker = ?', [broker]);
  } finally { await closeAsync(db); }
  cache = null;
  return { broker, removed: true };
}

/**
 * What the setup screen shows. Never the secret, and only the tail of the key — enough for
 * someone to confirm they pasted the right one without putting it back on the wire.
 */
async function status() {
  const m = await load();
  return BROKERS.map((broker) => {
    const c = m.get(broker);
    return {
      broker,
      configured: !!c,
      maskedKey: c ? `••••${c.apiKey.slice(-4)}` : null,
      updatedAt: c?.updatedAt || null,
    };
  });
}

module.exports = { get, save, forget, status, BROKERS };
