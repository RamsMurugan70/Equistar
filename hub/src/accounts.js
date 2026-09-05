// Participants: creating them, signing them in, and cutting them off.
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const config = require('./config');
const instances = require('./instances');
const { hashPassword, verifyPassword } = require('./lib/passwords');

const now = () => new Date().toISOString();

// Generated passwords are read out loud in a room. No l/1/I/O/0, because "did you say ell or
// one" wastes more of a workshop than the extra entropy is worth — and the password is temporary
// anyway, forced to change on first sign-in.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
function generatePassword(len = 10) {
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    loginId: row.login_id,
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: !!row.must_change_password,
    disabled: !!row.disabled_at,
    instancePort: row.instance_port,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

async function list() {
  const rows = await db.all('SELECT * FROM participants ORDER BY role DESC, login_id');
  return rows.map((r) => ({ ...shape(r), instance: instances.status(r.login_id) }));
}

const byLogin = (loginId) => db.get('SELECT * FROM participants WHERE login_id = ?',
  [String(loginId || '').trim().toLowerCase()]);

/**
 * Creates a participant, their database and their port — but does NOT start the instance.
 * Starting happens on their first sign-in, so an admin adding twenty people in a row does not
 * launch twenty processes for people who may not log in until next week.
 */
async function create({ loginId, displayName, role = 'participant' }, actor) {
  const id = String(loginId || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{1,30}$/.test(id)) {
    throw Object.assign(new Error(
      'A login ID must be 2–31 characters: letters, digits, and . _ - only.'), { code: 'BAD_LOGIN' });
  }
  if (await byLogin(id)) {
    throw Object.assign(new Error(`"${id}" is already taken.`), { code: 'TAKEN' });
  }

  const password = generatePassword();
  const { hash, salt } = await hashPassword(password);

  // An admin has no instance and no database: they manage people and do not trade. Giving them
  // one would create a portfolio nobody owns and a port nobody uses.
  let port = null;
  let dbFile = null;
  if (role !== 'admin') {
    const taken = (await db.all('SELECT instance_port FROM participants WHERE instance_port IS NOT NULL'))
      .map((r) => r.instance_port);
    port = await instances.allocatePort(taken);
    dbFile = path.relative(config.dataDir, instances.createUserDb(id));
  }

  const res = await db.run(
    `INSERT INTO participants
       (login_id, display_name, password_hash, password_salt, role, must_change_password,
        instance_port, db_file, created_at)
     VALUES (?,?,?,?,?,1,?,?,?)`,
    [id, String(displayName || id).trim(), hash, salt, role, port, dbFile, now()]);

  await db.audit(actor, 'participant.create', id, `role=${role} port=${port ?? '-'}`);
  const row = await db.get('SELECT * FROM participants WHERE id = ?', [res.lastID]);
  // The only time this password exists in readable form. It is not stored anywhere.
  return { ...shape(row), password };
}

/** A new generated password, for the "I never wrote it down" case. */
async function resetPassword(loginId, actor) {
  const row = await byLogin(loginId);
  if (!row) throw Object.assign(new Error('No such participant.'), { code: 'NOT_FOUND' });
  const password = generatePassword();
  const { hash, salt } = await hashPassword(password);
  await db.run(
    'UPDATE participants SET password_hash = ?, password_salt = ?, must_change_password = 1 WHERE id = ?',
    [hash, salt, row.id]);
  // Every existing session dies with the password. A reset is what you do when you think someone
  // else has it, and leaving their sessions alive would defeat the point.
  await db.run('DELETE FROM sessions WHERE participant_id = ?', [row.id]);
  await db.audit(actor, 'participant.reset_password', row.login_id, null);
  return { loginId: row.login_id, password };
}

/**
 * Sets a participant's password to something the admin chose, optionally without forcing a
 * change on next sign-in.
 *
 * WHAT THIS GIVES UP, stated plainly because it is the whole difference from resetPassword():
 * afterwards the admin knows a working password for that account. The generated-password flow
 * exists so that nobody but the participant ever knows their password — the temporary one dies
 * the moment they replace it. This deliberately breaks that, which is exactly what makes it
 * useful for testing and exactly why it is worth thinking about before using it on a real
 * participant. Every use is written to the audit log with the admin's name.
 *
 * Sessions are still ended. Whatever the reason for changing someone's password, leaving their
 * existing sessions alive means the change did not actually take effect anywhere.
 */
async function setPasswordDirect(loginId, password, { mustChange = false } = {}, actor) {
  const row = await byLogin(loginId);
  if (!row) throw Object.assign(new Error('No such participant.'), { code: 'NOT_FOUND' });
  const pw = String(password || '');
  if (pw.length < 8) {
    throw Object.assign(new Error('Pick a password of at least 8 characters.'), { code: 'WEAK' });
  }

  const { hash, salt } = await hashPassword(pw);
  await db.run(
    'UPDATE participants SET password_hash = ?, password_salt = ?, must_change_password = ? WHERE id = ?',
    [hash, salt, mustChange ? 1 : 0, row.id]);
  await db.run('DELETE FROM sessions WHERE participant_id = ?', [row.id]);
  await db.audit(actor, 'participant.set_password', row.login_id,
    `set directly by admin, mustChange=${mustChange ? 1 : 0}`);
  return { loginId: row.login_id, mustChangePassword: !!mustChange };
}

async function setDisabled(loginId, disabled, actor) {
  const row = await byLogin(loginId);
  if (!row) throw Object.assign(new Error('No such participant.'), { code: 'NOT_FOUND' });
  await db.run('UPDATE participants SET disabled_at = ? WHERE id = ?',
    [disabled ? now() : null, row.id]);
  if (disabled) {
    await db.run('DELETE FROM sessions WHERE participant_id = ?', [row.id]);
    instances.stop(row.login_id);
  }
  await db.audit(actor, disabled ? 'participant.disable' : 'participant.enable', row.login_id, null);
  return shape(await db.get('SELECT * FROM participants WHERE id = ?', [row.id]));
}

// ── Sign-in ──────────────────────────────────────────────────────────────────
async function authenticate(loginId, password, { userAgent, ip } = {}) {
  const row = await byLogin(loginId);

  // The same work and the same answer whether or not the account exists. Skipping the hash for
  // an unknown login makes it measurably faster, which turns the sign-in form into a way of
  // asking whether a given person is on the workshop list.
  const ok = row
    ? await verifyPassword(password, row.password_hash, row.password_salt)
    : await verifyPassword(password, 'x'.repeat(128), 'x'.repeat(32)).then(() => false);

  if (!row || !ok) {
    await db.audit(loginId, 'login.failed', loginId, null);
    throw Object.assign(new Error('That login ID and password do not match.'), { code: 'BAD_LOGIN' });
  }
  if (row.disabled_at) {
    throw Object.assign(new Error('That account has been disabled.'), { code: 'DISABLED' });
  }

  const sid = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + config.sessionDays * 864e5).toISOString();
  await db.run(
    `INSERT INTO sessions (id, participant_id, created_at, last_seen_at, expires_at, user_agent, ip)
     VALUES (?,?,?,?,?,?,?)`,
    [sid, row.id, now(), now(), expires, userAgent || null, ip || null]);
  await db.run('UPDATE participants SET last_login_at = ? WHERE id = ?', [now(), row.id]);
  await db.audit(row.login_id, 'login.ok', row.login_id, null);

  return { sessionId: sid, participant: shape(row) };
}

