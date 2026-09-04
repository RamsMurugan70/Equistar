// Encryption for stored broker credentials.
//
// WHAT IS AT STAKE. An ICICI Breeze api_key + api_secret + live session is full account access,
// and the Breeze API includes order placement. This app never places an order, but that is a
// property of our code, not of the credential — anyone who obtains one can. So the database is
// treated as though it will eventually be read by someone who should not have it.
//
// AES-256-GCM, not CBC. GCM authenticates as well as encrypts: altering a stored ciphertext
// makes decryption fail loudly instead of yielding plausible garbage that gets sent to a broker
// as somebody's API key.
//
// THE KEY LIVES IN THE ENVIRONMENT, NEVER IN THE DATABASE. That is the entire point of the
// arrangement: a stolen equixlite.db is a file full of ciphertext and nothing else. Storing the
// key in a table beside the data it protects would be theatre.
//
// A FRESH IV PER ENCRYPTION. Reusing an IV under the same key is the one mistake that breaks GCM
// outright — it leaks the XOR of two plaintexts and lets an attacker forge tags. crypto
// .randomBytes on every call, no counters, no derivation from the record.
const crypto = require('crypto');
const { credentialKey } = require('../../config/env');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;          // 96 bits, the size GCM is specified for
const VERSION = 'v1';         // lets a future key rotation identify what it is looking at

let cachedKey = null;

function key() {
  if (cachedKey) return cachedKey;
  if (!credentialKey) {
    throw Object.assign(
      new Error('CREDENTIAL_KEY is not set. Broker credentials cannot be stored or read without '
        + 'it. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'),
      { code: 'NO_CREDENTIAL_KEY' });
  }
  const buf = Buffer.from(String(credentialKey).trim(), 'hex');
  if (buf.length !== 32) {
    throw Object.assign(
      new Error(`CREDENTIAL_KEY must be 64 hex characters (32 bytes); got ${buf.length} bytes. `
        + 'A short key silently weakens every stored credential, so this refuses rather than pads.'),
      { code: 'BAD_CREDENTIAL_KEY' });
  }
  cachedKey = buf;
  return cachedKey;
}

/** Returns a single self-describing string: version.iv.tag.ciphertext, all hex. */
function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join('.');
}

function decrypt(packed) {
  if (!packed) return null;
  const parts = String(packed).split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw Object.assign(new Error('Stored credential is not in a format this version understands.'),
      { code: 'BAD_CIPHERTEXT' });
  }
  const [, ivHex, tagHex, dataHex] = parts;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch (e) {
    // Distinguished deliberately. A wrong key and a tampered record both fail here, and the
    // operator needs to know which: the first is a misconfigured deployment that will affect
    // every user, the second is one damaged row.
    if (e.code === 'NO_CREDENTIAL_KEY' || e.code === 'BAD_CREDENTIAL_KEY') throw e;
    throw Object.assign(
      new Error('Could not decrypt a stored credential. Either CREDENTIAL_KEY has changed since '
        + 'it was saved, or the stored value was altered. Re-enter the credential to fix it.'),
      { code: 'DECRYPT_FAILED' });
  }
}

// What the UI is allowed to see. Never the value — only enough to recognise which key is stored,
// so someone can tell "the one from my old app" from "the one I just made".
function mask(value) {
  const s = String(value || '');
  if (s.length <= 4) return '••••';
  return `••••${s.slice(-4)}`;
}

// Scrubs secrets out of anything on its way to a log. The broker clients echo request context
// when a call fails, and a Breeze error carrying the signed body would otherwise put an api_key
// in the log file — where it long outlives the request and is not covered by the encryption
// above.
const SECRET_KEYS = /^(api_?key|api_?secret|secret|session|session_?token|access_?token|request_?token|password|checksum|jKey|X-AppKey|X-SessionToken|X-Checksum)$/i;

function redact(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

module.exports = { encrypt, decrypt, mask, redact };
