// Starting, stopping and keeping track of each participant's app process.
//
// ONE PROCESS AND ONE DATABASE FILE PER PARTICIPANT. That is the whole isolation model, and the
// reason it is trustworthy is that it needs no cooperation from the app: a process that never
// opens someone else's file cannot leak their data, however the queries inside it are written.
// The alternative — a user_id on all 33 tables and every query in 111 files audited — has one
// failure mode that this one simply does not have.
//
// The market database is attached read-only-in-practice by every instance and written only by
// the hub's scanner, so one scan serves all 25.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const config = require('./config');

// pid, port and start time per login. Deliberately in memory: if the hub restarts, the children
// die with it (see `detached: false` below), so a table of them on disk would describe processes
// that no longer exist.
const running = new Map();

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

/** The lowest port in the range that no live account already owns. */
async function allocatePort(takenPorts) {
  const taken = new Set(takenPorts.filter(Boolean));
  for (let p = config.instancePortBase; p <= config.instancePortMax; p += 1) {
    if (taken.has(p)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free instance port between ${config.instancePortBase} and ${config.instancePortMax}. `
    + 'Raise INSTANCE_PORT_MAX or remove a disabled participant.');
}

/** Creates a participant's own database by copying the empty template. */
function createUserDb(loginId) {
  if (!fs.existsSync(config.templateDbPath)) {
    throw new Error(`No participant template at ${config.templateDbPath}. `
      + 'Run: node app/scripts/splitDatabase.js --from <desktop app.db>');
  }
  const dir = path.join(config.usersDir, loginId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'app.db');
  // Never overwrite. Re-running setup for an existing participant must not wipe their trades.
  if (!fs.existsSync(file)) fs.copyFileSync(config.templateDbPath, file);
  return file;
}

function isUp(loginId) {
  const r = running.get(loginId);
  return !!(r && r.child && !r.child.killed && r.child.exitCode === null);
}

/**
 * Starts one participant's instance if it is not already up.
 *
 * Every path the child needs is passed in its environment rather than read from a shared config,
 * so the process is incapable of finding another participant's file even by mistake.
 */
async function start(participant) {
  const { login_id: loginId, instance_port: port, db_file: dbFile } = participant;
  if (!port) throw new Error(`${loginId} has no instance port assigned.`);
  if (isUp(loginId)) return running.get(loginId);

  const absDb = path.isAbsolute(dbFile) ? dbFile : path.join(config.dataDir, dbFile);
  if (!fs.existsSync(absDb)) throw new Error(`${loginId}'s database is missing at ${absDb}`);

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: config.appServerDir,
    env: {
      ...process.env,
      NODE_ENV: config.isProd ? 'production' : 'development',
      PORT: String(port),
      DB_PATH: absDb,
      // Everything this participant's process writes outside its database — the two broker
      // session files above all — goes here, beside their own data. The app used to keep those
      // in one directory per installation, which on a shared server would hand the first
      // person's live trading session to all twenty-five.
      INSTANCE_DATA_DIR: path.dirname(absDb),
      MARKET_DB_PATH: config.marketDbPath,
      ENGINES_DIR: config.enginesDir,
      INSTANCE_OWNER: loginId,
      // The name they are actually called, for the sidebar. The login id is an address; a
      // person's own screen should greet them by name. Read at spawn, so an admin renaming
      // somebody takes effect the next time their instance starts — display names are not
      // editable today, so that is not yet a case anyone can hit.
      INSTANCE_OWNER_NAME: participant.display_name || loginId,
      CREDENTIAL_KEY: config.credentialKey,
    },
    // Not detached: a hub that goes down should not leave 25 orphans holding ports and database
    // handles, which is exactly the state that makes the next start fail for reasons nobody can
    // see. They live and die with their supervisor.
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const rec = { loginId, port, child, startedAt: new Date().toISOString(), lastError: null };
  running.set(loginId, rec);

  const tag = (stream, prefix) => stream.on('data', (b) => {
    const text = b.toString().trim();
    if (text) console.log(`  [${loginId}] ${prefix}${text}`);
  });
  tag(child.stdout, '');
  tag(child.stderr, '! ');

  child.on('exit', (code, signal) => {
    rec.exitedAt = new Date().toISOString();
    rec.lastError = code === 0 || signal ? null : `exited with code ${code}`;
    console.log(`  [${loginId}] instance stopped (${signal || `code ${code}`})`);
    // Left in the map on purpose. isUp() reads the child, and keeping the record means the admin
    // page can show "stopped, exit 1" rather than the instance simply vanishing from the list.
  });

  await waitForHealth(port).catch((e) => { rec.lastError = e.message; throw e; });
  return rec;
}

/** Polls until the instance answers, so a caller never proxies into a socket that is not up. */
function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error(`Instance on port ${port} did not start in time`));
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}

function stop(loginId) {
  const r = running.get(loginId);
  if (!r || !r.child || r.child.exitCode !== null) return false;
  r.child.kill('SIGTERM');
  return true;
}

function stopAll() {
  for (const loginId of running.keys()) stop(loginId);
}

function status(loginId) {
  const r = running.get(loginId);
  if (!r) return { running: false, startedAt: null, lastError: null };
  return {
    running: isUp(loginId),
    port: r.port,
    startedAt: r.startedAt,
    exitedAt: r.exitedAt || null,
    lastError: r.lastError || null,
  };
}

module.exports = { start, stop, stopAll, status, isUp, allocatePort, createUserDb, running };
