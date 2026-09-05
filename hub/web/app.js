// The hub's three screens: sign in, change your password, and the admin console.
//
// Everything past those is the app itself, which the hub proxies — so this file stays small on
// purpose. It is the front door, not the building.
const app = document.getElementById('app');

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) {
    if (k === null || k === undefined || k === false) continue;
    n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return n;
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { code: data.code });
  return data;
}

const msg = (text, kind = 'err') => el('div', { className: `msg ${kind}` }, text);

/** A password field with a reveal control, because people mistype what they cannot see. */
function passwordField(placeholder = '') {
  const input = el('input', { type: 'password', autocomplete: 'current-password', placeholder });
  const btn = el('button', { type: 'button', title: 'Show password', textContent: '👁' });
  btn.setAttribute('aria-label', 'Show password');
  btn.onclick = () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? '👁' : '🙈';
    btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    input.focus();
  };
  return { wrap: el('div', { className: 'pw' }, input, btn), input };
}

function shell(narrow, ...children) {
  app.className = narrow ? 'narrow' : '';
  app.replaceChildren(...children);
}

// ── Sign in ──────────────────────────────────────────────────────────────────
function renderLogin(note) {
  const loginId = el('input', { autocomplete: 'username', autocapitalize: 'none', spellcheck: false });
  const pw = passwordField();
  const out = el('div');
  const submit = el('button', { type: 'submit' }, 'Sign in');

  const form = el('form', {},
    el('h1', {}, 'EquiStar'),
    el('p', { className: 'sub' }, 'Sign in with the ID and password you were given.'),
    el('label', {}, 'Login ID'), loginId,
    el('label', {}, 'Password'), pw.wrap,
    el('div', { className: 'actions' }, submit),
    out);

  form.onsubmit = async (e) => {
    e.preventDefault();
    out.replaceChildren();
    submit.disabled = true;
    try {
      const { participant } = await api('/hub/api/login', {
        method: 'POST',
        body: { loginId: loginId.value.trim(), password: pw.input.value },
      });
      route(participant);
    } catch (err) {
      out.replaceChildren(msg(err.message));
      submit.disabled = false;
      pw.input.focus();
      pw.input.select();
    }
  };

  shell(true, el('div', { className: 'card' }, note ? msg(note, 'ok') : null, form));
  loginId.focus();
}

// ── Forced password change ───────────────────────────────────────────────────
function renderChangePassword(participant) {
  const current = passwordField();
  const next = passwordField();
  const again = passwordField();
  for (const f of [next, again]) f.input.autocomplete = 'new-password';
  const out = el('div');
  const submit = el('button', { type: 'submit' }, 'Set my password');

  const first = participant.mustChangePassword;
  const form = el('form', {},
    el('h1', {}, first ? 'Choose your password' : 'Change your password'),
    el('p', { className: 'sub' }, first
      ? 'The password you were given is temporary. Pick your own to continue.'
      : 'At least 8 characters.'),
    first ? null : el('label', {}, 'Current password'),
    first ? null : current.wrap,
    el('label', {}, 'New password'), next.wrap,
    el('label', {}, 'New password again'), again.wrap,
    el('div', { className: 'actions' }, submit,
      first ? null : el('button', { type: 'button', className: 'ghost', onclick: () => route(participant) }, 'Cancel')),
    out);

  form.onsubmit = async (e) => {
    e.preventDefault();
    out.replaceChildren();
    if (next.input.value !== again.input.value) {
      out.replaceChildren(msg('Those two passwords are not the same.'));
      return;
    }
    submit.disabled = true;
    try {
      const r = await api('/hub/api/password', {
        method: 'POST',
        body: { currentPassword: current.input.value, newPassword: next.input.value },
      });
      if (r.signedOut) {
        // Back to the sign-in form, on purpose. Typing the new password once more while it is
        // still in mind is what fixes it in memory — somebody carried straight into the app has
        // never actually used the password they just chose.
        renderLogin('Password changed. Sign in with your new password.');
      } else {
        window.location.href = '/';
      }
    } catch (err) {
      out.replaceChildren(msg(err.message));
      submit.disabled = false;
    }
  };

  shell(true, el('div', { className: 'card' }, form));
  (first ? next : current).input.focus();
}

