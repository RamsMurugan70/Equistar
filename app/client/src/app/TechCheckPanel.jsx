import React, { useEffect, useState } from 'react';
import {
  fetchEquityAdvice,
  previewEquityAdvice,
  ingestEquityAdvice,
  refreshEquityAdvice,
} from '../services/api';

// Equity tips pasted from the WhatsApp chat with the advisor.
//
// PASTE-BASED ON PURPOSE. Live automation (whatsapp-web.js / Baileys) can read the chat, but
// both are unofficial and Meta bans numbers for automation — losing the number would cost far
// more than the convenience is worth. Export or copy the chat, paste it here, and the parsing
// and tracking are identical to what a live feed would have produced.
//
// Tracking is against DAILY CLOSES because the advisor's stop is written on a closing basis
// ("Weak below 620 Clbs") — an intraday dip through the level that closes above it is not a
// stop-out, and using a live quote would fire false stops on every wick.
const money = (v) => (v == null ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const pct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v}%`);
const tone = (v) => (v == null ? '#1b1d28' : v >= 0 ? '#05664a' : '#dc2626');

const PLACEHOLDER = [
  "Paste the advisor's message(s) here, e.g.",
  '',
  'Kusumgar',
  'Adding cmp 650',
  'Weak below 620 Clbs',
  'Potential upside 680-710+',
  '',
  '(leave a blank line between separate tips)',
].join('\n');

export default function TechCheckPanel() {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const load = () => fetchEquityAdvice().then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function doPreview() {
    setError('');
    if (!text.trim()) return;
    try { setPreview((await previewEquityAdvice(text)).tips || []); }
    catch (e) { setError(e.message); }
  }

  async function doSave() {
    setBusy(true);
    setError('');
    try {
      const r = await ingestEquityAdvice(text);
      if (r.saved === 0 && r.duplicates > 0) {
        setError(`Already saved — ${r.duplicates} duplicate${r.duplicates > 1 ? 's' : ''} skipped.`);
      } else {
        setText('');
        setPreview(null);
      }
      load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function doRefresh() {
    setBusy(true);
    setError('');
    try { await refreshEquityAdvice(); load(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const tips = data?.tips || [];
  const s = data?.summary || {};

  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>💬 TechCheckByNiti</h2>
        <span style={{ fontSize: 12.5, color: '#565a6b' }}>
          Equity tips pasted from WhatsApp · entry / stop / target tracked against daily closes
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          <button
            type="button" onClick={() => setOpen(!open)}
            style={{
              background: open ? '#1355a8' : '#fff', color: open ? '#fff' : '#1b1d28',
              border: '1px solid #d6d9e0', borderRadius: 6, padding: '4px 12px',
              fontSize: 13, cursor: 'pointer', fontWeight: 600,
            }}
          >
            {open ? '− Close' : '+ Paste advice'}
          </button>
          <button
            type="button" onClick={doRefresh} disabled={busy}
            title="Re-check every open tip against the latest daily close"
            style={{
              background: '#fff', border: '1px solid #d6d9e0', borderRadius: 6,
              padding: '4px 12px', fontSize: 13, color: '#1b1d28',
              cursor: busy ? 'wait' : 'pointer',
            }}
          >
            ↻ Update prices
          </button>
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 12, padding: 12, background: '#f7f8fa', border: '1px solid #e4e6ea', borderRadius: 8 }}>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setPreview(null); }}
            placeholder={PLACEHOLDER}
            rows={8}
            style={{
              width: '100%', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13.5,
              padding: 10, border: '1px solid #d6d9e0', borderRadius: 6, resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <button
              type="button" onClick={doPreview} disabled={!text.trim()}
              style={{ background: '#fff', border: '1px solid #d6d9e0', borderRadius: 6, padding: '9px 16px', fontSize: 13.5, color: '#1b1d28', cursor: 'pointer' }}
            >
              Check what I understood
            </button>
            <button
              type="button" onClick={doSave} disabled={busy || !text.trim()}
              style={{ background: '#1355a8', color: '#fff', border: 'none', borderRadius: 6, padding: '9px 16px', fontSize: 13.5, fontWeight: 600, cursor: busy ? 'wait' : 'pointer' }}
            >
              {busy ? 'Saving…' : 'Save tips'}
            </button>
          </div>

          {/* Show what was understood BEFORE saving — a misread stock name is the one error
              that would quietly track the wrong company. */}
          {preview && preview.map((t, i) => (
            <div key={i} style={{ marginTop: 10, padding: 10, background: '#fff', border: '1px solid #e4e6ea', borderRadius: 6, fontSize: 13.5 }}>
              <strong style={{ color: t.symbol ? '#1b1d28' : '#9a5b06' }}>
                {t.symbol ? `${t.symbol} — ${t.matchedName}` : `"${t.stockText || '?'}" not recognised`}
              </strong>
              <div style={{ color: '#4b5563', marginTop: 3 }}>
                {t.action} · entry {money(t.entryLow)} · stop {money(t.stopLevel)}
                {t.stopClosingBasis ? ' (closing basis)' : ''}
                {' · target '}{money(t.targetLow)}
                {t.targetHigh ? `–${Number(t.targetHigh).toLocaleString('en-IN')}` : ''}
                {t.targetOpenEnded ? '+' : ''}
              </div>
              {(t.flags || []).filter((f) => f.level !== 'info').map((f, j) => (
                <div key={j} style={{ color: f.level === 'warn' ? '#b32d19' : '#9a5b06', fontSize: 12.5, marginTop: 2 }}>
                  ⚠ {f.message}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {error && <p className="negative" style={{ fontSize: 13.5 }}>{error}</p>}

      {tips.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', margin: '12px 0 6px', fontSize: 13 }}>
            <span><strong>{s.open ?? 0}</strong> open</span>
            <span><strong>{s.targetHit ?? 0}</strong> target hit</span>
            <span><strong>{s.stopHit ?? 0}</strong> stopped</span>
            {s.avgOpenReturnPct != null && (
              <span>avg open <strong style={{ color: tone(s.avgOpenReturnPct) }}>{pct(s.avgOpenReturnPct)}</strong></span>
            )}
            <span
              style={{ color: '#656974' }}
              title="A hit rate needs a real sample, so it stays hidden until at least 5 tips have resolved. Judging an advisor on two or three calls is noise."
            >
              hit rate {s.winRate != null ? `${s.winRate}%` : `— (${s.resolvedCount ?? 0}/5 resolved)`}
            </span>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="data-table compact-table" style={{ fontSize: 13.5 }}>
              <thead>
                <tr>
                  <th scope="col">Stock</th><th scope="col">Advised</th><th scope="col">Action</th>
                  <th scope="col" style={{ textAlign: 'right' }}>Entry</th>
                  <th scope="col" style={{ textAlign: 'right' }}>Stop</th>
                  <th scope="col" style={{ textAlign: 'right' }}>Target</th>
                  <th scope="col" style={{ textAlign: 'right' }}>CMP</th>
                  <th scope="col" style={{ textAlign: 'right' }}>Return</th>
                  <th scope="col" style={{ textAlign: 'right' }} title="How far above the stop the price currently sits">To Stop</th>
                  <th scope="col" style={{ textAlign: 'right' }} title="How far the price still has to travel to reach the target">To Target</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {tips.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <strong>{t.symbol || t.stockText}</strong>
                      {t.name && <div style={{ fontSize: 11.5, color: '#656974' }}>{t.name}</div>}
                      {!t.symbol && <div style={{ fontSize: 11.5, color: '#9a5b06' }}>unmapped</div>}
                    </td>
                    <td style={{ color: '#565a6b' }}>{t.advisedOn || '—'}</td>
                    <td>{t.action}</td>
                    <td style={{ textAlign: 'right' }}>{money(t.entry)}</td>
                    <td
                      style={{ textAlign: 'right' }}
                      title={t.stopClosingBasis
                        ? 'Closing basis — only a daily CLOSE below this counts as a stop, not an intraday dip'
                        : 'Intraday level'}
                    >
                      {money(t.stop)}
                      {t.stopClosingBasis ? <span style={{ fontSize: 11, color: '#656974' }}> clbs</span> : null}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {money(t.targetLow)}
                      {t.targetHigh ? `–${Number(t.targetHigh).toLocaleString('en-IN')}` : ''}
                      {t.targetOpenEnded ? '+' : ''}
                    </td>
                    <td style={{ textAlign: 'right' }}>{money(t.cmp)}</td>
                    <td style={{ textAlign: 'right', color: tone(t.returnPct), fontWeight: 600 }}>{pct(t.returnPct)}</td>
                    <td style={{ textAlign: 'right', color: t.toStopPct != null && t.toStopPct < 3 ? '#9a5b06' : '#565a6b' }}>
                      {pct(t.toStopPct)}
                    </td>
                    <td style={{ textAlign: 'right', color: '#565a6b' }}>{pct(t.toTargetPct)}</td>
                    <td>
                      {t.status === 'OPEN' ? (
                        <span style={{ background: '#e8f1fc', color: '#1355a8', borderRadius: 4, padding: '1px 7px', fontSize: 11.5, fontWeight: 700 }}>
                          OPEN
                        </span>
                      ) : (
                        <span
                          title={t.stopHitAt ? `Stop hit on ${t.stopHitAt} at ₹${t.stopHitPx}`
                            : t.targetHitAt ? `Target hit on ${t.targetHitAt} at ₹${t.targetHitPx}` : ''}
                          style={{
                            background: t.outcome === 'TARGET_HIT' ? '#e6f7f1' : '#fdecea',
                            color: t.outcome === 'TARGET_HIT' ? '#05664a' : '#b32d19',
                            borderRadius: 4, padding: '1px 7px', fontSize: 11.5, fontWeight: 700,
                          }}
                        >
                          {t.outcome === 'TARGET_HIT' ? 'TARGET' : t.outcome === 'STOP_HIT' ? 'STOPPED' : 'CLOSED'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tips.length === 0 && !error && (
        <p style={{ fontSize: 13.5, color: '#565a6b', marginTop: 10 }}>
          No tips saved yet. Click <strong>+ Paste advice</strong> and paste a message from the chat.
        </p>
      )}
    </section>
  );
}