async function sessionUser(sid) {
  if (!sid) return null;
  const row = await db.get(
    `SELECT p.* FROM sessions s JOIN participants p ON p.id = s.participant_id
      WHERE s.id = ? AND s.expires_at > ? AND p.disabled_at IS NULL`,
    [sid, now()]);
  if (!row) return null;
  await db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [now(), sid]);
  return row;                                  // raw row: callers need instance_port and db_file
}

const endSession = (sid) => db.run('DELETE FROM sessions WHERE id = ?', [sid]);

async function changePassword(participantId, currentPassword, newPassword) {
  const row = await db.get('SELECT * FROM participants WHERE id = ?', [participantId]);
  if (!row) throw Object.assign(new Error('No such participant.'), { code: 'NOT_FOUND' });

  // Skipped only when the account is still on its issued password: the admin read it out, the
  // participant is being made to replace it, and asking them to retype it changes nothing about
  // who is at the keyboard.
  if (!row.must_change_password) {
    const ok = await verifyPassword(currentPassword, row.password_hash, row.password_salt);
    if (!ok) throw Object.assign(new Error('Your current password is not right.'), { code: 'BAD_LOGIN' });
  }
  if (!newPassword || String(newPassword).length < 8) {
    throw Object.assign(new Error('Pick a password of at least 8 characters.'), { code: 'WEAK' });
  }

  const { hash, salt } = await hashPassword(String(newPassword));
  await db.run(
    'UPDATE participants SET password_hash = ?, password_salt = ?, must_change_password = 0 WHERE id = ?',
    [hash, salt, row.id]);
  await db.audit(row.login_id, 'password.change', row.login_id, null);
  return true;
}

module.exports = {
  list, create, resetPassword, setPasswordDirect, setDisabled, authenticate, sessionUser, endSession,
  changePassword, byLogin, shape, generatePassword,
};
