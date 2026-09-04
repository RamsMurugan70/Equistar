// Password hashing with scrypt from node:crypto.
//
// WHY scrypt AND NOT bcrypt/argon2 FROM npm. Both good algorithms, both native modules that need
// a compiler toolchain to install — on a Windows dev box and again on the server. scrypt is in
// the standard library, is memory-hard (which is the property that matters against GPU cracking),
// and has no supply chain to watch. For a handful of accounts that trade-off is clearly right.
//
// Parameters: N=2^15 with r=8 costs roughly 32 MB and ~100 ms per hash here. That is slow enough
// to make offline guessing expensive and fast enough that a login does not feel broken. maxmem
// has to be raised explicitly because Node's default (32 MB) is right at the boundary and the
// call fails otherwise.
const crypto = require('crypto');

const N = 32768;          // CPU/memory cost
const r = 8;              // block size
const p = 1;              // parallelisation
const KEYLEN = 64;
const MAXMEM = 128 * N * r * 2;

function hash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N, r, p, maxmem: MAXMEM }, (err, key) => {
      if (err) reject(err); else resolve(key.toString('hex'));
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { hash: await hash(password, salt), salt };
}

// Compared with timingSafeEqual so the answer takes the same time whether the first byte differs
// or the last. A plain === leaks how much of a guess was correct.
async function verifyPassword(password, expectedHash, salt) {
  if (!password || !expectedHash || !salt) return false;
  let actual;
  try {
    actual = await hash(password, salt);
  } catch {
    return false;
  }
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Deliberately mild. These are accounts you hand to people you know, and a rule that forces
// symbols mostly produces one written on a sticky note. Length is what actually helps.
function checkPasswordStrength(password) {
  const pw = String(password || '');
  if (pw.length < 12) return 'Use at least 12 characters — length matters more than symbols.';
  if (/^\d+$/.test(pw)) return 'Digits only is easy to guess. Add words.';
  if (/^(.)\1+$/.test(pw)) return 'That is one repeated character.';
  return null;
}

module.exports = { hashPassword, verifyPassword, checkPasswordStrength };
