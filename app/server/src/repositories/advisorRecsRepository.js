// Storage for Telegram advisory calls.
//
// EVENT-SOURCED ON PURPOSE. A follow-up like "Exit 3 lot 79500 CE / Sell 3 lot 79700 CE"
// mutates an existing structure (that one rolls a short strike up), and "EXIT" is
// position-relative — it only means BUY because the leg was short. So the current position
// cannot be stored as a single overwritten row: it is DERIVED by replaying events in order.
// That also means a mis-threaded follow-up can be unlinked without corrupting anything,
// and every call keeps a full audit trail of what the advisor said and when.
const { openDatabase, allAsync, getAsync, runAsync, closeAsync } = require('../db/connection');

async function ensureSchema(db) {
  // Raw messages, immutable. Kept verbatim so a parser improvement can be replayed over
  // history without needing to re-fetch from Telegram.
  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS tg_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      channel      TEXT NOT NULL,
      message_id   TEXT NOT NULL,
      posted_at    TEXT,
      text         TEXT NOT NULL,
      reply_to_id  TEXT,
      parsed_json  TEXT,
      kind         TEXT,
      confidence   REAL,
      status       TEXT NOT NULL DEFAULT 'NEW',
      fetched_at   TEXT,
      UNIQUE(channel, message_id)
    )`);

  // One row per advisory call. legs_json is a CACHE of the replayed event stream, not the
  // source of truth — rebuildable at any time from tg_rec_events.
  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS tg_recommendations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      channel       TEXT NOT NULL,
      underlying    TEXT NOT NULL,
      expiry        TEXT,
      view          TEXT,
      opened_at     TEXT,
      closed_at     TEXT,
      status        TEXT NOT NULL DEFAULT 'OPEN',
      target_rs     REAL,
      stop_rs       REAL,
      margin_rs     REAL,
      lot_size      INTEGER,
      legs_json     TEXT,
      origin_msg_id INTEGER,
      notes         TEXT
    )`);

  await runAsync(db, `
    CREATE TABLE IF NOT EXISTS tg_rec_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      rec_id      INTEGER NOT NULL,
      msg_id      INTEGER,
      seq         INTEGER NOT NULL,
      kind        TEXT NOT NULL,
      ops_json    TEXT,
      legs_after  TEXT,
      note        TEXT,
      applied_at  TEXT,
      confirmed   INTEGER NOT NULL DEFAULT 0
    )`);

  // Migrate DBs created before exit outcomes were tracked.
  const cols = await allAsync(db, 'PRAGMA table_info(tg_recommendations)');
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('exit_basis')) await runAsync(db, 'ALTER TABLE tg_recommendations ADD COLUMN exit_basis TEXT');
  if (!have.has('outcome'))    await runAsync(db, 'ALTER TABLE tg_recommendations ADD COLUMN outcome TEXT');

  await runAsync(db, `CREATE INDEX IF NOT EXISTS idx_tg_msg_status ON tg_messages (status)`);
  await runAsync(db, `CREATE INDEX IF NOT EXISTS idx_tg_rec_status ON tg_recommendations (status)`);
  await runAsync(db, `CREATE INDEX IF NOT EXISTS idx_tg_ev_rec ON tg_rec_events (rec_id, seq)`);
}

async function withDb(fn) {
  const db = openDatabase();
  try {
    await ensureSchema(db);
    return await fn(db);
  } finally {
    await closeAsync(db);
  }
}

