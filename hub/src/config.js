const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const rootDir = path.resolve(__dirname, '..', '..');          // D:\AI Projects\EquiStar
const dataDir = process.env.DATA_DIR
  ? path.resolve(rootDir, process.env.DATA_DIR)
  : path.join(rootDir, 'data');

const isProd = process.env.NODE_ENV === 'production';

// Instances get one port each, assigned once and never reused while the account exists. A range
// rather than a random free port, so `ss -ltnp` on the server reads as a list of participants
// rather than a scatter of arbitrary numbers.
const INSTANCE_PORT_BASE = Number(process.env.INSTANCE_PORT_BASE || 5100);
const INSTANCE_PORT_MAX = Number(process.env.INSTANCE_PORT_MAX || 5199);

const config = {
  isProd,
  rootDir,
  dataDir,
  port: Number(process.env.PORT || 5080),

  hubDbPath: path.join(dataDir, 'hub.db'),
  marketDbPath: path.join(dataDir, 'market.db'),
  templateDbPath: path.join(dataDir, 'template.db'),
  usersDir: path.join(dataDir, 'users'),

  appServerDir: path.join(rootDir, 'app', 'server'),
  enginesDir: path.join(rootDir, 'engines'),

  instancePortBase: INSTANCE_PORT_BASE,
  instancePortMax: INSTANCE_PORT_MAX,

  sessionSecret: process.env.SESSION_SECRET || '',
  // Marks the session cookie Secure. Must be true behind HTTPS and false on plain http, because
  // a Secure cookie over http is dropped silently by the browser and presents as "login does
  // nothing at all".
  cookieSecure: String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true',
  sessionDays: Number(process.env.SESSION_DAYS || 30),

  // Handed to a participant's instance so it can encrypt that person's broker API secrets. One
  // key for the whole deployment: the instances are already isolated from each other by process
  // and by file, and a key per participant would mean 25 secrets to lose instead of one.
  credentialKey: process.env.CREDENTIAL_KEY || '',
};

if (isProd) {
  const missing = ['sessionSecret', 'credentialKey'].filter((k) => !config[k]);
  if (missing.length) {
    console.error(`\n  Refusing to start: ${missing.join(' and ')} must be set in production.`);
    console.error('  Generate each with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n');
    process.exit(1);
  }
  if (!config.cookieSecure) {
    console.error('\n  Refusing to start: COOKIE_SECURE must be true in production.\n');
    process.exit(1);
  }
}

module.exports = config;
