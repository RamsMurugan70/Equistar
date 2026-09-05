const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const config = require('../config/env');

function openDatabase(filePath = config.dbPath) {
  const db = new sqlite3.Database(filePath);
  // Without this, SQLite gives up the instant another connection holds the write lock and
  // throws SQLITE_BUSY. Several services here open their own short-lived connections, and the
  // hub's scanner writes the shared market file while instances are reading it, so brief
  // contention is normal and expected — waiting a few seconds is correct, failing immediately
  // is not.
  db.configure('busyTimeout', 8000);

  // THE SHARED MARKET DATA, attached rather than copied.
  //
  // Every table the scan produces lives in one file that all 25 instances read. Because those
  // tables do not exist in the participant's own database, SQLite resolves unqualified names
  // into the attached file — so the app's existing queries, including the ones that join a
  // participant's holdings against universe_scores, work across both files untouched.
  //
  // Failures are logged, not thrown. An instance whose market file is missing can still show
  // holdings, orders and P&L; only the scan-derived screens go quiet. Refusing to open the
  // database at all would take the whole app down over data it does not own.
  // Skipped when there is nothing to attach, and when the market file IS this connection's main
  // database — which is how the hub's scanner runs. Attaching a file to itself under a second
  // name is at best pointless and at worst a second write path into the same tables.
  const attachable = config.marketDbPath
    && path.resolve(config.marketDbPath) !== path.resolve(filePath);
  if (attachable) {
    // SERIALIZED, and this is not optional. node-sqlite3 runs statements on a connection
    // concurrently by default, so without this the first query races the ATTACH and fails with
    // "no such table: universe_top_daily" — intermittently, and more often on a fast machine
    // under load, which is the worst way for it to show up. Calling serialize() with no callback
    // puts the connection in sequential mode for good, so everything queues behind the attach.
    db.serialize();
    db.run(`ATTACH DATABASE '${config.marketDbPath.replace(/'/g, "''")}' AS market`, (err) => {
      if (err) console.warn(`⚠ shared market data unavailable: ${err.message}`);
    });
  }
  return db;
}

function allAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function getAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function runAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function closeAsync(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

module.exports = {
  openDatabase,
  allAsync,
  getAsync,
  runAsync,
  closeAsync,
};