// ── Admin ────────────────────────────────────────────────────────────────────
async function renderAdmin(participant) {
  shell(false, el('div', { className: 'card' }, el('p', { className: 'muted' }, 'Loading…')));

  const [{ participants }, scan] = await Promise.all([
    api('/hub/api/participants'),
    api('/hub/api/scan').catch(() => null),
  ]);

  const out = el('div');
  const reload = () => renderAdmin(participant);

  // — create —
  const loginId = el('input', { placeholder: 'e.g. priya', autocapitalize: 'none', spellcheck: false });
  const name = el('input', { placeholder: 'e.g. Priya Sharma' });
  const role = el('select', {}, el('option', { value: 'participant' }, 'Participant'),
    el('option', { value: 'admin' }, 'Admin (no trading)'));
  const createBtn = el('button', {}, 'Create');

  createBtn.onclick = async () => {
    out.replaceChildren();
    createBtn.disabled = true;
    try {
      const r = await api('/hub/api/participants', {
        method: 'POST',
        body: { loginId: loginId.value.trim(), displayName: name.value.trim(), role: role.value },
      });
      // Shown once. There is no way to look it up later, by design — a reset is the only route
      // back, and that is what makes "the password is only in the participant's head" true.
      out.replaceChildren(el('div', { className: 'secret' },
        el('strong', {}, `Password for ${r.loginId}`),
        el('code', {}, r.password),
        el('p', { className: 'muted' }, 'Shown once. Give it to them now — it cannot be looked up again, only reset.')));
      loginId.value = ''; name.value = '';
      const list = await api('/hub/api/participants');
      drawTable(list.participants);
    } catch (e) {
      out.replaceChildren(msg(e.message));
    } finally { createBtn.disabled = false; }
  };

  const tableBox = el('div');
  function drawTable(rows) {
    const body = el('tbody', {}, rows.map((p) => {
      const inst = p.instance || {};
      const actions = el('td');
      if (p.role !== 'admin') {
        const reset = el('button', { className: 'ghost sm' }, 'Reset password');
        reset.onclick = async () => {
          out.replaceChildren();
          try {
            const r = await api(`/hub/api/participants/${p.loginId}/reset`, { method: 'POST' });
            out.replaceChildren(el('div', { className: 'secret' },
              el('strong', {}, `New password for ${r.loginId}`),
              el('code', {}, r.password),
              el('p', { className: 'muted' }, 'Their old password and every open session stopped working.')));
          } catch (e) { out.replaceChildren(msg(e.message)); }
        };
        // Set a password directly. Inline rather than a browser prompt(), which masks nothing,
        // cannot be styled, and gives no room to say what the choice costs.
        const setPw = el('button', { className: 'ghost sm' }, 'Set password');
        setPw.onclick = () => {
          const input = el('input', { type: 'text', placeholder: 'at least 8 characters',
            autocomplete: 'off', spellcheck: false });
          const keep = el('input', { type: 'checkbox' });
          const apply = el('button', { className: 'sm' }, 'Set');
          const cancel = el('button', { className: 'ghost sm' }, 'Cancel');
          const box = el('div', { className: 'card' },
            el('strong', {}, `Set a password for ${p.loginId}`),
            el('p', { className: 'muted' },
              'Shown as you type, because you are choosing it rather than reading it out. '
              + 'Note that you will then know a working password for this account — the '
              + 'generated-password flow exists so that nobody but the participant does.'),
            el('div', { className: 'row' },
              el('div', { className: 'grow' }, input),
              apply, cancel),
            el('label', { style: 'display:flex;gap:8px;align-items:center;margin-top:10px' },
              keep, el('span', { className: 'muted' },
                'Still make them change it at next sign-in')));
          apply.onclick = async () => {
            apply.disabled = true;
            try {
              await api(`/hub/api/participants/${p.loginId}/password`, {
                method: 'POST',
                body: { password: input.value, mustChange: keep.checked },
              });
              out.replaceChildren(msg(
                `Password set for ${p.loginId}. Any session they had open is now signed out.`, 'ok'));
              reload();
            } catch (e) {
              box.append(msg(e.message));
              apply.disabled = false;
            }
          };
          cancel.onclick = () => out.replaceChildren();
          out.replaceChildren(box);
          // The message area sits in the panel ABOVE the participants table, so a form opened
          // from a table row appears off-screen behind you. Without this the button reads as
          // doing nothing at all.
          box.scrollIntoView({ behavior: 'smooth', block: 'center' });
          input.focus();
        };

        const toggle = el('button', { className: p.disabled ? 'ghost sm' : 'danger sm' },
          p.disabled ? 'Enable' : 'Disable');
        toggle.onclick = async () => {
          try {
            await api(`/hub/api/participants/${p.loginId}/disabled`, {
              method: 'POST', body: { disabled: !p.disabled },
            });
            reload();
          } catch (e) { out.replaceChildren(msg(e.message)); }
        };
        actions.append(reset, ' ', setPw, ' ', toggle);
        if (inst.running) {
          const stop = el('button', { className: 'ghost sm' }, 'Stop app');
          stop.onclick = async () => {
            await api(`/hub/api/participants/${p.loginId}/stop`, { method: 'POST' }).catch(() => {});
            reload();
          };
          actions.append(' ', stop);
        }
      }

      let state = el('span', { className: 'tag off' }, 'never signed in');
      if (p.disabled) state = el('span', { className: 'tag bad' }, 'disabled');
      else if (p.role === 'admin') state = el('span', { className: 'tag adm' }, 'admin');
      else if (inst.running) state = el('span', { className: 'tag on' }, `app running :${inst.port}`);
      else if (inst.lastError) state = el('span', { className: 'tag bad' }, inst.lastError);
      else if (p.lastLoginAt) state = el('span', { className: 'tag off' }, 'app stopped');

      return el('tr', {},
        el('td', {}, el('strong', {}, p.loginId)),
        el('td', {}, p.displayName),
        el('td', {}, state),
        el('td', {}, p.mustChangePassword && p.lastLoginAt === null ? 'not yet' : (p.lastLoginAt || '—').slice(0, 16).replace('T', ' ')),
        actions);
    }));
    tableBox.replaceChildren(el('table', {},
      el('thead', {}, el('tr', {},
        ...['Login', 'Name', 'Status', 'Last sign-in', ''].map((h) => el('th', {}, h)))),
      body));
  }
  drawTable(participants);

  // — the shared scan —
  const scanBox = el('div');
  function drawScan(s) {
    const btn = el('button', { disabled: !!s?.running }, s?.running ? 'Scanning…' : 'Run the scan now');
    btn.onclick = async () => {
      btn.disabled = true;
      try { drawScan(await api('/hub/api/scan', { method: 'POST' })); }
      catch (e) { scanBox.append(msg(e.message)); }
      // Poll while it runs; it takes minutes and there is nothing else to look at.
      const poll = setInterval(async () => {
        const next = await api('/hub/api/scan').catch(() => null);
        if (!next) return;
        drawScan(next);
        if (!next.running) clearInterval(poll);
      }, 4000);
    };
    scanBox.replaceChildren(
      el('div', { className: 'bar' },
        el('div', {},
          el('strong', {}, 'Market data'),
          el('p', { className: 'muted' },
            'One scan serves everyone — participants read the same file. Run it after the 15:30 close; '
            + 'during market hours it records an incomplete candle as though it were a close.')),
        btn),
      s?.lastError ? msg(s.lastError) : null,
      s?.finishedAt && !s.running
        ? el('p', { className: 'muted' }, `Last run finished ${s.finishedAt.slice(0, 16).replace('T', ' ')}`
          + (s.triggeredBy ? `, started by ${s.triggeredBy}` : ''))
        : null,
      s?.output?.length ? el('pre', { className: 'log' }, s.output.join('\n')) : null);
  }
  drawScan(scan);

  const signOut = el('button', { className: 'ghost sm' }, 'Sign out');
  signOut.onclick = async () => { await api('/hub/api/logout', { method: 'POST' }); renderLogin(); };

  shell(false,
    el('div', { className: 'bar' },
      el('div', {}, el('h1', {}, 'EquiStar'),
        el('p', { className: 'sub' }, `Signed in as ${participant.displayName} · admin`)),
      signOut),
    el('div', { className: 'card' },
      el('h2', { style: 'margin-top:0' }, 'Add a participant'),
      el('p', { className: 'muted' },
        'They get their own app and their own database. Nothing they do is visible to anyone else.'),
      el('div', { className: 'row' },
        el('div', { className: 'grow' }, el('label', {}, 'Login ID'), loginId),
        el('div', { className: 'grow' }, el('label', {}, 'Name'), name),
        el('div', {}, el('label', {}, 'Role'), role),
        createBtn),
      out),
    el('h2', {}, `Participants (${participants.length})`),
    el('div', { className: 'card' }, tableBox),
    el('h2', {}, 'Shared market data'),
    el('div', { className: 'card' }, scanBox));
}

// ── Routing ──────────────────────────────────────────────────────────────────
function route(participant) {
  if (!participant) return renderLogin();
  if (participant.mustChangePassword) return renderChangePassword(participant);
  if (participant.role === 'admin') return renderAdmin(participant);
  // A participant with a settled password belongs in the app, which the hub proxies at /.
  window.location.href = '/';
  return null;
}

(async () => {
  if (window.location.hash === '#change-password') {
    const { participant } = await api('/hub/api/me').catch(() => ({ participant: null }));
    if (participant) return renderChangePassword(participant);
  }
  const { participant } = await api('/hub/api/me').catch(() => ({ participant: null }));
  return route(participant);
})();
