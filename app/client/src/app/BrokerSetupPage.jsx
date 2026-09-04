// Where a participant connects their own broker accounts.
//
// The desktop app had no screen like this: it read one developer's keys from a .env file on the
// machine it ran on. Every participant here has their own ICICI and Zerodha developer apps, so
// the keys have to be entered, stored encrypted, and — the part that actually trips people up —
// paired with a redirect URL registered at the broker that matches this server exactly.
import { useCallback, useEffect, useState } from 'react';
import { fetchBrokerSetup, saveBrokerKeys, forgetBrokerKeys } from '../services/api';

function Copyable({ value }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-row">
      <code>{value}</code>
      <button
        type="button"
        className="ghost"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          } catch {
            // Clipboard access is refused over plain http on some browsers. The value is on
            // screen and selectable either way, so this is a convenience, not the mechanism.
            setCopied(false);
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function SecretInput({ label, value, onChange, placeholder }) {
  const [shown, setShown] = useState(false);
  return (
    <label className="field">
      <span>{label}</span>
      <span className="secret-input">
        <input
          type={shown ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? 'Hide' : 'Show'}
          title={shown ? 'Hide' : 'Show'}
        >
          {shown ? '🙈' : '👁'}
        </button>
      </span>
    </label>
  );
}

function BrokerCard({ broker, onSaved }) {
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const session = broker.session || {};
  const connected = !!session.connected;

  const save = async () => {
    setBusy(true); setNote(null);
    try {
      await saveBrokerKeys(broker.broker, apiKey, apiSecret);
      setApiKey(''); setApiSecret('');
      setNote({ kind: 'ok', text: 'Saved. Now press Connect to log in to your broker.' });
      await onSaved();
    } catch (e) {
      setNote({ kind: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  const forget = async () => {
    setBusy(true); setNote(null);
    try {
      await forgetBrokerKeys(broker.broker);
      setNote({ kind: 'ok', text: 'Removed.' });
      await onSaved();
    } catch (e) {
      setNote({ kind: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  return (
    <article className="card broker-card">
      <header className="broker-head">
        <div>
          <h2>{broker.label}</h2>
          {broker.configured
            ? <p className="muted">Key {broker.maskedKey} saved{broker.updatedAt ? ` on ${broker.updatedAt.slice(0, 10)}` : ''}</p>
            : <p className="muted">Not set up yet.</p>}
        </div>
        <span className={`pill ${connected ? 'pill-on' : broker.configured ? 'pill-warn' : 'pill-off'}`}>
          {connected ? 'Connected today' : broker.configured ? 'Keys saved — not connected' : 'No keys'}
        </span>
      </header>

      <ol className="steps">
        {broker.steps.map((s) => <li key={s}>{s}</li>)}
      </ol>

      <p className="muted">
        Your broker console: <a href={broker.console} target="_blank" rel="noreferrer">{broker.console}</a>
      </p>

      <div className="field">
        <span>Redirect URL — paste this into your broker app, exactly</span>
        <Copyable value={broker.redirectUrl} />
        <p className="muted small">
          One wrong character here is the most common reason a login fails, and the broker will
          not tell you which character.
        </p>
      </div>

      <SecretInput label={broker.keyLabel} value={apiKey} onChange={setApiKey}
        placeholder={broker.configured ? 'Enter a new key to replace the saved one' : ''} />
      <SecretInput label={broker.secretLabel} value={apiSecret} onChange={setApiSecret} />

      <p className="muted small">{broker.dailyNote}</p>

      {note && <p className={note.kind === 'ok' ? 'note-ok' : 'note-err'}>{note.text}</p>}

      <div className="broker-actions">
        <button type="button" onClick={save} disabled={busy || !apiKey || !apiSecret}>
          {broker.configured ? 'Replace keys' : 'Save keys'}
        </button>
        {broker.configured && (
          <>
            <a
              className="button-link"
              href={broker.broker === 'zerodha' ? '/api/kite/login-url' : '/api/breeze/login-url'}
              onClick={async (e) => {
                e.preventDefault();
                // The login URL is built server-side from the stored key, so it is fetched
                // rather than assembled here — the client never sees the key at all.
                const path = broker.broker === 'zerodha' ? '/api/kite/login-url' : '/api/breeze/login-url';
                const r = await fetch(path).then((x) => x.json()).catch(() => null);
                if (r?.loginUrl) window.open(r.loginUrl, '_blank', 'noopener');
                else setNote({ kind: 'err', text: 'Could not build the login link. Check the key you saved.' });
              }}
            >
              Connect
            </a>
            <button type="button" className="ghost danger" onClick={forget} disabled={busy}>
              Remove keys
            </button>
          </>
        )}
      </div>
    </article>
  );
}

export default function BrokerSetupPage() {
  const [brokers, setBrokers] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await fetchBrokerSetup();
      setBrokers(data.brokers);
      setError('');
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <section className="page-shell">
      <div className="page-header">
        <div>
          <h1>🔗 Brokers</h1>
          <p>
            Connect your own ICICI Direct and Zerodha accounts. Your keys are stored encrypted in
            your own database — nobody else on this server can read them, including the admin.
          </p>
        </div>
      </div>

      {error && <p className="note-err">{error}</p>}
      {!brokers && !error && <p className="muted">Loading…</p>}

      <div className="broker-grid">
        {brokers?.map((b) => <BrokerCard key={b.broker} broker={b} onSaved={load} />)}
      </div>
    </section>
  );
}
