// The hub's database handle. One file, one process, no tenancy question — the hub is the thing
// that knows about everybody, which is exactly why it holds nothing worth stealing.
//
// EVERY HELPER AWAITS `ready`. Creating the schema is asynchronous, so a version of this that
// returned the handle immediately let the first query run before the tables existed. That fails
// only on a fresh database — the first boot of a new deployment, when nobody is watching closely
// and the error ("no such table: participants") reads like a broken build rather than a race.
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const config = require('../config');

let db = null;
let ready = null;

function open() {
  if (ready) return ready;
  fs.mkdirSync(path.dirname(config.hubDbPath), { recursive: true });

  ready = new Promise((resolve, reject) => {
    db = new sqlite3.Database(config.hubDbPath, (err) => {
      if (err) return reject(new Error(`Cannot open ${config.hubDbPath}: ${err.message}`));
      // Sequential mode: statements queue rather than racing each other, which is what makes
      // the schema below reliably land before anything queries it.
      db.serialize();
      db.configure('busyTimeout', 8000);
      db.run('PRAGMA foreign_keys = ON');
      return db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'), (e) => (
        e ? reject(new Error(`Hub schema failed: ${e.message}`)) : resolve(db)));
    });
  });
  return ready;
}

const all = async (sql, p = []) => {
  const d = await open();
  return new Promise((res, rej) => d.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
};
const get = async (sql, p = []) => {
  const d = await open();
  return new Promise((res, rej) => d.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
};
const run = async (sql, p = []) => {
  const d = await open();
  return new Promise((res, rej) => d.run(sql, p, function cb(e) { return e ? rej(e) : res(this); }));
};

// Never throws. An audit line is a record of something that already happened; losing the record
// is bad, but failing the action that succeeded is worse.
async function audit(actor, action, subject, detail) {
  try {
    await run('INSERT INTO audit_log (at, actor, action, subject, detail) VALUES (?,?,?,?,?)',
      [new Date().toISOString(), actor || 'system', action, subject || null, detail || null]);
  } catch (e) {
    console.warn(`⚠ audit write failed (${action}): ${e.message}`);
  }
}

module.exports = { open, all, get, run, audit };
