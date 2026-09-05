const path = require('path');

// The repo root, not the app directory. Inherited from the desktop app, where the server sat one
// level below the data folder; here it sits two (EquiStar/app/server), so the old `rootDir/..`
// resolved to EquiStar/app/data — a directory that does not exist. Instances never noticed
// because the hub passes every path explicitly, but the scan did, and warned four times about a
// market database it could not open while writing happily to the right one.
const rootDir = path.resolve(__dirname, '..', '..');            // <repo>/app/server
const repoRoot = path.resolve(rootDir, '..', '..');             // <repo>
require('dotenv').config({ path: path.join(repoRoot, '.env') });

const dataDir = process.env.DATA_DIR
  ? path.resolve(repoRoot, process.env.DATA_DIR)
  : path.join(repoRoot, 'data');

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
// Relative overrides resolve against the repo root, which is what a person typing
// DB_PATH=data/app.db expects. The hub always passes an absolute path, so this matters only for
// running the app by hand.
const dbPath = process.env.DB_PATH
  ? path.resolve(repoRoot, process.env.DB_PATH)
  : path.join(dataDir, 'app.db');

// An EXPLICITLY EMPTY value means "do not attach anything", which is how the scanner runs: it
// opens the market database as its own main and has nothing to attach. Treating empty as unset
// sent it back to the default and produced four warnings per scan about a file it did not need.
const marketDbPath = process.env.MARKET_DB_PATH === ''
  ? null
  : (process.env.MARKET_DB_PATH
    ? path.resolve(repoRoot, process.env.MARKET_DB_PATH)
    : path.join(dataDir, 'market.db'));

module.exports = {
  rootDir,
  dataDir,
  port: Number(process.env.PORT || 5050),
  dbPath,
  marketDbPath,
  // Which participant this instance belongs to. Set by the hub when it starts the process, and
  // used for log lines only — so a stray process is identifiable in `ps` and in the logs.
  instanceOwner: process.env.INSTANCE_OWNER || null,
  instanceOwnerName: process.env.INSTANCE_OWNER_NAME || process.env.INSTANCE_OWNER || null,
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