// Returns false when the message was already stored (channel+message_id is unique), so the
// poller can be run repeatedly without creating duplicates.
async function saveMessage(m) {
  return withDb(async (db) => {
    const existing = await getAsync(db, 'SELECT id FROM tg_messages WHERE channel = ? AND message_id = ?', [m.channel, String(m.messageId)]);
    if (existing) return { inserted: false, id: existing.id };
    await runAsync(db,
      `INSERT INTO tg_messages (channel, message_id, posted_at, text, reply_to_id, parsed_json, kind, confidence, status, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [m.channel, String(m.messageId), m.postedAt || null, m.text, m.replyToId ? String(m.replyToId) : null,
       m.parsed ? JSON.stringify(m.parsed) : null, m.parsed?.kind || null, m.parsed?.confidence ?? null,
       m.status || 'NEW', new Date().toISOString()]);
    const row = await getAsync(db, 'SELECT last_insert_rowid() AS id');
    return { inserted: true, id: row.id };
  });
}

async function listMessages({ channel = '', status = '', limit = 200 } = {}) {
  return withDb(async (db) => {
    const where = [];
    const params = [];
    if (channel) { where.push('channel = ?'); params.push(channel); }
    if (status) { where.push('status = ?'); params.push(status); }
    params.push(limit);
    return allAsync(db,
      `SELECT * FROM tg_messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY COALESCE(posted_at, fetched_at) DESC, id DESC LIMIT ?`, params);
  });
}

async function createRecommendation(rec, firstEvent) {
  return withDb(async (db) => {
    await runAsync(db,
      `INSERT INTO tg_recommendations
        (channel, underlying, expiry, view, opened_at, status, target_rs, stop_rs, margin_rs, lot_size, legs_json, origin_msg_id, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [rec.channel, rec.underlying, rec.expiry || null, rec.view || null, rec.openedAt || new Date().toISOString(),
       'OPEN', rec.targetRs ?? null, rec.stopRs ?? null, rec.marginRs ?? null, rec.lotSize ?? null,
       JSON.stringify(rec.legs || []), rec.originMsgId ?? null, rec.notes || null]);
    const { id } = await getAsync(db, 'SELECT last_insert_rowid() AS id');
    await runAsync(db,
      `INSERT INTO tg_rec_events (rec_id, msg_id, seq, kind, ops_json, legs_after, note, applied_at, confirmed)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, rec.originMsgId ?? null, 1, 'ALERT', null, JSON.stringify(rec.legs || []),
       firstEvent?.note || 'original alert', new Date().toISOString(), 1]);
    return id;
  });
}

async function appendEvent(recId, ev) {
  return withDb(async (db) => {
    const row = await getAsync(db, 'SELECT COALESCE(MAX(seq),0) AS mx FROM tg_rec_events WHERE rec_id = ?', [recId]);
    const seq = (row?.mx || 0) + 1;
    await runAsync(db,
      `INSERT INTO tg_rec_events (rec_id, msg_id, seq, kind, ops_json, legs_after, note, applied_at, confirmed)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [recId, ev.msgId ?? null, seq, ev.kind, ev.ops ? JSON.stringify(ev.ops) : null,
       ev.legsAfter ? JSON.stringify(ev.legsAfter) : null, ev.note || null,
       new Date().toISOString(), ev.confirmed ? 1 : 0]);
    if (ev.legsAfter) {
      await runAsync(db, 'UPDATE tg_recommendations SET legs_json = ? WHERE id = ?', [JSON.stringify(ev.legsAfter), recId]);
    }
    if (ev.closes) {
      // A "cost to cost" exit is a SCRATCH — flat, neither win nor loss. Recording it as
      // either would distort the channel's win rate, which is the point of the scorecard.
      const outcome = ev.exitBasis === 'BREAKEVEN' ? 'SCRATCH' : 'CLOSED_UNVALUED';
      await runAsync(db,
        `UPDATE tg_recommendations SET status = 'CLOSED', closed_at = ?, exit_basis = ?, outcome = ? WHERE id = ?`,
        [new Date().toISOString(), ev.exitBasis || null, outcome, recId]);
    }
    return seq;
  });
}

async function listRecommendations({ channel = '', status = '' } = {}) {
  return withDb(async (db) => {
    const where = [];
    const params = [];
    if (channel) { where.push('channel = ?'); params.push(channel); }
    if (status) { where.push('status = ?'); params.push(status); }
    const recs = await allAsync(db,
      `SELECT * FROM tg_recommendations ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY CASE status WHEN 'OPEN' THEN 0 ELSE 1 END, COALESCE(opened_at,'') DESC, id DESC`, params);
    for (const r of recs) {
      r.events = await allAsync(db, 'SELECT * FROM tg_rec_events WHERE rec_id = ? ORDER BY seq ASC', [r.id]);
    }
    return recs;
  });
}

async function setMessageStatus(id, status) {
  return withDb((db) => runAsync(db, 'UPDATE tg_messages SET status = ? WHERE id = ?', [status, id]));
}

// A call whose contracts have all expired is over, whether or not the advisor said so —
// most simply stop being mentioned. Leaving them OPEN was actively harmful: two long-expired
// SENSEX calls made every later SENSEX follow-up "ambiguous: 2 open calls", so 10 messages
// were parked for review that could not have applied to anything live.
//
// Uses the LATEST leg expiry, not the alert-level one: in a calendar spread the near leg
// expiring leaves the far leg still running, so the position is not finished.
async function closeExpiredCalls(channel, todayYMD) {
  return withDb(async (db) => {
    const rows = await allAsync(db,
      `SELECT id, expiry, legs_json FROM tg_recommendations WHERE status = 'OPEN'${channel ? ' AND channel = ?' : ''}`,
      channel ? [channel] : []);
    let closed = 0;
    for (const r of rows) {
      let last = r.expiry || null;
      try {
        for (const l of JSON.parse(r.legs_json || '[]')) {
          if (l.expiry && (!last || l.expiry > last)) last = l.expiry;
        }
      } catch { /* fall back to the alert-level expiry */ }
      if (!last || last >= todayYMD) continue;
      await runAsync(db,
        `UPDATE tg_recommendations
            SET status = 'CLOSED', closed_at = ?, outcome = COALESCE(outcome, 'EXPIRED')
          WHERE id = ?`,
        [new Date().toISOString(), r.id]);
      await runAsync(db,
        `INSERT INTO tg_rec_events (rec_id, msg_id, seq, kind, ops_json, legs_after, note, applied_at, confirmed)
         VALUES (?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM tg_rec_events WHERE rec_id = ?),?,?,?,?,?,?)`,
        [r.id, null, r.id, 'EXPIRED', null, null,
         `all legs expired on ${last}`, new Date().toISOString(), 1]);
      closed += 1;
    }
    return closed;
  });
}

async function findOpenByUnderlying(channel, underlying) {
  return withDb((db) => allAsync(db,
    `SELECT * FROM tg_recommendations WHERE channel = ? AND underlying = ? AND status = 'OPEN' ORDER BY id DESC`,
    [channel, underlying]));
}

module.exports = {
  saveMessage, listMessages, setMessageStatus,
  createRecommendation, appendEvent, listRecommendations, findOpenByUnderlying, closeExpiredCalls,
};
