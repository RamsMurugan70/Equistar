const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '..', '.env') });

const rootDir = path.resolve(__dirname, '..', '..');
const dataDir = path.join(rootDir, '..', 'data');

// TWO DATABASES, and which one a table lives in is the whole tenancy model.
//
//   DB_PATH        this participant's own file: orders, snapshots, broker keys, scores.
//                  One process, one participant, one file. Nothing else can reach it.
//   MARKET_DB_PATH shared, and the same file for everyone: scans, prices, fundamentals,
//                  corporate actions. Written by the hub's scanner, read by every instance.
//
// The split exists because market data is identical for all 25 participants and expensive to
// fetch. Twenty-five instances each scanning the same 500 symbols would put 12,500 requests at
// Yahoo in the same minute and get the server's address blocked, leaving everyone's Top 25 stale
// at once. One scan, one copy, many readers.
//
// connection.js ATTACHes the market file, and because those tables do not exist in the
// participant's own file, SQLite resolves the app's existing unqualified queries into the
// attached one. No query in the app had to change.
const dbPath = process.env.DB_PATH
  ? path.resolve(rootDir, '..', process.env.DB_PATH)
  : path.join(dataDir, 'app.db');

const marketDbPath = process.env.MARKET_DB_PATH
  ? path.resolve(rootDir, '..', process.env.MARKET_DB_PATH)
  : path.join(dataDir, 'market.db');

module.exports = {
  rootDir,
  dataDir,
  port: Number(process.env.PORT || 5050),
  dbPath,
  marketDbPath,
  // Which participant this instance belongs to. Set by the hub when it starts the process, and
  // used for log lines only — so a stray process is identifiable in `ps` and in the logs.
  instanceOwner: process.env.INSTANCE_OWNER || null,
  // Encrypts this participant's stored broker API secrets. Supplied by the hub, which reads it
  // from its own environment — so the key is never written into any database, and a copy of a
  // participant's file on its own is not enough to use their credentials.
  credentialKey: process.env.CREDENTIAL_KEY || '',
  // No default. On the desktop this pointed at the developer's own Downloads folder for CSV
  // imports; on a shared server there is no such thing, and guessing one would have every
  // participant reading from the same directory.
  downloadsDir: process.env.DOWNLOADS_DIR || null,
  logLevel: process.env.LOG_LEVEL || 'info',
};
