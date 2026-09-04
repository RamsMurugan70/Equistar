// Creates the first admin, which is the one account nothing else can make.
//
// Interactive so the password is printed to a terminal the operator is already looking at,
// rather than passed on a command line where it lands in shell history.
//
//   node src/scripts/createAdmin.js
const readline = require('readline');
const accounts = require('../accounts');
const db = require('../db');

const ask = (rl, q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

async function main() {
  db.open();
  const existing = await db.all("SELECT login_id FROM participants WHERE role = 'admin'");

  console.log('\n  EquiStar — create an admin\n');
  if (existing.length) {
    console.log(`  There ${existing.length === 1 ? 'is already an admin' : `are already ${existing.length} admins`}: `
      + `${existing.map((r) => r.login_id).join(', ')}`);
    console.log('  Adding another is fine; press Ctrl-C to stop.\n');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const loginId = await ask(rl, '  Login ID: ');
    if (!loginId) { console.log('\n  Nothing entered — stopping.\n'); return; }
    const displayName = await ask(rl, '  Display name: ') || loginId;

    const created = await accounts.create({ loginId, displayName, role: 'admin' }, 'setup');
    console.log('\n  ─────────────────────────────────────────');
    console.log(`   login ID   ${created.loginId}`);
    console.log(`   password   ${created.password}`);
    console.log('  ─────────────────────────────────────────');
    console.log('\n  Shown once. It cannot be looked up later, only reset.');
    console.log('  You will be asked to change it on first sign-in.\n');
    console.log('  An admin manages participants and does not trade — no portfolio, no instance.');
    console.log('  To use the app yourself, create an ordinary participant account and sign in as that.\n');
  } finally {
    rl.close();
  }
}

main().catch((e) => { console.error(`\n  Failed: ${e.message}\n`); process.exit(1); });
