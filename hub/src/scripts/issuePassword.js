// Puts a group of participants onto one shared joining password, still forced to change on
// first sign-in.
//
// WHY THIS EXISTS. The generated passwords are one per person and unrelated to each other, which
// is right for an account that lasts — but a workshop hands out twenty of them in one breath. One
// password in one message, replaced by each person the moment they arrive, trades a narrow risk
// for an announcement that actually works in a room.
//
// THE RISK, NAMED. Between this being sent and someone's first sign-in, anybody holding the
// message can sign in as them and set a password of their own — the account is then theirs, and
// its real owner is locked out. So the window matters: send it when the session starts, not the
// week before, and never put an admin account on a shared password.
//
//   node src/scripts/issuePassword.js hema rachit ravi
//
// The password is asked for rather than passed as an argument, so it does not end up in shell
// history on a machine other people can reach.
const readline = require('readline');
const accounts = require('../accounts');
const db = require('../db');

const ask = (rl, q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

async function main() {
  const logins = process.argv.slice(2).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!logins.length) {
    console.log('\n  Usage: node src/scripts/issuePassword.js <login> [login...]\n');
    process.exit(1);
  }

  db.open();

  // Checked before anything is written, so a typo in one name does not leave half the group
  // moved to the new password and half still on their old one.
  const rows = [];
  for (const id of logins) {
    const row = await accounts.byLogin(id);
    if (!row) { console.error(`\n  No participant "${id}". Nothing changed.\n`); process.exit(1); }
    if (row.role === 'admin') {
      console.error(`\n  "${id}" is an admin — admins do not go on a shared password. Nothing changed.\n`);
      process.exit(1);
    }
    rows.push(row);
  }

  console.log('\n  EquiStar — issue one joining password\n');
  rows.forEach((r) => console.log(`   ${r.login_id.padEnd(14)}${r.display_name}`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const password = await ask(rl, '\n  Joining password (8+ chars): ');
    if (password.length < 8) { console.log('\n  Too short — stopping.\n'); return; }

    for (const r of rows) {
      await accounts.setPasswordDirect(r.login_id, password, { mustChange: true }, 'admin-cli');
    }

    console.log('\n  ─────────────────────────────────────────');
    console.log(`   ${rows.length} account${rows.length === 1 ? '' : 's'} now on this password`);
    console.log('   Each will be made to change it at first sign-in.');
    console.log('  ─────────────────────────────────────────');
    console.log('\n  Any sessions those accounts had open have been ended.\n');
  } finally {
    rl.close();
  }
}

main().catch((e) => { console.error(`\n  Failed: ${e.message}\n`); process.exit(1); });
