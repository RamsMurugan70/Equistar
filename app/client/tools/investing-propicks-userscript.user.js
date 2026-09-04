// ==UserScript==
// @name         ZTA-Equix — investing.com ProPicks sync
// @namespace    zta.equix
// @description  Reads the ProPicks "Picks History" (facts only) from the page you're
//               logged into and sends symbol/action/price/return/link to ZTA-Equix.
// @match        https://in.investing.com/pro/propicks/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      localhost
// @version      1.1
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';
  const ENDPOINT = 'http://localhost:5050/api/external-recs';

  // AUTO-SYNC IS REMEMBERED PER STRATEGY, keyed on this page's own path.
  //
  // It used to be one shared 'lastSyncDate' flag. That meant the first strategy page you opened
  // each day synced and stamped "done today" — and the other three then skipped their own
  // auto-sync in silence. Only the strategy you happened to open first stayed current, and the
  // Equix panel showed a single "synced <date>" that looked perfectly healthy either way. The
  // ProPicks page sat a month stale before anyone noticed.
  //
  // Keyed on pathname rather than the scraped strategy name because the path is available
  // immediately at load, while the heading is rendered by the SPA a moment later — the check and
  // the write have to agree on the key, so it has to be something present for both.
  const syncKey = () => `lastSyncDate:${location.pathname}`;

  const isNum = (s) => /^\d+$/.test(s);

  function scrapePicks() {
    const rows = [...document.querySelectorAll('.rt-tr')].filter((r) =>
      r.querySelector('a[href^="/pro/"]') && /₹/.test(r.textContent) && /(Added|Removed)/.test(r.textContent));

    const picks = [];
    for (const row of rows) {
      try {
        const link = row.querySelector('a[href^="/pro/"]');
        const href = link.getAttribute('href') || '';
        const m = href.match(/\/pro\/([A-Za-z]+):(.+)$/);
        if (!m) continue;
        const exRaw = m[1];
        const codeRaw = m[2];
        const exchange = exRaw === 'NSEI' ? 'NSE' : (exRaw === 'BSE' ? 'BSE' : exRaw);
        const symbol = exchange === 'NSE' ? codeRaw : null;   // only NSE gives a usable ticker

        const nameCell = link.closest('.rt-td') || link.parentElement;
        const leaves = [...nameCell.querySelectorAll('*')]
          .filter((e) => !e.children.length && e.textContent.trim())
          .map((e) => e.textContent.trim());
        const company = leaves.length > 1
          ? (isNum(leaves[1]) ? leaves[0] : leaves[1])
          : (leaves[0] || '');

        const cells = [...row.querySelectorAll('.rt-td')];
        const priceCell = cells.find((c) => c.textContent.trim().startsWith('₹'));
        if (!priceCell) continue;
        const priceAdded = parseFloat(priceCell.textContent.replace(/[₹,\s]/g, '')) || null;

        const returnCell = cells[cells.indexOf(priceCell) + 1];
        const returnText = (returnCell?.textContent || '').trim();
        const isLive = /live/i.test(returnText);
        const returnPct = isLive ? null : (parseFloat(returnText.replace(/[%,\s]/g, '')) || null);

        const actionCell = cells.find((c) => /^(Added|Removed)$/.test(c.textContent.trim()));
        const action = actionCell ? actionCell.textContent.trim() : null;

        picks.push({
          symbol, exchange, code: codeRaw, company, action,
          priceAdded, returnPct, isLive,
          stockUrl: 'https://in.investing.com' + href,
        });
      } catch (_) { /* skip malformed row */ }
    }
    return picks;
  }

  function strategyName() {
    const el = document.querySelector('h1, [class*="title"]');
    return (el && el.textContent.trim()) || 'ProPicks';
  }

  function asOfDate() {
    // The date shown next to "Picks History" (e.g. "1 Jul 2026").
    const el = [...document.querySelectorAll('*')].find((e) =>
      !e.children.length && /^\d{1,2}\s+[A-Za-z]{3}\s+20\d{2}$/.test((e.textContent || '').trim())
      && e.closest('*') && /Picks History/.test((e.closest('section,div')?.textContent) || ''));
    return el ? el.textContent.trim() : null;
  }

  function send(picks, manual) {
    if (!picks.length) { if (manual) toast('No picks found on this page yet — scroll to Picks History and retry.', false); return; }
    GM_xmlhttpRequest({
      method: 'POST',
      url: ENDPOINT,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ source: 'investing.com', strategy: strategyName(), asOfDate: asOfDate(), picks }),
      onload: (r) => {
        const ok = r.status >= 200 && r.status < 300;
        toast(ok ? `✓ Synced ${picks.length} picks to ZTA-Equix` : `Sync failed (${r.status})`, ok);
        if (ok) GM_setValue(syncKey(), new Date().toDateString());
      },
      onerror: () => toast('Could not reach ZTA-Equix (is the backend running on :5050?)', false),
    });
  }

  function runSync(manual) {
    // Picks render client-side — poll until rows appear (max ~15s).
    let tries = 0;
    const timer = setInterval(() => {
      const picks = scrapePicks();
      if (picks.length || tries++ > 30) {
        clearInterval(timer);
        send(picks, manual);
      }
    }, 500);
  }

  // ── tiny on-page toast + manual sync button ────────────────────────────────
  function toast(msg, ok) {
    const d = document.createElement('div');
    d.textContent = msg;
    Object.assign(d.style, {
      position: 'fixed', bottom: '70px', right: '20px', zIndex: 999999,
      background: ok ? '#166534' : '#991b1b', color: '#fff', padding: '10px 14px',
      borderRadius: '8px', fontSize: '13px', fontWeight: '600', boxShadow: '0 4px 14px rgba(0,0,0,.3)',
    });
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 4000);
  }

  const btn = document.createElement('button');
  btn.textContent = '⟳ Sync ProPicks → Equix';
  Object.assign(btn.style, {
    position: 'fixed', bottom: '20px', right: '20px', zIndex: 999999,
    background: '#b8ef43', color: '#08090a', border: 'none', borderRadius: '10px',
    padding: '10px 16px', fontWeight: '700', fontSize: '13px', cursor: 'pointer',
    boxShadow: '0 4px 14px rgba(0,0,0,.3)',
  });
  btn.onclick = () => runSync(true);
  window.addEventListener('load', () => document.body.appendChild(btn));

  // ── auto-sync once per strategy per day, when that strategy's tab is open ──
  window.addEventListener('load', () => {
    if (GM_getValue(syncKey(), '') !== new Date().toDateString()) {
      setTimeout(() => runSync(false), 4000);   // let the SPA render first
    }
  });
})();
