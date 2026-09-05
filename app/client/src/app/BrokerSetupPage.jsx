// Where a participant sets the app up: what to call their two accounts, and their own broker
// API keys.
//
// This is the first screen a new participant sees after signing in, and stays the landing page
// until at least one broker is connected — without that the app has nothing to show, and a wall
// of empty panels teaches someone the app is broken rather than unfinished.
//
// The desktop app needed neither half: two portfolios named after the two people whose money
// they held, and one developer's keys read from a .env file on the machine it ran on.
import { useCallback, useEffect, useState } from 'react';
import {
  fetchBrokerSetup, saveBrokerKeys, forgetBrokerKeys, saveAccountNames,
} from '../services/api';

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
        <button type="button" onClick={() => setShown((s) => !s)}
          aria-label={shown ? 'Hide' : 'Show'} title={shown ? 'Hide' : 'Show'}>
          {shown ? '🙈' : '👁'}
        </button>
      </span>
    </label>
  );
}

/** Step one: what these two accounts are called. */
function AccountNames({ brokers, onSaved }) {
  const byBroker = Object.fromEntries(brokers.map((b) => [b.broker, b]));
  const [icici, setIcici] = useState(byBroker.icicidirect?.accountName || '');
  const [zerodha, setZerodha] = useState(byBroker.zerodha?.accountName || '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const save = async () => {
    setBusy(true); setNote(null);
    try {
      await saveAccountNames({ icicidirect: icici, zerodha });
      setNote({ kind: 'ok', text: 'Saved.' });
      await onSaved();
    } catch (e) {
      setNote({ kind: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  return (
    <article className="card">
      <h2>What should we call your accounts?</h2>
      <p className="muted">
        One per broker. These are the names you will see everywhere in the app, so use whatever
        you actually call them — your own name, a family member&apos;s, &quot;long term&quot;.
      </p>
      <div className="broker-grid">
        <label className="field">
          <span>Your ICICI Direct account</span>
          <input value={icici} maxLength={40} placeholder="e.g. Mine"
            onChange={(e) => setIcici(e.target.value)} />
        </label>
        <label className="field">
          <span>Your Zerodha account</span>
          <input value={zerodha} maxLength={40} placeholder="e.g. Geetha"
            onChange={(e) => setZerodha(e.target.value)} />
        </label>
      </div>
      {note && <p className={note.kind === 'ok' ? 'note-ok' : 'note-err'}>{note.text}</p>}
      <div className="broker-actions">
        <button type="button" onClick={save} disabled={busy || (!icici.trim() && !zerodha.trim())}>
          Save names
        </button>
        <span className="muted small">
          You can change these later — your holdings move with the name.
        </span>
      </div>
    </article>
  );
}

function BrokerCard({ broker, onSaved }) {
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [showTips, setShowTips] = useState(false);

  const connected = !!broker.session?.connected;

  const save = async () => {
    setBusy(true); setNote(null);
    try {
      await saveBrokerKeys(broker.broker, apiKey, apiSecret);
      setApiKey(''); setApiSecret('');
      setNote({ kind: 'ok', text: 'Saved. Now press Connect to log in at your broker.' });
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
          <h2>{broker.accountName}</h2>
          <p className="muted">
            {broker.label}
            {broker.configured ? ` · key ${broker.maskedKey}` : ' · no keys yet'}
          </p>
        </div>
        <span className={`pill ${connected ? 'pill-on' : broker.configured ? 'pill-warn' : 'pill-off'}`}>
          {connected ? 'Connected today' : broker.configured ? 'Keys saved — not connected' : 'Not set up'}
        </span>
      </header>

      {/* ONCE THE KEYS ARE IN, THE LOGIN IS THE ONLY THING LEFT TO DO, so it goes first and
          loud. Previously the broker-console URL sat in the middle of the card as a large blue
          link while Connect was a small button below the fold of attention — so people clicked
          the console, landed on their app's settings page, and no login ever started. */}
      {broker.configured && !connected && (
        <div className="connect-now">
          <div>
            <strong>Step 2 — log in at {broker.label}</strong>
            <p className="muted small">
              This opens {broker.label} in a new tab. Sign in there and you will be sent straight
              back here, connected.
            </p>
          </div>
          <a className="button-link big" href={broker.loginUrl || '#'} target="_blank" rel="noreferrer"
            onClick={(e) => { if (!broker.loginUrl) { e.preventDefault(); setNote({ kind: 'err', text: 'Save your API key first.' }); } }}>
            🔑 Log in to {broker.label} ↗
          </a>
        </div>
      )}

      <details className="setup-steps" open={!broker.configured}>
        <summary>{broker.configured ? 'One-time setup at the broker (already done)' : 'Step 1 — one-time setup at the broker'}</summary>
        <ol className="steps">
          {broker.setupSteps.map((s) => <li key={s}>{s}</li>)}
        </ol>
        <p className="muted small">
          Where you do that setup:{' '}
          <a href={broker.portalUrl} target="_blank" rel="noreferrer">{broker.portalUrl}</a>
          {' '}— this is <em>not</em> the login link.
        </p>
      </details>

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
            <button type="button" className="ghost danger" onClick={forget} disabled={busy}>
              Remove keys
            </button>
          </>
        )}
      </div>

      {/* Every one of these is a failure somebody actually hit getting this working. Collapsed
          by default so they do not shout at a participant for whom nothing has gone wrong yet. */}
      <button type="button" className="ghost sm tips-toggle" onClick={() => setShowTips((s) => !s)}>
        {showTips ? 'Hide' : 'If it does not work'}
      </button>
      {showTips && (
        <dl className="tips">
          {broker.tips.map(([q, a]) => (
            <div key={q}>
              <dt>{q}</dt>
              <dd>{a}</dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

export default function BrokerSetupPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await fetchBrokerSetup());
      setError('');
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const firstRun = data && !data.setupComplete;

  return (
    <section className="page-shell">
      <div className="page-header">
        <div>
          <h1>{firstRun ? '👋 Set up your accounts' : '🔗 Brokers'}</h1>
          <p>
            {firstRun
              ? 'Two steps: name your accounts, then connect each broker with your own API keys. '
                + 'Until a broker is connected there is nothing for the app to show you.'
              : 'Your own ICICI Direct and Zerodha keys, stored encrypted in your own database — '
                + 'nobody else on this server can read them, including the admin.'}
          </p>
        </div>
      </div>

      {error && <p className="note-err">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}

      {data && (
        <>
          <AccountNames brokers={data.brokers} onSaved={load} />
          <div className="broker-grid">
            {data.brokers.map((b) => <BrokerCard key={b.broker} broker={b} onSaved={load} />)}
          </div>
          {data.anyConnected && (
            <p className="note-ok">
              A broker is connected. <a href="/">Go to your dashboard →</a> Then use Daily Sync to
              pull your holdings and trades in.
            </p>
          )}
        </>
      )}
    </section>
  );
}
