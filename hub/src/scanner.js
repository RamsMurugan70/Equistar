// The one universe scan, run by the hub for everyone.
//
// WHY IT LIVES HERE. The scan writes market data that is identical for every participant. Left
// in the instances, twenty-five of them would fetch the same five hundred symbols within the
// same minute — 12,500 requests from one address, which gets the server rate-limited and leaves
// everybody's Top 25 stale at once. One scan, one copy in market.db, twenty-five readers.
//
// TRIGGERED BY HAND, not on a timer, because this deployment has no scheduled work at all. The
// admin runs it after the close; the participants see the result the moment it lands, since they
// are reading the same file.
const { spawn } = require('child_process');
const path = require('path');
const config = require('./config');
const db = require('./db');

const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  lastResult: null,
  lastError: null,
  triggeredBy: null,
  output: [],
};

/**
 * Runs the scan in a child process against the SHARED market database.
 *
 * A child rather than in-process: the scan is a long, CPU-and-network-heavy job, and running it
 * inside the hub would make signing in slow for everyone while it worked. If it dies, the hub
 * that twenty-five people are proxying through does not.
 */
function start(actor) {
  if (state.running) {
    throw Object.assign(new Error('A scan is already running.'), { code: 'SCAN_RUNNING' });
  }

  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.lastError = null;
  state.triggeredBy = actor || null;
  state.output = [];

  // The scanner writes market tables. Pointing DB_PATH at market.db is deliberate: for this one
  // process the market file IS the main database, so the scanner's own unqualified writes land
  // in it rather than in some participant's file.
  const child = spawn(process.execPath, ['-e', `
    const svc = require('./src/services/universe/universeScannerService');
    svc.runScan({ trigger: 'hub' })
      .then((r) => { console.log('RESULT ' + JSON.stringify(r)); process.exit(0); })
      .catch((e) => { console.error(e.message); process.exit(1); });
  `], {
    cwd: config.appServerDir,
    env: {
      ...process.env,
      NODE_ENV: config.isProd ? 'production' : 'development',
      DB_PATH: config.marketDbPath,
      MARKET_DB_PATH: '',                 // nothing to attach: this process owns the market file
      ENGINES_DIR: config.enginesDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const record = (b, isError) => {
    const text = b.toString().trim();
    if (!text) return;
    for (const line of text.split('\n')) {
      // Bounded: a scan that logs per symbol would otherwise grow this without limit, and it is
      // held in memory for the admin page.
      state.output.push(line.slice(0, 300));
      if (state.output.length > 200) state.output.shift();
      if (line.startsWith('RESULT ')) {
        try { state.lastResult = JSON.parse(line.slice(7)); } catch { /* keep the raw line */ }
      }
    }
    console.log(`  [scan] ${isError ? '! ' : ''}${text}`);
  };
  child.stdout.on('data', (b) => record(b, false));
  child.stderr.on('data', (b) => record(b, true));

  child.on('exit', async (code) => {
    state.running = false;
    state.finishedAt = new Date().toISOString();
    if (code !== 0) state.lastError = state.output.slice(-1)[0] || `scan exited with code ${code}`;
    await db.audit(actor, 'scan.finish', null,
      code === 0 ? JSON.stringify(state.lastResult || {}) : `failed: ${state.lastError}`)
      .catch(() => {});
  });

  db.audit(actor, 'scan.start', null, null).catch(() => {});
  return status();
}

function status() {
  return {
    running: state.running,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    triggeredBy: state.triggeredBy,
    lastResult: state.lastResult,
    lastError: state.lastError,
    output: state.output.slice(-40),
    marketDb: path.basename(config.marketDbPath),
  };
}

module.exports = { start, status };
