const sqlite3 = require('sqlite3').verbose();
const config = require('../../config/env');

function openLegacyDatabase() {
  return new sqlite3.Database(config.legacyDbPath, sqlite3.OPEN_READONLY);
}

function allAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
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
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  openLegacyDatabase,
  allAsync,
  runAsync,
  closeAsync,
};
