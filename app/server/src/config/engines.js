// Where the Python engines are, and which interpreter runs them.
//
// WHY THIS FILE EXISTS. The desktop app resolved these in four separate services, each with its
// own copy of an absolute Windows path into one developer's installation:
//
//   D:\AI Projects\ZTA\Options_Data_Agent\venv\Scripts\python.exe
//
// None of that exists on a Linux server. `venv/Scripts` is the Windows layout — on Linux it is
// `venv/bin` — and the drive letter is meaningless. Four copies also meant four places to fix,
// and a service that was missed would fail only on the screen that used it.
//
// The failure mode matters as much as the paths. execFile against a missing interpreter rejects
// with ENOENT, which surfaces as an empty chart rather than "Python is not installed here", so
// `describe()` exists to let a caller say something a person can act on.
const fs = require('fs');
const path = require('path');

// Default relative to this repo rather than an absolute path: EquiStar ships the six scripts it
// needs in engines/, so a checkout works with no configuration at all.
const dir = process.env.ENGINES_DIR
  || path.resolve(__dirname, '..', '..', '..', '..', 'engines');

const isWindows = process.platform === 'win32';

/**
 * The interpreter, in order of preference: an explicit override, a virtualenv beside the scripts
 * (either layout), then whatever `python3`/`python` is on PATH.
 */
function resolvePython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const candidates = isWindows
    ? [path.join(dir, 'venv', 'Scripts', 'python.exe'), path.join(dir, '.venv', 'Scripts', 'python.exe')]
    : [path.join(dir, 'venv', 'bin', 'python3'), path.join(dir, '.venv', 'bin', 'python3')];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  // Not resolved to an absolute path on purpose: letting the OS search PATH is what makes the
  // container image work, where python3 is installed system-wide and there is no virtualenv.
  return isWindows ? 'python' : 'python3';
}

const python = resolvePython();
const script = (name) => path.join(dir, name);

/** Whether a given script is actually present, for a caller that wants to say why it cannot run. */
function available(name) {
  try { return fs.existsSync(script(name)); } catch { return false; }
}

/** A sentence for a log line or an error body, rather than a bare ENOENT. */
function describe(name) {
  if (available(name)) return null;
  return `${name} is not installed on this server (looked in ${dir}). `
    + 'Set ENGINES_DIR if the Python scripts live elsewhere.';
}

module.exports = { dir, python, script, available, describe, isWindows };
