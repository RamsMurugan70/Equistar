import React, { useCallback, useEffect, useMemo, useState } from 'react';
import BrokerSetupPage from './BrokerSetupPage';
import { Link, NavLink, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import {
  fetchDashboard,
  fetchDashboardInsights,
  refreshCorpActions,
  fetchOrders,
  fetchOrdersMeta,
  fetchBuyEvaluatorReport,
  fetchSellEvaluation,
  fetchSellEvaluatorDates,
  fetchSellEvaluatorOptions,
  importOrderDownloads,
  fetchPortfolio,
  fetchAsOfReport,
  importPortfolioDownloads,
  fetchRecommendations,
  fetchPickerMatches,
  fetchSymbolTechnicals,
  fetchSymbol52wBatch,
  fetchPerformance,
  fetchInvestmentTrendReport,
  refreshScores,
  refreshAllScores,
  fetchLatestScores,
  fetchPortfolioEvolution,
  fetchDailySyncStatus,
  fetchCaptureCoverage,
  runDailySync,
  fetchBreezeLoginUrl,
  fetchKiteLoginUrl,
  uploadOrdersImport,
  uploadPortfolioImport,
  fetchKiteStatus,
  kiteExchangeToken,
  fetchKiteHoldings,
  saveKiteHoldings,
  revokeKiteSession,
  fetchBreezeStatus,
  breezeGenerateSession,
  fetchBreezeHoldings,
  saveBreezeHoldings,
  revokeBreezeSession,
  fetchBreezeOrders,
  saveBreezeOrders,
  fetchKiteOrders,
  saveKiteOrders,
  fetchLiveBreakdown,
  fetchCostBasisOverrides,
  importCostBasisOverrides,
  deleteCostBasisOverride,
  fetchIndustryScorecard,
  fetchNifty500Top,
  fetchExternalRecs,
  fetchNifty500Consistent,
  fetchNifty500StockPosition,
  fetchNifty500Symbols,
  fetchStockInsight,
  fetchSymbolHolding,
  fetchOrderImpact,
  startNifty500Scan,
  addRecommendation,
  askData,
  fetchAskDataStatus,
  fetchExitCandidates,
  fetchRsiBatch,
  fetchRankMovementBatch,
  fetchHeldSymbols,
  fetchHoldingPeriods,
} from '../services/api';
import { fileToText, parsePortfolioCSV, parseZerodhaOrders } from '../utils/importParsers';
import TechCheckPanel from './TechCheckPanel';

// ─────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────

function fmt(value, digits = 0) {
  return Number(value || 0).toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtPct(value, digits = 2) {
  if (value === null || value === undefined) return '-';
  const n = Number(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

/** Days between two ISO date strings (or date to today) */
function daysSince(dateStr) {
  if (!dateStr) return null;
  const ms = Date.now() - new Date(dateStr).getTime();
  return Math.floor(ms / 86400000);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const LTCG_DAYS = 365;
const STCG_WARNING_DAYS = 60; // within this many days of LTCG, show warning

/**
 * Generate a decision signal for a holding.
 * Returns { signal, urgency, reasons }
 * signal: 'EXIT' | 'TRIM' | 'WATCH' | 'HOLD' | 'ACCUMULATE'
 */
// Turns a bare "Score critically low (0)" into the actual data behind it:
// distinguishes a genuinely unscored stock from a real low score, breaks the
// combined score into its Technical/Fundamental/Momentum parts, and adds the
// stock's Nifty 500 rank when the scan has one for it.
function scoreDetail(holding, combined) {
  const status = holding.scores?.status;
  const tech = holding.scores?.technical?.value;
  const fund = holding.scores?.fundamental?.value;
  const mom  = holding.scores?.momentum?.value;
  const allZero = !tech && !fund && !mom && !combined;
  if (status === 'pending' || allZero) {
    return 'no health score yet — stock not yet covered by a scan';
  }
  const parts = [];
  if (tech != null) parts.push(`Tech ${tech}`);
  if (fund != null) parts.push(`Fund ${fund}`);
  if (mom  != null) parts.push(`Mom ${mom}`);
  let detail = `${combined}/100${parts.length ? ` (${parts.join(' · ')})` : ''}`;
  if (holding.n500Rank != null && holding.n500Total != null) {
    detail += ` · rank #${holding.n500Rank}/${holding.n500Total} in Nifty 500`;
  }
  return detail;
}

function generateSignal(holding) {
  const combined  = holding.scores?.combined?.value   ?? 0;
  const momentum  = holding.scores?.momentum?.value   ?? 0;
  const mm        = holding.momentumMetrics || {};
  const trend     = mm.trendStatus || '';
  const vs50      = mm.cmpVs50DmaPct   ?? null;
  const vs200     = mm.cmpVs200DmaPct  ?? null;
  const ret3m     = mm.return3M        ?? null;
  const dist52w   = mm.distanceFrom52WeekHighPct ?? null;
  // EMA metrics (faster than the DMA-based trend — used for EARLIER triggers)
  const ladder       = mm.emaLadder ?? null;          // STRONG_UPTREND / PULLBACK / DISTRIBUTION / DOWNTREND / MIXED
  const vs50Ema      = mm.cmpVs50EmaPct ?? null;
  const ema50Slope   = mm.ema50SlopePct ?? null;      // 10-session slope of the 50EMA, %
  const ema20Below50 = mm.ema20Below50 ?? null;       // bearish EMA cross state
  const daysBelow20  = mm.daysBelow20Ema ?? 0;

  const reasons = [];

  // ── EXIT ──
  // EMA confirmation trigger: price below a FALLING 50EMA with EMAs stacked
  // bearish — confirms the downtrend long before −25% vs 200DMA.
  const emaExit = ladder === 'DOWNTREND' && vs50Ema !== null && vs50Ema < 0
                  && ema50Slope !== null && ema50Slope < 0;
  if (
    trend === 'Breakdown' ||
    combined < 25 ||
    (vs200 !== null && vs200 < -25) ||
    (ret3m !== null && ret3m < -20) ||
    emaExit
  ) {
    if (trend === 'Breakdown')              reasons.push('Trend breakdown');
    if (combined < 25)                      reasons.push(`Score critically low: ${scoreDetail(holding, combined)}`);
    if (vs200 !== null && vs200 < -25)      reasons.push(`${(-vs200).toFixed(1)}% below 200DMA`);
    if (ret3m !== null && ret3m < -20)      reasons.push(`3M loss: ${(-ret3m).toFixed(1)}%`);
    if (emaExit)                            reasons.push(`Downtrend confirmed: below falling 50EMA (slope ${ema50Slope.toFixed(1)}%)`);
    return { signal: 'EXIT', urgency: 100, reasons };
  }

  // ── TRIM ──
  // EMA early trigger: 20EMA crossed below 50EMA while the trend is cracking —
  // fires well before the price is 12% under the 50DMA.
  const emaTrim = ema20Below50 === true && (ladder === 'DISTRIBUTION' || ladder === 'DOWNTREND' || ladder === 'MIXED');
  if (
    combined < 40 ||
    (vs50 !== null && vs50 < -12) ||
    (ret3m !== null && ret3m < -12) ||
    emaTrim
  ) {
    if (combined < 40)                      reasons.push(`Weak score: ${scoreDetail(holding, combined)}`);
    if (vs50 !== null && vs50 < -12)        reasons.push(`${(-vs50).toFixed(1)}% below 50DMA`);
    if (ret3m !== null && ret3m < -12)      reasons.push(`3M loss: ${(-ret3m).toFixed(1)}%`);
    if (emaTrim)                            reasons.push('20EMA crossed below 50EMA (dip confirmed)');
    // Longer below the EMA = more entrenched = more urgent
    const urgency = 70 + Math.min(mm.daysBelow50Ema ?? 0, 20);
    return { signal: 'TRIM', urgency, reasons };
  }

  // ── WATCH ──
  // EMA early warning: price has just slipped under its 20EMA (the first crack),
  // or the ladder shows a pullback within an uptrend.
  const emaWatch = (daysBelow20 >= 1 && daysBelow20 <= 15) || ladder === 'PULLBACK' || ladder === 'DISTRIBUTION';
  if (
    combined < 52 ||
    (vs50 !== null && vs50 < -5) ||
    trend === 'Sideways' ||
    trend === 'Caution' ||
    emaWatch
  ) {
    if (combined < 52)                      reasons.push(`Below-avg score: ${scoreDetail(holding, combined)}`);
    if (vs50 !== null && vs50 < -5)         reasons.push(`${(-vs50).toFixed(1)}% below 50DMA`);
    if (trend === 'Sideways' || trend === 'Caution') reasons.push(`Trend: ${trend}`);
    if (ladder === 'PULLBACK')              reasons.push('Pullback within uptrend (below 20EMA, above 50EMA)');
    else if (ladder === 'DISTRIBUTION')     reasons.push('Distribution: uptrend cracking (below 50EMA)');
    else if (daysBelow20 >= 1)              reasons.push(`Below 20EMA for ${daysBelow20} day${daysBelow20 > 1 ? 's' : ''} (early warning)`);
    return { signal: 'WATCH', urgency: 40 + Math.min(daysBelow20, 10), reasons };
  }

  // ── ACCUMULATE ──
  if (
    combined >= 68 &&
    (trend === 'Strong Uptrend' || trend === 'Uptrend') &&
    vs50 !== null && vs50 >= -3 && vs50 <= 12
  ) {
    reasons.push(`Strong score (${combined})`);
    reasons.push(trend);
    if (vs50 !== null) reasons.push(`Near 50DMA (${vs50 >= 0 ? '+' : ''}${vs50.toFixed(1)}%)`);
    return { signal: 'ACCUMULATE', urgency: 30, reasons };
  }

  // ── HOLD ──
  if (combined >= 60) reasons.push(`Good score (${combined})`);
  else                reasons.push(`Score ${combined}`);
  if (trend)          reasons.push(trend);
  if (vs50 !== null)  reasons.push(`${vs50 >= 0 ? '+' : ''}${vs50.toFixed(1)}% vs 50DMA`);
  return { signal: 'HOLD', urgency: 0, reasons };
}

// Differentiated 0–100 severity score for an EXIT-flagged holding — every EXIT
// from generateSignal() shares a flat urgency=100, so this breaks the tie using
// the same underlying data (how far below DMA, how weak the score, how deep the
// 3M loss, whether the downtrend is EMA-confirmed) so the worst names sort first.
function computeExitScore(holding) {
  const combined = holding.scores?.status !== 'pending' ? holding.scores?.combined?.value : null;
  const mm = holding.momentumMetrics || {};
  const trend = mm.trendStatus || '';
  const vs50 = mm.cmpVs50DmaPct ?? null;
  const vs200 = mm.cmpVs200DmaPct ?? null;
  const ret3m = mm.return3M ?? null;
  const ladder = mm.emaLadder ?? null;
  const vs50Ema = mm.cmpVs50EmaPct ?? null;
  const ema50Slope = mm.ema50SlopePct ?? null;
  const emaConfirmed = ladder === 'DOWNTREND' && vs50Ema !== null && vs50Ema < 0 && ema50Slope !== null && ema50Slope < 0;

  let score = 0;
  if (trend === 'Breakdown')        score += 25;
  if (emaConfirmed)                 score += 20;
  if (combined != null)             score += Math.max(0, Math.min(30, (40 - combined) * 0.75));   // 0/100 → +30, 40/100 → 0
  if (vs200 != null && vs200 < 0)   score += Math.max(0, Math.min(30, -vs200));                    // 30%+ below 200DMA → +30 cap
  if (ret3m != null && ret3m < 0)   score += Math.max(0, Math.min(15, -ret3m * 0.75));              // 20%+ 3M loss → +15 cap
  if (vs50 != null && vs50 < 0)     score += Math.max(0, Math.min(10, -vs50 * 0.3));                // small extra weight

  return Math.round(Math.min(100, score));
}

// ── EMA trend-ladder badge (shared: Action Queue + Portfolio Health) ─────────
const EMA_LADDER_STYLE = {
  STRONG_UPTREND: { bg: '#dcfce7', fg: '#166534', label: 'Strong uptrend' },
  PULLBACK:       { bg: '#e8f1fc', fg: '#1355a8', label: 'Pullback (dip)' },
  DISTRIBUTION:   { bg: '#fef6e7', fg: '#9a5b06', label: 'Distribution' },
  DOWNTREND:      { bg: '#fdecea', fg: '#b32d19', label: 'Downtrend' },
  MIXED:          { bg: '#e4e6ea', fg: '#565a6b', label: 'Mixed' },
};

function EmaLadderBadge({ ladder, slope }) {
  if (!ladder) return <span style={{ color: '#656974' }}>-</span>;
  const s = EMA_LADDER_STYLE[ladder] || EMA_LADDER_STYLE.MIXED;
  const arrow = slope == null ? '' : slope > 0.3 ? ' ▲' : slope < -0.3 ? ' ▼' : ' →';
  return (
    <span
      title={`EMA ladder: price vs 20/50/200 EMA stack. 50EMA 10-day slope: ${slope == null ? 'n/a' : `${slope.toFixed(2)}%`}`}
      style={{ background: s.bg, color: s.fg, borderRadius: 6, padding: '4px 10px',
               fontSize: '0.78rem', fontWeight: 700, whiteSpace: 'nowrap' }}>
      {s.label}{arrow}
    </span>
  );
}

const SIGNAL_ORDER = ['EXIT', 'TRIM', 'WATCH', 'ACCUMULATE', 'HOLD'];
const SIGNAL_LABELS = {
  EXIT:       '🔴 Exit',
  TRIM:       '🟠 Trim',
  WATCH:      '🟡 Watch',
  HOLD:       '🟢 Hold',
  ACCUMULATE: '💎 Add',
};

/**
 * Investment verdict for the Portfolio page (long-term buy/hold/add framing).
 * Distinct from the Action Queue's intraday trading signals.
 * Inputs: holding + its portfolio weight %. Returns { verdict, reasons }.
 *   ADD    – strong, trending up, room to add (underweight)
 *   HOLD   – healthy, no action
 *   TRIM   – over-concentrated (risk), regardless of score
 *   REVIEW – weak score / breakdown / unscored
 */
function portfolioVerdict(h, weightPct) {
  const c     = h.scores?.combined?.value ?? 0;
  const trend = h.momentumMetrics?.trendStatus || '';
  const vs200 = h.momentumMetrics?.cmpVs200DmaPct;
  const reasons = [];

  if (h.tradeable === false || !c) {
    return { verdict: 'REVIEW', reasons: ['Not scored — unlisted / illiquid / no data'] };
  }
  // Concentration risk takes precedence over everything
  if (weightPct >= 15) {
    reasons.push(`${weightPct.toFixed(0)}% of portfolio — over-concentrated`);
    if (c < 50) reasons.push(`and only moderate score (${c})`);
    return { verdict: 'TRIM', reasons };
  }
  // Weak quality → review (candidate to exit). A breakdown only forces a review
  // when quality is also sub-par; a strong name in a temporary breakdown is a Hold.
  if (c < 40 || (trend === 'Breakdown' && c < 50)) {
    if (c < 40)              reasons.push(`Weak score: ${scoreDetail(h, c)}`);
    if (trend === 'Breakdown') reasons.push('Trend breakdown');
    if (vs200 != null && vs200 < 0) reasons.push(`${vs200.toFixed(0)}% below 200DMA`);
    return { verdict: 'REVIEW', reasons };
  }
  // Add candidate: strong + uptrend + room to add
  if (c >= 60 && trend.includes('Uptrend') && weightPct < 8) {
    reasons.push(`Strong score (${c})`, trend, `underweight (${weightPct.toFixed(1)}%)`);
    return { verdict: 'ADD', reasons };
  }
  // Otherwise hold
  reasons.push(`Score ${c}`, trend || '—', `${weightPct.toFixed(1)}% weight`);
  return { verdict: 'HOLD', reasons };
}

const VERDICT_STYLE = {
  ADD:    { bg: '#e8f1fc', color: '#1355a8', label: '➕ Add' },
  HOLD:   { bg: '#dcfce7', color: '#166534', label: '✓ Hold' },
  TRIM:   { bg: '#ffedd5', color: '#9a3412', label: '✂ Trim' },
  REVIEW: { bg: '#fdecea', color: '#b32d19', label: '⚠ Review' },
};
function VerdictBadge({ verdict, reasons }) {
  const s = VERDICT_STYLE[verdict] || VERDICT_STYLE.HOLD;
  return (
    <span title={(reasons || []).join(' · ')}
      style={{ background: s.bg, color: s.color, padding: '2px 9px', borderRadius: 12,
               fontSize: '0.74rem', fontWeight: 700, whiteSpace: 'nowrap', cursor: 'help' }}>
      {s.label}
    </span>
  );
}

// Fetches both portfolios' overview data plus the live held-symbols cross-check in
// one shot — Action Queue and Dashboard both independently re-did this same
// Promise.all + fetchHeldSymbols call on mount. Callers that also need per-portfolio
// orders (e.g. LTCG Tracker) still fetch those separately.
function useBothPortfolios() {
  const [ramsData,    setRamsData]    = useState(null);
  const [geethaData,  setGeethaData]  = useState(null);
  const [heldSymbols, setHeldSymbols] = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchPortfolio('Rams'), fetchPortfolio('Geetha')])
      .then(([r, g]) => {
        setRamsData(r);
        setGeethaData(g);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
    fetchHeldSymbols().then(setHeldSymbols).catch(() => {});
  }, []);

  return { ramsData, geethaData, heldSymbols, loading, error };
}

// Rams/Geetha portfolio-tag badge — shared across Exit Candidates, LTCG Tracker,
// and Trades Performance panel, which previously each hand-rolled the same
// purple/lime color ternary. `style` merges in per-site size/spacing overrides.
function PortfolioBadge({ portfolio, style }) {
  return (
    <span style={{
      fontSize: 11.5, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
      background: portfolio === 'Geetha' ? 'rgba(139,92,246,0.15)' : 'rgba(184,239,67,0.12)',
      color:      portfolio === 'Geetha' ? '#1355a8'               : 'var(--lime)',
      ...style,
    }}>{portfolio}</span>
  );
}

/**
 * FIFO lot computation.
 * orders: array of { portfolio, symbol, side, trade_date, quantity, price }
 * Returns Map<"portfolio::symbol", { date, qty, price }[]>
 */
function computeOpenLots(orders) {
  const map = new Map();

  const sorted = [...orders].sort((a, b) =>
    (a.trade_date || '').localeCompare(b.trade_date || ''),
  );

  for (const order of sorted) {
    const key = `${order.portfolio}::${order.symbol}`;
    if (!map.has(key)) map.set(key, []);
    const lots = map.get(key);
    const qty = Number(order.quantity || 0);
    const price = Number(order.price || 0);
    const side = String(order.side || '').toUpperCase();

    if (side === 'BUY' || side === 'B') {
      lots.push({ date: order.trade_date, qty, price });
    } else if (side === 'SELL' || side === 'S') {
      let remaining = qty;
      while (remaining > 0 && lots.length > 0) {
        if (lots[0].qty <= remaining) {
          remaining -= lots[0].qty;
          lots.shift();
        } else {
          lots[0].qty -= remaining;
          remaining = 0;
        }
      }
    }
  }

  return map;
}

// ─────────────────────────────────────────
// SHARED COMPONENTS
// ─────────────────────────────────────────

function PageShell({ title, subtitle, children, actions }) {
  return (
    <section className="page-shell">
      <div className="page-header">
        <div>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions && <div>{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function StatCard({ label, value, helper, tone }) {
  return (
    <article className="stat-card">
      <span className="stat-label">{label}</span>
      <strong className={`stat-value${tone ? ` ${tone}` : ''}`}>{value}</strong>
      {helper ? <span className="stat-helper">{helper}</span> : null}
    </article>
  );
}

function ScorePill({ value, label }) {
  let tone = 'score-neutral';
  if (value >= 70)      tone = 'score-strong';
  else if (value >= 40) tone = 'score-medium';
  else if (value > 0)   tone = 'score-weak';
  return (
    <span className={`score-pill ${tone}`}>
      {value} <small>{label}</small>
    </span>
  );
}

function SignalBadge({ signal }) {
  return (
    <span className={`signal-badge signal-${signal}`}>
      {SIGNAL_LABELS[signal] || signal}
    </span>
  );
}

function TaxBadge({ days }) {
  if (days === null || days === undefined) return <span className="tax-badge tax-unknown">No data</span>;
  if (days >= LTCG_DAYS) return <span className="tax-badge tax-ltcg">LTCG ✓</span>;
  const daysLeft = LTCG_DAYS - days;
  if (daysLeft <= STCG_WARNING_DAYS) return <span className="tax-badge tax-stcg-soon">{daysLeft}d to LTCG</span>;
  return <span className="tax-badge tax-stcg">STCG · {daysLeft}d left</span>;
}

function DaysBar({ days }) {
  if (days === null || days === undefined) return null;
  const pct = Math.min((days / LTCG_DAYS) * 100, 100);
  const isLtcg = days >= LTCG_DAYS;
  return (
    <div className="days-bar-wrap">
      <div className="days-bar-track">
        <div
          className={`days-bar-fill${isLtcg ? ' ltcg' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span style={{ fontSize: '0.78rem', color: '#5b7060', minWidth: 28 }}>{days}d</span>
    </div>
  );
}

function getCrossSignal(dma50, dma200) {
  if (dma50 == null || dma200 == null) return null;
  return Number(dma50) > Number(dma200) ? 'golden' : 'death';
}

function CrossBadge({ dma50, dma200 }) {
  const signal = getCrossSignal(dma50, dma200);
  if (!signal) return <span>-</span>;
  return (
    <span className={`cross-badge cross-${signal}`}>
      {signal === 'golden' ? '☀ Golden Cross' : '☠ Death Cross'}
    </span>
  );
}

function HoldingDetailsModal({ holding, onClose }) {
  if (!holding) return null;
  const rows = [
    ['Portfolio',            holding.portfolio],
    ['Symbol',               holding.symbol],
    ['Snapshot Date',        holding.snapshotDate || '-'],
    ['Sector',               holding.sector || '-'],
    ['Industry',             holding.industry || '-'],
    ['Quantity',             fmt(holding.quantity)],
    ['Average Cost',         fmt(holding.avgCost, 2)],
    ['LTP',                  fmt(holding.ltp, 2)],
    ['Invested',             fmt(holding.invested)],
    ['Current Value',        fmt(holding.currentValue)],
    ['P&L',                  fmt(holding.pnl)],
    ['Net Change %',         `${fmt(holding.netChangePct, 2)}%`],
    ['Day Change %',         `${fmt(holding.dayChangePct, 2)}%`],
    ['50DMA',                holding.momentumMetrics?.dma50 == null ? '-' : fmt(holding.momentumMetrics.dma50, 2)],
    ['200DMA',               holding.momentumMetrics?.dma200 == null ? '-' : fmt(holding.momentumMetrics.dma200, 2)],
    ['CMP vs 50DMA %',       holding.momentumMetrics?.cmpVs50DmaPct == null ? '-' : `${fmt(holding.momentumMetrics.cmpVs50DmaPct, 2)}%`],
    ['CMP vs 200DMA %',      holding.momentumMetrics?.cmpVs200DmaPct == null ? '-' : `${fmt(holding.momentumMetrics.cmpVs200DmaPct, 2)}%`],
    ['52W High Distance %',  holding.momentumMetrics?.distanceFrom52WeekHighPct == null ? '-' : `${fmt(holding.momentumMetrics.distanceFrom52WeekHighPct, 2)}%`],
    ['3M Return %',          holding.momentumMetrics?.return3M == null ? '-' : `${fmt(holding.momentumMetrics.return3M, 2)}%`],
    ['Trend Status',         holding.momentumMetrics?.trendStatus || '-'],
    ['MA Cross',             (() => { const s = getCrossSignal(holding.momentumMetrics?.dma50, holding.momentumMetrics?.dma200); return s === 'golden' ? '☀ Golden Cross' : s === 'death' ? '☠ Death Cross' : '-'; })()],
    ['Momentum Score',       `${holding.scores.momentum.value} (${holding.scores.momentum.label})`],
    ['Fundamental Score',    `${holding.scores.fundamental.value} (${holding.scores.fundamental.label})`],
    ['Combined Score',       `${holding.scores.combined.value} (${holding.scores.combined.label})`],
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>{holding.symbol}</h2>
            <p>{holding.portfolio}{holding.snapshotDate ? ` · ${holding.snapshotDate}` : ''}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose}>Close</button>
        </div>
        <table className="data-table compact-table">
          <thead><tr><th scope="col">Field</th><th scope="col">Value</th></tr></thead>
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <td>{label}</td>
                <td className={label === 'P&L' ? (holding.pnl >= 0 ? 'positive' : 'negative') : ''}>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// ACTION QUEUE PAGE
// ─────────────────────────────────────────

const AQ_SORT_GETTERS = {
  urgency:                   (h) => h.urgency,
  symbol:                    (h) => h.symbol,
  combined:                  (h) => h.scores?.combined?.value ?? 0,
  trendStatus:               (h) => h.momentumMetrics?.trendStatus || '',
  return3M:                  (h) => h.momentumMetrics?.return3M ?? -Infinity,
  distanceFrom52WeekHighPct: (h) => h.momentumMetrics?.distanceFrom52WeekHighPct ?? -Infinity,
  high52Week:                (h) => h.momentumMetrics?.high52Week ?? 0,
  dma50:                     (h) => h.momentumMetrics?.dma50 ?? 0,
  dma200:                    (h) => h.momentumMetrics?.dma200 ?? 0,
  pnl:                       (h) => h.pnl ?? 0,
  pnlPct:                    (h) => h.invested > 0 ? (h.pnl / h.invested) * 100 : 0,
  value:                     (h) => h.currentValue ?? 0,
  crossSignal:               (h) => { const s = getCrossSignal(h.momentumMetrics?.dma50, h.momentumMetrics?.dma200); return s === 'golden' ? 1 : s === 'death' ? -1 : 0; },
};

const AQ_WINDOWS = [
  { label: '1 Week',   days: 7 },
  { label: '1 Month',  days: 30 },
  { label: '3 Months', days: 90 },
  { label: '6 Months', days: 180 },
];

// Shared mini table renderer used by ExitCandidatesTab for both the "today" and
// "consistency" sections. Hoisted to module scope (was defined inside the component
// body) so React treats it as a stable component type across renders instead of
// remounting its subtree — e.g. row hover state — on every parent re-render.
function BottomTable({ rows, showConsistency = false }) {
  return (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ background: 'var(--bg-elevated)', borderBottom: '2px solid var(--border-md)' }}>
              {['#', 'Symbol', 'Holding', 'Score', 'EMA', '1M Ret', '3M Ret', 'CMP', 'Avg Cost',
                ...(showConsistency ? ['In Bottom 25', 'Urgency'] : [])
              ].map((h) => (
                <th scope="col" key={h} style={{ padding: '11px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap', fontSize: 13 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => {
              const urgencyPct   = c.appearance_pct ?? null;
              const urgencyColor = urgencyPct == null ? 'var(--text-muted)' : urgencyPct >= 80 ? '#b32d19' : urgencyPct >= 50 ? '#9a5b06' : '#9a5b06';
              return (
                <tr key={c.symbol} style={{ borderBottom: '1px solid var(--border)', background: c.held || c.portfolios?.length ? 'rgba(196, 53, 31,0.06)' : 'transparent' }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-elevated)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = c.held || c.portfolios?.length ? 'rgba(196, 53, 31,0.06)' : 'transparent'}>
                  <td style={{ padding: '11px 16px', color: 'var(--text-muted)', fontSize: 12.5 }}>#{c.rank ?? i + 1}</td>
                  <td style={{ padding: '11px 16px' }}>
                    <span style={{ fontWeight: 700, color: (c.held || c.portfolios?.length) ? '#b32d19' : 'var(--text-primary)' }}>{c.symbol}</span>
                    {c.name && <span style={{ fontSize: 11.5, color: 'var(--text-muted)', display: 'block' }}>{c.name}</span>}
                  </td>
                  <td style={{ padding: '11px 16px' }}>
                    {(c.portfolios?.length > 0) ? (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {c.portfolios.map((p) => (
                          <PortfolioBadge key={p} portfolio={p} />
                        ))}
                        {c.held_qty > 0 && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{c.held_qty} qty</span>}
                      </div>
                    ) : <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>Not held</span>}
                  </td>
                  <td style={{ padding: '11px 16px', fontWeight: 600, color: (c.combined_score ?? 0) < 30 ? '#b32d19' : (c.combined_score ?? 0) < 50 ? '#9a5b06' : 'var(--text-secondary)' }}>
                    {c.combined_score != null ? c.combined_score.toFixed(1) : '—'}
                  </td>
                  <td style={{ padding: '11px 16px', fontSize: 12.5, color: 'var(--text-muted)' }}>{c.ema_ladder || '—'}</td>
                  <td style={{ padding: '11px 16px', fontWeight: 600, color: c.r1m == null ? 'var(--text-muted)' : c.r1m >= 0 ? '#05664a' : '#b32d19' }}>
                    {c.r1m != null ? `${c.r1m >= 0 ? '+' : ''}${c.r1m.toFixed(1)}%` : '—'}
                  </td>
                  <td style={{ padding: '11px 16px', fontWeight: 600, color: c.r3m == null ? 'var(--text-muted)' : c.r3m >= 0 ? '#05664a' : '#b32d19' }}>
                    {c.r3m != null ? `${c.r3m >= 0 ? '+' : ''}${c.r3m.toFixed(1)}%` : '—'}
                  </td>
                  <td style={{ padding: '11px 16px', color: 'var(--text-secondary)' }}>{c.cmp ? `₹${fmt(c.cmp, 2)}` : '—'}</td>
                  <td style={{ padding: '11px 16px', color: 'var(--text-secondary)' }}>{c.avg_cost ? `₹${fmt(c.avg_cost, 2)}` : '—'}</td>
                  {showConsistency && <>
                    <td style={{ padding: '11px 16px' }}>
                      {urgencyPct != null ? (
                        <div>
                          <span style={{ fontWeight: 700, color: urgencyColor }}>{c.appearances}/{c.total_days}</span>
                          <span style={{ fontSize: 12.5, color: 'var(--text-muted)', marginLeft: 4 }}>({urgencyPct}%)</span>
                          <div style={{ width: 60, height: 3, background: 'var(--bg-elevated)', borderRadius: 2, marginTop: 3 }}>
                            <div style={{ width: `${urgencyPct}%`, height: '100%', background: urgencyColor, borderRadius: 2 }} />
                          </div>
                        </div>
                      ) : '—'}
                    </td>
                    <td style={{ padding: '11px 16px' }}>
                      {urgencyPct != null && (
                        <span style={{ fontSize: 12.5, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                          background: urgencyPct >= 80 ? 'rgba(196, 53, 31,0.15)' : urgencyPct >= 50 ? 'rgba(251,146,60,0.15)' : 'rgba(154, 91, 6,0.15)',
                          color:      urgencyPct >= 80 ? '#b32d19'               : urgencyPct >= 50 ? '#9a5b06'               : '#9a5b06' }}>
                          {urgencyPct >= 80 ? '🔴 High' : urgencyPct >= 50 ? '🟠 Medium' : '🟡 Low'}
                        </span>
                      )}
                    </td>
                  </>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
  );
}

function ExitCandidatesTab() {
  const [windowDays, setWindow]    = useState(30);
  const [data,      setData]      = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');
  const [selected,  setSelected]  = useState(null);

  const load = (days) => {
    setLoading(true); setError('');
    fetchExitCandidates(days)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(windowDays); }, [windowDays]);

  const candidates   = data?.candidates   || [];
  const todayBottom  = data?.today_bottom || [];
  const windowMeta   = AQ_WINDOWS.find((w) => w.days === windowDays);
  const scanDate     = todayBottom[0]?.scan_date || null;

  return (
    <div>
      <HoldingDetailsModal holding={selected} onClose={() => setSelected(null)} />

      {/* Window selector */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, color: 'var(--text-secondary)', marginRight: 4 }}>Consistency window:</span>
        <div style={{ display: 'flex', gap: 6, background: 'var(--bg-elevated)', borderRadius: 8, padding: 4 }}>
          {AQ_WINDOWS.map(({ label, days }) => (
            <button key={days} onClick={() => setWindow(days)}
              style={{
                padding: '5px 14px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                background: windowDays === days ? 'var(--lime)' : 'transparent',
                color:      windowDays === days ? '#ffffff'     : 'var(--text-secondary)',
              }}>
              {label}
            </button>
          ))}
        </div>
        <button onClick={() => load(windowDays)}
          style={{ background: 'none', border: '1px solid var(--border-md)', borderRadius: 8, padding: '5px 12px', fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          ↻ Refresh
        </button>
        {data && <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 4 }}>
          {data.total_held} held · scan {scanDate || '—'}
        </span>}
      </div>

      {loading && <p style={{ color: 'var(--text-muted)' }}>Loading exit candidates…</p>}
      {error   && <p style={{ color: '#b32d19' }}>Error: {error}</p>}

      {!loading && !error && <>

        {/* ── Section 1: Today's Bottom 25 ───────────────────────────────── */}
        <div className="panel" style={{ marginBottom: 20, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-md)', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: '1rem' }}>
              📅 My Holdings — Ranked by Today's Scan {scanDate && <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>({scanDate})</span>}
            </h2>
            {todayBottom.length > 0 && (
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                {todayBottom.length} of {data?.total_held} held stocks found in scan · worst rank first
              </span>
            )}
            {!scanDate && <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>No scan data — run the Nifty 500 scan first</span>}
          </div>
          {todayBottom.length > 0 ? <BottomTable rows={todayBottom} /> : (
            <p style={{ padding: '20px 18px', color: 'var(--text-muted)', fontSize: 14 }}>
              No scan data available. Run the Nifty 500 daily scan from the Recommendations page.
            </p>
          )}
        </div>

        {/* ── Section 2: Consistency over window ─────────────────────────── */}
        <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-md)', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: '1rem' }}>📊 Consistent Bottom 25 — last {windowMeta?.label}</h2>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              Your held stocks that appeared in the bottom 25 most days in the window
            </span>
          </div>
          {candidates.length > 0 ? <BottomTable rows={candidates} showConsistency /> : (
            <div style={{ padding: '18px 20px', display: 'flex', alignItems: 'flex-start', gap: 16,
              background: 'rgba(154, 91, 6,0.08)', borderTop: '1px solid rgba(154, 91, 6,0.2)' }}>
              <span style={{ fontSize: 22, lineHeight: 1 }}>⚠️</span>
              <div>
                <p style={{ margin: '0 0 4px', fontWeight: 600, color: '#9a5b06', fontSize: 14 }}>
                  Not enough historical data to generate this list
                </p>
                <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
                  {data?.total_held === 0
                    ? 'No portfolio holdings found — upload your portfolio CSV on the Portfolio page first.'
                    : `The consistency report needs daily scan history. It will populate automatically after the scan runs for a few days. Today's ranking is shown above.`}
                </p>
              </div>
            </div>
          )}
        </div>
      </>}

    </div>
  );
}

function ActionQueuePage() {
  const [activeTab,    setActiveTab]    = useState('signals');
  const { ramsData, geethaData, heldSymbols, loading, error } = useBothPortfolios();
  const [filter,       setFilter]       = useState('ALL');
  const [signalFilter, setSignalFilter] = useState('ALL');
  const [sortBy,       setSortBy]       = useState('urgency');
  const [sortDir,      setSortDir]      = useState('desc');
  const [selected,     setSelected]     = useState(null);

  const allHoldings = useMemo(() => {
    const r = (ramsData?.currentHoldings || []).map((h) => ({ ...h, portfolio: 'Rams' }));
    const g = (geethaData?.currentHoldings || []).map((h) => ({ ...h, portfolio: 'Geetha' }));
    return [...r, ...g];
  }, [ramsData, geethaData]);

  // Separate non-tradeable (suspended / unlisted) from tradeable holdings
  const nonTradeable = useMemo(() =>
    allHoldings.filter((h) => h.tradeable === false),
  [allHoldings]);

  // Is this row ACTUALLY still held, per the orders table (always current) rather than
  // the possibly-stale qty field from the last saved portfolio snapshot? If we haven't
  // loaded heldSymbols yet, don't block on it — fall back to the qty field so the page
  // still works before that request lands.
  function isReallyHeld(h) {
    if (!heldSymbols) return Number(h.quantity) > 0;
    const set = heldSymbols[h.portfolio];
    if (!set) return Number(h.quantity) > 0;
    return set.includes((h.nseSymbol || h.symbol || '').toUpperCase());
  }

  const enriched = useMemo(() =>
    allHoldings
      // Fully-sold positions can still show qty > 0 here if the portfolio snapshot
      // (which holdings' qty comes from) hasn't been re-saved since the sale — cross-check
      // against the orders table (always current) instead of trusting the snapshot alone.
      .filter((h) => h.tradeable !== false && isReallyHeld(h))
      .map((h) => ({ ...h, ...generateSignal(h) })),
  [allHoldings, heldSymbols]);

  const filtered = useMemo(() => {
    return enriched.filter((h) => {
      if (filter !== 'ALL' && h.portfolio !== filter) return false;
      if (signalFilter !== 'ALL' && h.signal !== signalFilter) return false;
      return true;
    });
  }, [enriched, filter, signalFilter]);

  const grouped = useMemo(() => {
    const getter = AQ_SORT_GETTERS[sortBy] || AQ_SORT_GETTERS.urgency;
    const dir = sortDir === 'asc' ? 1 : -1;
    const groups = {};
    for (const s of SIGNAL_ORDER) groups[s] = [];
    for (const h of filtered) {
      if (groups[h.signal]) groups[h.signal].push(h);
    }
    for (const s of SIGNAL_ORDER) {
      groups[s].sort((a, b) => {
        const av = getter(a), bv = getter(b);
        if (typeof av === 'string') return dir * av.localeCompare(bv);
        return dir * (av - bv);
      });
    }
    return groups;
  }, [filtered, sortBy, sortDir]);

  const counts = useMemo(() => {
    const c = {};
    for (const s of SIGNAL_ORDER) c[s] = enriched.filter((h) => h.signal === s).length;
    return c;
  }, [enriched]);

  if (loading) return <PageShell title="Action Queue" subtitle="Loading both portfolios…"><p>Loading…</p></PageShell>;
  if (error)   return <PageShell title="Action Queue" subtitle="Decision signals"><p className="negative">{error}</p></PageShell>;

  return (
    <PageShell
      title="Action Queue"
      subtitle={activeTab === 'signals'
        ? `Ranked decision signals across Rams + Geetha · ${enriched.length} tradeable holdings${nonTradeable.length ? ` · ${nonTradeable.length} not tradeable` : ''}`
        : 'Held stocks consistently ranked in the Nifty 500 bottom 25 — rank-based exit signals'}
    >
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 6, background: 'var(--bg-elevated)', borderRadius: 10, padding: 5, marginBottom: 20, width: 'fit-content' }}>
        {[['signals', '⚡ Portfolio Signals'], ['exit', '🔴 Exit Candidates']].map(([id, label]) => (
          <button key={id} onClick={() => setActiveTab(id)}
            style={{
              padding: '7px 18px', borderRadius: 7, border: 'none', fontWeight: 700, fontSize: 14, cursor: 'pointer',
              background: activeTab === id ? (id === 'exit' ? '#b32d19' : 'var(--lime)') : 'transparent',
              color:      activeTab === id ? '#ffffff' : 'var(--text-secondary)',
            }}>
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'exit' && <ExitCandidatesTab />}

      {activeTab === 'signals' && <>
      <HoldingDetailsModal holding={selected} onClose={() => setSelected(null)} />

      {/* Summary stat cards */}
      <div className="stats-grid">
        {SIGNAL_ORDER.map((s) => (
          <StatCard
            key={s}
            label={SIGNAL_LABELS[s]}
            value={counts[s]}
            helper={`stocks`}
          />
        ))}
      </div>

      {/* Filters */}
      <div className="filters">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="ALL">Both portfolios</option>
          <option value="Rams">Rams only</option>
          <option value="Geetha">Geetha only</option>
        </select>
        <select value={signalFilter} onChange={(e) => setSignalFilter(e.target.value)}>
          <option value="ALL">All signals</option>
          {SIGNAL_ORDER.map((s) => (
            <option key={s} value={s}>{SIGNAL_LABELS[s]}</option>
          ))}
        </select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          <option value="urgency">Sort: Default (urgency)</option>
          <option value="symbol">Sort: Symbol</option>
          <option value="combined">Sort: Score</option>
          <option value="trendStatus">Sort: Trend</option>
          <option value="return3M">Sort: 3M Return</option>
          <option value="distanceFrom52WeekHighPct">Sort: vs 52W High</option>
          <option value="high52Week">Sort: 52W High</option>
          <option value="dma50">Sort: 50 DMA</option>
          <option value="dma200">Sort: 200 DMA</option>
          <option value="pnl">Sort: P&amp;L (₹)</option>
          <option value="pnlPct">Sort: P&amp;L (%)</option>
          <option value="value">Sort: Value</option>
          <option value="crossSignal">Sort: MA Cross</option>
        </select>
        <select value={sortDir} onChange={(e) => setSortDir(e.target.value)}>
          <option value="desc">High → Low</option>
          <option value="asc">Low → High</option>
        </select>
      </div>

      {/* Signal groups */}
      {SIGNAL_ORDER.map((signal) => {
        const rows = grouped[signal];
        if (!rows || rows.length === 0) return null;
        return (
          <div className="panel" key={signal}>
            <div className="action-section-header">
              <SignalBadge signal={signal} />
              <span className={`action-count-badge action-count-${signal}`}>{rows.length}</span>
              <h2 style={{ fontSize: '1rem', margin: 0, color: '#4a5e52' }}>
                {signal === 'EXIT'       && 'Consider exiting — strong warning signals'}
                {signal === 'TRIM'       && 'Consider reducing position size'}
                {signal === 'WATCH'      && 'Monitor closely — deteriorating metrics'}
                {signal === 'HOLD'       && 'Hold — no action needed'}
                {signal === 'ACCUMULATE' && 'Strong candidate for adding more'}
              </h2>
            </div>
            {rows.map((h) => {
              const mm = h.momentumMetrics || {};
              const pnlPct = h.invested > 0 ? ((h.pnl / h.invested) * 100).toFixed(1) : null;
              return (
                <div className="action-row" key={`${h.portfolio}-${h.symbol}`}>
                  {/* Symbol + portfolio */}
                  <div>
                    <div className="action-row-symbol">
                      <button type="button" className="symbol-button" onClick={() => setSelected(h)}>
                        {h.symbol}
                      </button>
                    </div>
                    <div className="action-row-portfolio">{h.portfolio} · {h.sector || 'Unknown sector'}</div>
                  </div>

                  {/* Signal badge */}
                  <SignalBadge signal={h.signal} />

                  {/* Reasons */}
                  <div className="action-row-reasons">
                    {h.reasons.map((r) => (
                      <span className="reason-pill" key={r}>{r}</span>
                    ))}
                  </div>

                  {/* Key metrics */}
                  <div className="action-row-metrics">
                    <div className="action-metric">
                      <span className="action-metric-label">Score</span>
                      <ScorePill value={h.scores.combined.value} label={h.scores.combined.label} />
                    </div>
                    <div className="action-metric">
                      <span className="action-metric-label">Trend</span>
                      <span style={{ fontWeight: 600, fontSize: '0.82rem' }}>{mm.trendStatus || '-'}</span>
                    </div>
                    <div className="action-metric">
                      <span className="action-metric-label">EMA Trend</span>
                      <EmaLadderBadge ladder={mm.emaLadder} slope={mm.ema50SlopePct} />
                    </div>
                    <div className="action-metric">
                      <span className="action-metric-label">3M Return</span>
                      <span className={mm.return3M == null ? '' : mm.return3M >= 0 ? 'positive' : 'negative'}>
                        {mm.return3M == null ? '-' : fmtPct(mm.return3M)}
                      </span>
                    </div>
                    <div className="action-metric">
                      <span className="action-metric-label">vs 52W High</span>
                      <span className={mm.distanceFrom52WeekHighPct == null ? '' : mm.distanceFrom52WeekHighPct >= 0 ? 'positive' : 'negative'}>
                        {mm.distanceFrom52WeekHighPct == null ? '-' : fmtPct(mm.distanceFrom52WeekHighPct)}
                      </span>
                    </div>
                    <div className="action-metric">
                      <span className="action-metric-label">52W High</span>
                      <span>{mm.high52Week == null ? '-' : fmt(mm.high52Week, 2)}</span>
                    </div>
                    <div className="action-metric">
                      <span className="action-metric-label">50 DMA</span>
                      <span>{mm.dma50 == null ? '-' : fmt(mm.dma50, 2)}</span>
                    </div>
                    <div className="action-metric">
                      <span className="action-metric-label">200 DMA</span>
                      <span>{mm.dma200 == null ? '-' : fmt(mm.dma200, 2)}</span>
                    </div>
                    <div className="action-metric">
                      <span className="action-metric-label">MA Cross</span>
                      <CrossBadge dma50={mm.dma50} dma200={mm.dma200} />
                    </div>
                    <div className="action-metric">
                      <span className="action-metric-label">P&amp;L</span>
                      <span className={h.pnl >= 0 ? 'positive' : 'negative'}>
                        {fmt(h.pnl)}{pnlPct ? ` (${pnlPct}%)` : ''}
                      </span>
                    </div>
                    <div className="action-metric">
                      <span className="action-metric-label">Value</span>
                      <span>₹{fmt(h.currentValue)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      {filtered.length === 0 && (
        <div className="panel"><p className="muted">No holdings match the selected filters.</p></div>
      )}

      {/* Not Tradeable — suspended / unlisted stocks excluded from signals */}
      {nonTradeable.length > 0 && (
        <div className="panel" style={{ opacity: 0.7 }}>
          <div className="action-section-header">
            <span style={{ fontSize: '1.1rem' }}>⚪</span>
            <span className="action-count-badge" style={{ background: '#e4e6ea', color: '#565a6b' }}>{nonTradeable.length}</span>
            <h2 style={{ fontSize: '1rem', margin: 0, color: '#565a6b' }}>Not Tradeable — suspended or unlisted</h2>
          </div>
          {nonTradeable.map((h) => (
            <div className="action-row" key={`${h.portfolio}-${h.symbol}`} style={{ opacity: 0.8 }}>
              <div>
                <div className="action-row-symbol" style={{ color: '#565a6b' }}>{h.symbol}</div>
                <div className="action-row-portfolio">{h.portfolio} · {h.sector || 'Unknown sector'}</div>
              </div>
              <span style={{ fontSize: '0.75rem', background: '#f1f5f9', color: '#565a6b', border: '1px solid #656974', borderRadius: 4, padding: '4px 10px' }}>
                Suspended / Unlisted
              </span>
              <div className="action-row-reasons">
                <span className="reason-pill" style={{ background: '#f1f5f9', color: '#565a6b' }}>
                  {h.note || 'No market data available'}
                </span>
              </div>
              <div className="action-row-metrics">
                <div className="action-metric">
                  <span className="action-metric-label">Qty</span>
                  <span>{h.quantity ?? '-'}</span>
                </div>
                <div className="action-metric">
                  <span className="action-metric-label">Avg Cost</span>
                  <span>{h.avgCost ? fmt(h.avgCost, 2) : '-'}</span>
                </div>
                <div className="action-metric">
                  <span className="action-metric-label">Invested</span>
                  <span>₹{fmt(h.invested)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      </>}
    </PageShell>
  );
}

// ─────────────────────────────────────────
// LTCG / STCG TAX TRACKER PAGE
// ─────────────────────────────────────────

function LtcgTrackerPage() {
  const [ramsData,    setRamsData]    = useState(null);
  const [geethaData,  setGeethaData]  = useState(null);
  const [ramsOrders,  setRamsOrders]  = useState(null);
  const [geethaOrders,setGeethaOrders]= useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [filter,      setFilter]      = useState('ALL'); // ALL | Rams | Geetha
  const [taxFilter,   setTaxFilter]   = useState('ALL'); // ALL | LTCG | STCG | SOON
  const [sortBy,      setSortBy]      = useState('days_asc');

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchPortfolio('Rams'),
      fetchPortfolio('Geetha'),
      fetchOrders({ portfolio: 'Rams',   pageSize: 2000, page: 1 }),
      fetchOrders({ portfolio: 'Geetha', pageSize: 2000, page: 1 }),
    ])
      .then(([rd, gd, ro, go]) => {
        setRamsData(rd);
        setGeethaData(gd);
        setRamsOrders(ro);
        setGeethaOrders(go);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  // Build open-lot map from all orders
  const openLotMap = useMemo(() => {
    const allOrders = [
      ...(ramsOrders?.rows   || []),
      ...(geethaOrders?.rows || []),
    ];
    return computeOpenLots(allOrders);
  }, [ramsOrders, geethaOrders]);

  // Combine all current holdings, enrich with tax data
  const enrichedHoldings = useMemo(() => {
    const rHoldings = (ramsData?.currentHoldings   || []).map((h) => ({ ...h, portfolio: 'Rams' }));
    const gHoldings = (geethaData?.currentHoldings || []).map((h) => ({ ...h, portfolio: 'Geetha' }));
    const all = [...rHoldings, ...gHoldings];

    return all.map((h) => {
      const key  = `${h.portfolio}::${h.symbol}`;
      const lots = openLotMap.get(key) || [];
      // Earliest open lot = FIFO oldest remaining share
      const earliestLot = lots.length > 0
        ? lots.reduce((a, b) => (a.date < b.date ? a : b))
        : null;
      const earliestDate = earliestLot?.date || null;
      const days = daysSince(earliestDate);
      const daysToLtcg = days !== null ? Math.max(0, LTCG_DAYS - days) : null;
      const isLtcg = days !== null && days >= LTCG_DAYS;
      const isSoon = !isLtcg && daysToLtcg !== null && daysToLtcg <= STCG_WARNING_DAYS;
      const ltcgDate = earliestDate ? addDays(earliestDate, LTCG_DAYS) : null;
      return {
        ...h,
        earliestDate,
        days,
        daysToLtcg,
        isLtcg,
        isSoon,
        ltcgDate,
        lotCount: lots.length,
      };
    });
  }, [ramsData, geethaData, openLotMap]);

  // Stocks approaching LTCG (within warning window)
  const soonHoldings = useMemo(
    () => enrichedHoldings.filter((h) => h.isSoon),
    [enrichedHoldings],
  );

  const filtered = useMemo(() => {
    let rows = enrichedHoldings;
    if (filter !== 'ALL') rows = rows.filter((h) => h.portfolio === filter);
    if (taxFilter === 'LTCG') rows = rows.filter((h) => h.isLtcg);
    else if (taxFilter === 'STCG') rows = rows.filter((h) => !h.isLtcg && h.days !== null);
    else if (taxFilter === 'SOON') rows = rows.filter((h) => h.isSoon);
    else if (taxFilter === 'NO_DATA') rows = rows.filter((h) => h.days === null);

    // Sort
    rows = [...rows];
    if (sortBy === 'days_asc')    rows.sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999));
    if (sortBy === 'days_desc')   rows.sort((a, b) => (b.days ?? 0)    - (a.days ?? 0));
    if (sortBy === 'pnl_desc')    rows.sort((a, b) => (b.pnl || 0)     - (a.pnl || 0));
    if (sortBy === 'value_desc')  rows.sort((a, b) => (b.currentValue  || 0) - (a.currentValue || 0));
    if (sortBy === 'symbol')      rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return rows;
  }, [enrichedHoldings, filter, taxFilter, sortBy]);

  const summary = useMemo(() => {
    const ltcg  = enrichedHoldings.filter((h) => h.isLtcg);
    const stcg  = enrichedHoldings.filter((h) => !h.isLtcg && h.days !== null);
    const soon  = enrichedHoldings.filter((h) => h.isSoon);
    const noData= enrichedHoldings.filter((h) => h.days === null);
    return {
      ltcgCount:  ltcg.length,
      stcgCount:  stcg.length,
      soonCount:  soon.length,
      noDataCount:noData.length,
      ltcgValue:  ltcg.reduce((s, h) => s + (h.currentValue || 0), 0),
      stcgValue:  stcg.reduce((s, h) => s + (h.currentValue || 0), 0),
      ltcgPnl:    ltcg.reduce((s, h) => s + (h.pnl || 0), 0),
      stcgPnl:    stcg.reduce((s, h) => s + (h.pnl || 0), 0),
    };
  }, [enrichedHoldings]);

  if (loading) return <PageShell title="LTCG / STCG Tracker" subtitle="Loading…"><p>Loading portfolio and order history…</p></PageShell>;
  if (error)   return <PageShell title="LTCG / STCG Tracker" subtitle="Tax status per holding"><p className="negative">{error}</p></PageShell>;

  return (
    <PageShell
      title="LTCG / STCG Tracker"
      subtitle="Holding-period tax status based on FIFO lot dates · India equity (365-day rule)"
    >
      {/* Warning banner for stocks approaching LTCG */}
      {soonHoldings.length > 0 && (
        <div className="ltcg-wait-banner">
          <span style={{ fontSize: '1.2rem' }}>⏳</span>
          <div>
            <strong>{soonHoldings.length} stock{soonHoldings.length > 1 ? 's' : ''} within {STCG_WARNING_DAYS} days of becoming LTCG:</strong>{' '}
            {soonHoldings.map((h) => (
              <span key={`${h.portfolio}-${h.symbol}`} style={{ marginRight: 8 }}>
                {h.symbol} ({h.portfolio}) — <strong>{h.daysToLtcg}d left</strong>
              </span>
            ))}
            <br />
            <span style={{ fontSize: '0.85rem' }}>Consider waiting before selling to qualify for lower LTCG tax rate.</span>
          </div>
        </div>
      )}

      {/* Summary cards */}
      <div className="stats-grid">
        <StatCard label="LTCG Holdings"  value={summary.ltcgCount}  helper={`₹${fmt(summary.ltcgValue)} value`}   />
        <StatCard label="STCG Holdings"  value={summary.stcgCount}  helper={`₹${fmt(summary.stcgValue)} value`}   />
        <StatCard label="Near LTCG"      value={summary.soonCount}  helper={`within ${STCG_WARNING_DAYS} days`}   />
        <StatCard label="LTCG P&L"       value={`₹${fmt(summary.ltcgPnl)}`}   helper="unrealized, LTCG bucket"
          tone={summary.ltcgPnl >= 0 ? 'positive' : 'negative'} />
        <StatCard label="STCG P&L"       value={`₹${fmt(summary.stcgPnl)}`}   helper="unrealized, STCG bucket"
          tone={summary.stcgPnl >= 0 ? 'positive' : 'negative'} />
        <StatCard label="No Order Data"  value={summary.noDataCount} helper="orders not yet imported" />
      </div>

      {/* Filters */}
      <div className="filters">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="ALL">Both portfolios</option>
          <option value="Rams">Rams only</option>
          <option value="Geetha">Geetha only</option>
        </select>
        <select value={taxFilter} onChange={(e) => setTaxFilter(e.target.value)}>
          <option value="ALL">All tax buckets</option>
          <option value="LTCG">LTCG only (&gt;365 days)</option>
          <option value="STCG">STCG only</option>
          <option value="SOON">Approaching LTCG</option>
          <option value="NO_DATA">No order data</option>
        </select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          <option value="days_asc">Shortest hold first (STCG risk)</option>
          <option value="days_desc">Longest hold first</option>
          <option value="pnl_desc">Highest P&L first</option>
          <option value="value_desc">Highest value first</option>
          <option value="symbol">Symbol A–Z</option>
        </select>
      </div>

      {/* Main table */}
      <div className="panel">
        <h2 style={{ marginBottom: 4 }}>Holdings ({filtered.length})</h2>
        <p style={{ margin: '0 0 10px', color: '#565a6b', fontSize: '0.85rem' }}>
          Earliest open lot date per holding computed via FIFO from your imported order history.
          Stocks with no order data show "No data" — import your tradebooks on the Orders page to populate them.
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table compact-table">
            <thead>
              <tr>
                <th scope="col">Symbol</th>
                <th scope="col">Portfolio</th>
                <th scope="col">Qty</th>
                <th scope="col">Invested</th>
                <th scope="col">Value</th>
                <th scope="col">P&amp;L</th>
                <th scope="col">Earliest Lot Date</th>
                <th scope="col">Days Held</th>
                <th scope="col">Progress</th>
                <th scope="col">LTCG Date</th>
                <th scope="col">Tax Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((h) => (
                <tr key={`${h.portfolio}-${h.symbol}`}>
                  <td>
                    <div className="symbol-cell">
                      <span style={{ fontWeight: 700, color: '#1d3f7a' }}>{h.symbol}</span>
                      <span>{h.sector || ''}</span>
                    </div>
                  </td>
                  <td>{h.portfolio}</td>
                  <td>{fmt(h.quantity)}</td>
                  <td>₹{fmt(h.invested)}</td>
                  <td>₹{fmt(h.currentValue)}</td>
                  <td className={h.pnl >= 0 ? 'positive' : 'negative'}>₹{fmt(h.pnl)}</td>
                  <td>{h.earliestDate || <span className="muted">—</span>}</td>
                  <td>{h.days !== null ? `${h.days}d` : <span className="muted">—</span>}</td>
                  <td><DaysBar days={h.days} /></td>
                  <td>
                    {h.ltcgDate ? (
                      <span className={h.isLtcg ? 'positive' : (h.isSoon ? '' : '')}>{h.isLtcg ? '✓ Achieved' : h.ltcgDate}</span>
                    ) : <span className="muted">—</span>}
                  </td>
                  <td><TaxBadge days={h.days} /></td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan="11" className="muted" style={{ padding: 20 }}>No holdings match the selected filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Lot-level detail per upcoming STCG → LTCG conversions */}
      {soonHoldings.length > 0 && (
        <div className="panel">
          <h2>Approaching LTCG — Sell Decision Guide</h2>
          <p style={{ color: '#565a6b', fontSize: '0.88rem', marginBottom: 12 }}>
            Selling any of these before their LTCG date incurs STCG tax (15%). Waiting saves on tax at the cost of market risk.
          </p>
          <table className="data-table compact-table">
            <thead>
              <tr>
                <th scope="col">Symbol</th>
                <th scope="col">Portfolio</th>
                <th scope="col">Days to LTCG</th>
                <th scope="col">LTCG Date</th>
                <th scope="col">Current Value</th>
                <th scope="col">P&amp;L</th>
                <th scope="col">STCG Tax Est. (15%)</th>
                <th scope="col">Decision</th>
              </tr>
            </thead>
            <tbody>
              {soonHoldings.map((h) => {
                const taxEstimate = h.pnl > 0 ? h.pnl * 0.15 : 0;
                return (
                  <tr key={`${h.portfolio}-${h.symbol}`}>
                    <td><strong>{h.symbol}</strong></td>
                    <td>{h.portfolio}</td>
                    <td><strong className={h.daysToLtcg <= 30 ? 'negative' : ''}>{h.daysToLtcg}d</strong></td>
                    <td>{h.ltcgDate}</td>
                    <td>₹{fmt(h.currentValue)}</td>
                    <td className={h.pnl >= 0 ? 'positive' : 'negative'}>₹{fmt(h.pnl)}</td>
                    <td className="negative">₹{fmt(taxEstimate)}</td>
                    <td>
                      {h.daysToLtcg <= 14
                        ? <span className="signal-badge signal-WATCH">Wait ≤14 days</span>
                        : <span className="signal-badge signal-HOLD">Consider waiting</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

// ─────────────────────────────────────────
// DASHBOARD PAGE
// ─────────────────────────────────────────

const ALERT_COLORS = {
  momentum_up:   { border: 'var(--lime)',      bg: 'rgba(184,239,67,0.06)',  badge: 'rgba(184,239,67,0.15)', badgeText: 'var(--lime)' },
  add_capital:   { border: '#05664a',          bg: 'rgba(6, 122, 85,0.06)',  badge: 'rgba(6, 122, 85,0.15)', badgeText: '#05664a' },
  momentum_down: { border: '#b32d19',          bg: 'rgba(196, 53, 31,0.06)', badge: 'rgba(196, 53, 31,0.15)', badgeText: '#b32d19' },
  weak_month:    { border: '#9a5b06',          bg: 'rgba(251,146,60,0.06)',  badge: 'rgba(251,146,60,0.15)', badgeText: '#9a5b06' },
  concentration: { border: '#9a5b06',          bg: 'rgba(154, 91, 6,0.06)',  badge: 'rgba(154, 91, 6,0.15)', badgeText: '#9a5b06' },
  sector_skew:   { border: 'var(--text-muted)',bg: 'rgba(255,255,255,0.03)', badge: '#e4e6ea', badgeText: 'var(--text-secondary)' },
  corp_upcoming: { border: '#1355a8',          bg: 'rgba(129,140,248,0.06)', badge: 'rgba(129,140,248,0.15)', badgeText: '#1355a8' },
  corp_recent:   { border: '#656974',          bg: 'rgba(148,163,184,0.06)', badge: 'rgba(148,163,184,0.12)', badgeText: '#656974' },
};

// Price + today's trend chip for an insight item. `isTradingDay === false` means
// today's a market holiday — the day's move is meaningless (nothing traded), so it's
// forced to a flat/sideways 0% rather than showing yesterday's last-known dayChg.
// Any other time (including after market close, same day) shows the real dayChg —
// that figure comes from the broker snapshot and naturally holds steady until the
// next fetch/trading day refreshes it.
function TodayTrendChip({ ltp, dayChg, isTradingDay }) {
  if (ltp == null) return null;
  const chg = isTradingDay === false ? 0 : (dayChg ?? 0);
  const arrow = chg > 0.05 ? '▲' : chg < -0.05 ? '▼' : '→';
  const color = chg > 0.05 ? '#05664a' : chg < -0.05 ? '#b32d19' : '#656974';
  return (
    <span
      title={isTradingDay === false ? 'Market holiday — no trading today' : "Today's change"}
      style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, fontSize: 13, color: 'var(--text-secondary)' }}>
      ₹{fmt(ltp, 2)}
      <span style={{ color, fontWeight: 700 }}>{arrow} {chg >= 0 ? '+' : ''}{chg.toFixed(1)}%</span>
    </span>
  );
}

function InsightCard({ alert, isTradingDay }) {
  const [open, setOpen] = useState(true);
  const c = ALERT_COLORS[alert.type] || ALERT_COLORS.sector_skew;
  return (
    <div style={{ border: `1px solid ${c.border}`, borderLeft: `3px solid ${c.border}`, background: c.bg,
      borderRadius: 10, overflow: 'hidden', marginBottom: 14 }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ width: '100%', background: 'none', border: 'none', padding: '16px 20px',
          display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ fontSize: 19 }}>{alert.icon}</span>
        <div style={{ flex: 1 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>{alert.title}</span>
          <span style={{ fontSize: 12.5, color: 'var(--text-muted)', marginLeft: 8 }}>{alert.subtitle}</span>
        </div>
        <span style={{ fontSize: 12.5, fontWeight: 700, padding: '4px 10px', borderRadius: 4,
          background: c.badge, color: c.badgeText }}>{alert.items.length}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 12px 12px' }}>
          {alert.items.map((item, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              padding: '11px 14px', borderRadius: 7, marginBottom: 4,
              background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)' }}>
              {/* Symbol + portfolio */}
              <div style={{ minWidth: 140 }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{item.symbol}</span>
                {item.portfolio && item.portfolio !== item.symbol && (
                  <PortfolioBadge portfolio={item.portfolio} style={{ fontWeight: 600, marginLeft: 6, padding: '1px 6px', borderRadius: 3 }} />
                )}
              </div>
              {/* Metric */}
              <span style={{ fontWeight: 700, fontSize: 14, minWidth: 90,
                color: item.signal === 'positive' ? '#05664a' : item.signal === 'negative' ? '#b32d19' : '#9a5b06' }}>
                {item.metric}
              </span>
              {/* Sub metric */}
              {item.sub && <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{item.sub}</span>}
              {/* Current price + today's trend */}
              <TodayTrendChip ltp={item.ltp} dayChg={item.dayChg} isTradingDay={isTradingDay} />
              {/* Action */}
              <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--text-secondary)',
                fontStyle: 'italic', textAlign: 'right' }}>{item.action}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DashboardPage() {
  const navigate = useNavigate();
  const [data,          setData]          = useState(null);
  const [insights,      setInsights]      = useState(null);
  const [liveBreakdown, setLiveBreakdown] = useState(null);
  const [error,         setError]         = useState('');
  const [insightsErr,   setInsightsErr]   = useState('');
  const [corpRefreshing, setCorpRefreshing] = useState(false);
  const [corpMsg,        setCorpMsg]        = useState('');
  const { ramsData, geethaData, heldSymbols } = useBothPortfolios();
  const [holdingPeriods, setHoldingPeriods] = useState(null);   // `${portfolio}::${nseSymbol}` -> earliest open-lot date

  useEffect(() => {
    fetchDashboard().then(setData).catch((err) => setError(err.message));
    fetchLiveBreakdown().then((r) => setLiveBreakdown(r.breakdown)).catch(() => {});
    fetchDashboardInsights().then(setInsights).catch((e) => setInsightsErr(e.message));
    // How long each exit candidate has actually been held — computed server-side via
    // FIFO with proper broker-code resolution (a stock's raw order code can change over
    // its life, e.g. HDFAMC -> HDFCAMC; matching only today's code would silently miss
    // older buys and understate the holding period).
    fetchHoldingPeriods().then(setHoldingPeriods).catch(() => {});
  }, []);

  // Exit candidates: same signal engine as Action Queue — combined score +
  // trend breakdown + vs 50/200-DMA + 3M return — filtered to EXIT only, then
  // ranked by a differentiated Exit Score (all EXIT share urgency=100, so this
  // breaks the tie so the worst names show first).
  const exitCandidates = useMemo(() => {
    const r = (ramsData?.currentHoldings   || []).map((h) => ({ ...h, portfolio: 'Rams' }));
    const g = (geethaData?.currentHoldings || []).map((h) => ({ ...h, portfolio: 'Geetha' }));
    return [...r, ...g]
      // Exclude fully-sold positions. h.quantity alone isn't reliable — it comes from the
      // last SAVED portfolio snapshot, which can lag a real sale by days if holdings
      // haven't been re-fetched since. Cross-check against orders (always current) too.
      .filter((h) => {
        if (h.tradeable === false) return false;
        if (Number(h.quantity) <= 0) return false;
        if (!heldSymbols) return true;   // not loaded yet — don't block on it
        const set = heldSymbols[h.portfolio];
        if (!set) return true;
        return set.includes((h.nseSymbol || h.symbol || '').toUpperCase());
      })
      .map((h) => ({ ...h, ...generateSignal(h) }))
      .filter((h) => h.signal === 'EXIT')
      .map((h) => {
        const key = `${h.portfolio}::${(h.nseSymbol || h.symbol || '').toUpperCase()}`;
        const earliestDate = holdingPeriods ? (holdingPeriods[key] || null) : null;
        const daysHeld = daysSince(earliestDate);
        return { ...h, exitScore: computeExitScore(h), earliestDate, daysHeld };
      })
      .sort((a, b) => b.exitScore - a.exitScore);
  }, [ramsData, geethaData, heldSymbols, holdingPeriods]);

  // Current RSI for each exit-candidate stock — one batched request, not one per row.
  const [rsiBySymbol, setRsiBySymbol] = useState({});
  useEffect(() => {
    const symbols = [...new Set(exitCandidates.map((h) => h.nseSymbol || h.symbol))];
    if (!symbols.length) return;
    fetchRsiBatch(symbols).then(setRsiBySymbol).catch(() => {});
  }, [exitCandidates]);

  // Current universe rank + rank ~1 week ago for each exit-candidate stock — same
  // batched-fetch pattern as RSI above.
  const [rankMovementBySymbol, setRankMovementBySymbol] = useState({});
  useEffect(() => {
    const symbols = [...new Set(exitCandidates.map((h) => h.nseSymbol || h.symbol))];
    if (!symbols.length) return;
    fetchRankMovementBatch(symbols).then(setRankMovementBySymbol).catch(() => {});
  }, [exitCandidates]);

  if (error) return <PageShell title="Dashboard" subtitle="Overview"><p className="negative">{error}</p></PageShell>;
  if (!data) return <PageShell title="Dashboard" subtitle="Overview"><p>Loading…</p></PageShell>;

  const pnl    = data.totals.totalValue - data.totals.totalInvested;
  const pnlPct = data.totals.totalInvested > 0 ? (pnl / data.totals.totalInvested) * 100 : null;

  return (
    <PageShell title="Dashboard"
      subtitle={`Portfolio pulse · ${data.latestSummaryDate || 'no date'} · ${data.totals.stockCount} stocks across ${data.totals.portfolioCount} portfolios`}>

      {/* ── Stat cards ─────────────────────────────────────────────────── */}
      <div className="stats-grid">
        <StatCard label="Total Invested"  value={`₹${fmt(data.totals.totalInvested)}`} />
        <StatCard label="Current Value"   value={`₹${fmt(data.totals.totalValue)}`} />
        <StatCard label="Overall P&L"
          value={pnlPct != null ? `${pnl >= 0 ? '+' : ''}₹${fmt(Math.abs(pnl))}` : '—'}
          helper={pnlPct != null ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : ''}
          tone={pnl >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Today's Change"
          value={`${data.totals.dayChangeValue >= 0 ? '+' : ''}₹${fmt(data.totals.dayChangeValue)}`}
          tone={data.totals.dayChangeValue >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Active Recs"     value={data.totals.activeRecommendationCount} />
        <StatCard label="Total Orders"    value={data.totals.orderCount} helper={`${data.totals.snapshotCount} snapshots`} />
      </div>

      {/* ── Portfolio breakdown ─────────────────────────────────────────── */}
      <div className="panel" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0 }}>Portfolio Breakdown
          {liveBreakdown && <span style={{ fontSize: '0.75rem', fontWeight: 400, color: 'var(--lime)', marginLeft: 10 }}>● live prices</span>}
        </h2>
        <table className="data-table">
          <thead>
            <tr><th scope="col">Portfolio</th><th scope="col">Invested</th><th scope="col">Value</th><th scope="col">P&L</th><th scope="col">Stocks</th></tr>
          </thead>
          <tbody>
            {data.portfolioBreakdown.map((row) => {
              const live     = liveBreakdown?.find((r) => r.portfolio === row.portfolio);
              const invested = live ? live.total_invested : Number(row.total_invested || 0);
              const value    = live ? live.total_value    : Number(row.total_value    || 0);
              const pnl      = invested > 0 ? value - invested : null;
              const pnlPct   = invested > 0 ? ((value - invested) / invested * 100) : null;
              return (
                <tr key={row.portfolio}>
                  <td style={{ fontWeight: 700 }}>{row.portfolio}</td>
                  <td>{invested > 0 ? `₹${fmt(invested)}` : <span className="muted">N/A</span>}</td>
                  <td>{value > 0 ? `₹${fmt(value)}` : <span className="muted">—</span>}</td>
                  <td>{pnl !== null
                    ? <span className={pnl >= 0 ? 'positive' : 'negative'}>
                        {pnl >= 0 ? '+' : ''}₹{fmt(Math.abs(pnl))} ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%)
                      </span>
                    : <span className="muted">—</span>}
                  </td>
                  <td>{live ? live.stock_count : row.stock_count}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {liveBreakdown?.some((r) => !r.invested_complete) && (
          <p className="status-note" style={{ marginTop: 10 }}>
            ⚠ Some stocks in Rams are missing cost basis — go to <strong>Portfolio → Cost Basis</strong> to fix.
          </p>
        )}
      </div>

      {/* ── Exit Candidates — same signal engine as Action Queue's EXIT flag ── */}
      {exitCandidates.length > 0 && (
        <div className="panel" style={{ marginBottom: 20, borderColor: '#b32d19' }}>
          <h2 style={{ marginTop: 0, color: '#b32d19' }}>🔴 Exit Candidates ({exitCandidates.length})</h2>
          <p style={{ margin: '-6px 0 12px', fontSize: 13, color: 'var(--text-muted)' }}>
            Sorted by Exit Score (0–100) — weighted from trend breakdown, EMA-confirmed downtrend, score weakness, and DMA/3M loss depth. Same underlying signal engine as Action Queue → Portfolio Signals.
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            {exitCandidates.map((h) => {
              const mm = h.momentumMetrics || {};
              const sc = h.scores || {};
              const lookupSymbol = h.nseSymbol || h.symbol;
              const rsi = rsiBySymbol[lookupSymbol.toUpperCase()]?.rsi;
              // Current universe rank(s) + how far it moved in the last ~week — a stock is
              // usually scanned in exactly one of NIFTY500/MIDCAP/SMALLCAP/MICROCAP, so this
              // is normally a single entry, but shows all if scanned in more than one.
              const rankMoves = rankMovementBySymbol[lookupSymbol.toUpperCase()] || [];
              const rankPoints = rankMoves.map((rm) => {
                const arrow = rm.rankChange == null ? '' : rm.rankChange > 0 ? ' ▼' : rm.rankChange < 0 ? ' ▲' : ' →';
                const delta = rm.rankChange != null ? `${arrow}${Math.abs(rm.rankChange)}` : '';
                const trail = rm.weekAgoRank != null ? ` (was #${rm.weekAgoRank}, ${delta} in 1wk)` : '';
                return `${rm.universe} #${rm.currentRank}/${rm.currentTotal}${trail}`;
              });
              const dataPoints = [
                sc.combined?.value != null && `Score ${sc.combined.value}/100${sc.technical || sc.fundamental || sc.momentum ? ` (Tech ${sc.technical?.value ?? '—'} · Fund ${sc.fundamental?.value ?? '—'} · Mom ${sc.momentum?.value ?? '—'})` : ''}`,
                rsi != null && `RSI ${rsi.toFixed(1)}`,
                mm.trendStatus && `Trend: ${mm.trendStatus}`,
                mm.emaLadder && `EMA: ${EMA_LADDER_STYLE[mm.emaLadder]?.label || mm.emaLadder}`,
                mm.cmpVs50DmaPct != null && `${mm.cmpVs50DmaPct >= 0 ? '+' : ''}${mm.cmpVs50DmaPct.toFixed(1)}% vs 50DMA`,
                mm.cmpVs200DmaPct != null && `${mm.cmpVs200DmaPct >= 0 ? '+' : ''}${mm.cmpVs200DmaPct.toFixed(1)}% vs 200DMA`,
                mm.return3M != null && `3M ${mm.return3M >= 0 ? '+' : ''}${mm.return3M.toFixed(1)}%`,
                ...(rankPoints.length ? rankPoints : (h.n500Rank != null && h.n500Total != null ? [`Rank #${h.n500Rank}/${h.n500Total}`] : [])),
              ].filter(Boolean);
              const scoreColor = h.exitScore >= 70 ? '#b32d19' : h.exitScore >= 40 ? '#9a5b06' : '#9a5b06';
              return (
                <div key={`${h.portfolio}-${h.symbol}`}
                  onClick={() => navigate(`/stock-lookups?symbol=${encodeURIComponent(lookupSymbol)}`)}
                  title={`Open Stock Sleuth for ${lookupSymbol} — rank history, price trend, and EMA trend over 1 week / 15 days / 1 month / 2 months`}
                  style={{
                    padding: '11px 16px', background: 'rgba(196, 53, 31,0.06)', border: '1px solid rgba(196, 53, 31,0.25)', borderRadius: 8,
                    cursor: 'pointer', transition: 'background 0.12s',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(196, 53, 31,0.12)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(196, 53, 31,0.06)'}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                    <span title="Exit Score: higher = more urgent to exit (0-100, from trend breakdown, EMA-confirmed downtrend, score weakness, DMA/3M loss depth)"
                      style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        minWidth: 34, height: 22, padding: '0 6px', borderRadius: 6,
                        background: scoreColor, color: '#ffffff', fontWeight: 800, fontSize: 13.5,
                      }}>
                      {h.exitScore}
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ color: 'var(--text-primary)', textDecoration: 'underline', textDecorationColor: 'rgba(196, 53, 31,0.4)', textUnderlineOffset: 3 }}>
                        {lookupSymbol} 🔎
                      </strong>
                      {h.name && <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{h.name}</span>}
                    </span>
                    <span style={{ fontSize: 12.5, color: 'var(--text-muted)', background: 'var(--bg-elevated)', borderRadius: 5, padding: '1px 7px' }}>{h.portfolio}</span>
                    <span style={{ fontSize: 13.5, color: '#b32d19', fontWeight: 600 }}>{h.reasons.join(' · ')}</span>
                  </div>
                  {/* Holding cost/value/P&L + how long it's been held — the numbers that
                      actually matter for the exit decision, not just the signal. */}
                  <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(196, 53, 31,0.15)' }}>
                    <span style={{ fontSize: 13 }}>
                      <span style={{ color: 'var(--text-muted)' }}>Invested </span>
                      <strong style={{ color: 'var(--text-primary)' }}>{h.invested != null ? `₹${fmt(h.invested)}` : '—'}</strong>
                    </span>
                    <span style={{ fontSize: 13 }}>
                      <span style={{ color: 'var(--text-muted)' }}>Current </span>
                      <strong style={{ color: 'var(--text-primary)' }}>{h.currentValue != null ? `₹${fmt(h.currentValue)}` : '—'}</strong>
                    </span>
                    <span style={{ fontSize: 13 }}>
                      <span style={{ color: 'var(--text-muted)' }}>P&amp;L </span>
                      <strong style={{ color: h.pnl >= 0 ? '#05664a' : '#b32d19' }}>
                        {h.pnl != null ? `${h.pnl >= 0 ? '+' : '-'}₹${fmt(Math.abs(h.pnl))}` : '—'}
                        {h.netChangePct != null && ` (${h.netChangePct >= 0 ? '+' : ''}${h.netChangePct.toFixed(1)}%)`}
                      </strong>
                    </span>
                    <span style={{ fontSize: 13 }} title={h.earliestDate ? `Held since ${h.earliestDate}` : 'Buy date unavailable'}>
                      <span style={{ color: 'var(--text-muted)' }}>Held </span>
                      <strong style={{ color: 'var(--text-primary)' }}>
                        {h.daysHeld == null ? '—'
                          : h.daysHeld < 30 ? `${h.daysHeld}d`
                          : `${(h.daysHeld / 30.44).toFixed(1)}mo`}
                      </strong>
                    </span>
                  </div>
                  {dataPoints.length > 0 && (
                    <div style={{ marginTop: 5, paddingTop: 5, borderTop: '1px solid rgba(196, 53, 31,0.15)', fontSize: 12.5, color: 'var(--text-muted)' }}>
                      {dataPoints.join('  ·  ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Insights / Alerts ──────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>📡 Portfolio Pulse</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
            {insights?.scanDate
              ? `Based on Nifty 500 scan · ${insights.scanDate} · ${insights.holdingCount} held stocks analysed`
              : 'What needs your attention right now'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button onClick={async () => {
            setCorpRefreshing(true); setCorpMsg('');
            try {
              const r = await refreshCorpActions();
              setCorpMsg(`✓ ${r.fetched} actions fetched, ${r.saved} new`);
              fetchDashboardInsights().then(setInsights).catch(() => {});
            } catch (e) { setCorpMsg('❌ ' + e.message); }
            finally { setCorpRefreshing(false); }
          }} disabled={corpRefreshing}
            style={{ background: 'none', border: '1px solid #1355a8', borderRadius: 8,
              padding: '6px 12px', fontSize: 13, color: '#1355a8', cursor: corpRefreshing ? 'not-allowed' : 'pointer' }}>
            {corpRefreshing ? '⏳ Fetching NSE…' : '📅 Refresh Corp Actions'}
          </button>
          <button onClick={() => fetchDashboardInsights().then(setInsights).catch((e) => setInsightsErr(e.message))}
            style={{ background: 'none', border: '1px solid var(--border-md)', borderRadius: 8,
              padding: '9px 16px', fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            ↻ Refresh
          </button>
        </div>
      </div>
      {corpMsg && <p style={{ fontSize: 12.5, color: corpMsg.startsWith('❌') ? '#b32d19' : '#1355a8', marginBottom: 10 }}>{corpMsg}</p>}

      {!insights && !insightsErr && (
        <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Analysing portfolio…</p>
      )}
      {insightsErr && (
        <p style={{ color: '#b32d19', fontSize: 14 }}>Could not load insights: {insightsErr}</p>
      )}

      {insights && insights.alerts.length === 0 && (
        <div className="panel" style={{ textAlign: 'center', padding: '32px 20px' }}>
          <div style={{ fontSize: 34, marginBottom: 8 }}>✅</div>
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Portfolio looks balanced — no alerts at this time.</p>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '6px 0 0' }}>
            Run the Nifty 500 daily scan to get richer momentum insights.
          </p>
        </div>
      )}

      {insights?.alerts.map((alert) => (
        <InsightCard key={alert.type} alert={alert} isTradingDay={insights.isTradingDay} />
      ))}

      {/* ── Latest import ───────────────────────────────────────────────── */}
      {data.latestImport && (
        <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-muted)', padding: '11px 16px',
          background: 'var(--bg-elevated)', borderRadius: 8, border: '1px solid var(--border)' }}>
          Last import: <strong style={{ color: 'var(--text-secondary)' }}>{data.latestImport.source_name}</strong>
          {' · '}{data.latestImport.status}{' · '}{data.latestImport.rows_inserted} rows
        </div>
      )}
    </PageShell>
  );
}

// ─────────────────────────────────────────
// AS-OF-DATE PERFORMANCE REPORT
// ─────────────────────────────────────────
// Point-in-time report using prices stored in the snapshot for the chosen date.
// Each stock shows its day-change on that date; portfolio total is value-weighted.
function AsOfReportPanel() {
  const [data,      setData]      = useState(null);
  const [portfolio, setPortfolio] = useState('');   // '' = all
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');

  function load(date, port) {
    setLoading(true); setError('');
    fetchAsOfReport({ portfolio: port, date })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load('', ''); }, []);   // latest date, all portfolios on mount

  const dates = data?.availableDates || [];

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>📅 Performance — As Of Date</h2>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Holdings &amp; each stock's day-move as they stood on the chosen snapshot date
        </span>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', margin: '12px 0' }}>
        <select value={portfolio} onChange={(e) => { setPortfolio(e.target.value); load(data?.date || '', e.target.value); }}
          style={{ padding: '8px 13px', background: 'var(--bg-elevated)', border: '1px solid var(--border-md)', borderRadius: 6, fontSize: 14, color: 'var(--text-primary)' }}>
          <option value="">All portfolios</option>
          <option value="Rams">Rams</option>
          <option value="Geetha">Geetha</option>
        </select>
        <select value={data?.date || ''} onChange={(e) => load(e.target.value, portfolio)} disabled={!dates.length}
          style={{ padding: '8px 13px', background: 'var(--bg-elevated)', border: '1px solid var(--border-md)', borderRadius: 6, fontSize: 14, color: 'var(--text-primary)' }}>
          {dates.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        {loading && <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading…</span>}
        {data?.date && !loading && <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{dates.length} dates available</span>}
      </div>

      {error && <p className="negative">{error}</p>}

      {(data?.portfolios || []).map((p) => {
        const t = p.totals || {};
        return (
          <div key={p.portfolio} style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline', margin: '6px 0 10px' }}>
              <strong style={{ fontSize: 15 }}>{p.portfolio}</strong>
              <span style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>Invested ₹{fmt(t.invested)}</span>
              <span style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>Value ₹{fmt(t.value)}</span>
              <span style={{ fontSize: 13.5, color: (t.pnl || 0) >= 0 ? '#05664a' : '#b32d19' }}>P&amp;L {(t.pnl || 0) >= 0 ? '+' : ''}₹{fmt(t.pnl)}</span>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: (t.dayPct || 0) >= 0 ? '#05664a' : '#b32d19' }}>
                Day {fmtPct(t.dayPct)}
              </span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table compact-table">
                <thead>
                  <tr>
                    <th scope="col">Stock</th><th scope="col">Sector</th><th scope="col">Qty</th><th scope="col">Avg Cost</th>
                    <th scope="col">Price</th><th scope="col">Value</th><th scope="col">P&amp;L</th><th scope="col">Net %</th><th scope="col">Day %</th>
                  </tr>
                </thead>
                <tbody>
                  {(p.holdings || []).slice().sort((a, b) => (b.dayChangePct || 0) - (a.dayChangePct || 0)).map((h) => (
                    <tr key={h.symbol}>
                      <td style={{ fontWeight: 600 }}>{h.symbol}</td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>{h.sector}</td>
                      <td>{fmt(h.quantity)}</td>
                      <td>{fmt(h.avgCost, 2)}</td>
                      <td>{fmt(h.ltp, 2)}</td>
                      <td>₹{fmt(h.currentValue)}</td>
                      <td className={h.pnl == null ? 'muted' : h.pnl >= 0 ? 'positive' : 'negative'}>
                        {h.pnl == null ? 'N/A' : `₹${fmt(h.pnl)}`}
                      </td>
                      <td className={h.netChangePct >= 0 ? 'positive' : 'negative'}>{fmtPct(h.netChangePct)}</td>
                      <td className={h.dayChangePct >= 0 ? 'positive' : 'negative'} style={{ fontWeight: 700 }}>{fmtPct(h.dayChangePct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      {data && !loading && (data.portfolios || []).length === 0 && (
        <p className="muted">No snapshot found for this date.</p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────
// PORTFOLIO PAGE
// ─────────────────────────────────────────

function PortfolioPage() {
  const [portfolio,    setPortfolio]    = useState('');
  const [data,         setData]         = useState(null);
  const [error,        setError]        = useState('');
  const [refreshState, setRefreshState] = useState('');
  const [downloadsScan,setDownloadsScan]= useState(null);
  const [portfolioDate,setPortfolioDate]= useState(new Date().toISOString().slice(0, 10));
  const [sortBy,       setSortBy]       = useState('combined');
  const [sortDir,      setSortDir]      = useState('desc');
  const [selected,     setSelected]     = useState(null);

  // ── Kite state ──────────────────────────────────────────────────────────────
  const [kiteStatus,       setKiteStatus]       = useState(null);   // {connected, loginAt, expiresAt}
  const [kiteConnecting,   setKiteConnecting]   = useState(false);
  const [kiteFetching,     setKiteFetching]     = useState(false);
  const [kitePreview,      setKitePreview]      = useState(null);   // {holdings, fetchedAt}
  const [kiteSaving,       setKiteSaving]       = useState(false);
  const [kiteMsg,          setKiteMsg]          = useState('');

  // ── Cost Basis Override state ────────────────────────────────────────────────
  const [cbOverrides,     setCbOverrides]     = useState(null);
  const [cbPortfolio,     setCbPortfolio]     = useState('Rams');
  const [cbCsvText,       setCbCsvText]       = useState('');
  const [cbImporting,     setCbImporting]     = useState(false);
  const [cbMsg,           setCbMsg]           = useState('');
  const [cbExpanded,      setCbExpanded]      = useState(false);

  function loadCostBasis(p) {
    fetchCostBasisOverrides(p).then((r) => setCbOverrides(r.overrides)).catch(() => {});
  }

  useEffect(() => { loadCostBasis(cbPortfolio); }, [cbPortfolio]);

  async function handleCostBasisImport() {
    setCbMsg(''); setCbImporting(true);
    try {
      const lines = cbCsvText.trim().split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) throw new Error('CSV is empty');
      const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
      const symIdx  = headers.findIndex((h) => h.includes('symbol') || h === 'stock');
      const costIdx = headers.findIndex((h) => h.includes('avg') || h.includes('cost') || h.includes('price'));
      const qtyIdx  = headers.findIndex((h) => h.includes('qty') || h.includes('quantity'));
      const dateIdx = headers.findIndex((h) => h.includes('date'));
      if (symIdx === -1 || costIdx === -1) throw new Error('CSV must have "symbol" and "avg cost" columns');
      const overrides = lines.slice(1).map((line) => {
        const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
        const symbol  = (cells[symIdx] || '').toUpperCase();
        const avgCost = parseFloat(cells[costIdx]);
        const qty     = qtyIdx >= 0 ? parseFloat(cells[qtyIdx]) : null;
        const date    = dateIdx >= 0 ? cells[dateIdx] : null;
        return { symbol, avgCost, qty, asOfDate: date };
      }).filter((o) => o.symbol && !isNaN(o.avgCost) && o.avgCost > 0);
      if (!overrides.length) throw new Error('No valid rows found');
      const result = await importCostBasisOverrides({ portfolio: cbPortfolio, overrides });
      setCbMsg(`✅ Imported ${result.upserted} overrides for ${cbPortfolio}`);
      setCbCsvText('');
      loadCostBasis(cbPortfolio);
    } catch (err) { setCbMsg(`❌ ${err.message}`); }
    finally { setCbImporting(false); }
  }

  async function handleDeleteOverride(symbol) {
    try {
      await deleteCostBasisOverride(cbPortfolio, symbol);
      loadCostBasis(cbPortfolio);
    } catch (err) { setCbMsg(`❌ ${err.message}`); }
  }

  // ── Breeze state ─────────────────────────────────────────────────────────────
  const [breezeStatus,     setBreezeStatus]     = useState(null);   // {connected, loginAt, expiresAt, userId}
  const [breezeConnecting, setBreezeConnecting] = useState(false);
  const [breezeFetching,   setBreezeFetching]   = useState(false);
  const [breezePreview,    setBreezePreview]     = useState(null);  // {holdings, fetchedAt, count}
  const [breezeSaving,     setBreezeSaving]      = useState(false);
  const [breezeMsg,        setBreezeMsg]         = useState('');
  const [pledgedRows,      setPledgedRows]       = useState([]);    // manually added pledged holdings
  const PLEDGED_EMPTY = { instrument: '', qty: '', avgCost: '' };
  const [pledgedForm,      setPledgedForm]       = useState(PLEDGED_EMPTY);

  useEffect(() => {
    fetchKiteStatus().then(setKiteStatus).catch(() => {});
    fetchBreezeStatus().then(setBreezeStatus).catch(() => {});
  }, []);

  async function handleBreezeFetch() {
    setBreezeFetching(true); setBreezeMsg(''); setBreezePreview(null);
    try {
      const result = await fetchBreezeHoldings();
      setBreezePreview(result);
      setBreezeMsg(`Fetched ${result.count} holdings from Breeze at ${new Date(result.fetchedAt).toLocaleTimeString()}. Review below and save.`);
    } catch (err) { setBreezeMsg(`❌ ${err.message}`); }
    finally { setBreezeFetching(false); }
  }

  async function handleBreezeSave() {
    if (!breezePreview?.holdings?.length) return;
    setBreezeSaving(true); setBreezeMsg('');
    try {
      const pledged = pledgedRows.map((r) => ({
        instrument: r.instrument.trim().toUpperCase(),
        exchange: 'NSE',
        isin: '',
        qty:     Number(r.qty) || 0,
        avgCost: Number(r.avgCost) || 0,
        ltp:     0,
        invested: (Number(r.qty) || 0) * (Number(r.avgCost) || 0),
        curVal:  0,
        pnl:     0,
        dayChg:  0,
        netChg:  0,
      })).filter((r) => r.instrument && r.qty > 0);
      const allHoldings = [...breezePreview.holdings, ...pledged];
      const result = await saveBreezeHoldings({
        holdings:     allHoldings,
        snapshotDate: portfolioDate,
        portfolio:    'Rams',
      });
      setBreezePreview(null);
      setPledgedRows([]);
      const updated = await fetchPortfolio('Rams');
      setData(updated); setPortfolio('Rams');
      // RECONCILE sent vs written. Without this, a save that wrote nothing reports
      // "Saved 0 holdings" — indistinguishable from a genuinely empty result, which is exactly
      // how a schema error silently dropped two days of orders before it was noticed.
      const wrote = Number(result.inserted ?? NaN);
      if (!Number.isFinite(wrote) || wrote !== allHoldings.length) {
        setBreezeMsg(`⚠ Snapshot did not account for every holding: sent ${allHoldings.length}, `
          + `saved ${Number.isFinite(wrote) ? wrote : 'unknown'}. Nothing is dropped without this `
          + `warning — check the server log and re-run before relying on the portfolio view.`);
      } else {
        setBreezeMsg(`✅ Saved ${wrote} holdings for Rams (${result.snapshotDate})${pledged.length ? ` · including ${pledged.length} pledged holding(s)` : ''}.`);
      }
    } catch (err) { setBreezeMsg(`❌ ${err.message}`); }
    finally { setBreezeSaving(false); }
  }

  async function handleKiteFetch() {
    setKiteFetching(true); setKiteMsg(''); setKitePreview(null);
    try {
      const result = await fetchKiteHoldings();
      setKitePreview(result);
      setKiteMsg(`Fetched ${result.count} holdings from Kite at ${new Date(result.fetchedAt).toLocaleTimeString()}. Review below and save.`);
    } catch (err) { setKiteMsg(`❌ ${err.message}`); }
    finally { setKiteFetching(false); }
  }

  async function handleKiteSave() {
    if (!kitePreview?.holdings?.length) return;
    setKiteSaving(true); setKiteMsg('');
    try {
      const result = await saveKiteHoldings({
        holdings:     kitePreview.holdings,
        snapshotDate: portfolioDate,
        portfolio:    'Geetha',
      });
      setKitePreview(null);
      const updated = await fetchPortfolio('Geetha');
      setData(updated); setPortfolio('Geetha');
      const wroteK = Number(result.inserted ?? NaN);
      if (!Number.isFinite(wroteK) || wroteK !== kitePreview.holdings.length) {
        setKiteMsg(`⚠ Snapshot did not account for every holding: sent ${kitePreview.holdings.length}, `
          + `saved ${Number.isFinite(wroteK) ? wroteK : 'unknown'}. Check the server log and re-run.`);
      } else {
        setKiteMsg(`✅ Saved ${wroteK} holdings for Geetha (${result.snapshotDate}).`);
      }
    } catch (err) { setKiteMsg(`❌ ${err.message}`); }
    finally { setKiteSaving(false); }
  }

  useEffect(() => {
    fetchPortfolio(portfolio).then(setData).catch((err) => setError(err.message));
  }, [portfolio]);

  async function handleRefreshScores() {
    try {
      setRefreshState('Refreshing scores…');
      setError('');
      await refreshScores();
      const updated = await fetchPortfolio(portfolio);
      setData(updated);
      setRefreshState('Scores refreshed.');
    } catch (err) { setError(err.message); setRefreshState(''); }
  }

  async function handlePortfolioFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setRefreshState('Parsing portfolio file…');
      setError('');
      const text = await fileToText(file);
      const holdings = parsePortfolioCSV(text);
      if (!holdings.length) throw new Error('No holdings parsed.');
      const targetPortfolio = portfolio || 'Rams';
      await uploadPortfolioImport({ portfolio: targetPortfolio, snapshotDate: portfolioDate, fileName: file.name, holdings });
      const updated = await fetchPortfolio(targetPortfolio);
      setData(updated);
      setPortfolio(targetPortfolio);
      setRefreshState(`Imported ${holdings.length} holdings for ${targetPortfolio}.`);
    } catch (err) { setError(err.message); setRefreshState(''); } finally { event.target.value = ''; }
  }

  async function handleDownloadsImport() {
    try {
      setRefreshState('Scanning Downloads…');
      setError('');
      const result = await importPortfolioDownloads();
      const updated = await fetchPortfolio(portfolio || '');
      setData(updated);
      setDownloadsScan(result);
      setRefreshState(result.importedCount > 0 ? `Imported ${result.importedCount} file(s).` : 'Nothing new found.');
    } catch (err) { setError(err.message); setRefreshState(''); }
  }

  const sortedHoldings = useMemo(() => {
    // Shallow-copy so we can attach weight/verdict without mutating source data
    const holdings = (data?.currentHoldings || []).map((h) => ({ ...h }));
    const totalValue = holdings.reduce((s, h) => s + (h.currentValue || 0), 0) || 1;
    const VERDICT_RANK = { ADD: 4, TRIM: 3, REVIEW: 2, HOLD: 1 };
    holdings.forEach((h) => {
      h.weightPct = (h.currentValue || 0) / totalValue * 100;
      const v = portfolioVerdict(h, h.weightPct);
      h.verdict = v.verdict;
      h.verdictReasons = v.reasons;
    });
    const getters = {
      verdict:  (h) => VERDICT_RANK[h.verdict] || 0,
      weight:   (h) => h.weightPct,
      // Unranked stocks sort last regardless of direction sentinel
      n500Rank: (h) => (h.n500Rank == null ? Number.MAX_SAFE_INTEGER : h.n500Rank),
      combined: (h) => h.scores.combined.value,
      momentum: (h) => h.scores.momentum.value,
      fundamental: (h) => h.scores.fundamental.value,
      value: (h) => h.currentValue,
      pnl:   (h) => h.pnl,
      symbol:(h) => h.symbol,
      cmpVs50DmaPct:  (h) => Number(h.momentumMetrics?.cmpVs50DmaPct  || 0),
      cmpVs200DmaPct: (h) => Number(h.momentumMetrics?.cmpVs200DmaPct || 0),
      return3M:       (h) => Number(h.momentumMetrics?.return3M       || 0),
      trendStatus:    (h) => h.momentumMetrics?.trendStatus || '',
      crossSignal:    (h) => { const s = getCrossSignal(h.momentumMetrics?.dma50, h.momentumMetrics?.dma200); return s === 'golden' ? 1 : s === 'death' ? -1 : 0; },
    };
    const getter = getters[sortBy] || getters.combined;
    holdings.sort((a, b) => {
      const av = getter(a), bv = getter(b);
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return holdings;
  }, [data, sortBy, sortDir]);

  // Live totals from current holdings (uses live prices) — more accurate than the
  // saved DB summary, which can lack prices/cost for broker-imported holdings.
  const liveSummary = useMemo(() => {
    const hs = data?.currentHoldings || [];
    const value    = hs.reduce((s, h) => s + (h.currentValue || 0), 0);
    const invested = hs.reduce((s, h) => s + (h.invested || 0), 0);
    const withCost = hs.filter((h) => (h.invested || 0) > 0).length;
    return { value, invested, withCost, stocks: hs.length };
  }, [data]);

  return (
    <PageShell title="Portfolio" subtitle="Current holdings, scores, and momentum">
      <HoldingDetailsModal holding={selected} onClose={() => setSelected(null)} />
      {error ? <p className="negative">{error}</p> : null}

      <div className="filters">
        <select value={portfolio} onChange={(e) => setPortfolio(e.target.value)}>
          <option value="">Latest overall</option>
          <option value="Geetha">Geetha</option>
          <option value="Rams">Rams</option>
        </select>
        <input type="date" value={portfolioDate} onChange={(e) => setPortfolioDate(e.target.value)} />
        <label className="upload-button">
          Upload Portfolio File
          <input type="file" accept=".csv,.xlsx,.xls" onChange={handlePortfolioFileChange} hidden />
        </label>
        <button type="button" onClick={handleDownloadsImport}>Sync Downloads</button>
      </div>

      {/* ── Breeze Connect Panel (ICICI Direct — Rams) ─────────────────── */}
      <div style={{
        border: '1px solid var(--border-md)', borderRadius: 8, padding: '14px 16px',
        marginBottom: 12, background: breezeStatus?.connected ? 'rgba(184,239,67,0.06)' : 'var(--bg-card)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>🔌 ICICI Direct Breeze — Rams</span>
          {breezeStatus && (
            <span style={{
              fontSize: 13, fontWeight: 600, padding: '2px 10px', borderRadius: 12,
              background: breezeStatus.connected ? 'rgba(184,239,67,0.15)' : 'rgba(239,68,68,0.15)',
              color:      breezeStatus.connected ? 'var(--lime)' : '#b32d19',
            }}>
              {breezeStatus.connected
                ? `● Connection established · valid till ${new Date(breezeStatus.expiresAt).toLocaleString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                : '○ Not connected'}
            </span>
          )}
          {breezeStatus?.connected && (
            <>
              <button
                onClick={handleBreezeFetch} disabled={breezeFetching}
                style={{ background: 'var(--primary, #1355a8)', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 12px', cursor: breezeFetching ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 13 }}
              >
                {breezeFetching ? '⏳ Fetching…' : '📥 Fetch Holdings'}
              </button>
            </>
          )}
        </div>

        {!breezeStatus?.connected && (
          // Connecting lives on Daily Sync, which owns the broker session and already has one
          // implementation of this flow for both brokers. Duplicating the login and token entry
          // here meant two copies free to drift apart.
          <p style={{ margin: 0, fontSize: 13.5, color: '#565a6b' }}>
            Not connected.{' '}
            <Link to="/daily-sync" style={{ color: '#1355a8', fontWeight: 600 }}>
              Connect ICICI Direct Breeze on Daily Sync
            </Link>{' '}
            to fetch holdings.
          </p>
        )}

        {breezeMsg && (
          <div style={{ marginTop: 8, fontSize: 13, color: breezeMsg.startsWith('❌') ? '#b32d19' : '#166534' }}>
            {breezeMsg}
          </div>
        )}

        {/* Holdings preview */}
        {breezePreview?.holdings?.length > 0 && (
          <div style={{ marginTop: 14 }}>
            {/* Total portfolio value (incl. pledged-for-margin ETFs) — shown on top */}
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap',
              padding: '16px 20px', marginBottom: 12, borderRadius: 10,
              background: 'rgba(184,239,67,0.07)', border: '1px solid var(--border-md)',
            }}>
              <div>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)', letterSpacing: 0.3 }}>PORTFOLIO VALUE (incl. pledged)</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--text-primary)' }}>
                  ₹{breezePreview.holdings.reduce((s, h) => s + (Number(h.curVal) || 0), 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </div>
              </div>
              {breezePreview.holdings.some((h) => h.pledged) && (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 420 }}>
                  📌 includes {breezePreview.holdings.filter((h) => h.pledged).length} pledged-for-margin holding(s) worth ₹
                  {breezePreview.holdings.filter((h) => h.pledged).reduce((s, h) => s + (Number(h.curVal) || 0), 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  {' '}— previously missing because Breeze reported their demat qty as 0.
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Preview — {breezePreview.count} holdings</span>
              <input type="date" value={portfolioDate} onChange={(e) => setPortfolioDate(e.target.value)}
                style={{ padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-md)', borderRadius: 6, fontSize: 13, color: 'var(--text-primary)' }} />
              <button
                onClick={handleBreezeSave} disabled={breezeSaving}
                style={{ background: 'var(--lime)', color: '#ffffff', border: 'none', borderRadius: 6, padding: '9px 16px', cursor: breezeSaving ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: 13 }}
              >
                {breezeSaving ? '⏳ Saving…' : `✅ Save as Rams · ${portfolioDate}`}
              </button>
              <button
                onClick={() => { setBreezePreview(null); setPledgedRows([]); }}
                style={{ background: 'none', border: '1px solid var(--border-md)', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)' }}
              >
                Discard
              </button>
            </div>
            <div className="preview-scroll" style={{ overflowX: 'auto', maxHeight: 'min(70vh, 620px)', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-elevated)' }}>
                  <tr style={{ borderBottom: '2px solid var(--border-md)' }}>
                    {['Symbol','Exchange','Qty','Avg Cost','LTP','Invested','Curr. Value','P&L','Net Chg%'].map((h) => (
                      <th scope="col" key={h} style={{ padding: '6px 8px', textAlign: h === 'Symbol' || h === 'Exchange' ? 'left' : 'right', fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {breezePreview.holdings.map((h, i) => (
                    <tr key={`${h.instrument}-${i}`} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg-hover)' }}>
                      <td style={{ padding: '7px 11px', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {h.instrument}
                        {h.pledged && (
                          <span title="Pledged for margin (SAM) — you own these but they can't be sold without unpledging. Breeze demat qty was 0; quantity taken from portfolio holdings."
                            style={{ marginLeft: 6, fontSize: 11, padding: '1px 6px', borderRadius: 10, whiteSpace: 'nowrap',
                              background: 'rgba(154, 91, 6,0.15)', color: '#9a5b06', border: '1px solid rgba(154, 91, 6,0.35)' }}>
                            📌 pledged
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '7px 11px', color: 'var(--text-muted)' }}>{h.exchange}</td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: 'var(--text-secondary)' }}>{h.qty}</td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: 'var(--text-secondary)' }}>₹{Number(h.avgCost).toFixed(2)}</td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: 'var(--text-secondary)' }}>₹{Number(h.ltp).toFixed(2)}</td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: 'var(--text-secondary)' }}>₹{Number(h.invested).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: 'var(--text-secondary)' }}>₹{Number(h.curVal).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: h.pnl >= 0 ? '#05664a' : '#b32d19', fontWeight: 600 }}>
                        {h.pnl >= 0 ? '+' : ''}₹{Number(h.pnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: h.netChg >= 0 ? '#05664a' : '#b32d19' }}>
                        {h.netChg >= 0 ? '+' : ''}{Number(h.netChg).toFixed(2)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ── Pledged Holdings ── */}
            <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--bg-elevated)', borderRadius: 8, border: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
                🔒 Pledged Holdings — manual add for anything still missing. (Gold/silver ETFs pledged for SAM now come through automatically, tagged 📌 above — no need to re-add them here or you'll double-count.)
              </div>
              {pledgedRows.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 8 }}>
                  <thead><tr style={{ borderBottom: '1px solid var(--border-md)' }}>
                    {['Symbol','Qty','Avg Cost (₹)',''].map((h) => (
                      <th scope="col" key={h} style={{ padding: '6px 10px', textAlign: h === '' ? 'center' : 'left', color: 'var(--text-muted)', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {pledgedRows.map((r, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '6px 10px', fontWeight: 600, color: 'var(--text-primary)' }}>{r.instrument}</td>
                        <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>{r.qty}</td>
                        <td style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>{r.avgCost}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                          <button onClick={() => setPledgedRows((prev) => prev.filter((_, j) => j !== i))}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#b32d19', fontWeight: 700, fontSize: 14 }}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input placeholder="Symbol (e.g. GOLDBEES)" value={pledgedForm.instrument}
                  onChange={(e) => setPledgedForm((f) => ({ ...f, instrument: e.target.value.toUpperCase() }))}
                  style={{ padding: '6px 10px', background: 'var(--bg-card)', border: '1px solid var(--border-md)', borderRadius: 6, fontSize: 13, color: 'var(--text-primary)', width: 160 }} />
                <input placeholder="Qty" type="number" value={pledgedForm.qty}
                  onChange={(e) => setPledgedForm((f) => ({ ...f, qty: e.target.value }))}
                  style={{ padding: '6px 10px', background: 'var(--bg-card)', border: '1px solid var(--border-md)', borderRadius: 6, fontSize: 13, color: 'var(--text-primary)', width: 80 }} />
                <input placeholder="Avg Cost ₹" type="number" value={pledgedForm.avgCost}
                  onChange={(e) => setPledgedForm((f) => ({ ...f, avgCost: e.target.value }))}
                  style={{ padding: '6px 10px', background: 'var(--bg-card)', border: '1px solid var(--border-md)', borderRadius: 6, fontSize: 13, color: 'var(--text-primary)', width: 100 }} />
                <button
                  onClick={() => {
                    if (!pledgedForm.instrument.trim() || !pledgedForm.qty) return;
                    setPledgedRows((prev) => [...prev, { ...pledgedForm }]);
                    setPledgedForm(PLEDGED_EMPTY);
                  }}
                  style={{ background: 'var(--lime)', color: '#ffffff', border: 'none', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}
                >+ Add</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Kite Connect Panel ─────────────────────────────────────────── */}
      <div style={{
        border: '1px solid var(--border-md)', borderRadius: 8, padding: '14px 16px',
        marginBottom: 18, background: kiteStatus?.connected ? 'rgba(184,239,67,0.06)' : 'var(--bg-card)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>🔌 Zerodha Kite — Geetha</span>
          {kiteStatus && (
            <span style={{
              fontSize: 13, fontWeight: 600, padding: '2px 10px', borderRadius: 12,
              background: kiteStatus.connected ? 'rgba(184,239,67,0.15)' : 'rgba(239,68,68,0.15)',
              color:      kiteStatus.connected ? 'var(--lime)' : '#b32d19',
            }}>
              {kiteStatus.connected
                ? `● Connected · expires ${new Date(kiteStatus.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : '○ Not connected'}
            </span>
          )}
          {kiteStatus?.connected && (
            <>
              <button
                onClick={handleKiteFetch} disabled={kiteFetching}
                style={{ background: 'var(--primary, #1355a8)', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 12px', cursor: kiteFetching ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 13 }}
              >
                {kiteFetching ? '⏳ Fetching…' : '📥 Fetch Holdings'}
              </button>
            </>
          )}
        </div>

        {!kiteStatus?.connected && (
          // Connecting lives on Daily Sync, which owns the broker session and already has one
          // implementation of this flow for both brokers. Duplicating the login and token entry
          // here meant two copies free to drift apart.
          <p style={{ margin: 0, fontSize: 13.5, color: '#565a6b' }}>
            Not connected.{' '}
            <Link to="/daily-sync" style={{ color: '#1355a8', fontWeight: 600 }}>
              Connect Zerodha Kite on Daily Sync
            </Link>{' '}
            to fetch holdings.
          </p>
        )}

        {kiteMsg && (
          <div style={{ marginTop: 8, fontSize: 13, color: kiteMsg.startsWith('❌') ? '#b32d19' : 'var(--lime)' }}>
            {kiteMsg}
          </div>
        )}

        {/* Holdings preview */}
        {kitePreview?.holdings?.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Preview — {kitePreview.count} holdings</span>
              <input type="date" value={portfolioDate} onChange={(e) => setPortfolioDate(e.target.value)}
                style={{ padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-md)', borderRadius: 6, fontSize: 13, color: 'var(--text-primary)' }} />
              <button
                onClick={handleKiteSave} disabled={kiteSaving}
                style={{ background: 'var(--lime)', color: '#ffffff', border: 'none', borderRadius: 6, padding: '9px 16px', cursor: kiteSaving ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: 13 }}
              >
                {kiteSaving ? '⏳ Saving…' : `✅ Save as Geetha · ${portfolioDate}`}
              </button>
              <button
                onClick={() => setKitePreview(null)}
                style={{ background: 'none', border: '1px solid var(--border-md)', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)' }}
              >
                Discard
              </button>
            </div>
            <div className="preview-scroll" style={{ overflowX: 'auto', maxHeight: 'min(70vh, 620px)', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-elevated)' }}>
                  <tr style={{ borderBottom: '2px solid var(--border-md)' }}>
                    {['Symbol','Exchange','Qty','Avg Cost','LTP','Invested','Curr. Value','P&L','Day Chg%','Net Chg%'].map((h) => (
                      <th scope="col" key={h} style={{ padding: '6px 8px', textAlign: h === 'Symbol' || h === 'Exchange' ? 'left' : 'right', fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {kitePreview.holdings.map((h, i) => (
                    <tr key={h.instrument} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg-hover)' }}>
                      <td style={{ padding: '7px 11px', fontWeight: 600, color: 'var(--text-primary)' }}>{h.instrument}</td>
                      <td style={{ padding: '7px 11px', color: 'var(--text-muted)' }}>{h.exchange}</td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: 'var(--text-secondary)' }}>{h.qty}</td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: 'var(--text-secondary)' }}>₹{Number(h.avgCost).toFixed(2)}</td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: 'var(--text-secondary)' }}>₹{Number(h.ltp).toFixed(2)}</td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: 'var(--text-secondary)' }}>₹{Number(h.invested).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: 'var(--text-secondary)' }}>₹{Number(h.curVal).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: h.pnl >= 0 ? '#05664a' : '#b32d19', fontWeight: 600 }}>
                        {h.pnl >= 0 ? '+' : ''}₹{Number(h.pnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: h.dayChg >= 0 ? '#05664a' : '#b32d19' }}>
                        {h.dayChg >= 0 ? '+' : ''}{Number(h.dayChg).toFixed(2)}%
                      </td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: h.netChg >= 0 ? '#05664a' : '#b32d19' }}>
                        {h.netChg >= 0 ? '+' : ''}{Number(h.netChg).toFixed(2)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ── Cost Basis Overrides Panel ── */}
      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <h2 style={{ margin: 0 }}>Cost Basis Override
              {cbOverrides && cbOverrides.length > 0 && (
                <span className="action-count-badge action-count-HOLD" style={{ marginLeft: 8, verticalAlign: 'middle' }}>{cbOverrides.length}</span>
              )}
            </h2>
            <p style={{ margin: '4px 0 0', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              Fix invested values for ICICI Breeze portfolios where API doesn't provide average buy price
            </p>
          </div>
          <button
            onClick={() => setCbExpanded((v) => !v)}
            className="modal-close"
          >{cbExpanded ? 'Collapse ▲' : 'Manage ▼'}</button>
        </div>

        {cbExpanded && (
          <div style={{ marginTop: 16, display: 'grid', gap: 18 }}>
            <div className="filters" style={{ alignItems: 'flex-start' }}>
              <select value={cbPortfolio} onChange={(e) => { setCbPortfolio(e.target.value); setCbMsg(''); }}>
                <option value="Rams">Rams</option>
                <option value="Geetha">Geetha</option>
              </select>
            </div>

            {/* Current overrides table */}
            {cbOverrides && cbOverrides.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table compact-table">
                  <thead>
                    <tr><th scope="col">Symbol</th><th scope="col">Avg Cost</th><th scope="col">Qty (at snapshot)</th><th scope="col">As-of Date</th><th scope="col">Source</th><th scope="col"></th></tr>
                  </thead>
                  <tbody>
                    {cbOverrides.map((o) => (
                      <tr key={o.symbol}>
                        <td className="symbol-button">{o.symbol}</td>
                        <td>₹{Number(o.avg_cost).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td>{o.qty_at_override || '—'}</td>
                        <td>{o.as_of_date || '—'}</td>
                        <td><span className="source-pill source-recomputed">{o.source}</span></td>
                        <td>
                          <button
                            onClick={() => handleDeleteOverride(o.symbol)}
                            style={{ background: 'none', border: '1px solid var(--border-md)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.78rem' }}
                          >✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {cbOverrides && cbOverrides.length === 0 && (
              <p className="muted" style={{ fontSize: '0.88rem' }}>No overrides yet for {cbPortfolio}.</p>
            )}

            {/* CSV Import */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
              <p style={{ margin: '0 0 8px', fontWeight: 600, fontSize: '0.9rem' }}>Import from CSV</p>
              <p className="muted" style={{ fontSize: '0.82rem', margin: '0 0 8px' }}>
                Paste CSV with columns: <code>symbol, avg_cost, qty, date</code><br />
                Example (from ICICI Direct portfolio export before 15-May-2026):<br />
                <code>BAJFI,752.30,140,2026-05-14</code>
              </p>
              <textarea
                value={cbCsvText}
                onChange={(e) => setCbCsvText(e.target.value)}
                placeholder={'symbol,avg_cost,qty,date\nBAJFI,752.30,140,2026-05-14\nANARAT,1450.00,356,2026-05-14'}
                rows={8}
                style={{
                  width: '100%', fontFamily: 'monospace', fontSize: '0.82rem',
                  background: 'var(--bg-elevated)', color: 'var(--text-primary)',
                  border: '1px solid var(--border-md)', borderRadius: 8, padding: 10, resize: 'vertical',
                }}
              />
              <div style={{ display: 'flex', gap: 12, marginTop: 8, alignItems: 'center' }}>
                <button
                  className="filters button"
                  onClick={handleCostBasisImport}
                  disabled={cbImporting || !cbCsvText.trim()}
                  style={{ padding: '9px 18px', borderRadius: 10, border: 0, background: 'var(--lime)', color: '#ffffff', fontWeight: 700, cursor: 'pointer', opacity: cbImporting || !cbCsvText.trim() ? 0.5 : 1 }}
                >{cbImporting ? 'Importing…' : 'Import Cost Basis'}</button>
                {cbMsg && <span style={{ fontSize: '0.88rem', color: cbMsg.startsWith('✅') ? '#05664a' : '#b32d19' }}>{cbMsg}</span>}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="filters">
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          <option value="verdict">Action (verdict)</option>
          <option value="weight">Weight %</option>
          <option value="combined">Combined Score</option>
          <option value="n500Rank">N500 Rank</option>
          <option value="momentum">Momentum</option>
          <option value="fundamental">Fundamental</option>
          <option value="value">Value</option>
          <option value="pnl">P&amp;L</option>
          <option value="symbol">Symbol</option>
          <option value="cmpVs50DmaPct">vs 50DMA %</option>
          <option value="cmpVs200DmaPct">vs 200DMA %</option>
          <option value="return3M">3M Return %</option>
          <option value="trendStatus">Trend</option>
          <option value="crossSignal">MA Cross</option>
        </select>
        <select value={sortDir} onChange={(e) => setSortDir(e.target.value)}>
          <option value="desc">High to Low</option>
          <option value="asc">Low to High</option>
        </select>
        <button type="button" onClick={handleRefreshScores}>Refresh Scores</button>
      </div>
      {refreshState ? <p className="status-note">{refreshState}</p> : null}

      <div className="stats-grid">
        <StatCard label="Invested"       value={liveSummary.invested > 0 ? `₹${fmt(liveSummary.invested)}` : 'N/A'}
          helper={liveSummary.invested > 0 ? `${liveSummary.withCost}/${liveSummary.stocks} have cost basis` : 'no cost basis'} />
        <StatCard label="Value (live)"   value={liveSummary.value > 0 ? `₹${fmt(liveSummary.value)}` : '-'}
          helper="live prices" />
        <StatCard label="Day Change %"   value={data?.latestSummary ? `${data.latestSummary.day_change_pct.toFixed(2)}%` : '-'}
          tone={data?.latestSummary?.day_change_pct >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Stocks"         value={liveSummary.stocks || '-'} helper={data?.scoreDate || ''} />
        <StatCard label="Avg Combined"   value={data?.scoreSummary ? data.scoreSummary.combinedAverage.toFixed(1) : '-'}
          helper={`${data?.scoreSummary?.scored || 0}/${data?.scoreSummary?.total || 0} scored`} />
        <StatCard label="Avg Momentum"   value={data?.scoreSummary ? data.scoreSummary.momentumAverage.toFixed(1) : '-'}
          helper={data?.scoreDate || 'No score date'} />
      </div>

      <AsOfReportPanel />

      <div className="panel">
        <h2>Current Holdings ({sortedHoldings.length})</h2>
        {(() => {
          const tally = sortedHoldings.reduce((a, h) => { a[h.verdict] = (a[h.verdict] || 0) + 1; return a; }, {});
          const concentrated = sortedHoldings.filter((h) => h.weightPct >= 15);
          return (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '0 0 12px' }}>
              {['ADD', 'HOLD', 'TRIM', 'REVIEW'].map((v) => tally[v] ? (
                <span key={v}><VerdictBadge verdict={v} /> <strong>{tally[v]}</strong></span>
              ) : null)}
              {concentrated.length > 0 && (
                <span style={{ marginLeft: 8, fontSize: '0.8rem', color: '#9a3412', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '5px 12px' }}>
                  ⚠ Concentration: {concentrated.map((h) => `${h.symbol} ${h.weightPct.toFixed(0)}%`).join(' · ')}
                </span>
              )}
              <span style={{ fontSize: '0.78rem', color: '#656974', marginLeft: 'auto' }}>
                Hover a verdict badge for the reason
              </span>
            </div>
          );
        })()}
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table compact-table">
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Symbol</th>
                <th scope="col">Port.</th>
                <th scope="col">Value / Wt</th>
                <th scope="col">P&amp;L</th>
                <th scope="col">vs 50 / 200 DMA</th>
                <th scope="col">3M Ret</th>
                <th scope="col">Trend</th>
                <th scope="col">Momentum</th>
                <th scope="col">Combined</th>
                <th scope="col">N500 Rank</th>
              </tr>
            </thead>
            <tbody>
              {sortedHoldings.map((h) => {
                const mm = h.momentumMetrics || {};
                return (
                  <tr key={`${h.portfolio}-${h.symbol}`} style={h.dead ? { opacity: 0.55 } : undefined}>
                    <td><VerdictBadge verdict={h.verdict} reasons={h.verdictReasons} /></td>
                    <td>
                      <div className="symbol-cell">
                        <button type="button" className="symbol-button" onClick={() => setSelected(h)}>{h.symbol}</button>
                        {/* Delisted/suspended: no price BY NATURE. Tagged so it reads as a known
                            dead holding rather than a data failure — the two look identical
                            otherwise, and conflating them teaches you to ignore missing prices. */}
                        {h.dead && (
                          <span title={[
                            h.deadInfo?.name ? `${h.deadInfo.name} — ${h.deadInfo.status}` : h.deadInfo?.status,
                            h.deadInfo?.note,
                            '',
                            'Zero cost, no order history, and no quote under any candidate symbol. Contributes ₹0 to portfolio value.',
                          ].filter(Boolean).join('\n')}
                            style={{ marginLeft: 6, fontSize: 11, fontWeight: 800, padding: '1px 5px',
                              borderRadius: 3, background: '#e4e6ea', color: '#565a6b', cursor: 'help' }}>
                            ☠ DEAD
                          </span>
                        )}
                        <span>{h.sector}</span>
                      </div>
                    </td>
                    <td>{h.portfolio}</td>
                    <td>
                      <div style={{ fontWeight: 600 }}>₹{fmt(h.currentValue)}</div>
                      <div className={h.weightPct >= 15 ? 'negative' : 'muted'} style={{ fontSize: 12.5, fontWeight: h.weightPct >= 15 ? 700 : 400 }}>
                        {h.weightPct >= 15 ? '⚠ ' : ''}{h.weightPct.toFixed(1)}%
                      </div>
                    </td>
                    <td className={h.pnl == null ? 'muted' : h.pnl >= 0 ? 'positive' : 'negative'}>
                      {h.pnl == null ? 'N/A' : `₹${fmt(h.pnl)}`}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span className={mm.cmpVs50DmaPct == null ? 'muted' : mm.cmpVs50DmaPct >= 0 ? 'positive' : 'negative'}>
                        {mm.cmpVs50DmaPct == null ? '-' : fmtPct(mm.cmpVs50DmaPct)}
                      </span>
                      <span className="muted"> / </span>
                      <span className={mm.cmpVs200DmaPct == null ? 'muted' : mm.cmpVs200DmaPct >= 0 ? 'positive' : 'negative'}>
                        {mm.cmpVs200DmaPct == null ? '-' : fmtPct(mm.cmpVs200DmaPct)}
                      </span>
                    </td>
                    <td className={mm.return3M == null ? '' : mm.return3M >= 0 ? 'positive' : 'negative'}>
                      {mm.return3M == null ? '-' : fmtPct(mm.return3M)}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span className={mm.trendStatus?.includes('Uptrend') ? 'positive' : mm.trendStatus === 'Breakdown' ? 'negative' : ''}>
                        {mm.trendStatus || '-'}
                      </span>
                      {' '}<CrossBadge dma50={mm.dma50} dma200={mm.dma200} />
                    </td>
                    <td><ScorePill value={h.scores.momentum.value}    label={h.scores.momentum.label} /></td>
                    <td><ScorePill value={h.scores.combined.value}    label={h.scores.combined.label} /></td>
                    <td style={{ textAlign: 'center' }}>
                      {h.n500Rank != null ? (
                        <span title={`Rank ${h.n500Rank} of ${h.n500Total} in the Nifty 500 daily ranked list`}
                          style={{
                            display: 'inline-block', minWidth: 34, padding: '4px 10px', borderRadius: 12,
                            fontWeight: 700, fontSize: 13,
                            background: h.n500Rank <= 25 ? 'rgba(184,239,67,0.15)' : h.n500Rank <= 100 ? 'rgba(129,140,248,0.15)' : 'var(--bg-hover)',
                            color:      h.n500Rank <= 25 ? 'var(--lime)'          : h.n500Rank <= 100 ? '#1355a8'                : 'var(--text-secondary)',
                          }}>
                          #{h.n500Rank}
                        </span>
                      ) : <span className="muted" title="Not in a qualifying trend — outside the ranked list">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {downloadsScan ? (
        <div className="panel">
          <h2>Downloads Sync Result</h2>
          <p>{downloadsScan.scannedCount} file(s) scanned. Imported {downloadsScan.importedCount}, skipped {downloadsScan.skippedCount}.</p>
        </div>
      ) : null}

      <div className="panel">
        <h2>Recent Summaries</h2>
        <table className="data-table compact-table">
          <thead><tr><th scope="col">Date</th><th scope="col">Portfolio</th><th scope="col">Invested</th><th scope="col">Value</th><th scope="col">Day %</th></tr></thead>
          <tbody>
            {data?.summaries?.map((row, i) => (
              <tr key={`${row.portfolio}-${row.summary_date}-${i}`}>
                <td>{row.summary_date}</td>
                <td>{row.portfolio}</td>
                <td>₹{fmt(row.total_invested)}</td>
                <td>₹{fmt(row.total_value)}</td>
                <td className={row.day_change_pct >= 0 ? 'positive' : 'negative'}>{row.day_change_pct.toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PageShell>
  );
}

// ─────────────────────────────────────────
// ORDERS PAGE
// ─────────────────────────────────────────

function OrdersPage() {
  const [meta,          setMeta]          = useState(null);
  const [portfolio,     setPortfolio]     = useState('');
  const [symbol,        setSymbol]        = useState('');
  const [data,          setData]          = useState(null);
  const [error,         setError]         = useState('');
  const [uploadState,   setUploadState]   = useState('');
  const [downloadsScan, setDownloadsScan] = useState(null);
  const [sellOptions,   setSellOptions]   = useState([]);
  const [sellDateChoices,setSellDateChoices] = useState([]);
  const [selectedSellKey,setSelectedSellKey]= useState('');
  const [selectedSellDate,setSelectedSellDate]= useState('');
  const [sellEvaluation,setSellEvaluation]= useState(null);
  const [buyReport,     setBuyReport]     = useState(null);
  const [buyPortfolio,  setBuyPortfolio]  = useState('');
  const [buySortBy,     setBuySortBy]     = useState('recentWindow');
  const [buySortDir,    setBuySortDir]    = useState('desc');
  // Broker order sync
  const [breezeStatus,  setBreezeStatus]  = useState(null);
  const [kiteStatus,    setKiteStatus]    = useState(null);
  const [ordPreview,    setOrdPreview]    = useState(null);   // { broker, portfolio, orders }
  const [ordBusy,       setOrdBusy]       = useState('');
  const [ordMsg,        setOrdMsg]        = useState('');
  const [ordFrom,       setOrdFrom]       = useState(() => new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10));
  const [ordTo,         setOrdTo]         = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    fetchOrdersMeta().then(setMeta).catch((err) => setError(err.message));
    fetchSellEvaluatorOptions().then(setSellOptions).catch((err) => setError(err.message));
    fetchSellEvaluatorDates().then(setSellDateChoices).catch((err) => setError(err.message));
    fetchBuyEvaluatorReport().then(setBuyReport).catch((err) => setError(err.message));
    fetchBreezeStatus().then(setBreezeStatus).catch(() => {});
    fetchKiteStatus().then(setKiteStatus).catch(() => {});
  }, []);

  async function handleBrokerFetch(broker) {
    try {
      setOrdBusy(broker); setOrdMsg(''); setError('');
      const res = broker === 'breeze' ? await fetchBreezeOrders(ordFrom, ordTo) : await fetchKiteOrders();
      const portfolio = broker === 'breeze' ? 'Rams' : 'Geetha';
      const count = res.count ?? (res.orders || []).length;
      setOrdPreview({ broker, portfolio, orders: res.orders || [] });
      if (broker === 'kite' && count === 0) {
        const book = res.orderBook || [];
        if (book.length) {
          const summary = book.map((o) => `${o.symbol} ${o.side} ${o.filled}/${o.quantity} [${o.status}]`).join(', ');
          setOrdMsg(`Kite shows ${book.length} order(s) today but 0 executed fills — only filled trades are imported. Found: ${summary}. (Cancelled/rejected/unfilled orders never executed, so there's nothing to record.)`);
        } else {
          setOrdMsg('Kite returned 0 trades. The Kite API only exposes TODAY\'s tradebook (no historical) — if Geetha traded on an earlier day, export the Tradebook CSV from Kite Console (Reports → Tradebook) and use "Upload orders file" below.');
        }
      } else {
        const range = broker === 'breeze' ? ` (${res.from} → ${res.to}, all segments)` : ' (today only)';
        setOrdMsg(`Fetched ${count} ${broker === 'breeze' ? 'Breeze' : 'Kite'} trade(s)${range}.`);
      }
    } catch (err) { setError(err.message); } finally { setOrdBusy(''); }
  }

  async function handleBrokerSave() {
    if (!ordPreview?.orders?.length) return;
    try {
      setOrdBusy('save'); setError('');
      const { broker, portfolio, orders } = ordPreview;
      const res = broker === 'breeze'
        ? await saveBreezeOrders({ orders, portfolio })
        : await saveKiteOrders({ orders, portfolio });
      const inserted = res.inserted ?? 0;
      const skipped = res.skipped ?? 0;

      // RECONCILE what was sent against what the server accounted for.
      //
      // Every fetched trade must come back as either inserted or skipped-as-duplicate. When it
      // does not, rows were dropped — and that failure is otherwise invisible, because
      // "Saved 0 new order(s)" reads exactly the same whether 0 means "all were already there"
      // or "the insert threw and nothing was written". A schema error did precisely that for
      // two days: the fetch succeeded, the save reported nothing, and the P&L stayed at zero.
      const accounted = inserted + skipped;
      if (accounted !== orders.length) {
        setError(`⚠ Import did not account for every trade: sent ${orders.length}, `
          + `inserted ${inserted}, skipped ${skipped} — ${orders.length - accounted} unaccounted for. `
          + `Nothing was silently dropped without this warning; check the server log and re-run.`);
      } else if (inserted === 0 && skipped > 0) {
        setOrdMsg(`Nothing new — all ${skipped} trade(s) for ${portfolio} were already saved`
          + `${(res.dates || []).length ? ` (${(res.dates || []).join(', ')})` : ''}.`);
      }

      const skipMsg = skipped ? ` · skipped ${skipped} duplicate(s) already in DB` : '';
      const recs = res.autoRecommendations || [];
      const recMsg = recs.length
        ? ` · 🏆 auto-added ${recs.length} recommendation(s) from Top 25 buys: ${recs.map((r) => `${r.symbol} @₹${r.entry}→₹${r.target}`).join(', ')}`
        : '';
      if (!(inserted === 0 && skipped > 0) && accounted === orders.length) {
        setOrdMsg(`Saved ${inserted} new order(s) for ${portfolio}${skipMsg}${(res.dates || []).length ? ` (${(res.dates || []).join(', ')})` : ''}${recMsg}.`);
      }
      if (accounted === orders.length) setOrdPreview(null);
      fetchOrders({ segment: 'equity', portfolio: '', symbol: '' }).then(setData).catch(() => {});
      fetchOrdersMeta().then(setMeta).catch(() => {});
    } catch (err) { setError(err.message); } finally { setOrdBusy(''); }
  }

  useEffect(() => {
    fetchOrders({ segment: 'equity', portfolio, symbol }).then(setData).catch((err) => setError(err.message));
  }, [portfolio, symbol]);

  async function handleOrdersFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setUploadState('Parsing…');
      setError('');
      const text = await fileToText(file);
      const ordersByDate = parseZerodhaOrders(text);
      const dateCount = Object.keys(ordersByDate).length;
      if (!dateCount) throw new Error('No orders parsed.');
      const target = portfolio || 'Rams';
      setUploadState(`Uploading ${dateCount} dates into ${target}…`);
      await uploadOrdersImport({ portfolio: target, fileName: file.name, ordersByDate });
      const [um, ud, ub] = await Promise.all([fetchOrdersMeta(), fetchOrders({ segment: 'equity', portfolio: target, symbol }), fetchBuyEvaluatorReport()]);
      setMeta(um); setData(ud); setBuyReport(ub); setPortfolio(target);
      setUploadState(`Imported ${file.name} into ${target}.`);
    } catch (err) { setError(err.message); setUploadState(''); } finally { e.target.value = ''; }
  }

  async function handleDownloadsImport() {
    try {
      setUploadState('Scanning Downloads…');
      setError('');
      const result = await importOrderDownloads();
      const [ud, um, uso, usd, ub] = await Promise.all([
        fetchOrders({ segment: 'equity', portfolio, symbol }),
        fetchOrdersMeta(),
        fetchSellEvaluatorOptions(),
        fetchSellEvaluatorDates(),
        fetchBuyEvaluatorReport(),
      ]);
      setData(ud); setMeta(um); setSellOptions(uso); setSellDateChoices(usd); setBuyReport(ub);
      setDownloadsScan(result);
      setUploadState(result.insertedOrders > 0 ? `Imported ${result.insertedOrders} new order(s).` : 'No new orders found.');
    } catch (err) { setError(err.message); setUploadState(''); }
  }

  async function handleSellKeyChange(e) {
    const value = e.target.value;
    setSelectedSellKey(value); setSellEvaluation(null); setSelectedSellDate('');
    if (!value) return;
    try {
      setUploadState('Evaluating…');
      // No portfolio — pulls sells from every portfolio that sold this symbol.
      const result = await fetchSellEvaluation({ symbol: value });
      setSellEvaluation(result); setUploadState('');
    } catch (err) { setError(err.message); setUploadState(''); }
  }

  async function handleSellDateChange(e) {
    const value = e.target.value;
    setSelectedSellDate(value); setSellEvaluation(null); setSelectedSellKey('');
    if (!value) return;
    try {
      setUploadState('Evaluating date…');
      const result = await fetchSellEvaluation({ saleDate: value });
      setSellEvaluation(result); setUploadState('');
    } catch (err) { setError(err.message); setUploadState(''); }
  }

  const sortedBuyRows = useMemo(() => {
    const rows = [...(buyReport?.rows || [])].filter((r) => !buyPortfolio || r.portfolio === buyPortfolio);
    const getters = {
      recentWindow: (r) => r.lastBuyDate || '',
      portfolio:    (r) => r.portfolio || '',
      symbol:       (r) => r.symbol || '',
      quantity:     (r) => Number(r.quantity || 0),
      averageBuyPrice:(r)=> Number(r.averageBuyPrice || 0),
      currentPrice: (r) => Number(r.currentPrice || 0),
      cmpVs50DmaPct:(r) => Number(r.cmpVs50DmaPct || 0),
      return3M:     (r) => Number(r.return3M || 0),
      trendStatus:  (r) => r.trendStatus || '',
      crossSignal:  (r) => { const s = getCrossSignal(r.dma50, r.dma200); return s === 'golden' ? 1 : s === 'death' ? -1 : 0; },
    };
    const getter = getters[buySortBy] || getters.recentWindow;
    rows.sort((a, b) => {
      const av = getter(a), bv = getter(b);
      if (typeof av === 'string') return buySortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return buySortDir === 'asc' ? av - bv : bv - av;
    });
    return rows;
  }, [buyReport, buySortBy, buySortDir, buyPortfolio]);

  return (
    <PageShell title="Orders" subtitle="Trade history, sell outcome evaluator, buy tracker">
      {error ? <p className="negative">{error}</p> : null}
      <div className="filters">
        <select value={portfolio} onChange={(e) => setPortfolio(e.target.value)}>
          <option value="">All portfolios</option>
          {meta?.portfolios?.map((p) => <option key={p.portfolio} value={p.portfolio}>{p.portfolio}</option>)}
        </select>
        <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="Filter by symbol" />
        <label className="upload-button">
          Upload Orders File
          <input type="file" accept=".csv,.txt,.xlsx,.xls" onChange={handleOrdersFileChange} hidden />
        </label>
        <button type="button" onClick={handleDownloadsImport}>Sync Downloads</button>
      </div>
      {uploadState ? <p className="status-note">{uploadState}</p> : null}

      {/* Import today's executed trades from broker APIs */}
      <div className="panel">
        <h2>Import Orders from Broker</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.86rem', marginTop: 4 }}>
          Pulls <strong>executed trades</strong> (real fill prices) from the broker APIs — Rams via ICICI Breeze, Geetha via Zerodha Kite.
          Breeze pulls <strong>all segments</strong> (cash + F&amp;O, NSE + BSE) over the chosen date range; Kite returns today only.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0' }}>
          <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            From <input type="date" value={ordFrom} max={ordTo} onChange={(e) => setOrdFrom(e.target.value)}
              style={{ padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-md)', borderRadius: 6, fontSize: 13, color: 'var(--text-primary)' }} />
          </label>
          <label style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            To <input type="date" value={ordTo} min={ordFrom} onChange={(e) => setOrdTo(e.target.value)}
              style={{ padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-md)', borderRadius: 6, fontSize: 13, color: 'var(--text-primary)' }} />
          </label>
          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>(Breeze only)</span>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', margin: '8px 0' }}>
          <button type="button" onClick={() => handleBrokerFetch('breeze')}
            disabled={!breezeStatus?.connected || ordBusy === 'breeze'}
            style={{ background: breezeStatus?.connected ? 'var(--primary, #1355a8)' : 'rgba(27, 29, 40, 0.06)', color: breezeStatus?.connected ? '#fff' : 'var(--text-muted)', border: 'none', borderRadius: 6, padding: '10px 18px', fontWeight: 600, fontSize: 14, cursor: breezeStatus?.connected ? 'pointer' : 'not-allowed' }}>
            {ordBusy === 'breeze' ? '⏳ Fetching…' : '📥 Fetch Rams (Breeze)'}
          </button>
          <span style={{ fontSize: 13, color: breezeStatus?.connected ? 'var(--lime)' : '#b32d19' }}>
            {breezeStatus?.connected ? '● Breeze connected' : '○ Breeze not connected (Portfolio → Login)'}
          </span>
          <button type="button" onClick={() => handleBrokerFetch('kite')}
            disabled={!kiteStatus?.connected || ordBusy === 'kite'}
            style={{ background: kiteStatus?.connected ? 'var(--primary, #1355a8)' : 'rgba(27, 29, 40, 0.06)', color: kiteStatus?.connected ? '#fff' : 'var(--text-muted)', border: 'none', borderRadius: 6, padding: '10px 18px', fontWeight: 600, fontSize: 14, cursor: kiteStatus?.connected ? 'pointer' : 'not-allowed' }}>
            {ordBusy === 'kite' ? '⏳ Fetching…' : '📥 Fetch Geetha (Kite)'}
          </button>
          {kiteStatus?.connected ? (
            <span style={{ fontSize: 13, color: 'var(--lime)' }}>● Kite connected</span>
          ) : (
            <span style={{ fontSize: 13, color: '#b32d19', display: 'inline-flex', gap: 10, alignItems: 'center' }}>
              ○ Kite not connected
              {/* The login URL is built SERVER-SIDE from this participant's own stored key. It
                  used to be a literal here with the developer's api_key in it, which put a live
                  credential into every browser that loaded the page — and would have been wrong
                  for all 25 participants besides. */}
              <button type="button"
                 className="btn-link"
                 onClick={async () => {
                   const r = await fetch('/api/kite/login-url').then((x) => x.json()).catch(() => null);
                   if (r?.loginUrl) window.open(r.loginUrl, '_blank', 'noopener');
                   else window.location.href = '/brokers';
                 }}
                 style={{ background: '#9a5b06', color: '#fff', border: 'none', textDecoration: 'none', borderRadius: 5, padding: '7px 13px', fontWeight: 600, cursor: 'pointer' }}>
                🔑 Login with Kite ↗
              </button>
              <button type="button" onClick={() => fetchKiteStatus().then(setKiteStatus)}
                style={{ background: 'none', border: '1px solid var(--border-md)', borderRadius: 5, padding: '3px 8px', cursor: 'pointer', fontSize: 12.5, color: 'var(--text-secondary)' }}>
                ↻ Re-check
              </button>
            </span>
          )}
        </div>
        {ordMsg && <div style={{ fontSize: 13, color: ordMsg.startsWith('❌') ? '#b32d19' : 'var(--lime)', marginBottom: 6 }}>{ordMsg}</div>}

        {ordPreview?.orders?.length > 0 && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>
                Preview — {ordPreview.orders.length} trade(s) → save as {ordPreview.portfolio}
              </span>
              <button type="button" onClick={handleBrokerSave} disabled={ordBusy === 'save'}
                style={{ background: 'var(--lime)', color: '#ffffff', border: 'none', borderRadius: 6, padding: '9px 16px', fontWeight: 700, fontSize: 13, cursor: ordBusy === 'save' ? 'not-allowed' : 'pointer' }}>
                {ordBusy === 'save' ? '⏳ Saving…' : `✅ Save ${ordPreview.portfolio} orders`}
              </button>
              <button type="button" onClick={() => setOrdPreview(null)}
                style={{ background: 'none', border: '1px solid var(--border-md)', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)' }}>
                Discard
              </button>
            </div>
            <div className="preview-scroll" style={{ overflowX: 'auto', maxHeight: 'min(70vh, 620px)', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-elevated)' }}>
                  <tr style={{ borderBottom: '2px solid var(--border-md)' }}>
                    {['Date', 'Symbol', 'Side', 'Qty', 'Price', 'Value', 'Exch', 'Type'].map((h) => (
                      <th scope="col" key={h} style={{ padding: '6px 8px', textAlign: h === 'Qty' || h === 'Price' || h === 'Value' ? 'right' : 'left', fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ordPreview.orders.map((o, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg-hover)' }}>
                      <td style={{ padding: '7px 11px', color: 'var(--text-muted)' }}>{o.trade_date}</td>
                      <td style={{ padding: '7px 11px', fontWeight: 600, color: 'var(--text-primary)' }}>{o.symbol}</td>
                      <td style={{ padding: '7px 11px', color: o.side === 'SELL' ? '#b32d19' : '#05664a', fontWeight: 600 }}>{o.side}</td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: 'var(--text-secondary)' }}>{o.quantity}</td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: 'var(--text-secondary)' }}>₹{Number(o.price).toFixed(2)}</td>
                      <td style={{ padding: '7px 11px', textAlign: 'right', color: 'var(--text-secondary)' }}>₹{Number(o.quantity * o.price).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                      <td style={{ padding: '7px 11px', color: 'var(--text-muted)' }}>{o.exchange}</td>
                      <td style={{ padding: '7px 11px', color: 'var(--text-muted)' }}>{o.product || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Sell Evaluator */}
      <div className="panel">
        <h2>Sell Outcome Evaluator</h2>
        <p style={{ color: '#565a6b', fontSize: '0.88rem' }}>
          Pick a stock you've sold — see every sale date with its realized P&L, and whether holding until today would have been better. FIFO cost basis, NSE prices.
        </p>
        <div className="filters">
          <select value={selectedSellKey} onChange={handleSellKeyChange}>
            <option value="">Choose a sold stock</option>
            {sellOptions.map((o) => <option key={o.symbol} value={o.symbol}>{o.symbol}</option>)}
          </select>
        </div>
        {sellEvaluation?.saleLots?.length ? (() => {
          // Aggregate sale lots by sale date + portfolio (a stock sold in both
          // portfolios on the same date gets its own row per portfolio).
          const byDate = {};
          for (const l of sellEvaluation.saleLots) {
            const key = `${l.saleDate}::${l.portfolio || ''}`;
            const d = byDate[key] || (byDate[key] = {
              saleDate: l.saleDate, portfolio: l.portfolio || '', qty: 0, saleValue: 0, realizedPnl: 0, holdValueToday: 0, missed: 0,
            });
            d.qty += l.soldQuantity; d.saleValue += l.saleValue;
            d.realizedPnl += l.realizedPnl; d.holdValueToday += l.holdValueToday; d.missed += l.missedProfitVsSale;
          }
          const rows = Object.values(byDate).sort((a, b) => b.saleDate.localeCompare(a.saleDate));
          const s = sellEvaluation.saleSummary || {};
          const pu = sellEvaluation.priceUnavailable;
          const multiPortfolio = (sellEvaluation.portfolios || []).length > 1;
          return (
            <div style={{ marginTop: 12 }}>
              <p style={{ fontSize: '0.85rem', color: '#565a6b' }}>
                <strong>{sellEvaluation.symbol}</strong> · {rows.length} sale(s)
                {sellEvaluation.portfolios ? ` · ${sellEvaluation.portfolios.join(' + ')}` : ''} · current price ₹{fmt(sellEvaluation.currentPrice, 2)}
                {sellEvaluation.currentPriceAsOf ? ` (as of ${sellEvaluation.currentPriceAsOf})` : ''}
              </p>
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table compact-table">
                  <thead>
                    <tr>
                      <th scope="col">Sale Date</th>{multiPortfolio && <th scope="col">Portfolio</th>}<th scope="col">Qty</th><th scope="col">Sale Price</th><th scope="col">Sale Value</th>
                      <th scope="col">Realized P&amp;L</th><th scope="col">Value if Held Today</th><th scope="col">Hold vs Sell</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.saleDate}::${r.portfolio}`}>
                        <td>{r.saleDate}</td>
                        {multiPortfolio && <td>{r.portfolio}</td>}
                        <td>{fmt(r.qty, 0)}</td>
                        <td>₹{fmt(r.qty > 0 ? r.saleValue / r.qty : 0, 2)}</td>
                        <td>₹{fmt(r.saleValue)}</td>
                        <td className={r.realizedPnl >= 0 ? 'positive' : 'negative'}>{r.realizedPnl >= 0 ? '+' : ''}₹{fmt(r.realizedPnl)}</td>
                        <td>{pu ? '—' : `₹${fmt(r.holdValueToday)}`}</td>
                        <td className={pu ? '' : r.missed >= 0 ? 'negative' : 'positive'}
                          title={pu ? 'Current price unavailable' : r.missed >= 0 ? 'Holding till today would have been better' : 'Selling avoided a loss'}>
                          {pu ? '—' : `${r.missed >= 0 ? '+' : ''}₹${fmt(r.missed)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700, borderTop: '2px solid #e4e6ea' }}>
                      <td>Total</td>
                      {multiPortfolio && <td>—</td>}
                      <td>{fmt(s.soldQuantity, 0)}</td>
                      <td>—</td>
                      <td>₹{fmt(s.totalSaleValue)}</td>
                      <td className={s.realizedPnlAtSale >= 0 ? 'positive' : 'negative'}>{s.realizedPnlAtSale >= 0 ? '+' : ''}₹{fmt(s.realizedPnlAtSale)}</td>
                      <td>{pu ? '—' : `₹${fmt(s.holdValueToday)}`}</td>
                      <td className={pu ? '' : s.missedProfitVsSale >= 0 ? 'negative' : 'positive'}>{pu ? '—' : `${s.missedProfitVsSale >= 0 ? '+' : ''}₹${fmt(s.missedProfitVsSale)}`}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p style={{ fontSize: '0.78rem', color: '#656974', marginTop: 6 }}>
                <strong>Realized P&amp;L</strong> = sale price vs FIFO cost. <strong>Hold vs Sell</strong>: red (+) = holding till today would have been better; green (−) = selling avoided a loss.
              </p>
            </div>
          );
        })() : (selectedSellKey ? <p className="muted">No completed sales found for this stock.</p> : null)}
      </div>

      {/* Buy Evaluator */}
      <div className="panel">
        <h2>Recent Buy Evaluator</h2>
        <p style={{ color: '#565a6b', fontSize: '0.88rem' }}>
          Buys from the last 3 months with momentum metrics for tracking trend strength.
        </p>
        <div className="filters">
          <select value={buyPortfolio} onChange={(e) => setBuyPortfolio(e.target.value)}>
            <option value="">All portfolios</option>
            {meta?.portfolios?.map((p) => <option key={p.portfolio} value={p.portfolio}>{p.portfolio}</option>)}
          </select>
          <select value={buySortBy} onChange={(e) => setBuySortBy(e.target.value)}>
            <option value="recentWindow">Recent Buy Window</option>
            <option value="symbol">Symbol</option>
            <option value="cmpVs50DmaPct">CMP vs 50DMA %</option>
            <option value="return3M">3M Return %</option>
            <option value="trendStatus">Trend</option>
            <option value="crossSignal">MA Cross</option>
            <option value="currentPrice">Current Price</option>
          </select>
          <select value={buySortDir} onChange={(e) => setBuySortDir(e.target.value)}>
            <option value="desc">High to Low</option>
            <option value="asc">Low to High</option>
          </select>
        </div>
        <p style={{ fontSize: '0.85rem', color: '#565a6b' }}>
          {buyReport ? `${sortedBuyRows.length} stocks since ${buyReport.fromDate}` : 'Loading…'}
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table compact-table">
            <thead>
              <tr>
                <th scope="col">Portfolio</th><th scope="col">Symbol</th><th scope="col">Qty</th><th scope="col">Avg Buy</th><th scope="col">Current</th>
                <th scope="col">vs 50DMA</th><th scope="col">vs 200DMA</th><th scope="col">MA Cross</th><th scope="col">3M Return</th><th scope="col">Buy Window</th><th scope="col">Trend</th>
              </tr>
            </thead>
            <tbody>
              {sortedBuyRows.map((r) => (
                <tr key={`${r.portfolio}-${r.symbol}`}>
                  <td>{r.portfolio}</td>
                  <td><strong>{r.symbol}</strong></td>
                  <td>{fmt(r.quantity, 2)}</td>
                  <td>{fmt(r.averageBuyPrice, 2)}</td>
                  <td>{r.currentPrice == null ? '-' : fmt(r.currentPrice, 2)}</td>
                  <td className={r.cmpVs50DmaPct == null ? '' : r.cmpVs50DmaPct >= 0 ? 'positive' : 'negative'}>
                    {r.cmpVs50DmaPct == null ? '-' : fmtPct(r.cmpVs50DmaPct)}
                  </td>
                  <td className={r.cmpVs200DmaPct == null ? '' : r.cmpVs200DmaPct >= 0 ? 'positive' : 'negative'}>
                    {r.cmpVs200DmaPct == null ? '-' : fmtPct(r.cmpVs200DmaPct)}
                  </td>
                  <td><CrossBadge dma50={r.dma50} dma200={r.dma200} /></td>
                  <td className={r.return3M == null ? '' : r.return3M >= 0 ? 'positive' : 'negative'}>
                    {r.return3M == null ? '-' : fmtPct(r.return3M)}
                  </td>
                  <td style={{ fontSize: '0.8rem' }}>{r.firstBuyDate} → {r.lastBuyDate}</td>
                  <td className={r.trendStatus?.includes('Uptrend') ? 'positive' : r.trendStatus === 'Breakdown' ? 'negative' : ''}>
                    {r.trendStatus || '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Order History */}
      <div className="panel">
        <h2>Order History</h2>
        {/* The equity-only scope is stated, not silent. A filtered count that looks like a
            total is how you end up hunting for orders that were never missing. */}
        <p style={{ fontSize: '0.85rem', color: '#565a6b' }}>
          {data ? `${data.total} matching equity orders` : 'Loading…'}
          <span style={{ marginLeft: 8, color: '#656974' }}
            title="Options and futures are excluded here — they are opened and closed within days and are tracked in the Optix F&O reports instead. They are still imported and stored; only this list filters them out.">
            · F&amp;O excluded (tracked in Optix) ⓘ
          </span>
        </p>
        <table className="data-table compact-table">
          <thead><tr><th scope="col">Date</th><th scope="col">Portfolio</th><th scope="col">Symbol</th><th scope="col">Side</th><th scope="col">Qty</th><th scope="col">Price</th></tr></thead>
          <tbody>
            {data?.rows?.map((r) => (
              <tr key={r.id}>
                <td>{r.trade_date}</td>
                <td>{r.portfolio}</td>
                <td><strong>{r.symbol}</strong></td>
                <td className={r.side === 'BUY' ? 'positive' : 'negative'}>{r.side}</td>
                <td>{r.quantity}</td>
                <td>{r.price}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PageShell>
  );
}

// ─────────────────────────────────────────
// RECOMMENDATIONS PAGE
// ─────────────────────────────────────────

// ── Add-recommendation form (manual entry or prefilled from Top 25) ──────────
function AddRecommendationForm({ prefill, onSaved, onClose }) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({
    symbol: prefill?.symbol || '', actionType: prefill?.actionType || 'BUY',
    recommendationDate: todayStr,
    cmp: prefill?.cmp ?? '', targetPrice: '', stopLoss: '',
    timeframe: '', advisor: prefill?.advisor || 'ICICI Direct', notes: prefill?.notes || '',
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg]   = useState('');
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function save() {
    if (!f.symbol.trim()) { setMsg('❌ Symbol is required.'); return; }
    setBusy(true); setMsg('');
    try {
      await addRecommendation({
        symbol: f.symbol.toUpperCase().trim(), actionType: f.actionType,
        recommendationDate: f.recommendationDate || todayStr,
        cmp: f.cmp || null, targetPrice: f.targetPrice || null, stopLoss: f.stopLoss || null,
        timeframe: f.timeframe, advisor: f.advisor, notes: f.notes,
      });
      setMsg('✅ Saved.');
      onSaved?.();
      setTimeout(() => onClose?.(), 600);
    } catch (e) { setMsg(`❌ ${e.message}`); }
    finally { setBusy(false); }
  }

  const inp = {
    padding: '8px 12px', background: 'var(--bg-elevated)',
    border: '1px solid var(--border-md)', borderRadius: 6, fontSize: 14,
    color: 'var(--text-primary)',
  };
  const lbl = { fontSize: 13, color: 'var(--text-secondary)' };

  return (
    <div className="panel" style={{ border: '1.5px solid var(--lime)', marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>➕ Add Recommendation</h2>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 19, cursor: 'pointer', color: 'var(--text-muted)' }}>✕</button>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12, alignItems: 'flex-end' }}>
        <label style={lbl}>Symbol *<br />
          <input style={{ ...inp, width: 130, textTransform: 'uppercase' }} value={f.symbol} onChange={set('symbol')} placeholder="e.g. RELIANCE" /></label>
        <label style={lbl}>Rec. Date<br />
          <input type="date" style={{ ...inp, width: 140 }} value={f.recommendationDate} onChange={set('recommendationDate')} /></label>
        <label style={lbl}>Action<br />
          <select style={inp} value={f.actionType} onChange={set('actionType')}>
            {['BUY', 'SELL', 'ACCUMULATE', 'HOLD'].map((a) => <option key={a}>{a}</option>)}
          </select></label>
        <label style={lbl}>Rec. Price ₹<br />
          <input style={{ ...inp, width: 100 }} type="number" value={f.cmp} onChange={set('cmp')} placeholder="entry" /></label>
        <label style={lbl}>Target ₹<br />
          <input style={{ ...inp, width: 100 }} type="number" value={f.targetPrice} onChange={set('targetPrice')} /></label>
        <label style={lbl}>Stop Loss ₹<br />
          <input style={{ ...inp, width: 100 }} type="number" value={f.stopLoss} onChange={set('stopLoss')} /></label>
        <label style={lbl}>Timeframe<br />
          <input style={{ ...inp, width: 100 }} value={f.timeframe} onChange={set('timeframe')} placeholder="e.g. 3-6M" /></label>
        <label style={lbl}>Advisor / Source<br />
          <input style={{ ...inp, width: 140 }} value={f.advisor} onChange={set('advisor')} /></label>
        <label style={{ ...lbl, flex: 1, minWidth: 180 }}>Notes<br />
          <input style={{ ...inp, width: '100%' }} value={f.notes} onChange={set('notes')} /></label>
        <button type="button" onClick={save} disabled={busy}
          style={{ background: 'var(--lime)', color: '#ffffff', border: 'none', borderRadius: 8, padding: '8px 18px', fontWeight: 700, fontSize: 14, cursor: busy ? 'not-allowed' : 'pointer' }}>
          {busy ? '⏳ Saving…' : '✅ Save'}
        </button>
      </div>
      {msg && <p style={{ fontSize: 13.5, margin: '8px 0 0', color: msg.startsWith('✅') ? '#05664a' : '#b32d19' }}>{msg}</p>}
    </div>
  );
}

// ── Daily Top 25 scanner panel (same scoring as Portfolio Health) ─────────────
// Reused for Nifty 500 and the 3 cap-size universes (Mid/Small/Micro) — only the
// `universe` key + display labels change; the fetch/scan/lookup logic is shared.
function Nifty500TopPanel({ onAddRec, universe = 'NIFTY500', title = 'Nifty 500 Daily Top 25', icon = '🏆', totalLabel = '500' }) {
  const navigate = useNavigate();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [scanMsg, setScanMsg] = useState('');
  const [consist, setConsist] = useState(null);
  const [consistWin, setConsistWin] = useState('5d');

  function load() {
    setLoading(true);
    fetchNifty500Top(25, universe)
      .then((d) => { setData(d); setError(''); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    fetchNifty500Consistent(universe).then((c) => {
      setConsist(c);
      // Default to the WIDEST window that has enough history
      const avail = (c?.windows || []).filter((w) => w.available);
      if (avail.length) setConsistWin((cur) => (avail.some((w) => w.key === cur) ? cur : avail[avail.length - 1].key));
    }).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  // While a scan runs, poll for completion every 30s
  useEffect(() => {
    if (!data?.status?.running) return undefined;
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [data?.status?.running]);

  async function scanNow() {
    try {
      setScanMsg('');
      await startNifty500Scan(false, universe);
      setScanMsg('Scan started — prices take ~10 min (first run also crawls fundamentals, ~45–60 min). This panel refreshes automatically.');
      load();
    } catch (e) { setScanMsg(`❌ ${e.message}`); }
  }

  const running = !!data?.status?.running;
  // The scan belongs to whoever owns the shared market file — the admin's hub, not a
  // participant's instance. The server says which this is; older responses without the flag are
  // treated as allowed, so a stand-alone run of the app keeps its button.
  const canScan = data?.status?.canScan !== false;
  const rows = data?.rows || [];

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>{icon} {title}</h2>
          <p style={{ margin: '3px 0 0', fontSize: 13, color: '#565a6b' }}>
            Same health score as Portfolio Health, across all {totalLabel} stocks · trend-filtered (Strong uptrend / Pullback only)
            {data?.scanDate && <span> · scanned <strong>{data.scanDate}</strong></span>}
            {data?.qualifying != null && <span> · {data.qualifying} of {data.universeScored} qualify</span>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {running && <span style={{ fontSize: 13, color: '#9a5b06', fontWeight: 600 }}>⏳ scan running…</span>}
          {canScan ? (
            <button type="button" onClick={scanNow} disabled={running}
              style={{ background: 'transparent', color: 'var(--primary,#1355a8)', border: '1px solid var(--primary,#1355a8)',
                borderRadius: 6, padding: '5px 12px', fontSize: 13, fontWeight: 600, cursor: running ? 'not-allowed' : 'pointer' }}>
              🔍 Scan now
            </button>
          ) : (
            <span style={{ fontSize: 12.5, color: '#656974' }}
              title="One scan is run for everyone against the shared market data. Twenty-five separate scans would be twenty-five copies of the same 500 requests, and the shared result would be overwritten each time.">
              scan run by the admin
            </span>
          )}
          <button type="button" onClick={load} disabled={loading}
            style={{ background: 'transparent', color: '#565a6b', border: '1px solid #656974',
              borderRadius: 6, padding: '5px 10px', fontSize: 13, cursor: 'pointer' }}>↻</button>
        </div>
      </div>

      {scanMsg && <p style={{ fontSize: 13, color: scanMsg.startsWith('❌') ? '#b32d19' : '#166534', margin: '8px 0 0' }}>{scanMsg}</p>}
      {error && <p className="negative" style={{ marginTop: 8 }}>{error}</p>}
      {data?.fundamentalsPending && (
        <p style={{ fontSize: 13, color: '#9a5b06', margin: '8px 0 0' }}>
          ⚠ Fundamentals pending — scores are technical+momentum only until the first fundamentals crawl completes.
        </p>
      )}

      {rows.length > 0 ? (
        <div style={{ overflowX: 'auto', marginTop: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e4e6ea', background: '#f7f8fa' }}>
                {['#', 'Stock', 'Industry', 'CMP', 'Score', 'EMA Trend', '1W', '1M', '3M', '6M', 'Move', 'Held', '➕'].map((h) => (
                  <th scope="col" key={h} style={{ padding: '7px 9px', textAlign: ['CMP','Score','1W','1M','3M','6M'].includes(h) ? 'right' : 'left',
                    fontWeight: 600, color: '#565a6b', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol} style={{ borderBottom: '1px solid #f2f4f7' }}>
                  <td style={{ padding: '8px 12px', color: '#656974', fontWeight: 700 }}>{r.rank}</td>
                  <td style={{ padding: '8px 12px' }}>
                    <div
                      onClick={() => navigate(`/stock-lookups?symbol=${encodeURIComponent(r.symbol)}`)}
                      title={`Open Stock Sleuth for ${r.symbol} — price & EMA trend over 1 week / 15 days / 1 month / 2 months`}
                      style={{ fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'rgba(148,163,184,0.4)', textUnderlineOffset: 3, display: 'inline-block' }}>
                      {r.symbol} 🔎
                    </div>
                    <div style={{ fontSize: 12.5, color: '#656974' }}>{String(r.name || '').slice(0, 32)}</div>
                  </td>
                  <td style={{ padding: '8px 12px', fontSize: 12.5, color: '#565a6b' }}>{r.industry || '—'}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }}>₹{fmt(r.cmp, 2)}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700,
                    color: r.combined >= 70 ? '#05664a' : r.combined >= 55 ? '#0369a1' : '#9a5b06' }}
                    title={`Tech ${r.technical ?? '—'} · Fund ${r.fundamental ?? '—'} · Mom ${r.momentum ?? '—'} (${r.components}/3 components)`}>
                    {r.combined}
                  </td>
                  <td style={{ padding: '8px 12px' }}><EmaLadderBadge ladder={r.emaLadder} slope={r.ema50Slope} /></td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }}><ReturnCell value={r.r1w} /></td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }}><ReturnCell value={r.r1m} /></td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }}><ReturnCell value={r.r3m} /></td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }}><ReturnCell value={r.r6m} /></td>
                  <td style={{ padding: '8px 12px', fontSize: 12.5 }}>
                    {r.isNew ? <span style={{ background: '#e8f1fc', color: '#1355a8', borderRadius: 5, padding: '1px 7px', fontWeight: 700 }}>NEW</span>
                      : r.prevRank != null && r.prevRank !== r.rank
                        ? <span style={{ color: r.prevRank > r.rank ? '#05664a' : '#b32d19', fontWeight: 600 }}>
                            {r.prevRank > r.rank ? '▲' : '▼'} {Math.abs(r.prevRank - r.rank)}
                          </span>
                        : <span style={{ color: '#656974' }}>—</span>}
                  </td>
                  <td style={{ padding: '8px 12px', fontSize: 12.5 }}>
                    {(r.heldBy || []).length
                      ? <span style={{ background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0', borderRadius: 5, padding: '1px 6px', fontWeight: 600 }}>
                          HELD · {r.heldBy.join('+')}
                        </span>
                      : ''}
                  </td>
                  <td style={{ padding: '6px 6px' }}>
                    <button type="button" title={`Add ${r.symbol} as a recommendation`}
                      onClick={() => onAddRec?.({
                        symbol: r.symbol, cmp: r.cmp, advisor: `${title.replace(/ Daily Top 25$/, '')} Scanner`,
                        notes: `Top 25 #${r.rank} on ${data?.scanDate} (score ${r.combined}, ${r.emaLadder})`,
                      })}
                      style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: 6,
                        padding: '4px 10px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                      ➕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p style={{ fontSize: 14, color: '#656974', marginTop: 12 }}>
          {loading ? 'Loading…' : running ? 'First scan in progress — results appear here when it finishes.' : canScan ? `No scan yet — click "Scan now" to run the first ${title.replace(/ Daily Top 25$/, '')} scan.` : 'No scan yet — your admin runs it once for everyone, and the results appear here.'}
        </p>
      )}

      {/* Your holdings nearest the list (qualify on trend, ranked just outside) */}
      {(data?.heldNearMiss || []).length > 0 && (
        <div style={{ marginTop: 12, padding: '9px 12px', background: '#f8fafc', border: '1px solid #e4e6ea', borderRadius: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#565a6b' }}>📍 Your holdings nearest the list: </span>
          <span style={{ fontSize: 13.5, color: '#334155' }}>
            {data.heldNearMiss.map((h, i) => (
              <span key={h.symbol} title={`${h.name || h.symbol} · score ${h.combined} · ${h.emaLadder} · held by ${h.heldBy.join('+')}`}>
                {i > 0 && ' · '}
                <strong>{h.symbol}</strong> #{h.rank}
                <span style={{ color: '#656974' }}> ({h.combined})</span>
                <span style={{ fontSize: 11.5, color: '#166534', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 4, padding: '0 4px', marginLeft: 3 }}>
                  {h.heldBy.join('+')}
                </span>
              </span>
            ))}
          </span>
          <span style={{ fontSize: 12.5, color: '#656974', display: 'block', marginTop: 2 }}>
            Holdings in a healthy trend (Strong uptrend / Pullback) ranked just outside the Top {rows.length || 25}.
          </span>
        </div>
      )}

      {/* Consistency: stocks in EVERY daily Top 25 over the window */}
      {consist && (
        <div style={{ marginTop: 14, padding: '10px 12px', background: '#fef6e7', border: '1px solid #9a5b06', borderRadius: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13.5, fontWeight: 700, color: '#9a5b06' }}>📌 Consistent performers</span>
            <div style={{ display: 'inline-flex', border: '1px solid #fcd34d', borderRadius: 7, overflow: 'hidden' }}>
              {(consist.windows || []).map((w) => (
                <button key={w.key} type="button" onClick={() => setConsistWin(w.key)}
                  disabled={!w.available}
                  title={w.available ? `${w.rows.length} stock(s) in every Top 25 from ${w.from} to ${w.to}` : `Needs ${w.days} scan days — only ${w.have} stored so far`}
                  style={{ background: consistWin === w.key ? '#9a5b06' : '#fff',
                    color: consistWin === w.key ? '#fff' : w.available ? '#9a5b06' : '#d6d9e0',
                    border: 'none', padding: '4px 11px', fontSize: 13, fontWeight: 600,
                    cursor: w.available ? 'pointer' : 'not-allowed' }}>
                  {w.label}{w.available ? ` (${w.rows.length})` : ''}
                </button>
              ))}
            </div>
            <span style={{ fontSize: 12.5, color: '#9a5b06' }}>{consist.daysStored} scan day(s) stored</span>
          </div>
          {(() => {
            const w = (consist.windows || []).find((x) => x.key === consistWin);
            if (!w) return null;
            if (!w.available) return (
              <p style={{ fontSize: 13, color: '#9a5b06', margin: '8px 0 0' }}>
                Needs {w.days} stored scan days — {w.have} so far. This view fills in automatically as daily scans accumulate.
              </p>
            );
            if (!w.rows.length) return (
              <p style={{ fontSize: 13, color: '#9a5b06', margin: '8px 0 0' }}>No stock stayed in the Top 25 on every one of the last {w.days} scan days.</p>
            );
            return (
              <div style={{ marginTop: 8, fontSize: 13.5, color: '#451a03', lineHeight: 1.9 }}>
                {w.rows.map((r, i) => (
                  <span key={r.symbol} title={`${r.name || r.symbol} · in Top 25 all ${w.days} days (${w.from} → ${w.to}) · rank range #${r.bestRank}–#${r.worstRank} · today #${r.latestRank} (score ${r.latestScore})`}>
                    {i > 0 && ' · '}
                    <strong>{r.symbol}</strong>
                    <span style={{ color: '#9a5b06' }}> avg#{r.avgRank}</span>
                    <span style={{ color: '#9a5b06', fontSize: 12.5 }}> (now #{r.latestRank})</span>
                  </span>
                ))}
                <span style={{ display: 'block', fontSize: 12.5, color: '#9a5b06', marginTop: 3 }}>
                  In the Top 25 on every scan day {w.from} → {w.to}, sorted by average rank.
                </span>
              </div>
            );
          })()}
        </div>
      )}

    </div>
  );
}

// ── GARCH volatility strip ───────────────────────────────────────────────────
// Annualised conditional volatility from a GARCH(1,1) fit on two years of daily returns,
// with where it stood 1, 3 and 6 months ago.
//
// Volatility is a property of the STOCK, not of any one scanned universe, so this renders once
// above the four universe cards rather than four times inside them - the same reasoning the
// fundamentals panel already follows.
//
// THE CHANGE IS IN POINTS, NOT PERCENT. Volatility is already a percentage, so "up 12%" would
// be ambiguous between 20 -> 22.4 and 20 -> 32. "+12 pts" is not.
//
// DIRECTION IS SHOWN, JUDGEMENT IS NOT. Rising volatility is risk to a holder and opportunity
// to an option seller, and this app is used for both, so a rise is not painted red. Up is amber
// and down is blue: unmistakably directional, deliberately not good/bad.
function GarchStrip({ garch }) {
  if (!garch) return null;
  if (!garch.ok) {
    return (
      <p style={{ fontSize: 12.5, color: '#656974', margin: '10px 0 0' }}>
        Volatility unavailable — {garch.reason}
      </p>
    );
  }
  const PERIODS = [['1M', garch.changes?.m1], ['3M', garch.changes?.m3], ['6M', garch.changes?.m6]];
  const vsLongRun = garch.longRunVol != null && garch.vol != null
    ? Math.round((garch.vol - garch.longRunVol) * 100) / 100 : null;

  return (
    <div style={{ marginTop: 12, padding: '11px 14px', background: '#fff',
                  border: '1px solid #bae6fd', borderRadius: 8,
                  display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
      <div title={`GARCH(1,1) fitted on ${garch.source}. Annualised from daily conditional volatility.`}>
        <div style={{ fontSize: 11.5, color: '#565a6b', fontWeight: 700, textTransform: 'uppercase' }}>
          GARCH volatility
        </div>
        <div style={{ fontSize: 22, fontWeight: 800, color: '#1b1d28', lineHeight: 1.15 }}>
          {garch.vol}%
        </div>
        <div style={{ fontSize: 11.5, color: '#656974' }}>
          annualised{garch.asOf ? ` · ${garch.asOf}` : ''}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        {PERIODS.map(([label, c]) => {
          const ch = c?.change;
          const up = ch != null && ch > 0;
          const flat = ch == null || Math.abs(ch) < 0.005;
          return (
            <div key={label} title={c?.was != null
              ? `Was ${c.was}% on ${c.asOf} — ${flat ? 'unchanged' : `${up ? 'up' : 'down'} ${Math.abs(ch).toFixed(2)} volatility points since`}`
              : 'Not enough history for this period'}>
              <div style={{ fontSize: 11.5, color: '#565a6b', fontWeight: 700, textTransform: 'uppercase' }}>
                vs {label}
              </div>
              <div style={{ fontSize: 15.5, fontWeight: 800,
                            color: flat ? '#656974' : up ? '#8a5105' : '#1355a8' }}>
                {flat ? '—' : `${up ? '▲' : '▼'} ${Math.abs(ch).toFixed(2)} pts`}
              </div>
              <div style={{ fontSize: 11.5, color: '#656974' }}>
                {c?.was != null ? `was ${c.was}%` : 'no data'}
              </div>
            </div>
          );
        })}
      </div>

      {vsLongRun != null && (
        <div title={`The model's long-run volatility for this stock is ${garch.longRunVol}%. Today's reading sits ${Math.abs(vsLongRun).toFixed(2)} points ${vsLongRun > 0 ? 'above' : 'below'} it. Persistence ${garch.persistence} — how slowly a shock decays; near 1 means calm and stormy stretches both last.`}
             style={{ borderLeft: '1px solid #e0f2fe', paddingLeft: 18 }}>
          <div style={{ fontSize: 11.5, color: '#565a6b', fontWeight: 700, textTransform: 'uppercase' }}>
            vs its norm
          </div>
          <div style={{ fontSize: 15.5, fontWeight: 800, color: Math.abs(vsLongRun) < 0.005 ? '#656974' : vsLongRun > 0 ? '#8a5105' : '#1355a8' }}>
            {Math.abs(vsLongRun) < 0.005 ? '—' : `${vsLongRun > 0 ? '▲' : '▼'} ${Math.abs(vsLongRun).toFixed(2)} pts`}
          </div>
          <div style={{ fontSize: 11.5, color: '#656974' }}>long-run {garch.longRunVol}%</div>
        </div>
      )}
    </div>
  );
}

// ── Unified Stock Sleuth: ONE search box that looks up a symbol across all 4
// scanned universes (Nifty 500, Midcap, Smallcap, Microcap) and shows a result
// card per category where the stock is actually found.
const LOOKUP_UNIVERSES = [
  { key: 'NIFTY500', label: 'Nifty 500',          icon: '🏆', totalLabel: '500' },
  { key: 'MIDCAP',   label: 'Nifty Midcap 150',    icon: '🥈', totalLabel: '150' },
  { key: 'SMALLCAP', label: 'Nifty Smallcap 250',  icon: '🥉', totalLabel: '250' },
  { key: 'MICROCAP', label: 'Nifty Microcap 250',  icon: '🔬', totalLabel: '250' },
];

// ── Stock Sleuth right-hand panel: the fundamental case for the stock, next to the
// technical history on the left.
//
// Three questions, in the order an analyst actually asks them:
//   1. Is the business growing?      → 5-quarter revenue/EPS trend, accelerating or not
//   2. Is it beating its own peers?  → rank inside its industry, and whether that
//                                      industry is itself beating or lagging the market
//   3. What am I paying for it?      → valuation last, because it only means something
//                                      once you know what you are buying
//
// The industry comparison is the part that stops a false read: a stock up 140% inside an
// industry whose median is -0.4% is doing the work itself; the same 140% in an industry
// median of +90% is a sector tide.
function InsightStat({ label, value, sub, tone, title }) {
  const color = tone === 'good' ? '#05664a' : tone === 'bad' ? '#b32d19' : '#1355a8';
  return (
    <div title={title || ''} style={{ cursor: title ? 'help' : 'default' }}>
      <div style={{ fontSize: 11.5, color: '#565a6b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.2 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 800, color }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: '#656974' }}>{sub}</div>}
    </div>
  );
}

function StockInsightPanel({ symbol }) {
  const [data, setData]   = useState(null);
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState('');

  const load = useCallback((force) => {
    if (!symbol) return;
    setBusy(true); setErr('');
    fetchStockInsight(symbol, force)
      .then(setData)
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  }, [symbol]);

  useEffect(() => { setData(null); load(false); }, [load]);

  const f = data?.fundamentals || null;
  const p = data?.peers || null;
  const q = data?.quarterTrend || null;
  const sh = data?.shareholding || null;
  const hasF = f && !f.error;

  // Signed on purpose: these are all CHANGE figures, where a bare "158.7%" reads as a level.
  const pct  = (v, d = 1) => (v == null ? '—' : `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(d)}%`);
  const rpct = (v, d = 1) => (v == null ? '—' : `${v >= 0 ? '' : '-'}${Math.abs(v * 100).toFixed(d)}%`); // 0-1 ratios
  const cr   = (v) => (v == null ? '—' : v >= 1e7 ? `₹${Math.round(v / 1e7).toLocaleString('en-IN')} cr` : `₹${Math.round(v).toLocaleString('en-IN')}`);
  const x    = (v, d = 1) => (v == null ? '—' : `${v.toFixed(d)}×`);

  return (
    <div style={{ flex: '0 1 380px', minWidth: 320, alignSelf: 'flex-start', position: 'sticky', top: 12 }}>
      <div style={{ background: '#fff', border: '1px solid #bae6fd', borderRadius: 8, padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
          <strong style={{ fontSize: 14, color: '#1355a8' }}>📊 Fundamentals &amp; Peers</strong>
          <button type="button" onClick={() => load(true)} disabled={busy}
            title="Re-fetch from source, bypassing the 3-day cache"
            style={{ background: 'none', border: '1px solid #bae6fd', borderRadius: 5, padding: '1px 7px', fontSize: 11.5, color: '#1355a8', cursor: busy ? 'wait' : 'pointer' }}>
            {busy ? '⏳' : '↻'}
          </button>
        </div>

        {busy && !data && <p style={{ fontSize: 12.5, color: '#565a6b', margin: '8px 0 0' }}>Loading fundamentals…</p>}
        {err && <p style={{ fontSize: 12.5, color: '#b32d19', margin: '8px 0 0' }}>{err}</p>}

        {hasF && (f.sector || f.industry) && (
          <p style={{ fontSize: 12.5, color: '#565a6b', margin: '3px 0 0' }}>
            {[f.sector, f.industry].filter(Boolean).join(' · ')}
            {f.marketCap != null && <span style={{ color: '#656974' }}> · mkt cap {cr(f.marketCap)}</span>}
          </p>
        )}

        {/* 1. GROWTH — the quarterly trend, the single most decision-useful block. */}
        {q && (
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #e0f2fe' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#1355a8', marginBottom: 5 }}>
              Quarterly trend <span style={{ color: '#656974', fontWeight: 400 }}>({q.periods}q, {q.from} → {q.to})</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 10 }}>
              <InsightStat label="Revenue" value={pct(q.revenueChangePct)} sub={`over ${q.periods}q`}
                tone={q.revenueChangePct > 0 ? 'good' : q.revenueChangePct < 0 ? 'bad' : null}
                title="Total change in quarterly revenue from the oldest to the newest reported quarter" />
              <InsightStat label="EPS" value={pct(q.epsChangePct)} sub={`over ${q.periods}q`}
                tone={q.epsChangePct > 0 ? 'good' : q.epsChangePct < 0 ? 'bad' : null}
                title="Total change in quarterly earnings per share across the same window" />
              <InsightStat label="Momentum"
                value={q.accelerating === true ? 'Accelerating' : q.accelerating === false ? 'Slowing' : '—'}
                sub={`${q.quartersUp}/${q.revQoQ.length} quarters up`}
                tone={q.accelerating === true ? 'good' : q.accelerating === false ? 'bad' : null}
                title="Compares average revenue growth of the last two quarters against the earlier ones — growth can be high and still be rolling over" />
              {q.marginTrend != null && (
                <InsightStat label="Op margin" value={`${q.marginTrend >= 0 ? '+' : '-'}${Math.abs(q.marginTrend).toFixed(1)} pts`}
                  sub="change over window" tone={q.marginTrend > 0 ? 'good' : q.marginTrend < 0 ? 'bad' : null}
                  title="Change in operating margin from the first to the latest quarter. Expanding margins alongside growing revenue is the strongest combination." />
              )}
            </div>
            {/* Quarter-on-quarter revenue steps — the shape of the trend, not just its total. */}
            {q.revQoQ.some((v) => v != null) && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 7, alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, color: '#565a6b', fontWeight: 700 }}>QoQ rev</span>
                {q.revQoQ.map((v, i) => (
                  <span key={i} style={{ fontSize: 11.5, fontWeight: 700, padding: '1px 6px', borderRadius: 5,
                    background: v == null ? '#f1f5f9' : v >= 0 ? '#dcfce7' : '#fdecea',
                    color: v == null ? '#656974' : v >= 0 ? '#05664a' : '#b32d19' }}>
                    {v == null ? '—' : `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(0)}%`}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 2. PEERS — rank within its own industry, plus how that industry itself is doing. */}
        {p && (
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #e0f2fe' }}>
            {/* The peer group uses the NSE industry recorded in the daily scans, which is a
                different (broader) taxonomy from the Yahoo sector shown at the top of this
                panel — BEL is "Aerospace & Defense" to Yahoo but "Capital Goods" in the scans.
                Both are correct; the source is named so the two never look contradictory. */}
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#1355a8', marginBottom: 5 }}
              title={`Peer group is the NSE industry recorded in the daily scans (${p.industry}) — a broader grouping than the Yahoo sector shown above.`}>
              vs {p.industry} <span style={{ color: '#656974', fontWeight: 400 }}>({p.peerCount} NSE peers, {p.scanDate})</span>
            </div>
            <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}>
              <thead>
                <tr style={{ color: '#565a6b' }}>
                  <th scope="col" style={{ textAlign: 'left', padding: '3px 7px', fontWeight: 700 }}>Period</th>
                  <th scope="col" style={{ textAlign: 'right', padding: '3px 7px', fontWeight: 700 }}>Stock</th>
                  <th scope="col" style={{ textAlign: 'right', padding: '3px 7px', fontWeight: 700 }} title="Median return of every scanned stock in the same industry">Peer med.</th>
                  <th scope="col" style={{ textAlign: 'right', padding: '3px 7px', fontWeight: 700 }}>Rank</th>
                </tr>
              </thead>
              <tbody>
                {[['1M', p.r1m], ['3M', p.r3m], ['6M', p.r6m], ['Score', p.score]].map(([label, r]) => r && (
                  <tr key={label} style={{ borderTop: '1px solid #f0f9ff' }}>
                    <td style={{ padding: '3px 7px', color: '#1355a8', fontWeight: 600 }}>{label}</td>
                    <td style={{ padding: '3px 7px', textAlign: 'right', fontWeight: 700,
                      color: r.value == null ? '#656974' : r.value >= 0 ? '#05664a' : '#b32d19' }}>
                      {r.value == null ? '—' : label === 'Score' ? r.value.toFixed(0) : pct(r.value)}
                    </td>
                    <td style={{ padding: '3px 7px', textAlign: 'right', color: '#565a6b' }}>
                      {r.median == null ? '—' : label === 'Score' ? r.median.toFixed(0) : pct(r.median)}
                    </td>
                    <td style={{ padding: '3px 7px', textAlign: 'right', fontWeight: 700, color: '#0369a1' }}
                      title={`Top ${r.topPct}% of its industry on this measure`}>
                      #{r.rank}<span style={{ color: '#656974', fontWeight: 400 }}>/{r.of}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Is the industry itself carrying the stock, or is the stock carrying the industry? */}
            {p.industryVsMarket?.r3m?.industry != null && p.industryVsMarket?.r3m?.market != null && (
              <p style={{ fontSize: 11.5, color: '#565a6b', margin: '6px 0 0', lineHeight: 1.45 }}>
                Industry 3M median <strong style={{ color: p.industryVsMarket.r3m.industry >= 0 ? '#05664a' : '#b32d19' }}>
                  {pct(p.industryVsMarket.r3m.industry)}</strong> vs {p.universe} median{' '}
                <strong style={{ color: p.industryVsMarket.r3m.market >= 0 ? '#05664a' : '#b32d19' }}>
                  {pct(p.industryVsMarket.r3m.market)}</strong>
                {' — '}
                {p.industryVsMarket.r3m.industry >= p.industryVsMarket.r3m.market
                  ? 'the sector is running ahead of the market, so some of this move is a sector tailwind.'
                  : 'the sector is lagging the market, so this stock is moving on its own merits, not a sector tide.'}
              </p>
            )}
          </div>
        )}

        {/* 3. VALUATION & QUALITY — last, because it only means something once you know
            what the business is doing. */}
        {hasF && (
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #e0f2fe' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#1355a8', marginBottom: 5 }}>Valuation &amp; quality</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: 10 }}>
              <InsightStat label="P/E" value={x(f.trailingPE)} sub={f.forwardPE != null ? `fwd ${x(f.forwardPE)}` : null}
                title="Trailing price-to-earnings. High multiples demand the growth above to continue — that is the risk being priced in." />
              <InsightStat label="P/B" value={x(f.priceToBook)} sub={f.bookValue != null ? `BV ₹${fmt(f.bookValue, 1)}` : null}
                title="Price to book value per share" />
              <InsightStat label="EPS (ttm)" value={f.trailingEps == null ? '—' : `₹${fmt(f.trailingEps, 2)}`}
                title="Trailing twelve-month earnings per share" />
              <InsightStat label="ROE" value={rpct(f.returnOnEquity)}
                tone={f.returnOnEquity == null ? null : f.returnOnEquity >= 0.15 ? 'good' : f.returnOnEquity < 0 ? 'bad' : null}
                title="Return on equity — how hard shareholder capital is working. Above ~15% is generally strong." />
              <InsightStat label="Op margin" value={rpct(f.operatingMargins)}
                title="Operating profit as a share of revenue" />
              <InsightStat label="Net margin" value={rpct(f.profitMargins)}
                tone={f.profitMargins == null ? null : f.profitMargins > 0 ? 'good' : 'bad'}
                title="Net profit as a share of revenue" />
              <InsightStat label="Debt/Equity" value={f.debtToEquity == null ? '—' : f.debtToEquity.toFixed(1)}
                tone={f.debtToEquity == null ? null : f.debtToEquity < 50 ? 'good' : f.debtToEquity > 150 ? 'bad' : null}
                title="Total debt as a percentage of equity. Under ~50 is comfortable; over ~150 means leverage is a real risk." />
              <InsightStat label="Current ratio" value={f.currentRatio == null ? '—' : x(f.currentRatio, 2)}
                tone={f.currentRatio == null ? null : f.currentRatio >= 1.5 ? 'good' : f.currentRatio < 1 ? 'bad' : null}
                title="Current assets over current liabilities — short-term solvency. Below 1 is a liquidity warning." />
              {f.dividendYield != null && f.dividendYield > 0 && (
                <InsightStat label="Div yield" value={rpct(f.dividendYield, 2)}
                  sub={f.dividendRate != null ? `₹${fmt(f.dividendRate, 2)}/sh` : null}
                  title="Trailing dividend yield, with the per-share dividend it is based on" />
              )}
            </div>
          </div>
        )}

        {/* Ownership — promoter / FII / DII from the company's own quarterly SEBI filing
            (NSE), with the change over the last one and two quarters.
            Filings are QUARTERLY, so "3M" is one quarter's change and "6M" is two; the actual
            quarter-end each delta is measured from is shown rather than implied. */}
        {sh && !sh.error && sh.latest && (
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #e0f2fe' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#1355a8', marginBottom: 5 }}>
              Ownership <span style={{ color: '#656974', fontWeight: 400 }}>(as filed {sh.latest.quarter})</span>
            </div>
            <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}>
              <thead>
                <tr style={{ color: '#565a6b' }}>
                  <th scope="col" style={{ textAlign: 'left', padding: '3px 7px', fontWeight: 700 }}>Holder</th>
                  <th scope="col" style={{ textAlign: 'right', padding: '3px 7px', fontWeight: 700 }}>Now</th>
                  <th scope="col" style={{ textAlign: 'right', padding: '3px 7px', fontWeight: 700 }}
                    title={sh.change3m ? `Change since the quarter ended ${sh.change3m.since}` : 'Needs the previous quarter’s filing'}>
                    3M {sh.change3m ? '' : '—'}
                  </th>
                  <th scope="col" style={{ textAlign: 'right', padding: '3px 7px', fontWeight: 700 }}
                    title={sh.change6m ? `Change since the quarter ended ${sh.change6m.since}` : 'Needs two prior quarterly filings'}>
                    6M {sh.change6m ? '' : '—'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['Promoter', 'promoter', 'Promoter & promoter group holding. Promoters increasing their stake is generally a confidence signal; steady selling is worth a hard look.'],
                  ['FII', 'fii', 'Foreign institutional / foreign portfolio investors.'],
                  ['DII', 'dii', 'Domestic institutions — mutual funds, insurers and banks combined.'],
                  ['— Mutual funds', 'mutualFunds', 'Mutual fund holding, the largest DII component for most stocks.'],
                  ['— Insurance', 'insurance', 'Insurance company holding.'],
                  ['Retail / other', 'nonInstitutions', 'Non-institutional public — retail investors, HUFs, bodies corporate.'],
                ].map(([label, key, tip]) => {
                  const now = sh.latest[key];
                  if (now == null) return null;
                  const sub = label.startsWith('—');
                  return (
                    <tr key={key} style={{ borderTop: '1px solid #f0f9ff' }} title={tip}>
                      <td style={{ padding: '3px 7px', color: sub ? '#565a6b' : '#1355a8',
                        fontWeight: sub ? 500 : 600, paddingLeft: sub ? 12 : 4, fontSize: sub ? 11 : 11.5 }}>
                        {label}
                      </td>
                      <td style={{ padding: '3px 7px', textAlign: 'right', fontWeight: sub ? 500 : 700, color: '#1355a8' }}>
                        {now.toFixed(2)}%
                      </td>
                      {[sh.change3m, sh.change6m].map((chg, i) => {
                        const v = chg ? chg[key] : null;
                        return (
                          <td key={i} style={{ padding: '3px 7px', textAlign: 'right', fontWeight: 700,
                            color: v == null ? '#656974' : v > 0 ? '#05664a' : v < 0 ? '#b32d19' : '#656974' }}>
                            {v == null ? '—' : v === 0 ? '0.00' : `${v > 0 ? '▲' : '▼'} ${Math.abs(v).toFixed(2)}`}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p style={{ fontSize: 11, color: '#656974', margin: '5px 0 0', lineHeight: 1.4 }}>
              Change in percentage points, from the company&apos;s quarterly SEBI filing (NSE).
              Filed four times a year — 3M is one quarter
              {sh.change3m ? ` (vs ${sh.change3m.since})` : ''}, 6M is two
              {sh.change6m ? ` (vs ${sh.change6m.since})` : ''}.
              {!sh.hasDetail && ' FII/DII breakdown unavailable for this filing — only promoter/public were reported.'}
            </p>
          </div>
        )}
        {sh?.error && (
          <p style={{ fontSize: 11.5, color: '#656974', margin: '8px 0 0' }}>
            Shareholding unavailable: {sh.error}
          </p>
        )}

        {f?.error && (
          <p style={{ fontSize: 12.5, color: '#b32d19', margin: '8px 0 0' }}>Fundamentals unavailable: {f.error}</p>
        )}
        {!p && data && (
          <p style={{ fontSize: 11.5, color: '#656974', margin: '8px 0 0' }}>
            No peer comparison — this symbol has no industry recorded in the scans.
          </p>
        )}
        {data?.fundamentals?.fetchedAt && (
          <p style={{ fontSize: 11, color: '#656974', margin: '8px 0 0' }}>
            Fundamentals as of {String(data.fundamentals.fetchedAt).slice(0, 10)}
            {data.fundamentals.cached ? ' (cached)' : ''} · source Yahoo Finance; peer data from the daily scans
          </p>
        )}
      </div>
    </div>
  );
}

// ── "Do I own this, and how is it doing?" — shown bottom-right of the Stock Sleuth stats
// box. Renders NA across the board when the stock is in neither portfolio, because "not held"
// is a real answer and blanking the fields would look like a loading failure.
//
// Cost basis follows the same precedence as the Portfolio page (broker snapshot → override →
// orders-computed), so the two views can never quietly disagree.
function HoldingsBox({ holding, loading }) {
  const money = (v) => (v == null ? 'NA'
    : `${v < 0 ? '-' : ''}₹${fmt(Math.abs(v), 2)}`);
  const held = holding?.held;
  const t = holding?.total || null;
  const NA = <span style={{ color: '#656974', fontWeight: 700 }}>NA</span>;

  const cell = (label, node, tip) => (
    <div title={tip || ''} style={{ minWidth: 96, cursor: tip ? 'help' : 'default' }}>
      <div style={{ fontSize: 11.5, color: '#565a6b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.2 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 800, marginTop: 1 }}>{node}</div>
    </div>
  );

  return (
    <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1px dashed #bae6fd',
      display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ background: held ? '#f0fdf4' : '#f8fafc',
        border: `1px solid ${held ? '#bbf7d0' : '#e4e6ea'}`, borderRadius: 8, padding: '11px 16px',
        minWidth: 330, maxWidth: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 12.5, color: held ? '#166534' : '#565a6b' }}>
            💼 My Holding
          </strong>
          {loading && <span style={{ fontSize: 11.5, color: '#656974' }}>loading…</span>}
          {!loading && !held && <span style={{ fontSize: 11.5, color: '#656974' }}>not held in Rams or Geetha</span>}
          {held && (
            <span style={{ fontSize: 11.5, color: '#565a6b' }}>
              {holding.positions.map((p) => `${p.portfolio} ${fmt(p.quantity, 0)} sh`).join(' · ')}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          {cell('Value', held ? <span style={{ color: '#1355a8' }}>{money(t.currentValue)}</span> : NA,
            held ? 'Current market value of the position' : 'Not held in either portfolio')}
          {cell('Total cost', held && t.invested != null ? <span style={{ color: '#1355a8' }}>{money(t.invested)}</span> : NA,
            held ? 'Amount invested, at the same cost basis the Portfolio page uses' : 'Not held in either portfolio')}
          {cell('P&L',
            held && t.pnl != null
              ? (
                <span style={{ color: t.pnl >= 0 ? '#05664a' : '#b32d19' }}>
                  {money(t.pnl)}
                  {t.pnlPct != null && (
                    <span style={{ fontSize: 12.5, fontWeight: 700, marginLeft: 5 }}>
                      ({t.pnlPct >= 0 ? '+' : '-'}{Math.abs(t.pnlPct).toFixed(2)}%)
                    </span>
                  )}
                </span>
              )
              : NA,
            held ? 'Current value minus total cost' : 'Not held in either portfolio')}
        </div>

        {/* Split shown only when it actually is split — two portfolios holding the same stock. */}
        {held && holding.positions.length > 1 && (
          <div style={{ marginTop: 7, paddingTop: 6, borderTop: '1px solid #dcfce7' }}>
            {holding.positions.map((p) => (
              <div key={p.portfolio} style={{ fontSize: 11.5, color: '#565a6b', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, color: '#166534', minWidth: 52 }}>{p.portfolio}</span>
                <span>{fmt(p.quantity, 0)} sh @ ₹{fmt(p.avgCost, 2)}</span>
                <span>cost {money(p.invested)}</span>
                <span>val {money(p.currentValue)}</span>
                <span style={{ color: p.pnl >= 0 ? '#05664a' : '#b32d19', fontWeight: 700 }}>
                  {money(p.pnl)}{p.pnlPct != null ? ` (${p.pnlPct >= 0 ? '+' : '-'}${Math.abs(p.pnlPct).toFixed(1)}%)` : ''}
                </span>
              </div>
            ))}
          </div>
        )}

        {held && (
          <p style={{ fontSize: 11, color: '#656974', margin: '6px 0 0' }}>
            Broker holdings as of {holding.positions.map((p) => p.asOf).filter(Boolean).join(' / ') || '—'}
            {t.costIncomplete && ' · cost basis missing for part of this position, P&L is incomplete'}
          </p>
        )}
      </div>
    </div>
  );
}

function StockLookupPanel() {
  const [searchParams] = useSearchParams();
  const [posSym, setPosSym]   = useState(() => searchParams.get('symbol') || '');
  const [posDays, setPosDays] = useState(5);
  const [results, setResults] = useState(null);   // array of { cfg, data } for universes where found
  const [posBusy, setPosBusy] = useState(false);
  const [posErr, setPosErr]   = useState('');
  const [symDir, setSymDir]   = useState(null);   // merged directory across all 4 universes (lazy)
  const [showSugg, setShowSugg] = useState(false);
  const [holding, setHolding] = useState(null);   // this symbol's position across both portfolios
  const [holdingBusy, setHoldingBusy] = useState(false);

  function ensureSymbolDir() {
    if (symDir) return;
    Promise.all(LOOKUP_UNIVERSES.map((u) =>
      fetchNifty500Symbols(u.key).then((d) => (d.rows || []).map((r) => ({ ...r, universe: u.key })))
        .catch(() => [])
    )).then((lists) => {
      // Merge by symbol, keeping the categories each symbol was found in.
      const merged = new Map();
      for (const list of lists) {
        for (const r of list) {
          if (!merged.has(r.symbol)) merged.set(r.symbol, { symbol: r.symbol, name: r.name, universes: [] });
          merged.get(r.symbol).universes.push(r.universe);
        }
      }
      setSymDir([...merged.values()]);
    });
  }

  const suggestions = useMemo(() => {
    const q = posSym.trim().toUpperCase();
    if (!symDir || q.length < 2) return [];
    const byPrefix = symDir.filter((s) => s.symbol.toUpperCase().startsWith(q));
    const byName = symDir.filter((s) =>
      !s.symbol.toUpperCase().startsWith(q) &&
      (s.symbol.toUpperCase().includes(q) || String(s.name || '').toUpperCase().includes(q)));
    return [...byPrefix, ...byName].slice(0, 10);
  }, [symDir, posSym]);

  async function lookupPosition(symOverride) {
    const sym = (typeof symOverride === 'string' ? symOverride : posSym).trim();
    if (!sym) { setPosErr('Enter a symbol.'); return; }
    setShowSugg(false);
    setPosBusy(true); setPosErr(''); setResults(null);
    // Holdings are independent of whether the symbol turns up in any scanned universe, so
    // this runs alongside the lookup rather than waiting on it.
    setHolding(null); setHoldingBusy(true);
    fetchSymbolHolding(sym)
      .then(setHolding)
      .catch(() => setHolding({ held: false, positions: [] }))
      .finally(() => setHoldingBusy(false));
    try {
      const settled = await Promise.all(LOOKUP_UNIVERSES.map((cfg) =>
        fetchNifty500StockPosition(sym, posDays, cfg.key)
          .then((data) => ({ cfg, data }))
          .catch(() => ({ cfg, data: null }))
      ));
      const found = settled.filter((r) => r.data && r.data.daysCovered > 0);
      setResults(found);
      if (!found.length) setPosErr(`${sym.toUpperCase()} not found in any stored scan — check the symbol (NSE code) or whether it's a constituent of Nifty 500 / Midcap 150 / Smallcap 250 / Microcap 250.`);
    } catch (e) { setPosErr(e.message); }
    finally { setPosBusy(false); }
  }

  // Deep-link support: /stock-lookups?symbol=XXX (e.g. from the Dashboard's Exit
  // Candidates card) pre-fills the search and runs it immediately.
  useEffect(() => {
    const sym = searchParams.get('symbol');
    if (sym) lookupPosition(sym);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <h2 style={{ margin: 0 }}>🔎 Stock Sleuth</h2>
      <p style={{ margin: '3px 0 0', fontSize: 13, color: '#565a6b' }}>
        One search, all four scanned universes — Nifty 500, Midcap 150, Smallcap 250, Microcap 250.
      </p>
      <div style={{ marginTop: 14, padding: '10px 12px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ position: 'relative', display: 'inline-block' }}>
            <input value={posSym}
              onChange={(e) => { setPosSym(e.target.value); setShowSugg(true); }}
              onFocus={() => { ensureSymbolDir(); setShowSugg(true); }}
              onBlur={() => setTimeout(() => setShowSugg(false), 180)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') lookupPosition(suggestions.length === 1 ? suggestions[0].symbol : undefined);
                if (e.key === 'Escape') setShowSugg(false);
              }}
              placeholder="type 2+ letters…"
              style={{ padding: '5px 9px', border: '1px solid #7dd3fc', borderRadius: 6, fontSize: 14, width: 170, textTransform: 'uppercase' }} />
            {showSugg && suggestions.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 30, marginTop: 2,
                background: '#fff', border: '1px solid #7dd3fc', borderRadius: 8, boxShadow: '0 6px 18px rgba(2,132,199,0.18)',
                width: 320, maxHeight: 270, overflowY: 'auto' }}>
                {suggestions.map((s) => (
                  <button key={s.symbol} type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setPosSym(s.symbol); setShowSugg(false); lookupPosition(s.symbol); }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none',
                      borderBottom: '1px solid #f0f9ff', padding: '8px 13px', cursor: 'pointer' }}>
                    <span style={{ fontWeight: 700, fontSize: 13.5, color: '#1355a8' }}>{s.symbol}</span>
                    <span style={{ fontSize: 12.5, color: '#565a6b', marginLeft: 8 }}>{String(s.name || '').slice(0, 30)}</span>
                    <span style={{ fontSize: 11.5, color: '#1355a8', marginLeft: 6 }}>
                      {s.universes.map((u) => LOOKUP_UNIVERSES.find((c) => c.key === u)?.icon).join(' ')}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </span>
          <select value={posDays} onChange={(e) => setPosDays(Number(e.target.value))}
            style={{ padding: '7px 11px', border: '1px solid #7dd3fc', borderRadius: 6, fontSize: 13.5 }}>
            <option value={5}>1 week (5 scan days)</option>
            <option value={15}>15 days</option>
            <option value={22}>1 month</option>
            <option value={44}>2 months</option>
          </select>
          <button type="button" onClick={() => lookupPosition()} disabled={posBusy}
            style={{ background: '#1355a8', color: '#fff', border: 'none', borderRadius: 6, padding: '9px 16px', fontSize: 13.5, fontWeight: 600, cursor: posBusy ? 'not-allowed' : 'pointer' }}>
            {posBusy ? '⏳ Searching all 4…' : 'Check'}
          </button>
        </div>

        {/* EMA Trend legend — what each ladder label means */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginTop: 8, paddingTop: 8, borderTop: '1px solid #e0f2fe' }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: '#565a6b' }}>EMA Trend:</span>
          {[
            { key: 'STRONG_UPTREND', desc: 'Price > 20 > 50 > 200 EMA — clean, healthy uptrend' },
            { key: 'PULLBACK',       desc: 'Uptrend intact (50>200), price dipped just below 20 EMA — shallow dip' },
            { key: 'DISTRIBUTION',   desc: 'Uptrend intact (50>200) but price fell below 50 EMA — momentum cracking, caution' },
            { key: 'DOWNTREND',      desc: 'Price and 50 EMA both below 200 EMA — uptrend broken' },
            { key: 'MIXED',          desc: "Doesn't cleanly fit the other patterns" },
          ].map(({ key, desc }) => {
            const s = EMA_LADDER_STYLE[key];
            return (
              <span key={key} title={desc} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'help' }}>
                <span style={{ background: s.bg, color: s.fg, borderRadius: 6, padding: '4px 10px', fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {s.label}
                </span>
                <span style={{ fontSize: 12.5, color: '#565a6b' }}>{desc}</span>
              </span>
            );
          })}
        </div>
        {posErr && <p style={{ fontSize: 13, color: '#b32d19', margin: '8px 0 0' }}>{posErr}</p>}

        {/* Volatility is the same number whichever universe the stock was found in, so it is
            taken from whichever card carries it and shown once. */}
        <GarchStrip garch={(results || []).map((r) => r.data?.garch).find(Boolean)} />

        {/* Two columns: the per-universe technical history on the left, the company's
            fundamental case on the right. Fundamentals are a property of the COMPANY, not of
            any one universe, so the panel is rendered once beside the whole set rather than
            repeated inside each universe card. */}
        <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 560px', minWidth: 0 }}>
        {(results || []).map(({ cfg, data: posData }, cardIdx) => (
          <div key={cfg.key} style={{ marginTop: 12, paddingTop: 10, borderTop: '2px solid #bae6fd' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ background: '#1355a8', color: '#fff', borderRadius: 6, padding: '2px 10px', fontSize: 13, fontWeight: 700 }}>
                {cfg.icon} {cfg.label}
              </span>
              <strong style={{ fontSize: 15, color: '#1355a8' }}>{posData.symbol}</strong>
              {posData.name && <span style={{ fontSize: 13.5, color: '#334155' }}>{posData.name}</span>}
              {posData.industry && <span style={{ fontSize: 12.5, color: '#656974' }}>· {posData.industry}</span>}
            </div>
            <p style={{ fontSize: 13.5, color: '#1355a8', margin: '4px 0 0', fontWeight: 600 }}>
              In the Top 25 on {posData.daysInTop25} of {posData.daysCovered} scan day(s) ({posData.top25Pct}%)
              {' · '}rank avg #{posData.avgUniRank} (best #{posData.bestUniRank}, worst #{posData.worstUniRank})
            </p>
            {posData.latest && (
              <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap', marginTop: 6, padding: '8px 13px', background: '#e0f2fe', borderRadius: 6 }}>
                <span style={{ fontSize: 12.5, color: '#565a6b' }}>As of {posData.latest.date}:</span>
                {[['1W', posData.latest.r1w], ['1M', posData.latest.r1m], ['3M', posData.latest.r3m], ['6M', posData.latest.r6m]].map(([label, val]) => (
                  <span key={label} style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline' }}>
                    <span style={{ fontSize: 12.5, color: '#565a6b', fontWeight: 600 }}>{label}</span>
                    <ReturnCell value={val} />
                  </span>
                ))}
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline' }}>
                  <span style={{ fontSize: 12.5, color: '#565a6b', fontWeight: 600 }}>Move</span>
                  {posData.latest.prevUniRank != null && posData.latest.uniRank != null && posData.latest.prevUniRank !== posData.latest.uniRank
                    ? <span style={{ fontSize: 13, fontWeight: 700, color: posData.latest.prevUniRank > posData.latest.uniRank ? '#05664a' : '#b32d19' }}>
                        {posData.latest.prevUniRank > posData.latest.uniRank ? '▲' : '▼'} {Math.abs(posData.latest.prevUniRank - posData.latest.uniRank)}
                      </span>
                    : <span style={{ fontSize: 13, color: '#656974' }}>—</span>}
                </span>
              </div>
            )}

            {/* Current / static numbers — live where available (price, DMA, 52w range,
                EMA ladder), latest-scan for RSI and the score breakdown. This is the
                "where does it stand right now" view; the table below is the history. */}
            {(posData.live || posData.latest) && (
              <div style={{ marginTop: 8, padding: '10px 12px', background: '#fff', border: '1px solid #bae6fd', borderRadius: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 12 }}>
                {posData.live?.currentPrice != null && (
                  <div>
                    <div style={{ fontSize: 11.5, color: '#565a6b', fontWeight: 700, textTransform: 'uppercase' }}>Price</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: '#1355a8' }}>₹{fmt(posData.live.currentPrice, 2)}</div>
                    {posData.live.trendStatus && <div style={{ fontSize: 11.5, color: '#565a6b' }}>{posData.live.trendStatus}</div>}
                  </div>
                )}
                {posData.latest?.rsi != null && (
                  <div title="Relative Strength Index (14d) — above ~70 is typically overbought, below ~30 oversold">
                    <div style={{ fontSize: 11.5, color: '#565a6b', fontWeight: 700, textTransform: 'uppercase' }}>RSI</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: posData.latest.rsi >= 70 ? '#b32d19' : posData.latest.rsi <= 30 ? '#05664a' : '#1355a8' }}>
                      {posData.latest.rsi.toFixed(1)}
                    </div>
                  </div>
                )}
                {posData.live?.cmpVs50DmaPct != null && (
                  <div>
                    <div style={{ fontSize: 11.5, color: '#565a6b', fontWeight: 700, textTransform: 'uppercase' }}>vs 50 DMA</div>
                    <ReturnCell value={posData.live.cmpVs50DmaPct} />
                  </div>
                )}
                {posData.live?.cmpVs200DmaPct != null && (
                  <div>
                    <div style={{ fontSize: 11.5, color: '#565a6b', fontWeight: 700, textTransform: 'uppercase' }}>vs 200 DMA</div>
                    <ReturnCell value={posData.live.cmpVs200DmaPct} />
                  </div>
                )}
                {posData.live?.distanceFrom52WeekHighPct != null && (
                  <div title={posData.live.high52Week != null ? `52W high ₹${fmt(posData.live.high52Week, 2)}` : ''}>
                    <div style={{ fontSize: 11.5, color: '#565a6b', fontWeight: 700, textTransform: 'uppercase' }}>vs 52W High</div>
                    <ReturnCell value={posData.live.distanceFrom52WeekHighPct} />
                  </div>
                )}
                {posData.live?.distanceFrom52WeekLowPct != null && (
                  <div title={posData.live.low52Week != null ? `52W low ₹${fmt(posData.live.low52Week, 2)}` : ''}>
                    <div style={{ fontSize: 11.5, color: '#565a6b', fontWeight: 700, textTransform: 'uppercase' }}>vs 52W Low</div>
                    <ReturnCell value={posData.live.distanceFrom52WeekLowPct} />
                  </div>
                )}
                {posData.live?.emaLadder && (
                  <div>
                    <div style={{ fontSize: 11.5, color: '#565a6b', fontWeight: 700, textTransform: 'uppercase' }}>EMA Ladder</div>
                    <div style={{ marginTop: 2 }}><EmaLadderBadge ladder={posData.live.emaLadder} slope={posData.live.ema50SlopePct} /></div>
                  </div>
                )}
                {posData.latest?.combinedScore != null && (
                  <div title={`Technical ${fmt(posData.latest.technicalScore, 0)} · Fundamental ${fmt(posData.latest.fundamentalScore, 0)} · Momentum ${fmt(posData.latest.momentumScore, 0)}`}>
                    <div style={{ fontSize: 11.5, color: '#565a6b', fontWeight: 700, textTransform: 'uppercase' }}>Score</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: '#1355a8' }}>{fmt(posData.latest.combinedScore, 0)}<span style={{ fontSize: 12.5, color: '#656974', fontWeight: 500 }}>/100</span></div>
                    <div style={{ fontSize: 11.5, color: '#656974' }}>
                      T{fmt(posData.latest.technicalScore, 0)} · F{fmt(posData.latest.fundamentalScore, 0)} · M{fmt(posData.latest.momentumScore, 0)}
                    </div>
                  </div>
                )}
                </div>
                {/* Holdings are a property of the COMPANY, not of any one universe, so this
                    shows once on the first card rather than repeating per universe. */}
                {cardIdx === 0 && <HoldingsBox holding={holding} loading={holdingBusy} />}
              </div>
            )}
            <div style={{ overflowX: 'auto', marginTop: 6 }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ color: '#1355a8' }}>
                    <th scope="col" style={{ padding: '5px 12px', textAlign: 'left' }}>Date</th>
                    <th scope="col" style={{ padding: '5px 12px', textAlign: 'right' }} title={`Position out of all ${cfg.totalLabel} scanned stocks that day (🏆 = also made that day's Top 25)`}>Top {cfg.totalLabel}</th>
                    <th scope="col" style={{ padding: '5px 12px', textAlign: 'center' }} title="Price move vs the previous scan day">Trend</th>
                    <th scope="col" style={{ padding: '5px 12px', textAlign: 'right' }}>Price</th>
                    <th scope="col" style={{ padding: '5px 12px', textAlign: 'left' }}>EMA Trend</th>
                    <th scope="col" style={{ padding: '5px 12px', textAlign: 'right' }} title="Relative Strength Index (14d) — above ~70 overbought, below ~30 oversold">RSI</th>
                    <th scope="col" style={{ padding: '5px 12px', textAlign: 'right' }} title="Combined score out of 100 — hover a row for the Technical/Fundamental/Momentum breakdown">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {posData.days.map((d, i) => {
                    // days[] is newest→oldest, so the previous trading day is the next entry.
                    const prevCmp = posData.days[i + 1]?.cmp;
                    let dayTrend = null;   // 'up' | 'down' | 'flat'
                    if (d.cmp != null && prevCmp != null) {
                      dayTrend = d.cmp > prevCmp ? 'up' : d.cmp < prevCmp ? 'down' : 'flat';
                    }
                    return (
                    <tr key={d.date} style={{ borderTop: '1px solid #e0f2fe' }}>
                      <td style={{ padding: '5px 12px', color: '#1355a8' }}>{d.date}</td>
                      <td style={{ padding: '5px 12px', textAlign: 'right', fontWeight: 700, color: '#0369a1' }}>
                        #{d.uniRank}<span style={{ color: '#656974', fontWeight: 400 }}>/{d.uniTotal}</span>
                        {d.top25Rank != null && <span title={`Also #${d.top25Rank} in that day's Top 25`}> 🏆</span>}
                      </td>
                      <td style={{ padding: '5px 12px', textAlign: 'center' }}
                        title={dayTrend === 'up' ? `Up from ₹${fmt(prevCmp, 2)}` : dayTrend === 'down' ? `Down from ₹${fmt(prevCmp, 2)}` : dayTrend === 'flat' ? 'No change from previous day' : 'No prior-day price to compare'}>
                        {dayTrend === 'up' && <span style={{ color: '#16a34a', fontWeight: 700, fontSize: 15 }}>▲</span>}
                        {dayTrend === 'down' && <span style={{ color: '#dc2626', fontWeight: 700, fontSize: 15 }}>▼</span>}
                        {dayTrend === 'flat' && <span style={{ color: '#ca8a04', fontWeight: 700, fontSize: 15 }}>↔</span>}
                        {dayTrend === null && <span style={{ color: '#656974' }}>—</span>}
                      </td>
                      <td style={{ padding: '5px 12px', textAlign: 'right', color: '#1355a8' }}>
                        {d.cmp != null ? `₹${fmt(d.cmp, 2)}` : <span style={{ color: '#656974' }}>—</span>}
                      </td>
                      <td style={{ padding: '5px 12px' }}><EmaLadderBadge ladder={d.emaLadder} slope={d.ema50Slope} /></td>
                      <td style={{ padding: '5px 12px', textAlign: 'right', fontWeight: 600,
                        color: d.rsi == null ? '#656974' : d.rsi >= 70 ? '#b32d19' : d.rsi <= 30 ? '#05664a' : '#1355a8' }}>
                        {d.rsi != null ? d.rsi.toFixed(1) : '—'}
                      </td>
                      <td style={{ padding: '5px 12px', textAlign: 'right', color: '#1355a8' }}
                        title={d.score != null ? `Technical ${fmt(d.technicalScore, 0)} · Fundamental ${fmt(d.fundamentalScore, 0)} · Momentum ${fmt(d.momentumScore, 0)}` : ''}>
                        {d.score != null ? fmt(d.score, 0) : <span style={{ color: '#656974' }}>—</span>}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        </div>
        {results && results.length > 0 && <StockInsightPanel symbol={results[0].data.symbol} />}
        </div>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────
// TRADES vs RECOMMENDATIONS — one row per BUY order you currently still hold,
// tagged with whichever Top-25 list(s) or ProPicks strategy recommended it on
// that same day, enriched with the matching advisor recommendation (entry/target/
// trend/status) when one exists. Positions fully exited drop off this view — the
// underlying orders stay in the DB for a future full performance report, they're
// just not shown here (this page is about what you're currently in and why).
// ProPicks matching is best-effort: the sync table only holds the CURRENT pick
// list (full-replace on every sync), so a pick removed since your order was
// placed can no longer be matched — see pickerMatchService.js.
// ─────────────────────────────────────────
function TradesPerformancePanel({ navigate, recommendations, onAddRec }) {
  const [result, setResult]   = useState(null);
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState({});   // { [orderId]: true }
  const [technicals, setTechnicals] = useState({});   // { [symbol]: data | 'loading' | 'error' }
  const [expandedCategories, setExpandedCategories] = useState({});   // { [categoryKey]: true }
  const [w52, setW52] = useState({});   // { [symbol]: data | 'loading' | 'error' } — global cache, shared across categories

  // No date filter — every currently-held equity position is matched and categorized,
  // regardless of when it was bought. (A "Since" filter used to limit this to recent
  // buys only; removed so a stock's full invested amount lands in one category instead
  // of being split by an arbitrary cutoff.)
  function load() {
    setLoading(true); setError('');
    fetchPickerMatches({})
      .then(setResult)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  const inr = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  const pnlColor = (v) => (v > 0 ? 'var(--lime)' : v < 0 ? '#b32d19' : 'var(--text-secondary)');

  // Positions carry the authoritative money figures (invested/currentValue/pnl), sourced
  // backend-side from the broker's own holdings snapshot rather than recomputed from raw
  // order history — order prices/quantities aren't adjusted for stock splits/bonuses, so
  // summing them directly can badly misstate P&L for a stock that's had one. See
  // pickerMatchService.getPickerMatches.
  const positions = result?.positions || [];
  const summary = result?.summary || [];
  const untrackedSummary = summary.find((s) => s.key === 'untagged') || null;
  const trackedSummary = summary.filter((s) => s.key !== 'untagged');

  // Same three-tier priority the backend uses (ProPicks > Nifty 500 > other lists) — used
  // here only to decide which badge to highlight when a symbol's positions across
  // portfolios matched different sources; the category cards' own totals already use each
  // position's individually-assigned primarySource, this doesn't affect those.
  function pickPrimarySourceClientSide(sources) {
    if (!sources.length) return null;
    const propicks = sources.find((s) => s.type === 'propicks');
    if (propicks) return propicks;
    const nifty500 = sources.find((s) => s.type === 'top25' && s.key === 'NIFTY500');
    if (nifty500) return nifty500;
    const others = sources.filter((s) => s.type === 'top25' && s.key !== 'NIFTY500');
    if (others.length) return others.reduce((best, s) => (s.rank < best.rank ? s : best));
    return null;
  }

  // One row per SYMBOL (merged across portfolios) — a stock held in both Rams and Geetha,
  // or bought in several tranches, collapses into a single row: invested = sum across
  // positions, Since Buy % = blended (total current value vs total invested, not an
  // average of the per-position %s). The individual buys are still listed in the row's
  // expand detail, not lost.
  const groupedRows = useMemo(() => {
    const map = new Map();
    for (const p of positions) {
      let g = map.get(p.symbol);
      if (!g) {
        g = { symbol: p.symbol, buys: [], invested: 0, currentValue: 0, pricedInvested: 0,
              firstDate: p.tradeDate, lastDate: p.tradeDate, sourcesByKey: new Map(), cmp: null, cmpAsOf: null };
        map.set(p.symbol, g);
      }
      g.invested += p.invested;
      if (p.priced) { g.currentValue += p.currentValue; g.pricedInvested += p.invested; }
      if (g.cmp == null && p.cmp != null) { g.cmp = p.cmp; g.cmpAsOf = p.cmpAsOf; }
      for (const b of p.buys) g.buys.push({ ...b, portfolio: p.portfolio });
      for (const s of p.sources) if (!g.sourcesByKey.has(s.key)) g.sourcesByKey.set(s.key, s);
      if (p.tradeDate < g.firstDate) g.firstDate = p.tradeDate;
      if (p.tradeDate > g.lastDate)  g.lastDate  = p.tradeDate;
    }
    return [...map.values()].map((g) => {
      const sortedBuys = [...g.buys].sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));
      const sources = [...g.sourcesByKey.values()];
      const returnPct = g.pricedInvested > 0
        ? Math.round(((g.currentValue - g.pricedInvested) / g.pricedInvested) * 1000) / 10 : null;
      return {
        symbol: g.symbol, tradeDate: g.lastDate, firstDate: g.firstDate, count: sortedBuys.length,
        invested: Math.round(g.invested * 100) / 100, returnPct, cmp: g.cmp, cmpAsOf: g.cmpAsOf,
        sources, tagged: sources.length > 0, primarySource: pickPrimarySourceClientSide(sources),
        orders: sortedBuys,
      };
    }).sort((a, b) => b.tradeDate.localeCompare(a.tradeDate) || b.invested - a.invested);
  }, [positions]);

  const shown = showAll ? groupedRows : groupedRows.slice(0, 15);

  // For each order, find the closest advisor recommendation for the same symbol dated
  // on or before the order date (falls back to the earliest one if all postdate the order).
  const recBySymbol = useMemo(() => {
    const map = new Map();
    for (const r of recommendations) {
      const k = (r.symbol || '').toUpperCase();
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    for (const list of map.values()) list.sort((a, b) => (a.recommendation_date < b.recommendation_date ? -1 : 1));
    return map;
  }, [recommendations]);

  function matchRec(symbol, onOrBeforeDate) {
    const list = recBySymbol.get(symbol.toUpperCase());
    if (!list || !list.length) return null;
    const onOrBefore = list.filter((r) => r.recommendation_date <= onOrBeforeDate);
    return onOrBefore.length ? onOrBefore[onOrBefore.length - 1] : list[0];
  }

  // Lazy — only fetched the first time a row for that symbol is expanded, cached after.
  function toggleExpand(row) {
    setExpanded((p) => ({ ...p, [row.symbol]: !p[row.symbol] }));
    if (technicals[row.symbol]) return;   // already loaded/loading
    setTechnicals((p) => ({ ...p, [row.symbol]: 'loading' }));
    fetchSymbolTechnicals(row.symbol)
      .then((r) => setTechnicals((p) => ({ ...p, [row.symbol]: r })))
      .catch(() => setTechnicals((p) => ({ ...p, [row.symbol]: 'error' })));
  }

  // Per-picker-category stock breakdown — each POSITION counts toward exactly ONE category
  // (its backend-assigned primarySource: ProPicks > Nifty 500 Top 25 > other cap lists),
  // so a stock is never double-counted across cards. Grouped by symbol within the
  // category so a stock held across portfolios shows once with a blended return.
  const categoryStocks = useMemo(() => {
    const byCategory = new Map();   // key -> Map<symbol, {invested, currentValue, pricedInvested}>
    for (const p of positions) {
      const key = p.primarySource ? p.primarySource.key : 'untagged';
      if (!byCategory.has(key)) byCategory.set(key, new Map());
      const bySymbol = byCategory.get(key);
      let e = bySymbol.get(p.symbol);
      if (!e) { e = { symbol: p.symbol, invested: 0, currentValue: 0, pricedInvested: 0 }; bySymbol.set(p.symbol, e); }
      e.invested += p.invested;
      if (p.priced) { e.currentValue += p.currentValue; e.pricedInvested += p.invested; }
    }
    const out = new Map();
    for (const [key, bySymbol] of byCategory) {
      const list = [...bySymbol.values()]
        .map((e) => ({
          symbol: e.symbol,
          invested: Math.round(e.invested * 100) / 100,
          returnPct: e.pricedInvested > 0 ? Math.round(((e.currentValue - e.pricedInvested) / e.pricedInvested) * 1000) / 10 : null,
        }))
        .sort((a, b) => b.invested - a.invested);
      out.set(key, list);
    }
    return out;
  }, [positions]);

  // Lazy, batched — only fetches 52w high/low for symbols not already cached, the first
  // time a category card is expanded.
  function toggleCategory(key) {
    setExpandedCategories((p) => ({ ...p, [key]: !p[key] }));
    const stocks = categoryStocks.get(key) || [];
    const missing = stocks.map((s) => s.symbol).filter((sym) => !w52[sym]);
    if (!missing.length) return;
    setW52((p) => { const n = { ...p }; missing.forEach((sym) => { n[sym] = 'loading'; }); return n; });
    fetchSymbol52wBatch(missing)
      .then((data) => setW52((p) => { const n = { ...p }; missing.forEach((sym) => { n[sym] = data[sym] || 'error'; }); return n; }))
      .catch(() => setW52((p) => { const n = { ...p }; missing.forEach((sym) => { n[sym] = 'error'; }); return n; }));
  }

  return (
    <div className="panel" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ margin: 0 }}>🧭 Your Trades vs Recommendations</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button type="button" onClick={load}
            style={{ background: 'none', border: '1px solid var(--border-md)', borderRadius: 8, padding: '6px 12px', fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            ↻ Refresh
          </button>
          <button type="button" onClick={onAddRec}
            style={{ background: 'var(--lime)', color: '#ffffff', border: 'none', borderRadius: 8,
              padding: '10px 18px', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
            + Add
          </button>
        </div>
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
        Every equity position you currently hold, matched against whichever source flagged it on or up to 5 days before you bought it — so you can see which picker's calls are actually paying off, across your full order history (no date cutoff).
        Click <strong>+</strong> on a row for portfolio, entry/target and trend detail. Fully-exited positions aren't shown here but stay in your order history.
        {' '}A buy often matches more than one source, so it is credited to a single one in this order:{' '}
        <strong>ProPicks → TechCheck by Niti → Top-25</strong> (Nifty 500 first, then Midcap, Smallcap, Microcap).
        {' '}The named calls outrank the screens deliberately — a Top-25 entry only says the stock screened well that day, while a named call is the likelier reason you actually bought it.
        {' '}The cards below read in that same order rather than by return, since a list can top the table just because one holding in it ran.
        {' '}ProPicks and TechCheck both match against the call's own live window — added/removed dates for ProPicks, advice date until the target or stop was hit for TechCheck — so a buy made while the call was running still counts even after it has closed.
      </p>
      <p style={{ fontSize: 12.5, color: '#9a5b06', marginTop: 4, background: 'rgba(154, 91, 6,0.08)', border: '1px solid rgba(154, 91, 6,0.25)', borderRadius: 6, padding: '8px 13px' }}>
        ⚠️ Daily Top-25 scan history in this app only goes back to late June 2026 — a trade bought well before that has nothing to match against here even if it genuinely was on a list at the time (e.g. one you were following offline). Such trades will land in "Not from a tracked list" by default, not because they weren't picks, but because we have no scan record for that date. Treat "untagged" for old trades as "unverifiable", not "wasn't a pick."
      </p>
      {error && <p className="negative">{error}</p>}
      {loading && !result && <p className="muted">Loading…</p>}

      {/* "Not from a tracked list" is its own full pull-report (see Untracked Holdings in
          the nav) rather than a card here — it's most of the portfolio by trade count and
          reads as a long list dragging down this category grid, not a quick-glance summary. */}
      {trackedSummary.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginTop: 10, alignItems: 'start' }}>
          {trackedSummary.map((s) => {
            const isOpen = !!expandedCategories[s.key];
            const stocks = categoryStocks.get(s.key) || [];
            return (
              <div key={s.key} style={{ padding: '10px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border-md)', borderRadius: 8 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <button type="button" onClick={() => toggleCategory(s.key)}
                    title={isOpen ? 'Collapse stock list' : `Show the ${stocks.length} stock(s) behind this category`}
                    style={{
                      flexShrink: 0, width: 18, height: 18, marginTop: 1, padding: 0, lineHeight: '16px',
                      background: 'var(--bg-card)', border: '1px solid var(--border-md)', borderRadius: 4,
                      color: 'var(--text-secondary)', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                    }}>
                    {isOpen ? '−' : '+'}
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{s.label}</div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 19, fontWeight: 700, color: pnlColor(s.pnlPct) }}>
                        {s.pnlPct != null ? `${s.pnlPct > 0 ? '+' : ''}${s.pnlPct}%` : '—'}
                      </span>
                      {s.pnlAmount != null && (
                        <span style={{ fontSize: 13, fontWeight: 600, color: pnlColor(s.pnlAmount) }}>
                          ({s.pnlAmount >= 0 ? '+' : ''}{inr(s.pnlAmount)})
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                      {s.trades} trade{s.trades === 1 ? '' : 's'} · {inr(s.invested)} invested
                      {s.priced ? ` · ${s.winRate}% win rate` : ' · not yet priced'}
                    </div>
                  </div>
                </div>
                {isOpen && (
                  <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {stocks.map((st) => {
                      const w = w52[st.symbol];
                      return (
                        <div key={st.symbol} style={{ fontSize: 12.5 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                            <span onClick={() => navigate(`/stock-lookups?symbol=${encodeURIComponent(st.symbol)}`)}
                              title={`Open Stock Sleuth for ${st.symbol}`}
                              style={{ fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'rgba(148,163,184,0.4)', textUnderlineOffset: 2 }}>
                              {st.symbol}
                            </span>
                            <span style={{ color: pnlColor(st.returnPct) }}>
                              {st.returnPct != null ? `${st.returnPct > 0 ? '+' : ''}${st.returnPct}%` : '—'}
                            </span>
                          </div>
                          <div style={{ color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                            <span>{inr(st.invested)} invested</span>
                            <span>
                              {w === 'loading' ? 'loading 52w…'
                                : w === 'error' || !w ? '52w n/a'
                                : `${w.distanceFrom52WeekHighPct != null ? `${w.distanceFrom52WeekHighPct.toFixed(1)}% vs high` : ''}${w.distanceFrom52WeekHighPct != null && w.distanceFrom52WeekLowPct != null ? ' · ' : ''}${w.distanceFrom52WeekLowPct != null ? `+${w.distanceFrom52WeekLowPct.toFixed(1)}% vs low` : ''}`}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {untrackedSummary && (
        <div onClick={() => navigate('/untracked-holdings')}
          title="Open the full Untracked Holdings report"
          style={{ marginTop: 10, padding: '10px 14px', background: 'var(--bg-elevated)', border: '1px dashed var(--border-md)', borderRadius: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, cursor: 'pointer' }}
          onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--text-secondary)'}
          onMouseLeave={(e) => e.currentTarget.style.borderColor = 'var(--border-md)'}>
          <span style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>
            🔍 {untrackedSummary.trades} more position{untrackedSummary.trades === 1 ? '' : 's'} ({inr(untrackedSummary.invested)} invested) aren't matched to any tracked list.
          </span>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--lime)', whiteSpace: 'nowrap' }}>Untracked Holdings →</span>
        </div>
      )}

      {positions.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 14 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-md)' }}>
                <th scope="col" style={{ width: 24 }}></th>
                <th scope="col" style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--text-secondary)' }}>Date</th>
                <th scope="col" style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--text-secondary)' }}>Stock</th>
                <th scope="col" style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--text-secondary)' }}>Matched From</th>
                <th scope="col" style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--text-secondary)' }}>Invested</th>
                <th scope="col" style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--text-secondary)' }}>Since Buy</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((g) => {
                const isOpen = !!expanded[g.symbol];
                const rec = matchRec(g.symbol, g.lastDate || g.tradeDate);
                const gain   = rec?.gain_from_entry;
                const upside = rec?.upside_to_target;
                return (
                  <React.Fragment key={g.symbol}>
                    <tr style={{ borderBottom: isOpen ? 'none' : '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 0 6px 9px' }}>
                        <button type="button" onClick={() => toggleExpand(g)}
                          title={isOpen ? 'Collapse detail' : `Show ${g.count > 1 ? `${g.count} buys, ` : ''}entry/target, trend & technicals`}
                          style={{
                            width: 18, height: 18, padding: 0, lineHeight: '16px',
                            background: 'var(--bg-elevated)', border: '1px solid var(--border-md)', borderRadius: 4,
                            color: 'var(--text-secondary)', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                          }}>
                          {isOpen ? '−' : '+'}
                        </button>
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>
                        {g.tradeDate}{g.count > 1 && <span title={`${g.count} buys, ${g.firstDate} → ${g.tradeDate}`} style={{ marginLeft: 4, fontSize: 11.5, color: 'var(--text-muted)' }}>(×{g.count})</span>}
                      </td>
                      <td style={{ padding: '8px 12px', fontWeight: 600 }}>
                        <span onClick={() => navigate(`/stock-lookups?symbol=${encodeURIComponent(g.symbol)}`)}
                          title={`Open Stock Sleuth for ${g.symbol}`}
                          style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'rgba(148,163,184,0.4)', textUnderlineOffset: 3 }}>
                          {g.symbol} 🔎
                        </span>
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        {g.tagged
                          ? g.sources.map((s) => {
                              const isPrimary = g.primarySource?.key === s.key;
                              return (
                                <span key={s.key}
                                  title={isPrimary ? 'Counted toward this category’s card above' : 'Also matched, but not the counted category (see priority: ProPicks > Nifty 500 > other lists)'}
                                  style={{ display: 'inline-block', fontSize: 12.5, padding: '2px 7px', margin: '1px 4px 1px 0', borderRadius: 12,
                                    background: isPrimary ? 'rgba(163,230,53,0.12)' : 'transparent',
                                    border: `1px solid ${isPrimary ? 'rgba(163,230,53,0.3)' : 'var(--border-md)'}`,
                                    color: isPrimary ? 'var(--lime)' : 'var(--text-muted)' }}>
                                  {s.label}
                                </span>
                              );
                            })
                          : <span style={{ fontSize: 12.5, padding: '2px 7px', background: 'var(--bg-elevated)', border: '1px solid var(--border-md)', borderRadius: 12, color: 'var(--text-muted)' }}>
                              Untagged
                            </span>}
                      </td>
                      <td style={{ padding: '8px 12px', textAlign: 'right' }}>{inr(g.invested)}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: pnlColor(g.returnPct) }}>
                        {g.returnPct != null ? `${g.returnPct > 0 ? '+' : ''}${g.returnPct}%` : '—'}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <td colSpan={6} style={{ padding: '0 10px 10px 34px', background: 'rgba(255,255,255,0.02)' }}>
                          {/* Underlying buys — the row above is the sum/blend of these */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 6 }}>
                            {g.orders.map((o) => (
                              <div key={o.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'center', fontSize: 13 }}>
                                <span style={{ color: 'var(--text-muted)', minWidth: 76, display: 'inline-block' }}>{o.tradeDate}</span>
                                <PortfolioBadge portfolio={o.portfolio} style={{ fontSize: 11.5, padding: '1px 7px' }} />
                                <span style={{ color: 'var(--text-secondary)' }}>
                                  {o.quantity} qty @ <strong style={{ color: 'var(--text-primary)' }}>₹{fmt(o.price, 2)}</strong>
                                </span>
                                <span style={{ color: 'var(--text-muted)' }}>{inr(o.invested)} invested</span>
                              </div>
                            ))}
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', paddingTop: 8, marginTop: 6, borderTop: '1px dashed var(--border)', fontSize: 13 }}>
                            {g.cmp != null && (
                              <span style={{ color: 'var(--text-secondary)' }}>
                                CMP <strong style={{ color: 'var(--text-primary)' }}>₹{fmt(g.cmp, 2)}</strong>
                                {g.cmpAsOf && <span style={{ color: 'var(--text-muted)' }}> (as of {g.cmpAsOf})</span>}
                              </span>
                            )}
                            {rec ? (
                              <>
                                <span style={{ color: 'var(--text-secondary)' }}>
                                  {rec.advisor} rec'd {rec.recommendation_date} @ <strong style={{ color: 'var(--text-primary)' }}>₹{fmt(rec.cmp, 2)}</strong>
                                  {gain != null && <span style={{ marginLeft: 4, color: pnlColor(gain) }}>({gain >= 0 ? '+' : ''}{gain.toFixed(1)}% since rec)</span>}
                                </span>
                                {rec.target_price > 0 && (
                                  <span style={{ color: 'var(--text-secondary)' }}>
                                    Target <strong style={{ color: 'var(--text-primary)' }}>₹{fmt(rec.target_price, 2)}</strong>
                                    {rec.target_hit
                                      ? <span style={{ marginLeft: 4, color: 'var(--lime)' }}>✅ Hit</span>
                                      : upside != null && <span style={{ marginLeft: 4, color: pnlColor(upside) }}>({upside >= 0 ? '+' : ''}{upside.toFixed(1)}% to go)</span>}
                                  </span>
                                )}
                                {rec.trend_status && <span style={{ color: 'var(--text-secondary)' }}>Trend: {rec.trend_status}</span>}
                              </>
                            ) : (
                              <span style={{ color: 'var(--text-muted)' }}>No advisor recommendation logged for this symbol.</span>
                            )}
                          </div>
                          {(() => {
                            const t = technicals[g.symbol];
                            if (t === 'loading') return <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '6px 0 0' }}>Loading technicals…</p>;
                            if (t === 'error' || !t) return t === 'error' ? <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '6px 0 0' }}>Technicals unavailable.</p> : null;
                            const uni = t.byUniverse?.[0];
                            const universeIcon = { NIFTY500: '🏆', MIDCAP: '🥈', SMALLCAP: '🥉', MICROCAP: '🔬' };
                            return (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', paddingTop: 8, marginTop: 6, borderTop: '1px dashed var(--border)', fontSize: 13 }}>
                                {uni?.rsi != null && (
                                  <span style={{ color: 'var(--text-secondary)' }}>
                                    RSI <strong style={{ color: uni.rsi >= 70 ? '#9a5b06' : uni.rsi <= 30 ? '#1355a8' : 'var(--text-primary)' }}>{fmt(uni.rsi, 1)}</strong>
                                  </span>
                                )}
                                {t.cmpVs200EmaPct != null && (
                                  <span style={{ color: 'var(--text-secondary)' }}
                                    title={`200 EMA ₹${fmt(t.ema200, 2)} vs CMP ₹${fmt(t.currentPrice, 2)}`}>
                                    vs 200 EMA <strong style={{ color: pnlColor(t.cmpVs200EmaPct) }}>{t.cmpVs200EmaPct >= 0 ? '+' : ''}{fmt(t.cmpVs200EmaPct, 1)}%</strong>
                                  </span>
                                )}
                                {uni?.emaLadder && <span style={{ color: 'var(--text-secondary)' }}>EMA: {uni.emaLadder.replace(/_/g, ' ')}</span>}
                                {(t.ranks || []).map((r) => (
                                  <span key={r.universe} style={{ color: 'var(--text-secondary)' }}>
                                    {universeIcon[r.universe] || ''} {r.universe} <strong style={{ color: 'var(--text-primary)' }}>#{r.rank}</strong>/{r.total}
                                  </span>
                                ))}
                                {!uni && !(t.ranks || []).length && (
                                  <span style={{ color: 'var(--text-muted)' }}>Not in any scanned universe.</span>
                                )}
                              </div>
                            );
                          })()}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          {groupedRows.length > 15 && (
            <button type="button" onClick={() => setShowAll((v) => !v)}
              style={{ marginTop: 8, background: 'none', border: 'none', color: 'var(--lime)', fontSize: 13, cursor: 'pointer', padding: 0 }}>
              {showAll ? '▲ Show fewer' : `▼ Show all ${groupedRows.length} stocks`}
            </button>
          )}
        </div>
      )}

      {!loading && positions.length === 0 && !error && (
        <p style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 10 }}>No currently-held equity positions found.</p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────
// UNTRACKED HOLDINGS PAGE — the "Not from a tracked list" complement of the
// Recommendations page's "Your Trades vs Recommendations" panel, pulled out into its
// own report since it's most of the portfolio by trade count and didn't fit as a
// quick-glance summary card.
// ─────────────────────────────────────────
function UntrackedHoldingsPage() {
  const navigate = useNavigate();
  const [result, setResult]   = useState(null);
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(true);
  const [w52, setW52]         = useState({});   // { [symbol]: data | 'loading' | 'error' }
  const [sortBy, setSortBy]   = useState('invested');
  const [sortDir, setSortDir] = useState('desc');
  const [expanded, setExpanded] = useState({});   // { [symbol]: true }

  function load() {
    setLoading(true); setError('');
    fetchPickerMatches({})
      .then(setResult)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  const inr = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  const pnlColor = (v) => (v > 0 ? 'var(--lime)' : v < 0 ? '#b32d19' : 'var(--text-secondary)');

  // Positions carry the authoritative money figures (invested/currentValue/pnl), sourced
  // backend-side from the broker's own holdings snapshot rather than recomputed from raw
  // order history — order prices/quantities aren't adjusted for stock splits/bonuses, so
  // summing them directly can badly misstate P&L for a stock that's had one. See
  // pickerMatchService.getPickerMatches.
  const untrackedPositions = useMemo(() => (result?.positions || []).filter((p) => !p.tagged), [result]);

  const rows = useMemo(() => {
    const map = new Map();
    for (const p of untrackedPositions) {
      let g = map.get(p.symbol);
      if (!g) g = { symbol: p.symbol, portfolios: new Set(), buys: [], invested: 0, currentValue: 0, pricedInvested: 0 };
      map.set(p.symbol, g);
      for (const b of p.buys) g.buys.push({ ...b, portfolio: p.portfolio });
      g.portfolios.add(p.portfolio);
      g.invested += p.invested;
      if (p.priced) { g.currentValue += p.currentValue; g.pricedInvested += p.invested; }
    }
    return [...map.values()].map((g) => ({
      symbol: g.symbol,
      portfolios: [...g.portfolios],
      trades: g.buys.length,
      invested: Math.round(g.invested * 100) / 100,
      returnPct: g.pricedInvested > 0 ? Math.round(((g.currentValue - g.pricedInvested) / g.pricedInvested) * 1000) / 10 : null,
      orders: [...g.buys].sort((a, b) => b.tradeDate.localeCompare(a.tradeDate)),
    }));
  }, [untrackedPositions]);

  const sorted = useMemo(() => {
    const getters = { invested: (r) => r.invested, returnPct: (r) => r.returnPct ?? -Infinity, symbol: (r) => r.symbol };
    const getter = getters[sortBy] || getters.invested;
    return [...rows].sort((a, b) => {
      const av = getter(a), bv = getter(b);
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === 'asc' ? av - bv : bv - av;
    });
  }, [rows, sortBy, sortDir]);

  const totals = useMemo(() => {
    const invested = untrackedPositions.reduce((s, p) => s + p.invested, 0);
    const priced = untrackedPositions.filter((p) => p.priced);
    const pricedInvested = priced.reduce((s, p) => s + p.invested, 0);
    const currentValue = priced.reduce((s, p) => s + p.currentValue, 0);
    const wins = untrackedPositions.filter((p) => p.returnPct != null && p.returnPct > 0).length;
    return {
      trades: untrackedPositions.reduce((s, p) => s + p.tradeCount, 0),
      invested: Math.round(invested * 100) / 100,
      currentValue: priced.length ? Math.round(currentValue * 100) / 100 : null,
      pnlAmount: priced.length ? Math.round((currentValue - pricedInvested) * 100) / 100 : null,
      pnlPct: priced.length && pricedInvested ? Math.round(((currentValue - pricedInvested) / pricedInvested) * 1000) / 10 : null,
      winRate: priced.length ? Math.round((wins / priced.length) * 1000) / 10 : null,
    };
  }, [untrackedPositions]);

  // Lazy-batched 52w fetch — only for the symbols currently expanded, not the whole list.
  function toggleExpand(symbol) {
    setExpanded((p) => ({ ...p, [symbol]: !p[symbol] }));
    if (w52[symbol]) return;
    setW52((p) => ({ ...p, [symbol]: 'loading' }));
    fetchSymbol52wBatch([symbol])
      .then((data) => setW52((p) => ({ ...p, [symbol]: data[symbol] || 'error' })))
      .catch(() => setW52((p) => ({ ...p, [symbol]: 'error' })));
  }

  return (
    <PageShell title="Untracked Holdings"
      subtitle="Currently-held equity positions that don't match any tracked Top-25 list or ProPicks strategy"
      actions={<button type="button" onClick={load}
        style={{ background: 'none', border: '1px solid var(--border-md)', borderRadius: 8, padding: '10px 18px', fontSize: 14, color: 'var(--text-secondary)', cursor: 'pointer' }}>
        ↻ Refresh
      </button>}>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: -6, marginBottom: 6 }}>
        This is the complement of the <strong>Your Trades vs Recommendations</strong> panel on the{' '}
        <span onClick={() => navigate('/recommendations')} style={{ cursor: 'pointer', textDecoration: 'underline', color: 'var(--lime)' }}>Recommendations page</span>:
        every currently-held position that didn't match a tracked list ends up here instead.
      </p>
      <p style={{ fontSize: 12.5, color: '#9a5b06', marginBottom: 14, background: 'rgba(154, 91, 6,0.08)', border: '1px solid rgba(154, 91, 6,0.25)', borderRadius: 6, padding: '8px 13px' }}>
        ⚠️ Daily Top-25 scan history only goes back to late June 2026, so most of what's below is "bought before we could check," not "wasn't a pick" — including anything you were following on your own before this app existed. Treat this list as unverified, not as a verdict on stock quality.
      </p>

      {error && <p className="negative">{error}</p>}
      {loading && !result && <p className="muted">Loading…</p>}

      {!loading && !error && (
        <>
          <div className="stats-grid" style={{ marginBottom: 20 }}>
            <StatCard label="Untracked Positions" value={rows.length} helper={`${totals.trades} trades`} />
            <StatCard label="Invested" value={inr(totals.invested)} />
            <StatCard label="Current Value" value={totals.currentValue != null ? inr(totals.currentValue) : '—'} />
            <StatCard label="P&L"
              value={totals.pnlAmount != null ? `${totals.pnlAmount >= 0 ? '+' : ''}${inr(Math.abs(totals.pnlAmount))}` : '—'}
              helper={totals.pnlPct != null ? `${totals.pnlPct >= 0 ? '+' : ''}${totals.pnlPct}%` : ''}
              tone={totals.pnlAmount != null ? (totals.pnlAmount >= 0 ? 'positive' : 'negative') : ''} />
            <StatCard label="Win Rate" value={totals.winRate != null ? `${totals.winRate}%` : '—'} />
          </div>

          <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border-md)', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Sort:</span>
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
                style={{ fontSize: 13, padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-md)', borderRadius: 6, color: 'var(--text-primary)' }}>
                <option value="invested">Invested</option>
                <option value="returnPct">Return %</option>
                <option value="symbol">Symbol</option>
              </select>
              <select value={sortDir} onChange={(e) => setSortDir(e.target.value)}
                style={{ fontSize: 13, padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-md)', borderRadius: 6, color: 'var(--text-primary)' }}>
                <option value="desc">High → Low</option>
                <option value="asc">Low → High</option>
              </select>
              <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 'auto' }}>{rows.length} stock{rows.length === 1 ? '' : 's'}</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr style={{ background: 'var(--bg-elevated)', borderBottom: '2px solid var(--border-md)' }}>
                    <th scope="col" style={{ width: 30 }}></th>
                    <th scope="col" style={{ textAlign: 'left', padding: '11px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>Stock</th>
                    <th scope="col" style={{ textAlign: 'left', padding: '11px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>Portfolio(s)</th>
                    <th scope="col" style={{ textAlign: 'right', padding: '11px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>Trades</th>
                    <th scope="col" style={{ textAlign: 'right', padding: '11px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>Invested</th>
                    <th scope="col" style={{ textAlign: 'right', padding: '11px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>Return</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => {
                    const isOpen = !!expanded[r.symbol];
                    const w = w52[r.symbol];
                    return (
                      <React.Fragment key={r.symbol}>
                        <tr style={{ borderBottom: isOpen ? 'none' : '1px solid var(--border)' }}>
                          <td style={{ padding: '6px 0 6px 9px' }}>
                            <button type="button" onClick={() => toggleExpand(r.symbol)}
                              title={isOpen ? 'Collapse detail' : `Show ${r.trades} buy(s) and 52-week range`}
                              style={{ width: 18, height: 18, padding: 0, lineHeight: '16px', background: 'var(--bg-elevated)', border: '1px solid var(--border-md)', borderRadius: 4, color: 'var(--text-secondary)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                              {isOpen ? '−' : '+'}
                            </button>
                          </td>
                          <td style={{ padding: '8px 12px', fontWeight: 600 }}>
                            <span onClick={() => navigate(`/stock-lookups?symbol=${encodeURIComponent(r.symbol)}`)}
                              title={`Open Stock Sleuth for ${r.symbol}`}
                              style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'rgba(148,163,184,0.4)', textUnderlineOffset: 3 }}>
                              {r.symbol} 🔎
                            </span>
                          </td>
                          <td style={{ padding: '8px 12px' }}>
                            {r.portfolios.map((p) => <PortfolioBadge key={p} portfolio={p} style={{ marginRight: 4 }} />)}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-secondary)' }}>{r.trades}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right' }}>{inr(r.invested)}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: pnlColor(r.returnPct) }}>
                            {r.returnPct != null ? `${r.returnPct > 0 ? '+' : ''}${r.returnPct}%` : '—'}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td></td>
                            <td colSpan={5} style={{ padding: '0 9px 12px' }}>
                              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 8 }}>
                                {w === 'loading' ? 'Loading 52-week range…'
                                  : w === 'error' || !w ? '52w data unavailable'
                                  : `${w.distanceFrom52WeekHighPct != null ? `${w.distanceFrom52WeekHighPct.toFixed(1)}% vs high` : ''}${w.distanceFrom52WeekHighPct != null && w.distanceFrom52WeekLowPct != null ? ' · ' : ''}${w.distanceFrom52WeekLowPct != null ? `+${w.distanceFrom52WeekLowPct.toFixed(1)}% vs low` : ''}`}
                              </div>
                              <div style={{ display: 'grid', gap: 6 }}>
                                {r.orders.map((o) => (
                                  <div key={o.id} style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'flex', gap: 12, alignItems: 'center' }}>
                                    <span style={{ color: 'var(--text-muted)', minWidth: 76 }}>{o.tradeDate}</span>
                                    <PortfolioBadge portfolio={o.portfolio} style={{ fontSize: 11.5, padding: '1px 7px' }} />
                                    <span>{o.quantity} @ ₹{o.price}</span>
                                    <span style={{ marginLeft: 'auto' }}>{inr(o.invested)}</span>
                                  </div>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}

function RecommendationsPage() {
  const navigate = useNavigate();
  const [data,     setData]     = useState(null);
  const [error,    setError]    = useState('');
  const [recForm,  setRecForm]  = useState(null);

  const loadRecs = () => fetchRecommendations().then(setData).catch((err) => setError(err.message));

  useEffect(() => { loadRecs(); }, []);

  return (
    <PageShell title="Recommendations" subtitle="Advisor recommendations with live tracking">
      {error ? <p className="negative">{error}</p> : null}

      {recForm && (
        <AddRecommendationForm key={recForm.symbol || 'manual'} prefill={recForm} onSaved={loadRecs} onClose={() => setRecForm(null)} />
      )}

      <TradesPerformancePanel navigate={navigate} recommendations={data?.rows || []} onAddRec={() => setRecForm({})} />

      <TechCheckPanel />

      <Nifty500TopPanel onAddRec={(prefill) => { setRecForm(prefill); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />

      <Nifty500TopPanel universe="MIDCAP" title="Nifty Midcap 150 Daily Top 25" icon="🥈" totalLabel="~150"
        onAddRec={(prefill) => { setRecForm(prefill); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />

      <Nifty500TopPanel universe="SMALLCAP" title="Nifty Smallcap 250 Daily Top 25" icon="🥉" totalLabel="~250"
        onAddRec={(prefill) => { setRecForm(prefill); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />

      <Nifty500TopPanel universe="MICROCAP" title="Nifty Microcap 250 Daily Top 25" icon="🔬" totalLabel="~250"
        onAddRec={(prefill) => { setRecForm(prefill); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
    </PageShell>
  );
}

function InvestingPicksPage() {
  return (
    <PageShell title="Investing.com ProPicks" subtitle="Facts synced from your investing.com Pro subscription, cross-mapped to your Nifty 500 scan & holdings">
      <InvestingRecsPanel />
    </PageShell>
  );
}

// ─────────────────────────────────────────
// INVESTING.COM PROPICKS (synced via userscript; facts + link-out only)
// ─────────────────────────────────────────
function InvestingRecsPanel() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  // THIS ENDPOINT TAKES 10-13 SECONDS. It ranks every pick against four full universe scans
  // before answering. Without a loading state the panel renders "No picks synced yet" for that
  // whole time - which is not "still loading", it is a positive claim that there is no data.
  // Anyone who had just run the userscript would reasonably read it as the sync having failed.
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    fetchExternalRecs()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  const picks = data?.picks || [];
  const today = new Date().toDateString();
  const fmtDate = (iso) => iso
    ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', ...(new Date(iso).toDateString() === today ? { hour: '2-digit', minute: '2-digit' } : { year: '2-digit' }) })
    : '—';

  // Group picks by strategy, mirroring investing.com's own "Explore Different
  // Strategies" cards (Bharat Bargains / Infra Titans / Mid-Cap Movers / Small Cap Gems).
  const byStrategy = new Map();
  for (const p of picks) {
    if (!byStrategy.has(p.strategy)) byStrategy.set(p.strategy, []);
    byStrategy.get(p.strategy).push(p);
  }
  const strategyGroups = [...byStrategy.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // ── How old is this data? ──────────────────────────────────────────────────
  //
  // NOTHING IN THIS APP CAN FETCH PROPICKS. The data only arrives when the browser userscript
  // scrapes the page you are logged into and pushes it here, so the panel is only ever as
  // current as the last time you visited investing.com. A month-old sync used to render
  // identically to one from this morning — a muted grey "synced 03 Aug" that reads as a
  // caption rather than a warning — and the list sat a full ProPicks cycle out of date.
  //
  // Thresholds follow the source's own cadence: ProPicks republishes monthly, so a week is
  // unremarkable, and anything past 30 days means an entire update has been missed.
  const ageDays = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null);
  function staleness(iso) {
    const days = ageDays(iso);
    if (days === null) return { level: 'none', days: null, label: 'never synced' };
    const label = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    if (days > 30) return { level: 'bad', days, label };
    if (days > 7) return { level: 'warn', days, label };
    return { level: 'ok', days, label };
  }
  const StaleChip = ({ iso, prefix = 'synced' }) => {
    const s = staleness(iso);
    if (s.level === 'ok') {
      return <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{prefix} {fmtDate(iso)}</span>;
    }
    const tone = s.level === 'bad'
      ? { fg: 'var(--neg)', bg: 'var(--neg-tint)' }
      : { fg: 'var(--warn)', bg: 'var(--warn-tint)' };
    return (
      <span
        title={s.level === 'none'
          ? 'No sync has ever reached this app.'
          : `Last pushed by the userscript on ${new Date(iso).toLocaleString('en-IN')}. `
            + 'This panel cannot fetch on its own — Refresh only re-reads what is already stored.'}
        style={{
          fontSize: 12, fontWeight: 700, color: tone.fg, background: tone.bg,
          border: `1px solid ${tone.fg}`, borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap',
        }}
      >
        {s.level === 'none' ? 'never synced' : `${prefix} ${s.label}`}
      </span>
    );
  };

  // The header stamp is the NEWEST capture across all strategies, so it hides a strategy that
  // has fallen behind on its own. Worth calling out separately, because that was the exact
  // shape of the bug: one strategy syncing daily while the other three quietly went stale.
  const overallStale = staleness(data?.capturedAt);
  const staleStrategies = strategyGroups
    .map(([name, rows]) => {
      const newest = rows.reduce((max, r) => (r.capturedAt > max ? r.capturedAt : max), '');
      return { name, capturedAt: newest, s: staleness(newest) };
    })
    .filter((x) => x.s.level === 'warn' || x.s.level === 'bad');

  const Table = ({ rows, kind }) => (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table compact-table">
        <thead>
          <tr>
            <th scope="col">Stock</th><th scope="col">Price When Added</th>
            <th scope="col" title="Change in the stock's own price from price-when-added to its latest scan price — keeps moving whether or not the pick is still live. Hover a cell for the two prices and the scan date.">Change Since Added</th>
            <th scope="col">{kind === 'removed' ? 'Removed' : 'Added'}</th>
            <th scope="col">{kind === 'removed' ? 'Return at Exit' : 'Status'}</th>
            <th scope="col" title="Your rank in each scanned universe: NY=Nifty 500, MC=Midcap 150, SC=Smallcap 250, MI=Microcap 250. Shows every list the stock is in.">Your Scan Rank</th>
            <th scope="col">Held</th><th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const dateIso = kind === 'removed' ? (p.removedAt || p.capturedAt) : (p.firstSeenAt || p.capturedAt);
            const isNewToday = kind !== 'removed' && dateIso && new Date(dateIso).toDateString() === today;
            // Splits/bonuses restate the price scale — the backend rescales price-when-added
            // so the change stays honest, and withholds it outright when the ratio is unreadable.
            const acts = p.corpActionsSinceAdded || [];
            const actText = acts.map((a) => `${a.type} "${a.subject}" ex ${a.exDate}`).join('; ');
            const changeTitle = p.changeBlockedByCorpAction
              ? `Not comparable — ${actText} changed the price scale and its ratio couldn't be read, so ₹${fmt(p.priceAdded, 2)} can't be restated onto today's scale.`
              : p.cmp == null
                ? 'No scan price for this stock — not in any scanned universe'
                : `₹${fmt(p.priceAdded, 2)} when added → ₹${fmt(p.cmp, 2)}${p.cmpAsOf ? ` (scan of ${p.cmpAsOf})` : ''}`
                  + (acts.length ? `\nAdjusted for ${actText} — measured against the restated ₹${fmt(p.priceAddedAdjusted, 2)}.` : '');
            return (
            <tr key={p.id}>
              <td>
                <strong
                  onClick={() => navigate(`/stock-lookups?symbol=${encodeURIComponent(p.symbol || p.company)}`)}
                  title={`Open Stock Sleuth for ${p.symbol || p.company} — price & EMA trend over 1 week / 15 days / 1 month / 2 months`}
                  style={{
                    color: p.heldBy?.length ? 'var(--lime)' : 'var(--text-primary)',
                    cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'rgba(148,163,184,0.4)', textUnderlineOffset: 3,
                  }}>
                  {p.symbol || p.company} 🔎
                </strong>
                {p.company && p.symbol && <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-muted)' }}>{p.company}</span>}
              </td>
              <td>{p.priceAdded != null ? `₹${fmt(p.priceAdded, 2)}` : '—'}</td>
              <td className={p.changeSinceAdded != null ? (p.changeSinceAdded >= 0 ? 'positive' : 'negative') : ''}
                title={changeTitle}>
                {p.changeSinceAddedPct != null
                  ? <>
                      {/* Sign goes before the ₹, not inside the number — fmt() keeps its own
                          minus, so ₹{fmt(-62.3)} would render the wrong "₹-62.30". */}
                      {p.changeSinceAdded >= 0 ? '+' : '-'}₹{fmt(Math.abs(p.changeSinceAdded), 2)}
                      <span style={{ opacity: 0.75 }}> ({fmtPct(p.changeSinceAddedPct)})</span>
                      {acts.length > 0 && <span style={{ marginLeft: 5, fontSize: 11.5, color: 'var(--text-muted)' }}>⚙adj</span>}
                    </>
                  : <span className={p.changeBlockedByCorpAction ? '' : 'muted'}
                      style={p.changeBlockedByCorpAction ? { color: '#9a5b06' } : undefined}>
                      {p.changeBlockedByCorpAction ? '⚠ n/a' : '—'}
                    </span>}
              </td>
              <td>
                {fmtDate(dateIso)}
                {isNewToday && <span style={{ marginLeft: 6, fontSize: 11.5, fontWeight: 700, color: 'var(--lime)', border: '1px solid var(--lime)', borderRadius: 4, padding: '1px 4px' }}>NEW</span>}
              </td>
              <td className={kind === 'removed' ? (p.returnPct >= 0 ? 'positive' : 'negative') : ''}>
                {kind === 'removed'
                  ? (p.returnPct != null ? fmtPct(p.returnPct) : '—')
                  : <span style={{ color: 'var(--lime)', fontWeight: 600 }}>● Live</span>}
              </td>
              <td>{p.ranks?.length
                ? <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {p.ranks.map((r) => (
                      <span key={r.universe}
                        title={`${{NIFTY500:'Nifty 500', MIDCAP:'Nifty Midcap 150', SMALLCAP:'Nifty Smallcap 250', MICROCAP:'Nifty Microcap 250'}[r.universe]} — rank ${r.rank} (1 = best score)`}
                        style={{ fontWeight: 700, whiteSpace: 'nowrap', color: r.rank <= 25 ? 'var(--lime)' : r.rank <= 100 ? '#1355a8' : 'var(--text-secondary)' }}>
                        {r.prefix} #{r.rank}
                      </span>
                    ))}
                  </span>
                : <span className="muted" title="Not in any scanned universe (Nifty 500 / Midcap 150 / Smallcap 250 / Microcap 250)">—</span>}</td>
              <td>{p.heldBy?.length
                ? <span style={{ fontSize: 12.5, color: 'var(--lime)', fontWeight: 700 }}>{p.heldBy.join('+')}</span>
                : <span className="muted" style={{ fontSize: 12.5 }}>—</span>}</td>
              <td>{p.stockUrl && <a href={p.stockUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: '#1355a8' }}>View ↗</a>}</td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>📊 Investing.com ProPicks</h2>
        {data?.strategies?.length > 0 && <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{data.strategies.length} strateg{data.strategies.length === 1 ? 'y' : 'ies'} synced</span>}
        {data?.capturedAt && (
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              synced {new Date(data.capturedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </span>
            {overallStale.level !== 'ok' && <StaleChip iso={data.capturedAt} prefix="" />}
          </span>
        )}
        {/* Named "Reload" rather than "Refresh": it re-reads what is already stored and has
            never once contacted investing.com. Calling it Refresh next to a stale date is an
            invitation to press it and conclude the data really is current. */}
        <button type="button" onClick={load} title="Re-reads the picks already stored locally. It cannot fetch from investing.com — only the browser userscript can do that." style={{ background: 'transparent', border: '1px solid var(--border-md)', borderRadius: 6, padding: '4px 10px', fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>↻ Reload</button>
      </div>
      <p style={{ margin: '4px 0 12px', fontSize: 12.5, color: 'var(--text-muted)' }}>
        Facts synced from your investing.com Pro subscription (via the browser userscript) and cross-mapped to your Nifty 500 scan &amp; holdings. Rationale stays on investing.com — click "View".
      </p>

      {/* Only shown when it matters, and it says what to actually do. A warning that does not
          name the next action just makes the staleness feel unavoidable. */}
      {picks.length > 0 && overallStale.level !== 'ok' && (
        <div style={{
          margin: '0 0 14px', padding: '10px 12px', borderRadius: 8, fontSize: 12.5,
          color: overallStale.level === 'bad' ? 'var(--neg)' : 'var(--warn)',
          background: overallStale.level === 'bad' ? 'var(--neg-tint)' : 'var(--warn-tint)',
          border: `1px solid ${overallStale.level === 'bad' ? 'var(--neg)' : 'var(--warn)'}`,
        }}>
          <strong>
            {overallStale.level === 'bad'
              ? `These picks are ${overallStale.label} — ProPicks republishes monthly, so at least one update has been missed.`
              : `These picks were last synced ${overallStale.label}.`}
          </strong>
          <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>
            Nothing here can fetch on its own. Open{' '}
            <a href="https://in.investing.com/pro/propicks/" target="_blank" rel="noopener noreferrer">in.investing.com/pro/propicks</a>{' '}
            signed in, visit <strong>each</strong> strategy page, and use the{' '}
            <strong>⟳ Sync ProPicks → Equix</strong> button — the userscript only reads the page it is on.
            {staleStrategies.length > 0 && staleStrategies.length < strategyGroups.length && (
              <> Behind right now: <strong>{staleStrategies.map((x) => x.name).join(', ')}</strong>.</>
            )}
          </div>
        </div>
      )}

      {error && <p className="negative">{error}</p>}
      {loading && (
        <p className="muted">Loading picks and cross-mapping them against your universe scans… this takes about ten seconds.</p>
      )}
      {!loading && !error && picks.length === 0 && (
        <p className="muted">No picks synced yet. Open your investing.com ProPicks page (with the userscript installed) and click <strong>⟳ Sync ProPicks → Equix</strong>.</p>
      )}

      {strategyGroups.map(([strategy, groupPicks]) => {
        const added = groupPicks.filter((p) => p.action === 'Added');
        const removed = groupPicks.filter((p) => p.action === 'Removed');
        const newTodayCount = added.filter((p) => p.firstSeenAt && new Date(p.firstSeenAt).toDateString() === today).length;
        // Each strategy is synced by its own page visit, so each one ages independently. The
        // header stamp only shows the newest across all four and would hide exactly this.
        const groupCapturedAt = groupPicks.reduce((max, r) => (r.capturedAt > max ? r.capturedAt : max), '');
        return (
          <div key={strategy} style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border-md)' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: '1.02rem', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span>🗂️ {strategy}</span>
              <span style={{ fontSize: 12.5, fontWeight: 400, color: 'var(--text-muted)' }}>{added.length} live{removed.length ? ` · ${removed.length} removed` : ''}</span>
              {newTodayCount > 0 && <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--lime)', border: '1px solid var(--lime)', borderRadius: 4, padding: '1px 5px' }}>{newTodayCount} new today</span>}
              <span style={{ fontWeight: 400 }}><StaleChip iso={groupCapturedAt} /></span>
            </h3>
            {added.length > 0 && <>
              <h4 style={{ margin: '10px 0 6px', fontSize: '0.85rem', color: 'var(--lime)', fontWeight: 600 }}>✅ Currently Added ({added.length})</h4>
              <Table rows={added} kind="added" />
            </>}
            {removed.length > 0 && <>
              <h4 style={{ margin: '16px 0 6px', fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 600 }}>↩️ Recently Removed ({removed.length})</h4>
              <Table rows={removed} kind="removed" />
            </>}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────
// INVESTMENT TREND REPORT — weekly/monthly rows of invested vs current value,
// over a user-picked date range, from portfolio_summary.
// ─────────────────────────────────────────
function InvestmentTrendSection({ portfolio }) {
  const [frequency, setFrequency] = useState('monthly');
  const [fromDate,  setFromDate]  = useState('');
  const [toDate,    setToDate]    = useState(new Date().toISOString().slice(0, 10));
  const [report,    setReport]    = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');

  function load() {
    setLoading(true); setError('');
    fetchInvestmentTrendReport({ portfolio, frequency, from: fromDate, to: toDate })
      .then(setReport)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, [portfolio, frequency]);   // eslint-disable-line react-hooks/exhaustive-deps

  const inr = (v) => v == null ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  const pct = (v) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  const rows = report?.rows || [];
  const first = rows[0], last = rows[rows.length - 1];

  return (
    <div className="panel" style={{ marginBottom: 20 }}>
      <h2 style={{ marginTop: 0 }}>📈 Investment Trend Report — Invested vs Current Value</h2>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: -6, marginBottom: 12 }}>
        Each row is a period's closing figures, as of the latest portfolio snapshot saved on or before that period's end date.
        Periods with no snapshot yet are skipped. Some months below reflect real data gaps/partial saves in the underlying snapshots, not a calculation error.
      </p>

      {/* Filters — frequency + date range */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border-md)', borderRadius: 8, overflow: 'hidden' }}>
          {['weekly', 'monthly'].map((f) => (
            <button key={f} type="button" onClick={() => setFrequency(f)}
              style={{ background: frequency === f ? 'var(--lime)' : 'var(--bg-elevated)', color: frequency === f ? '#ffffff' : 'var(--text-secondary)',
                border: 'none', padding: '7px 16px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize' }}>
              {f}
            </button>
          ))}
        </div>
        <label style={{ fontSize: 13.5, display: 'inline-flex', gap: 8, alignItems: 'center', color: 'var(--text-secondary)' }}>
          From <input type="date" value={fromDate} max={toDate} onChange={(e) => setFromDate(e.target.value)}
            style={{ padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-md)', borderRadius: 6, fontSize: 13, color: 'var(--text-primary)' }} />
        </label>
        <label style={{ fontSize: 13.5, display: 'inline-flex', gap: 8, alignItems: 'center', color: 'var(--text-secondary)' }}>
          To <input type="date" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)}
            style={{ padding: '6px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-md)', borderRadius: 6, fontSize: 13, color: 'var(--text-primary)' }} />
        </label>
        <button type="button" onClick={load} disabled={loading}
          style={{ background: 'var(--lime)', color: '#ffffff', border: 'none', borderRadius: 8, padding: '7px 16px', fontWeight: 700, fontSize: 14, cursor: loading ? 'not-allowed' : 'pointer' }}>
          {loading ? '⏳ Loading…' : '↻ Apply'}
        </button>
      </div>

      {error && <p className="negative">{error}</p>}

      {!loading && last && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
          <div style={{ padding: '11px 16px', background: 'var(--bg-elevated)', borderRadius: 8, border: '1px solid var(--border-md)' }}>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>INVESTED (as of {last.asOfDate})</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{inr(last.invested)}</div>
          </div>
          <div style={{ padding: '11px 16px', background: 'var(--bg-elevated)', borderRadius: 8, border: '1px solid var(--border-md)' }}>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>CURRENT VALUE</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{inr(last.value)}</div>
          </div>
          <div style={{ padding: '11px 16px', background: 'var(--bg-elevated)', borderRadius: 8, border: '1px solid var(--border-md)' }}>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>GAIN</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: last.gain >= 0 ? 'var(--lime)' : '#b32d19' }}>
              {last.gain >= 0 ? '+' : ''}{inr(last.gain)} ({pct(last.gainPct)})
            </div>
          </div>
          {first && first !== last && (
            <div style={{ padding: '11px 16px', background: 'var(--bg-elevated)', borderRadius: 8, border: '1px solid var(--border-md)' }}>
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>ADDED SINCE {first.asOfDate}</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{inr(last.invested - first.invested)}</div>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>No portfolio snapshots in this range yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-md)' }}>
                <th scope="col" style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--text-secondary)' }}>Period</th>
                <th scope="col" style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--text-secondary)' }}>As Of</th>
                <th scope="col" style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--text-secondary)' }}>Invested</th>
                <th scope="col" style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--text-secondary)' }}>Current Value</th>
                <th scope="col" style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--text-secondary)' }}>Gain</th>
                <th scope="col" style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--text-secondary)' }}>Gain %</th>
                <th scope="col" style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--text-secondary)' }}>Added This Period</th>
                <th scope="col" style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--text-secondary)' }}>Value Δ This Period</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((r) => (
                <tr key={r.label} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px', fontWeight: 600 }}>{r.label}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{r.asOfDate}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }}>{inr(r.invested)}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }}>{inr(r.value)}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: r.gain >= 0 ? 'var(--lime)' : '#b32d19' }}>{inr(r.gain)}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', color: r.gainPct >= 0 ? 'var(--lime)' : '#b32d19' }}>{pct(r.gainPct)}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-secondary)' }}>{inr(r.addedThisPeriod)}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', color: r.valueChgPctThisPeriod == null ? 'var(--text-muted)' : r.valueChgPctThisPeriod >= 0 ? 'var(--lime)' : '#b32d19' }}>
                    {r.valueChgThisPeriod == null ? '—' : `${inr(r.valueChgThisPeriod)} (${pct(r.valueChgPctThisPeriod)})`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────
// PERFORMANCE PAGE
// ─────────────────────────────────────────

const PERF_PERIODS = ['weekly', 'monthly', 'quarterly'];
const PERF_PORTFOLIOS = ['both', 'Rams', 'Geetha'];

// ── Trade Impact: were the buys and sells of a period well timed? ─────────────
// Scored against what the price did AFTERWARDS, so a sale into a rally is a negative even
// though it booked a profit. That inversion is the point — it is what turns a P&L statement
// into an answer to "did my rotation make sense".
function TradeImpactPanel() {
  const monthOptions = useMemo(() => {
    const out = [];
    const now = new Date(Date.now() + 330 * 60000);   // IST
    for (let i = 0; i < 24; i += 1) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const last = new Date(Date.UTC(y, d.getUTCMonth() + 1, 0)).getUTCDate();
      out.push({ key: `${y}-${m}`, label: d.toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
                 from: `${y}-${m}-01`, to: `${y}-${m}-${last}` });
    }
    return out;
  }, []);

  const [monthKey, setMonthKey] = useState(monthOptions[0].key);
  const [custom, setCustom]     = useState(false);
  const [from, setFrom]         = useState(monthOptions[0].from);
  const [to, setTo]             = useState(monthOptions[0].to);
  const [portfolio, setPortfolio] = useState('');
  const [horizon, setHorizon]   = useState('now');
  const [data, setData]         = useState(null);
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState('');

  const range = custom ? { from, to } : monthOptions.find((m) => m.key === monthKey) || monthOptions[0];

  const load = useCallback(() => {
    setBusy(true); setErr('');
    fetchOrderImpact({ from: range.from, to: range.to, portfolio, horizon })
      .then(setData)
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, portfolio, horizon]);

  useEffect(() => { load(); }, [load]);

  const t = data?.totals;
  const money = (v) => (v == null ? '—' : `${v < 0 ? '-' : ''}₹${fmt(Math.abs(v), 0)}`);
  const pct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(1)}%`);

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <h2 style={{ margin: 0 }}>🔄 Trade Impact — did this period&apos;s rotations work?</h2>
      <p style={{ margin: '3px 0 0', fontSize: 13, color: '#565a6b', lineHeight: 1.5 }}>
        Every buy and sell placed in the period, scored on what the price did <strong>afterwards</strong>.
        A buy that fell scores negative; a sell that fell scores <strong>positive</strong>, because the drop was avoided.
        Grouped by stock, not by order.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
        {!custom ? (
          <select value={monthKey} onChange={(e) => setMonthKey(e.target.value)}
            style={{ padding: '5px 9px', border: '1px solid #656974', borderRadius: 6, fontSize: 13.5 }}>
            {monthOptions.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        ) : (
          <>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              style={{ padding: '6px 10px', border: '1px solid #656974', borderRadius: 6, fontSize: 13.5 }} />
            <span style={{ color: '#656974', fontSize: 13 }}>→</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              style={{ padding: '6px 10px', border: '1px solid #656974', borderRadius: 6, fontSize: 13.5 }} />
          </>
        )}
        <button type="button" onClick={() => setCustom((c) => !c)}
          style={{ background: 'none', border: '1px solid #656974', borderRadius: 6, padding: '4px 10px', fontSize: 12.5, color: '#565a6b', cursor: 'pointer' }}>
          {custom ? 'Use month' : 'Custom range'}
        </button>
        <select value={portfolio} onChange={(e) => setPortfolio(e.target.value)}
          style={{ padding: '5px 9px', border: '1px solid #656974', borderRadius: 6, fontSize: 13.5 }}>
          <option value="">Both portfolios</option>
          <option value="Rams">Rams</option>
          <option value="Geetha">Geetha</option>
        </select>
        <select value={horizon} onChange={(e) => setHorizon(e.target.value)}
          title="'To today' marks every trade to the current price — best for recent periods, and completed round trips reconcile exactly to realised P&L. A fixed window judges each trade over the same span from its own date, so different periods can be compared fairly."
          style={{ padding: '5px 9px', border: '1px solid #656974', borderRadius: 6, fontSize: 13.5 }}>
          <option value="now">Judged: to today</option>
          <option value="1m">Judged: 1 month after each trade</option>
          <option value="3m">Judged: 3 months after</option>
          <option value="6m">Judged: 6 months after</option>
          <option value="12m">Judged: 12 months after</option>
        </select>
        {busy && <span style={{ fontSize: 12.5, color: '#565a6b' }}>loading…</span>}
      </div>

      {err && <p style={{ fontSize: 13, color: '#b32d19', marginTop: 8 }}>{err}</p>}

      {/* Honest caveats before the numbers, not buried under them. */}
      {data?.corpActionCoverageGap && (
        <p style={{ marginTop: 10, padding: '7px 10px', background: '#fef6e7', border: '1px solid #9a5b06',
          borderRadius: 6, fontSize: 12.5, color: '#9a5b06', lineHeight: 1.5 }}>
          ⚠ Split/bonus records only start {data.corpActionCoverageFrom}. This period predates them, so any
          stock that has split since will show an overstated loss — a 10:1 split reads as −90%. Treat large
          negative outliers here with suspicion.
        </p>
      )}
      {data?.dividendCoverageGap && (
        <p style={{ marginTop: 8, padding: '7px 10px', background: '#fef6e7', border: '1px solid #9a5b06',
          borderRadius: 6, fontSize: 12.5, color: '#9a5b06', lineHeight: 1.5 }}>
          ⚠ Dividend records only start {data.dividendCoverageFrom}. Payouts before that are unknown, not zero —
          so sells in this period look slightly better than they were, and buys slightly worse.
        </p>
      )}
      {data?.notMaturedSymbols?.length > 0 && (
        <p style={{ marginTop: 8, fontSize: 12.5, color: '#9a5b06' }}>
          ⏳ {data.totals.immatureFills} fill(s) across {data.notMaturedSymbols.length} stock(s) haven&apos;t
          completed the {data.horizonMonths}-month window yet — excluded rather than scored on a partial
          window. Switch to &ldquo;to today&rdquo; to include them.
        </p>
      )}
      {data?.unpricedSymbols?.length > 0 && (
        <p style={{ marginTop: 8, fontSize: 12.5, color: '#656974' }}>
          No price available for {data.unpricedSymbols.join(', ')} — excluded from the totals below
          (usually renamed or delisted tickers).
        </p>
      )}

      {t && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginTop: 12 }}>
          {[
            ['Net impact', money(t.totalImpact), pct(t.impactPct), t.totalImpact,
              'Buy impact plus sell impact, over the capital rotated in this period'],
            ['Buy decisions', money(t.buyImpact), `₹${fmt(t.buyValue, 0)} deployed`, t.buyImpact,
              'How the stocks bought in this period have moved since'],
            ['Sell decisions', money(t.sellImpact), `₹${fmt(t.sellValue, 0)} raised`, t.sellImpact,
              'Positive means what you sold fell afterwards — the exit was well timed'],
            ['Dividends', money(t.dividendImpact), 'collected on buys, forgone on sells', t.dividendImpact,
              'Total-return adjustment. A price falls by roughly the dividend on its ex-date, so without this a seller gets credit for a fall that was really a payout, and a holder is penalised for a drop whose cash they received.'],
            ['Good / bad calls', `${t.goodCalls} / ${t.badCalls}`, `${t.scored} of ${t.symbols} stocks scored`, null,
              'Stocks where the net impact was positive vs negative'],
          ].map(([label, value, sub, tone, tip]) => (
            <div key={label} title={tip} style={{ padding: '9px 11px', background: '#f8fafc', border: '1px solid #e4e6ea', borderRadius: 8, cursor: 'help' }}>
              <div style={{ fontSize: 11.5, color: '#565a6b', fontWeight: 700, textTransform: 'uppercase' }}>{label}</div>
              <div style={{ fontSize: 17, fontWeight: 800, marginTop: 2,
                color: tone == null ? '#0f172a' : tone >= 0 ? '#05664a' : '#b32d19' }}>{value}</div>
              <div style={{ fontSize: 11.5, color: '#656974' }}>{sub}</div>
            </div>
          ))}
        </div>
      )}

      {data?.rows?.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: '#565a6b', borderBottom: '2px solid #e4e6ea' }}>
                <th scope="col" style={{ textAlign: 'left', padding: '7px 11px' }}>Stock</th>
                <th scope="col" style={{ textAlign: 'left', padding: '7px 11px' }} title="Bought and sold in this period = a completed rotation">Action</th>
                <th scope="col" style={{ textAlign: 'right', padding: '7px 11px' }}>Bought</th>
                <th scope="col" style={{ textAlign: 'right', padding: '7px 11px' }}>Sold</th>
                <th scope="col" style={{ textAlign: 'right', padding: '7px 11px' }}>Now</th>
                <th scope="col" style={{ textAlign: 'right', padding: '7px 11px' }} title="Move since the buy — up is good">Buy →</th>
                <th scope="col" style={{ textAlign: 'right', padding: '7px 11px' }} title="Move since the sell, inverted — a fall after selling is good">Sell →</th>
                <th scope="col" style={{ textAlign: 'right', padding: '7px 11px' }}>Impact ₹</th>
                <th scope="col" style={{ textAlign: 'right', padding: '7px 11px' }}>on capital</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.symbol} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '6px 10px', fontWeight: 700, color: '#1355a8' }}>
                    {r.symbol}
                    {r.corpActionAdjusted && <span title="Historic prices restated for a split/bonus" style={{ marginLeft: 5, fontSize: 11, color: '#1355a8' }}>adj</span>}
                  </td>
                  <td style={{ padding: '6px 10px' }}>
                    <span style={{ fontSize: 11.5, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                      background: r.activity === 'ROTATED' ? '#ede9fe' : r.activity === 'BOUGHT' ? '#dcfce7' : '#fdecea',
                      color: r.activity === 'ROTATED' ? '#6d28d9' : r.activity === 'BOUGHT' ? '#05664a' : '#b32d19' }}>
                      {r.activity}
                    </span>
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: r.buyQty ? '#0f172a' : '#656974' }}
                    title={r.buyAvg ? `${fmt(r.buyQty, 0)} sh @ avg ₹${fmt(r.buyAvg, 2)}` : ''}>
                    {r.buyQty ? money(r.buyValue) : '—'}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: r.sellQty ? '#0f172a' : '#656974' }}
                    title={r.sellAvg ? `${fmt(r.sellQty, 0)} sh @ avg ₹${fmt(r.sellAvg, 2)}` : ''}>
                    {r.sellQty ? money(r.sellValue) : '—'}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: '#565a6b' }}
                    title={r.cmpAsOf ? `as of ${r.cmpAsOf} (${r.priceSource})` : 'no price available'}>
                    {r.cmp != null ? `₹${fmt(r.cmp, 2)}` : <span style={{ color: '#656974' }}>n/a</span>}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 600,
                    color: r.buyReturnPct == null ? '#656974' : r.buyReturnPct >= 0 ? '#05664a' : '#b32d19' }}>
                    {r.buyReturnPct == null ? '—' : pct(r.buyReturnPct)}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 600,
                    color: r.sellReturnPct == null ? '#656974' : r.sellReturnPct >= 0 ? '#05664a' : '#b32d19' }}>
                    {r.sellReturnPct == null ? '—' : pct(r.sellReturnPct)}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 800,
                    color: r.totalImpact == null ? '#656974' : r.totalImpact >= 0 ? '#05664a' : '#b32d19' }}>
                    {money(r.totalImpact)}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: '#565a6b' }}>{pct(r.impactPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && !data.rows.length && !busy && (
        <p style={{ fontSize: 13.5, color: '#565a6b', marginTop: 12 }}>No equity orders in this period.</p>
      )}
    </div>
  );
}

function PerformancePage() {
  const [periodType, setPeriodType]   = useState('monthly');
  const [portfolio, setPortfolio]     = useState('both');
  const [data, setData]               = useState(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchPerformance({ period: periodType, portfolio })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [periodType, portfolio]);

  // Compute bar heights relative to the max absolute change %
  const periods = data?.periods || [];
  const maxAbsPct = useMemo(() => {
    let max = 0;
    for (const p of periods) {
      const portPct = p.likeForLike?.changePct ?? p.portfolio?.changePct;
      if (portPct != null) max = Math.max(max, Math.abs(portPct));
      if (p.nifty)         max = Math.max(max, Math.abs(p.nifty.changePct));
    }
    return max || 1;
  }, [periods]);

  function barHeight(pct) {
    return Math.max(2, Math.round((Math.abs(pct) / maxAbsPct) * 140));
  }

  const stats = data?.stats;

  return (
    <PageShell title="Performance" subtitle="Portfolio change vs Nifty 50 over time · Upload more portfolio CSVs on the Portfolio page to extend history">
      <div className="perf-controls">
        <div className="perf-toggle-group">
          {PERF_PERIODS.map(p => (
            <button
              key={p}
              className={periodType === p ? 'active' : ''}
              onClick={() => setPeriodType(p)}
            >
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
        <select
          className="perf-portfolio-select"
          value={portfolio}
          onChange={e => setPortfolio(e.target.value)}
        >
          {PERF_PORTFOLIOS.map(p => (
            <option key={p} value={p}>{p === 'both' ? 'Both Portfolios' : p}</option>
          ))}
        </select>
      </div>

      <InvestmentTrendSection portfolio={portfolio} />

      {loading && <p className="perf-no-data">Loading…</p>}
      {error   && <p className="perf-no-data" style={{ color: '#e05252' }}>Error: {error}</p>}

      {!loading && !error && stats && (
        <div className="perf-stats-row">
          <StatCard label="Periods with data" value={stats.totalPeriods} />
          <StatCard label="Up periods"   value={stats.upCount}   tone="positive" />
          <StatCard label="Down periods" value={stats.downCount} tone={stats.downCount > 0 ? 'negative' : ''} />
          <StatCard
            label="Best period"
            value={stats.bestLabel}
            helper={stats.bestChangePct != null ? fmtPct(stats.bestChangePct) : '-'}
            tone="positive"
          />
          <StatCard
            label="Worst period"
            value={stats.worstLabel}
            helper={stats.worstChangePct != null ? fmtPct(stats.worstChangePct) : '-'}
            tone={stats.worstChangePct != null && stats.worstChangePct < 0 ? 'negative' : ''}
          />
        </div>
      )}

      {!loading && !error && periods.length === 0 && (
        <p className="perf-no-data">No data available for the selected range.</p>
      )}

      {!loading && !error && periods.length > 0 && (
        <>
          <div className="perf-scroll-outer">
            <div className="perf-bars-track">
              {[...periods].reverse().map(p => {
                // Like-for-like takes priority; fall back to total portfolio
                const lfl      = p.likeForLike;
                const portPct  = lfl?.changePct ?? p.portfolio?.changePct ?? null;
                const niftyPct = p.nifty?.changePct ?? null;
                const portUp   = portPct != null && portPct >= 0;
                const niftyUp  = niftyPct != null && niftyPct >= 0;
                const alpha    = portPct != null && niftyPct != null ? portPct - niftyPct : null;
                const beat     = alpha != null && alpha >= 0;
                const isLfl    = lfl != null;
                const newCount = lfl?.newAdditions?.count ?? 0;

                return (
                  <div key={p.label} className="perf-period-col">
                    <div className="perf-col-labels">
                      <div className={`perf-port-pct ${portPct == null ? 'nil' : portUp ? 'up' : 'down'}`}>
                        {portPct != null ? fmtPct(portPct) : '–'}
                      </div>
                      {niftyPct != null && (
                        <div className="perf-nifty-label">N {fmtPct(niftyPct)}</div>
                      )}
                      {alpha != null && (
                        <div className={`perf-alpha-badge ${beat ? 'beat' : 'lagged'}`}>
                          {beat ? '▲' : '▼'} {Math.abs(alpha).toFixed(1)}%
                        </div>
                      )}
                    </div>
                    <div className="perf-bar-pair">
                      <div
                        className={`perf-bar ${portPct == null ? 'portfolio-null' : portUp ? 'portfolio-up' : 'portfolio-down'}`}
                        style={{ height: portPct != null ? barHeight(portPct) : 4 }}
                        title={`${isLfl ? 'Like-for-like' : 'Portfolio'}: ${portPct != null ? fmtPct(portPct) : 'no data'}`}
                      />
                      <div
                        className={`perf-bar ${niftyPct == null ? 'nifty-null' : niftyUp ? 'nifty-up' : 'nifty-down'}`}
                        style={{ height: niftyPct != null ? barHeight(niftyPct) : 4 }}
                        title={`Nifty: ${niftyPct != null ? fmtPct(niftyPct) : 'no data'}`}
                      />
                    </div>
                    <div className="perf-period-label">{p.label}</div>
                    {newCount > 0 && (
                      <div className="perf-new-badge">+{newCount} new</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="perf-legend">
            <span><span className="perf-legend-dot" style={{ background: '#2d9e5f' }} />Portfolio ↑</span>
            <span><span className="perf-legend-dot" style={{ background: '#e05252' }} />Portfolio ↓</span>
            <span><span className="perf-legend-dot" style={{ background: '#a0d4b8' }} />Nifty ↑</span>
            <span><span className="perf-legend-dot" style={{ background: '#f0a0a0' }} />Nifty ↓</span>
            <span><span className="perf-legend-dot" style={{ background: '#d4f0e0', border: '1px solid #2d9e5f' }} />Beat Nifty</span>
            <span><span className="perf-legend-dot" style={{ background: '#fde8e8', border: '1px solid #e05252' }} />Lagged Nifty</span>
            <span><span className="perf-legend-dot" style={{ background: '#e8f1fc', border: '1px solid #3b82f6' }} />New stocks added</span>
          </div>
        </>
      )}
      <TradeImpactPanel />
    </PageShell>
  );
}

// ─────────────────────────────────────────
// PORTFOLIO HEALTH PAGE
// ─────────────────────────────────────────

function RatingBadge({ rating }) {
  const colours = {
    'STRONG HOLD': { bg: '#e6f7f1', color: '#05664a', border: '#6ee7b7' },
    'HOLD':        { bg: '#e8f1fc', color: '#1355a8', border: '#93c5fd' },
    'WATCH':       { bg: '#fef6e7', color: '#9a5b06', border: '#fde047' },
    'WEAK':        { bg: '#fdecea', color: '#b32d19', border: '#b32d19' },
    'REVIEW':      { bg: '#f2f4f7', color: '#565a6b', border: '#d8b4fe' },
    'SKIP':        { bg: '#f1f5f9', color: '#565a6b', border: '#656974' },
    'ERROR':       { bg: '#fff1f2', color: '#be123c', border: '#fda4af' },
  };
  const s = colours[rating] || colours['SKIP'];
  return (
    <span style={{
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
      borderRadius: 4, padding: '2px 7px', fontSize: 12.5, fontWeight: 600,
      whiteSpace: 'nowrap',
    }}>
      {rating}
    </span>
  );
}

function ScoreBar({ value, max = 100 }) {
  if (value == null) return <span style={{ color: '#aaa' }}>—</span>;
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const colour = value >= 70 ? '#05664a' : value >= 50 ? '#9a5b06' : '#b32d19';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{
        flex: 1, height: 6, background: '#e4e6ea', borderRadius: 3, minWidth: 48,
      }}>
        <div style={{ width: `${pct}%`, height: '100%', background: colour, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 13, fontWeight: 600, color: colour, minWidth: 28 }}>
        {value.toFixed(0)}
      </span>
    </div>
  );
}

function ReturnCell({ value }) {
  if (value == null) return <span style={{ color: '#aaa' }}>—</span>;
  const up = value >= 0;
  return (
    <span style={{ color: up ? 'var(--pos, #16a34a)' : 'var(--neg, #dc2626)', fontWeight: 600, fontSize: 13 }}>
      {up ? '+' : ''}{value.toFixed(1)}%
    </span>
  );
}

// ── Suggested action: ladder × 50EMA slope × health score ────────────────────
// Encodes the reading guide: the ladder says WHERE the stock is in its trend
// cycle, the slope says which way the trend is turning, the score confirms.
function suggestHealthAction(r) {
  const ladder = r.ema_ladder;
  const slope  = r.ema50_slope;
  const score  = r.combined_score ?? 0;
  if (!ladder) return null;
  const up   = slope != null && slope > 0.3;
  const down = slope != null && slope < -0.3;

  switch (ladder) {
    case 'STRONG_UPTREND':
      return { action: 'HOLD', rank: 3, why: 'Strong uptrend — nothing to do; add only on dips.' };
    case 'PULLBACK':
      if (up && score >= 60) return { action: 'ADD',   rank: 4, why: 'Dip in a rising trend with a healthy score — buy-the-dip zone.' };
      if (score >= 55)       return { action: 'HOLD',  rank: 3, why: 'Routine pullback within an intact uptrend.' };
      return                        { action: 'WATCH', rank: 2, why: 'Pullback, but the score is weak — wait for confirmation.' };
    case 'DISTRIBUTION':
      if (down && score < 50) return { action: 'TRIM',  rank: 1, why: 'Uptrend cracking with a falling 50EMA and weak score — sell weakness early.' };
      return                         { action: 'WATCH', rank: 2, why: 'Below 50EMA but not yet confirmed down — decision point, re-check next scan.' };
    case 'DOWNTREND':
      if (down && score < 40) return { action: 'EXIT',  rank: 0, why: 'Confirmed downtrend, falling 50EMA, weak score — why still holding?' };
      if (down)               return { action: 'TRIM',  rank: 1, why: 'Confirmed downtrend with falling 50EMA — reduce exposure.' };
      return                         { action: 'WATCH', rank: 2, why: 'Downtrend but the 50EMA is flattening — possibly basing.' };
    default: // MIXED
      return score < 40 ? { action: 'WATCH', rank: 2, why: 'No clear trend and a weak score.' }
                        : { action: 'HOLD',  rank: 3, why: 'No clear trend — fall back to score and fundamentals.' };
  }
}

const HEALTH_ACTION_STYLE = {
  ADD:   { bg: '#dcfce7', fg: '#166534' },
  HOLD:  { bg: '#f1f5f9', fg: '#565a6b' },
  WATCH: { bg: '#fef6e7', fg: '#9a5b06' },
  TRIM:  { bg: '#ffedd5', fg: '#9a3412' },
  EXIT:  { bg: '#fdecea', fg: '#b32d19' },
};

function HealthActionBadge({ row }) {
  const s = suggestHealthAction(row);
  if (!s) return <span style={{ color: '#656974' }}>—</span>;
  const st = HEALTH_ACTION_STYLE[s.action];
  return (
    <span title={s.why}
      style={{ background: st.bg, color: st.fg, borderRadius: 6, padding: '2px 9px',
               fontSize: '0.78rem', fontWeight: 700, whiteSpace: 'nowrap' }}>
      {s.action}
    </span>
  );
}


// Holding performance for one position, shown under its Portfolio Health row. Built to answer
// "sell or add?", which is a question about TIME-NORMALISED return: +20% is excellent over two
// months and poor over three years, and the raw P&L column can't distinguish those.
//
// Ret/mo is simple (uncompounded) and only shown past ~2 weeks; CAGR only past 90 days. Below
// those thresholds the arithmetic explodes on noise - a 5% week annualises to four figures -
// so the fields are withheld rather than printed as impressive nonsense.
function HoldingPerfLine({ h, cmp }) {
  const M = ({ label, value, sub, tone, title }) => (
    <div style={{ minWidth: 88 }} title={title}>
      <div style={{ fontSize: 11, color: '#656974', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: tone || '#1b1d28' }}>{value}</div>
      {sub ? <div style={{ fontSize: 11.5, color: '#656974' }}>{sub}</div> : null}
    </div>
  );
  const money = (v) => v == null ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  const pct   = (v, d = 1) => v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`;
  const tone  = (v) => v == null ? '#1b1d28' : v >= 0 ? '#05664a' : '#dc2626';
  const snapshotOnly = h.source === 'snapshot-only';

  return (
    <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start',
                  borderLeft: '3px solid #656974', paddingLeft: 12 }}>
      <M label="Invested" value={money(h.invested)} sub={h.quantity != null ? `${h.quantity} sh` : null}
         title="Capital currently committed to this position" />
      <M label="Value" value={money(h.currentValue)} title="Current market value" />
      <M label="P&L" value={money(h.pnl)} tone={tone(h.pnl)} sub={pct(h.returnPct)}
         title="Unrealised profit or loss, and total return on cost" />
      <M label="Held" value={h.heldMonths != null ? `${h.heldMonths} mo` : '—'}
         sub={h.heldDays != null ? `${h.heldDays} d` : (snapshotOnly ? 'no buy date' : null)}
         title={snapshotOnly
           ? 'This holding has no order history in the app, so its purchase date is unknown — the time-based figures below cannot be computed.'
           : 'Time since the first buy that is still open (FIFO)'} />
      <M label="Ret/mo" value={pct(h.retPerMonth, 2)} tone={tone(h.retPerMonth)}
         title="Total return divided by months held — the like-for-like number to compare positions on. Withheld under ~2 weeks, where it is meaningless." />
      <M label="CAGR" value={h.cagr != null ? pct(h.cagr) : '—'} tone={tone(h.cagr)}
         title="Annualised compound return. Shown only past 90 days held; below that it exaggerates wildly." />
      <M label="Avg Cost" value={h.avgCost != null ? `₹${Number(h.avgCost).toFixed(2)}` : '—'}
         sub={cmp != null ? `now ₹${Number(cmp).toFixed(2)}` : null}
         title="Your average buy price versus the current price — where a top-up would average in from" />
      <M label="Weight" value={h.weightPct != null ? `${h.weightPct}%` : '—'}
         title="Share of your total invested capital. High weight argues against adding more, whatever the return." />
      {h.lastBuy && (
        <M label="Last Buy" value={h.lastBuy}
           sub={h.lastBuyPrice != null ? `@ ₹${Number(h.lastBuyPrice).toFixed(2)}` : null}
           title={`Most recent buy${h.buyCount ? ` of ${h.buyCount}` : ''}`} />
      )}
      {h.sinceLastBuyPct != null && (
        <M label="vs Last Buy" value={pct(h.sinceLastBuyPct)} tone={tone(h.sinceLastBuyPct)}
           title="Price move since your most recent buy — has your latest entry worked?" />
      )}
      {snapshotOnly && (
        <div style={{ fontSize: 11.5, color: '#9a5b06', maxWidth: 260, alignSelf: 'center' }}>
          From the broker snapshot only — no order history for this holding, so period, Ret/mo and CAGR are unavailable.
        </div>
      )}
    </div>
  );
}


// ─────────────────────────────────────────
// PORTFOLIO EVOLUTION
// ─────────────────────────────────────────

// Rupees at a glance. Crores and lakhs are read far faster here than a nine-digit number, and
// this panel is meant to be taken in at one pass.
function inrShort(value) {
  if (value === null || value === undefined) return '--';
  const n = Number(value);
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)} L`;
  return `${sign}₹${fmt(a)}`;
}

const EVOLUTION_PERIODS = ['1M', '2M', '3M', '6M', '1Y'];

function ContributionRow({ row, max }) {
  const positive = row.contribution >= 0;
  // Bar width is relative to the biggest mover shown, so the shape of the period reads at a
  // glance — one dominant winner looks different from ten even ones.
  const width = max > 0 ? Math.max(2, (Math.abs(row.contribution) / max) * 100) : 0;
  return (
    <div className="evo-contrib-row">
      <span className="evo-contrib-sym">
        {row.symbol}
        {row.exited && <span className="evo-exit-tag" title="Position fully closed in this period">exited</span>}
      </span>
      <span className="evo-contrib-bar-wrap">
        <span className={`evo-contrib-bar ${positive ? 'pos' : 'neg'}`} style={{ width: `${width}%` }} />
      </span>
      <span className={`evo-contrib-val ${positive ? 'pos' : 'neg'}`}>{inrShort(row.contribution)}</span>
    </div>
  );
}

function PortfolioEvolutionPanel() {
  const [period, setPeriod] = useState('3M');
  const [portfolio, setPortfolio] = useState('both');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPortfolioEvolution({ period, portfolio })
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [period, portfolio]);

  const controls = (
    <div className="evo-controls">
      <div className="evo-period-group">
        {EVOLUTION_PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            className={`evo-period-btn ${p === period ? 'active' : ''}`}
            onClick={() => setPeriod(p)}
          >{p}</button>
        ))}
      </div>
      <select value={portfolio} onChange={(e) => setPortfolio(e.target.value)} className="evo-select">
        <option value="both">Rams + Geetha</option>
        <option value="Rams">Rams</option>
        <option value="Geetha">Geetha</option>
      </select>
    </div>
  );

  if (loading) {
    return <section className="evo-panel"><h2>Portfolio Evolution</h2>{controls}<p className="evo-muted">Loading…</p></section>;
  }
  if (error) {
    return <section className="evo-panel"><h2>Portfolio Evolution</h2>{controls}<p className="evo-error">{error}</p></section>;
  }

  // A period the stored history cannot honestly support. Shown as an explanation rather than a
  // number, because a plausible-looking wrong return is worse than no return at all.
  if (!data?.ok) {
    return (
      <section className="evo-panel">
        <h2>Portfolio Evolution</h2>
        {controls}
        <div className="evo-unavailable">
          <strong>Not available for this period.</strong>
          <p>{data?.unavailable || 'No data for this window.'}</p>
          {data?.whyNotFixable && (
            <p className="evo-una-sub"><strong>Why it can&apos;t just be repaired:</strong>{' '}
              {data.whyNotFixable}</p>
          )}
          {/* Says when it resolves on its own. Without this the panel reads as a defect to chase,
              when the honest answer is that the window simply has to move past the bad stretch. */}
          {data?.healsNote && <p className="evo-una-sub">{data.healsNote}</p>}
          {data?.worksNow?.length > 0 && (
            <div className="evo-una-alt">
              <span>Available now:</span>
              {data.worksNow.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="evo-period-btn"
                  onClick={() => setPeriod(p)}
                >{p}</button>
              ))}
            </div>
          )}
        </div>
      </section>
    );
  }

  const { dietz, index, value, flows } = data;
  const beat = data.vsIndexRs != null && data.vsIndexRs >= 0;
  const movers = [...(data.best || []), ...(data.worst || [])];
  const maxMove = movers.reduce((m, c) => Math.max(m, Math.abs(c.contribution)), 0);
  const activeNotes = Object.values(data.notes || {}).filter(Boolean);

  return (
    <section className="evo-panel">
      <h2>Portfolio Evolution</h2>
      {controls}

      <p className="evo-window">
        {data.from} → {data.to} · {dietz.days} days · equity only
      </p>

      {/* Headline. The return is money-weighted, so deposits and withdrawals do not flatter it. */}
      <div className="evo-headline">
        <div className="evo-hero">
          <span className="evo-hero-label">Your return</span>
          <span className={`evo-hero-val ${dietz.returnPct >= 0 ? 'pos' : 'neg'}`}>
            {dietz.returnPct == null ? '--' : fmtPct(dietz.returnPct)}
          </span>
          <span className="evo-hero-sub">{inrShort(dietz.gain)} earned</span>
        </div>
        <div className="evo-hero">
          <span className="evo-hero-label">Nifty 50</span>
          <span className={`evo-hero-val ${index && index.indexReturnPct >= 0 ? 'pos' : 'neg'}`}>
            {index ? fmtPct(index.indexReturnPct) : '--'}
          </span>
          <span className="evo-hero-sub">same window</span>
        </div>
        <div className="evo-hero">
          <span className="evo-hero-label">Portfolio value</span>
          <span className="evo-hero-val">{inrShort(value.end)}</span>
          <span className="evo-hero-sub">from {inrShort(value.start)}</span>
        </div>
      </div>

      {/* The counterfactual: the same rupees, moved on the same days, into the index instead.
          This is the only comparison that stays fair when money went in and out mid-period. */}
      {index && (
        <div className={`evo-verdict ${beat ? 'good' : 'bad'}`}>
          <span>
            Your money is worth <strong>{inrShort(value.end)}</strong>. The same amounts, moved on
            the same days into Nifty, would be <strong>{inrShort(index.value)}</strong>.
          </span>
          <span className="evo-verdict-num">
            {beat ? 'Your decisions added ' : 'Your decisions cost '}
            <strong>{inrShort(Math.abs(data.vsIndexRs))}</strong>
          </span>
        </div>
      )}

      {/* Money moved, kept separate from performance so a deposit is never read as a good month. */}
      <div className="evo-money-map">
        <div><span className="evo-mm-label">Bought</span><span>{inrShort(flows.bought)}</span></div>
        <div><span className="evo-mm-label">Sold</span><span>{inrShort(flows.sold)}</span></div>
        <div>
          <span className="evo-mm-label">{flows.net >= 0 ? 'Net added' : 'Net taken out'}</span>
          <span>{inrShort(Math.abs(flows.net))}</span>
        </div>
        <div><span className="evo-mm-label">Fills</span><span>{flows.count}</span></div>
      </div>

      {/* Attribution: value change plus what was sold, minus what was bought — so a stock sold
          at a profit mid-period still shows its gain instead of vanishing from the list. */}
      {movers.length > 0 && (
        <div className="evo-movers">
          <div className="evo-movers-col">
            <h3>Best moves</h3>
            {(data.best || []).map((r) => <ContributionRow key={r.symbol} row={r} max={maxMove} />)}
          </div>
          <div className="evo-movers-col">
            <h3>Worst moves</h3>
            {(data.worst || []).length === 0
              ? <p className="evo-muted">Nothing lost money this period.</p>
              : data.worst.map((r) => <ContributionRow key={r.symbol} row={r} max={maxMove} />)}
          </div>
        </div>
      )}

      {activeNotes.length > 0 && (
        <details className="evo-notes">
          <summary>Data notes ({activeNotes.length})</summary>
          <ul>{activeNotes.map((n) => <li key={n}>{n}</li>)}</ul>
          {(data.inferredAliases || []).length > 0 && (
            <p className="evo-muted">
              Merged on matching value (broker code missing from the symbol map):{' '}
              {data.inferredAliases.map((a) => `${a.trades} → ${a.holding}`).join(', ')}
            </p>
          )}
        </details>
      )}
    </section>
  );
}


// ─────────────────────────────────────────
// DAILY SYNC
// ─────────────────────────────────────────

// The page exists because a capture that fails quietly is worse than no capture at all: 706
// GMRAIRPORT shares went missing for months because an import did not run and nothing said so.
// Neither broker login can be automated, so the two things that must be visible together are
// whether the sessions are alive and which trading days are still uncaptured.

function ConnectionCard({ conn, onConnected }) {
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState(null);
  const [opened, setOpened] = useState(false);

  const isBreeze = conn.broker === 'breeze';

  const openLogin = async () => {
    setError(null);
    try {
      const r = isBreeze ? await fetchBreezeLoginUrl() : await fetchKiteLoginUrl();
      if (r?.loginUrl) {
        window.open(r.loginUrl, '_blank', 'noopener');
        setOpened(true);
      } else {
        setError('No login URL returned — check the API key in .env');
      }
    } catch (e) { setError(e.message); }
  };

  const submit = async () => {
    if (!token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (isBreeze) await breezeGenerateSession(token.trim());
      else await kiteExchangeToken(token.trim());
      setToken('');
      setOpened(false);
      await onConnected();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  // Disconnecting belongs beside connecting. It used to live on the Portfolio page, which meant
  // the two halves of one decision sat on different screens.
  //
  // Confirmed first, because there is no undo that does not involve logging in at the broker
  // again — and on a day when the session is already alive, an accidental click costs a trip
  // through ICICI's or Zerodha's login rather than a click back.
  const disconnect = async () => {
    if (!window.confirm(
      `Disconnect ${conn.label}? Reconnecting means logging in at the broker again.`)) return;
    setBusy(true);
    setError(null);
    try {
      if (isBreeze) await revokeBreezeSession();
      else await revokeKiteSession();
      await onConnected();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  // Expiry is shown as a time, not a countdown: both brokers die on a fixed clock (Breeze at
  // 23:59 today, Kite at 06:00 tomorrow) rather than after a duration, so the wall-clock time
  // is what tells you whether tonight's retries can still succeed.
  const expiry = conn.expiresAt
    ? new Date(conn.expiresAt).toLocaleString('en-IN',
      { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className={`ds-conn ${conn.connected ? 'ok' : 'bad'}`}>
      <div className="ds-conn-head">
        <span className="ds-conn-dot" />
        <div>
          <div className="ds-conn-name">{conn.label}</div>
          <div className="ds-conn-sub">{conn.portfolio}</div>
        </div>
        <span className={`ds-badge ${conn.connected ? 'ok' : 'bad'}`}>
          {conn.connected ? 'Connected' : 'Not connected'}
        </span>
      </div>

      {conn.connected ? (
        <div className="ds-conn-live">
          <p className="ds-conn-note">Session valid until {expiry}</p>
          <button type="button" className="ds-btn" onClick={disconnect} disabled={busy}>
            {busy ? 'Working…' : 'Disconnect'}
          </button>
        </div>
      ) : (
        <>
          <p className="ds-conn-note">{conn.reason}</p>
          {/* A missing API key is a .env problem — no amount of logging in will fix it, so the
              login flow is not offered for it. */}
          {conn.hasApiKey && (
            <div className="ds-connect">
              {/* A REAL LINK. This used to fetch the login URL and then call window.open, but a
                  popup opened after an await is blocked — the browser's user-activation window
                  has closed by then — so the button silently did nothing and the broker was
                  never reached. The URL now arrives with the page data. */}
              <a
                className="ds-btn"
                href={conn.loginUrl || '#'}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  if (!conn.loginUrl) { e.preventDefault(); setError('No login URL — save your API key on the Brokers page first.'); }
                  else setOpened(true);
                }}
              >
                {opened ? '↗ Reopen login' : '↗ Open broker login'}
              </a>
              <input
                className="ds-input"
                placeholder={isBreeze ? 'Paste API session token' : 'Paste request_token'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              />
              <button
                type="button"
                className="ds-btn primary"
                onClick={submit}
                disabled={busy || !token.trim()}
              >{busy ? 'Connecting…' : 'Connect'}</button>
            </div>
          )}
          {opened && (
            <p className="ds-hint">
              {isBreeze
                ? 'After logging in, copy the API_Session value from the redirected URL.'
                : 'After logging in, copy the request_token value from the redirected URL.'}
            </p>
          )}
        </>
      )}
      {error && <p className="ds-error">{error}</p>}
    </div>
  );
}


// One cell of the coverage grid. The label carries the meaning; colour only reinforces it, so
// the table still reads correctly in a screenshot, in print, or to anyone who cannot separate
// red from green.
function CoverageCell({ cell }) {
  const { orders, holdings } = cell;
  const chip = {
    PRESENT: { cls: 'ok', text: orders.count ? `${orders.count}` : 'yes' },
    QUIET: { cls: 'quiet', text: 'no trades' },
    GAP: { cls: 'gap', text: 'MISSING' },
    UNVERIFIED: { cls: 'unknown', text: '?' },
  }[orders.status];

  return (
    <>
      <td className="ds-cell">
        <span className={`ds-chip ${chip.cls}`} title={orders.detail || ''}>{chip.text}</span>
        {orders.status === 'GAP' && orders.evidence?.length > 0 && (
          <div className="ds-evidence">
            {orders.evidence.map((e) => (
              <span key={e.symbol}>
                {e.symbol} {e.delta > 0 ? '+' : ''}{e.delta}
              </span>
            ))}
          </div>
        )}
      </td>
      <td className="ds-cell">
        <span className={`ds-chip ${holdings.status === 'PRESENT' ? 'ok' : 'absent'}`}>
          {holdings.status === 'PRESENT' ? holdings.count : 'none'}
        </span>
      </td>
    </>
  );
}

function CoverageReport({ coverage }) {
  const [showAll, setShowAll] = useState(false);
  if (!coverage) return null;

  const { rows, summary, actions, portfolios } = coverage;
  // Days needing attention float to the top by default. A 45-row table where 43 rows are fine
  // buries the two that are not.
  const problem = rows.filter((r) => portfolios.some((p) =>
    r.portfolios[p].orders.status === 'GAP' || r.portfolios[p].orders.status === 'UNVERIFIED'));
  const shown = showAll ? rows : (problem.length ? problem : rows.slice(0, 10));

  return (
    <>
      <div className="ds-tiles">
        <div className="ds-tile">
          <span className="ds-tile-n">{summary.ordersPresent}</span>
          <span className="ds-tile-l">days with orders</span>
        </div>
        <div className="ds-tile">
          <span className="ds-tile-n">{summary.ordersQuiet}</span>
          <span className="ds-tile-l">quiet days<em>verified no trades</em></span>
        </div>
        <div className={`ds-tile ${summary.ordersGap ? 'bad' : 'good'}`}>
          <span className="ds-tile-n">{summary.ordersGap}</span>
          <span className="ds-tile-l">missing orders<em>needs action</em></span>
        </div>
        <div className={`ds-tile ${summary.holdingsAbsent ? 'warn' : 'good'}`}>
          <span className="ds-tile-n">{summary.holdingsAbsent}</span>
          <span className="ds-tile-l">missing snapshots<em>not recoverable</em></span>
        </div>
      </div>

      {/* The legend is not decoration. "No orders" is ambiguous on its own, and without knowing
          that a quiet day was actively verified, every blank cell looks like a possible loss. */}
      <div className="ds-legend">
        <span><span className="ds-chip ok">12</span> orders captured</span>
        <span><span className="ds-chip quiet">no trades</span> holdings unchanged, so nothing to capture</span>
        <span><span className="ds-chip gap">MISSING</span> holdings moved but no orders — a real gap</span>
        <span><span className="ds-chip unknown">?</span> could not verify either way</span>
        <span><span className="ds-chip absent">none</span> no holdings snapshot that day</span>
      </div>

      {actions.length > 0 && (
        <div className="ds-actions-list">
          {actions.map((a) => (
            <div key={a.kind + a.title} className={`ds-action ${a.severity}`}>
              <div className="ds-action-title">{a.title}</div>
              <div className="ds-action-why">{a.why}</div>
              <div className="ds-action-how"><strong>Fix:</strong> {a.how}</div>
              {a.dates?.length > 0 && (
                <details className="ds-action-dates">
                  <summary>{a.dates.length} affected</summary>
                  <div>{a.dates.join(', ')}</div>
                </details>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="ds-table-head">
        <h3 className="ds-h3">
          Daily coverage
          <span className="ds-sub">
            {coverage.tradingDays} trading days · {coverage.from} → {coverage.to} · weekends and
            market holidays excluded
          </span>
        </h3>
        <button type="button" className="ds-btn" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show only issues' : `Show all ${rows.length} days`}
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="ds-ok-note">Every trading day is accounted for.</p>
      ) : (
        <div className="ds-table-wrap">
          <table className="ds-grid">
            <thead>
              <tr>
                <th scope="col" rowSpan={2} className="ds-date-col">Date</th>
                {portfolios.map((p) => <th scope="col" key={p} colSpan={2} className="ds-pf-head">{p}</th>)}
              </tr>
              <tr>
                {portfolios.map((p) => (
                  <React.Fragment key={p}>
                    <th scope="col" className="ds-sub-head">Orders</th>
                    <th scope="col" className="ds-sub-head">Holdings</th>
                  </React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const bad = portfolios.some((p) => r.portfolios[p].orders.status === 'GAP');
                return (
                  <tr key={r.date} className={bad ? 'ds-row-bad' : ''}>
                    <td className="ds-date-col">{r.date}</td>
                    {portfolios.map((p) => (
                      <CoverageCell key={p} cell={r.portfolios[p]} />
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!showAll && problem.length > 0 && (
        <p className="ds-muted ds-showing-note">
          Showing {problem.length} day(s) needing attention. The other{' '}
          {rows.length - problem.length} are fully captured.
        </p>
      )}
    </>
  );
}

function DailySyncPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState(null);
  const [coverage, setCoverage] = useState(null);

  const load = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([fetchDailySyncStatus(), fetchCaptureCoverage()]);
      setData(d);
      setCoverage(c);
      setError(null);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRun = async () => {
    setRunning(true);
    setRunResult(null);
    try {
      const r = await runDailySync();
      setRunResult(r);
      await load();
    } catch (e) { setError(e.message); }
    setRunning(false);
  };

  if (loading) {
    return <PageShell title="Daily Sync"><p className="ds-muted">Loading…</p></PageShell>;
  }

  const conns = data?.connections || [];
  const allConnected = conns.every((c) => c.connected);
  const gaps = data?.gaps || [];
  const needTradebook = data?.gapsNeedingTradebook || [];

  return (
    <PageShell title="Daily Sync">
      <p className="ds-intro">
        Captures orders and holdings for both portfolios after the close. Runs automatically
        every hour from 4:00 PM to 9:00 PM on weekdays — but only while a broker session is
        alive, and neither broker allows an automated login. Anything it could not capture is
        listed below rather than passed over.
      </p>

      <div className="ds-conns">
        {conns.map((c) => <ConnectionCard key={c.broker} conn={c} onConnected={load} />)}
      </div>

      <div className="ds-actions">
        <button
          type="button"
          className="ds-btn primary lg"
          onClick={handleRun}
          disabled={running}
        >{running ? '⏳ Syncing…' : '⟳ Sync now'}</button>
        {!allConnected && (
          <span className="ds-warn">
            Connect both brokers first — a run without a session records a failure, not data.
          </span>
        )}
      </div>

      {runResult && (
        <div className={`ds-result ${runResult.ok ? 'ok' : 'bad'}`}>
          <strong>
            {runResult.ok
              ? `Captured ${runResult.tradeDate}`
              : `${runResult.failed} step(s) failed for ${runResult.tradeDate}`}
          </strong>
          <table className="ds-table">
            <thead>
              <tr><th scope="col">Portfolio</th><th scope="col">What</th><th scope="col">Result</th><th scope="col">Detail</th></tr>
            </thead>
            <tbody>
              {runResult.results.map((r, i) => (
                <tr key={`${r.portfolio}-${r.kind}-${i}`}>
                  <td>{r.portfolio}</td>
                  <td>{r.kind}</td>
                  {/* The server now phrases the outcome, because "0 new" was ambiguous: it
                      covered "you didn't trade", "we already had them all" and a genuine
                      dropped insert alike. `summary` says which, and falls back to the old
                      wording for any result recorded before this change. */}
                  <td className={r.status === 'OK' ? 'pos' : 'neg'}>
                    {r.status === 'OK' ? `OK · ${r.summary || `${r.rows} new`}` : 'Failed'}
                  </td>
                  <td className="ds-detail">{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CoverageReport coverage={coverage} />

      {error && <p className="ds-error">{error}</p>}
    </PageShell>
  );
}

function PortfolioHealthPage() {
  const [data,      setData]      = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [scanning,  setScanning]  = useState(false);
  const [error,     setError]     = useState(null);
  const [filter,    setFilter]    = useState('ALL');
  const [sortKeys,  setSortKeys]  = useState([{ field: 'combined_score', dir: 'desc' }]);
  const [etfSortKeys, setEtfSortKeys] = useState([{ field: 'combined_score', dir: 'desc' }]);
  // Which holdings have their performance line open. Keyed portfolio::symbol so the same
  // stock held in two portfolios expands independently.
  const [openPerf, setOpenPerf] = useState(() => new Set());
  const togglePerf = (key) => setOpenPerf((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const load = () => {
    setLoading(true);
    setError(null);
    // Load all portfolios combined
    fetchLatestScores('')
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  };

  useEffect(() => { load(); }, []);

  const handleScan = () => {
    setScanning(true);
    setError(null);
    // Scan Rams (from CSV) + all other portfolios (from DB snapshots)
    refreshAllScores()
      .then(() => fetchLatestScores(''))
      .then((d) => { setData(d); setScanning(false); })
      .catch((e) => { setError(e.message); setScanning(false); });
  };

  // Multi-field sort: click = primary sort (toggle asc/desc), Shift+click = add/toggle secondary
  const makeHandleSort = (setter) => (field, shiftKey) => {
    setter((prev) => {
      const existing = prev.find((k) => k.field === field);
      if (shiftKey) {
        if (existing) {
          // toggle direction of this secondary key
          return prev.map((k) => k.field === field ? { ...k, dir: k.dir === 'asc' ? 'desc' : 'asc' } : k);
        }
        return [...prev, { field, dir: 'asc' }];
      }
      // Primary sort: if already sole key, toggle; otherwise make it sole key
      if (existing && prev.length === 1) {
        return [{ field, dir: existing.dir === 'asc' ? 'desc' : 'asc' }];
      }
      return [{ field, dir: existing?.dir === 'asc' ? 'desc' : 'asc' }];
    });
  };

  const handleSort    = makeHandleSort(setSortKeys);
  const handleEtfSort = makeHandleSort(setEtfSortKeys);

  const applySort = (arr, keys) => [...arr].sort((a, b) => {
    for (const { field, dir } of keys) {
      const av = a[field] ?? (typeof a[field] === 'string' ? '' : -Infinity);
      const bv = b[field] ?? (typeof b[field] === 'string' ? '' : -Infinity);
      let cmp = 0;
      if (typeof av === 'string') cmp = av.localeCompare(bv);
      else cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
    }
    return 0;
  });

  // Enrich with the suggested-action rank so the column is sortable
  const rows    = (data?.rows || []).map((r) => ({ ...r, action_rank: suggestHealthAction(r)?.rank ?? null }));
  const stocks  = applySort(
    rows.filter((r) => !r.is_etf && !['SKIP', 'ERROR'].includes(r.rating) && r.combined_score != null),
    sortKeys
  );
  const etfs    = applySort(
    rows.filter((r) => r.is_etf && r.combined_score != null),
    etfSortKeys
  );
  const skipped = rows.filter((r) => ['SKIP', 'ERROR'].includes(r.rating));

  const visibleStocks = filter === 'ALL' ? stocks : stocks.filter((r) => r.rating === filter);

  // Sortable <th scope="col"> helper
  const Th = ({ field, label, align = 'left', keys, onSort, minWidth }) => {
    const key   = keys.find((k) => k.field === field);
    const rank  = keys.length > 1 ? keys.findIndex((k) => k.field === field) + 1 : null;
    const arrow = key ? (key.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return (
      <th scope="col"
        onClick={(e) => onSort(field, e.shiftKey)}
        title={`Sort by ${label}${keys.length > 0 ? '\nShift+click to add as secondary sort' : ''}`}
        style={{
          padding: '11px 14px', textAlign: align, fontWeight: 600, cursor: 'pointer',
          color: key ? 'var(--primary, #1355a8)' : '#1b1d28', whiteSpace: 'nowrap',
          userSelect: 'none', minWidth,
          borderBottom: key ? '2px solid #1355a8' : undefined,
        }}
      >
        {label}{arrow}{rank ? <sup style={{ fontSize: 11, marginLeft: 1 }}>{rank}</sup> : null}
      </th>
    );
  };

  return (
    <PageShell title="Portfolio Health">
      {/* How the books got here, before the holding-by-holding scores below. */}
      <PortfolioEvolutionPanel />

      {/* Header bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          {data?.scoreDate && (
            <span style={{ fontSize: 14, color: data.stale ? '#9a5b06' : '#565a6b' }}>
              Last scored: <strong>{data.scoreDate}</strong>
              {data.scoreAgeDays != null && (
                <> ({data.scoreAgeDays === 0 ? 'today' : `${data.scoreAgeDays}d ago`})</>
              )}
              {' · '}{rows.length} holdings across all portfolios
            </span>
          )}
        </div>
        <button
          onClick={handleScan}
          disabled={scanning}
          style={{
            background: scanning ? '#656974' : 'var(--primary, #1355a8)', color: '#fff',
            border: 'none', borderRadius: 6, padding: '8px 16px',
            cursor: scanning ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 14,
          }}
        >
          {scanning ? '⏳ Scanning all portfolios… (~2 min)' : '🔄 Run Health Scan (All Portfolios)'}
        </button>
      </div>

      {error && (
        <div style={{ background: '#fdecea', color: '#b32d19', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 14 }}>
          {error}
        </div>
      )}

      {/* A failed scan leaves the OLD scores in place and the page still renders fully, so
          age is the only clue that any of this is out of date. This portfolio silently ran on
          two-month-old scores, listing seven already-sold positions, with nothing looking wrong. */}
      {data?.stale && (
        <div style={{ background: '#fef6e7', color: '#9a5b06', border: '1px solid #fcd34d',
                      padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 14 }}>
          ⚠️ These scores are <strong>{data.scoreAgeDays} days old</strong> (last scored {data.scoreDate}).
          Sold positions may still be listed and recent buys missing — and prices, ratings and
          the holding lines below are all from that date. Click <strong>Run Health Scan</strong> to refresh.
        </div>
      )}

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#565a6b' }}>Loading scores…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#565a6b' }}>
          No scores yet. Click <strong>Run Health Scan</strong> to score your portfolio.
        </div>
      ) : (
        <>
          {/* Summary chips */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
            {['STRONG HOLD', 'HOLD', 'WATCH', 'WEAK', 'REVIEW'].map((r) => {
              const count = stocks.filter((s) => s.rating === r).length;
              if (!count) return null;
              return (
                <button
                  key={r}
                  onClick={() => setFilter(filter === r ? 'ALL' : r)}
                  style={{
                    border: 'none', borderRadius: 20, padding: '4px 12px',
                    cursor: 'pointer', fontWeight: 600, fontSize: 13,
                    opacity: filter !== 'ALL' && filter !== r ? 0.4 : 1,
                    background: { 'STRONG HOLD': '#e6f7f1', HOLD: '#e8f1fc', WATCH: '#fef6e7', WEAK: '#fdecea', REVIEW: '#f2f4f7' }[r],
                    color: { 'STRONG HOLD': '#05664a', HOLD: '#1355a8', WATCH: '#9a5b06', WEAK: '#b32d19', REVIEW: '#565a6b' }[r],
                  }}
                >
                  {r} {count}
                </button>
              );
            })}
            {filter !== 'ALL' && (
              <button onClick={() => setFilter('ALL')} style={{ border: '1px solid #d6d9e0', borderRadius: 20, padding: '4px 12px', cursor: 'pointer', fontSize: 13, background: '#fff', color: '#1b1d28' }}>
                ✕ Clear
              </button>
            )}
          </div>

          {/* Sort hint + active sort pills */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: '#656974' }}>
              Click column header to sort · Shift+click to add secondary sort
            </span>
            {sortKeys.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {sortKeys.map(({ field, dir }, i) => (
                  <span key={field} style={{ background: '#eff6ff', color: 'var(--primary, #1355a8)', border: '1px solid #bfdbfe', borderRadius: 12, padding: '4px 10px', fontSize: 12.5, fontWeight: 600 }}>
                    {i + 1}. {field.replace(/_/g, ' ')} {dir === 'asc' ? '↑' : '↓'}
                  </span>
                ))}
                {sortKeys.length > 1 && (
                  <button onClick={() => setSortKeys([{ field: 'combined_score', dir: 'desc' }])} style={{ background: 'none', border: 'none', color: '#656974', cursor: 'pointer', fontSize: 12.5 }}>
                    ✕ Reset
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Stocks table */}
          <div style={{ overflowX: 'auto', marginBottom: 24 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e4e6ea', background: '#f7f8fa' }}>
                  <th scope="col" style={{ padding: '8px 6px', width: 26 }} title="Expand for holding performance" />
                  <th scope="col" style={{ padding: '11px 14px', color: '#656974', fontWeight: 600, width: 32 }}>#</th>
                  <Th field="portfolio"         label="Portfolio"    align="left"   keys={sortKeys} onSort={handleSort} minWidth={70} />
                  <Th field="name"              label="Stock"        align="left"   keys={sortKeys} onSort={handleSort} minWidth={140} />
                  <Th field="cmp"               label="CMP"          align="right"  keys={sortKeys} onSort={handleSort} />
                  <Th field="technical_score"   label="Technical"    align="left"   keys={sortKeys} onSort={handleSort} minWidth={90} />
                  <Th field="fundamental_score" label="Fundamental"  align="left"   keys={sortKeys} onSort={handleSort} minWidth={90} />
                  <Th field="momentum_score"    label="Momentum"     align="left"   keys={sortKeys} onSort={handleSort} minWidth={90} />
                  <Th field="combined_score"    label="Health Score" align="left"   keys={sortKeys} onSort={handleSort} minWidth={100} />
                  <Th field="ema_ladder"        label="EMA Trend"    align="left"   keys={sortKeys} onSort={handleSort} minWidth={110} />
                  <Th field="action_rank"       label="Suggested"    align="left"   keys={sortKeys} onSort={handleSort} minWidth={80} />
                  <Th field="nifty500_rank"     label="N500 Rank"    align="right"  keys={sortKeys} onSort={handleSort} />
                  <Th field="rsi"               label="RSI"          align="right"  keys={sortKeys} onSort={handleSort} />
                  <Th field="r1m"               label="1M"           align="right"  keys={sortKeys} onSort={handleSort} />
                  <Th field="r3m"               label="3M"           align="right"  keys={sortKeys} onSort={handleSort} />
                  <Th field="r6m"               label="6M"           align="right"  keys={sortKeys} onSort={handleSort} />
                  <Th field="rating"            label="Rating"       align="center" keys={sortKeys} onSort={handleSort} />
                </tr>
              </thead>
              <tbody>
                {visibleStocks.map((r, i) => {
                  const perfKey = `${r.portfolio}::${r.symbol}`;
                  const perfOpen = openPerf.has(perfKey);
                  return (
                  <React.Fragment key={perfKey}>
                  <tr style={{ borderBottom: perfOpen ? 'none' : '1px solid #f2f4f7', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                      <button type="button" onClick={() => togglePerf(perfKey)}
                        title={r.holding ? 'Holding performance - invested, period held, return per month' : 'No holding data for this row'}
                        disabled={!r.holding}
                        style={{
                          width: 18, height: 18, lineHeight: '16px', textAlign: 'center', padding: 0,
                          border: '1px solid ' + (r.holding ? '#656974' : '#e4e6ea'), borderRadius: 4,
                          background: perfOpen ? '#1355a8' : '#fff', color: perfOpen ? '#fff' : (r.holding ? '#565a6b' : '#d6d9e0'),
                          cursor: r.holding ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700,
                        }}>
                        {perfOpen ? '−' : '+'}
                      </button>
                    </td>
                    <td style={{ padding: '11px 14px', color: '#656974', fontWeight: 600 }}>{i + 1}</td>
                    <td style={{ padding: '11px 14px', fontSize: 12.5, color: '#565a6b' }}>{r.portfolio || '—'}</td>
                    <td style={{ padding: '11px 14px' }}>
                      <div style={{ fontWeight: 600, color: '#1b1d28' }}>{r.name || r.symbol}</div>
                      <div style={{ fontSize: 12.5, color: '#656974' }}>{r.symbol}</div>
                    </td>
                    <td style={{ padding: '11px 14px', textAlign: 'right', color: '#1b1d28' }}>
                      {r.cmp != null ? `₹${Number(r.cmp).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                    </td>
                    <td style={{ padding: '11px 14px' }}><ScoreBar value={r.technical_score} /></td>
                    <td style={{ padding: '11px 14px' }}><ScoreBar value={r.fundamental_score} /></td>
                    <td style={{ padding: '11px 14px' }}><ScoreBar value={r.momentum_score} /></td>
                    <td style={{ padding: '11px 14px' }}><ScoreBar value={r.combined_score} /></td>
                    <td style={{ padding: '11px 14px' }}><EmaLadderBadge ladder={r.ema_ladder} slope={r.ema50_slope} /></td>
                    <td style={{ padding: '11px 14px' }}><HealthActionBadge row={r} /></td>
                    <td style={{ padding: '11px 14px', textAlign: 'right', fontSize: 13 }}
                      title={r.nifty500_rank != null
                        ? `Rank ${r.nifty500_rank} of ${data?.nifty500Total || 500} in the Nifty 500 health-score ranking (scan ${data?.nifty500ScanDate || ''})`
                        : 'Not a NIFTY 500 constituent — below the index size cutoff or dropped at a rebalance. Not covered by the universe scan; EMA Trend and Suggested still apply.'}>
                      {r.nifty500_rank != null ? (
                        <span style={{ fontWeight: 700,
                          color: r.nifty500_rank <= 50 ? '#05664a' : r.nifty500_rank <= 150 ? '#0369a1' : r.nifty500_rank <= 300 ? '#565a6b' : '#9a5b06' }}>
                          #{r.nifty500_rank}
                        </span>
                      ) : <span style={{ color: '#656974', fontSize: 11.5 }}>not in N500</span>}
                    </td>
                    <td style={{ padding: '11px 14px', textAlign: 'right', fontSize: 13 }}>
                      {r.rsi != null ? (
                        <span style={{ color: r.rsi > 70 ? 'var(--neg, #dc2626)' : r.rsi < 30 ? 'var(--primary, #1355a8)' : '#1b1d28', fontWeight: 600 }}>
                          {Number(r.rsi).toFixed(1)}
                          {r.rsi > 70 ? ' ⚠' : r.rsi < 30 ? ' 🔵' : ''}
                        </span>
                      ) : '—'}
                    </td>
                    <td style={{ padding: '11px 14px', textAlign: 'right' }}><ReturnCell value={r.r1m} /></td>
                    <td style={{ padding: '11px 14px', textAlign: 'right' }}><ReturnCell value={r.r3m} /></td>
                    <td style={{ padding: '11px 14px', textAlign: 'right' }}><ReturnCell value={r.r6m} /></td>
                    <td style={{ padding: '11px 14px', textAlign: 'center' }}><RatingBadge rating={r.rating} /></td>
                  </tr>
                  {perfOpen && r.holding && (
                    <tr style={{ borderBottom: '1px solid #f2f4f7', background: '#f8fafc' }}>
                      <td />
                      <td colSpan={16} style={{ padding: '4px 10px 12px' }}>
                        <HoldingPerfLine h={r.holding} cmp={r.cmp} />
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ETFs */}
          {etfs.length > 0 && (
            <>
              <h3 style={{ fontSize: 15, fontWeight: 600, color: '#1b1d28', margin: '0 0 10px', paddingTop: 4 }}>
                ETFs — Technical + Momentum
              </h3>
              <div style={{ overflowX: 'auto', marginBottom: 24 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e4e6ea', background: '#f7f8fa' }}>
                      <Th field="name"           label="ETF"          align="left"   keys={etfSortKeys} onSort={handleEtfSort} minWidth={140} />
                      <Th field="cmp"            label="CMP"          align="right"  keys={etfSortKeys} onSort={handleEtfSort} />
                      <Th field="technical_score" label="Technical"   align="left"   keys={etfSortKeys} onSort={handleEtfSort} minWidth={90} />
                      <Th field="momentum_score" label="Momentum"     align="left"   keys={etfSortKeys} onSort={handleEtfSort} minWidth={90} />
                      <Th field="combined_score" label="Health Score" align="left"   keys={etfSortKeys} onSort={handleEtfSort} minWidth={100} />
                      <Th field="ema_ladder"     label="EMA Trend"    align="left"   keys={etfSortKeys} onSort={handleEtfSort} minWidth={110} />
                      <Th field="action_rank"    label="Suggested"    align="left"   keys={etfSortKeys} onSort={handleEtfSort} minWidth={80} />
                      <Th field="nifty500_rank"  label="N500 Rank"    align="right"  keys={etfSortKeys} onSort={handleEtfSort} />
                      <Th field="r1m"            label="1M"           align="right"  keys={etfSortKeys} onSort={handleEtfSort} />
                      <Th field="r3m"            label="3M"           align="right"  keys={etfSortKeys} onSort={handleEtfSort} />
                      <Th field="r6m"            label="6M"           align="right"  keys={etfSortKeys} onSort={handleEtfSort} />
                      <Th field="rating"         label="Rating"       align="center" keys={etfSortKeys} onSort={handleEtfSort} />
                    </tr>
                  </thead>
                  <tbody>
                    {etfs.map((r, i) => (
                      <tr key={r.symbol} style={{ borderBottom: '1px solid #f2f4f7', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                        <td style={{ padding: '11px 14px' }}>
                          <div style={{ fontWeight: 600, color: '#1b1d28' }}>{r.name || r.symbol}</div>
                          <div style={{ fontSize: 12.5, color: '#656974' }}>{r.symbol}</div>
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'right', color: '#1b1d28' }}>
                          {r.cmp != null ? `₹${Number(r.cmp).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                        </td>
                        <td style={{ padding: '11px 14px' }}><ScoreBar value={r.technical_score} /></td>
                        <td style={{ padding: '11px 14px' }}><ScoreBar value={r.momentum_score} /></td>
                        <td style={{ padding: '11px 14px' }}><ScoreBar value={r.combined_score} /></td>
                        <td style={{ padding: '11px 14px' }}><EmaLadderBadge ladder={r.ema_ladder} slope={r.ema50_slope} /></td>
                        <td style={{ padding: '11px 14px' }}><HealthActionBadge row={r} /></td>
                        <td style={{ padding: '11px 14px', textAlign: 'right', fontSize: 13 }}
                          title={r.nifty500_rank != null ? `Rank ${r.nifty500_rank} of ${data?.nifty500Total || 500}` : 'ETF — funds are never NIFTY 500 constituents (the index ranks companies only).'}>
                          {r.nifty500_rank != null ? <span style={{ fontWeight: 700, color: '#565a6b' }}>#{r.nifty500_rank}</span> : <span style={{ color: '#656974', fontSize: 11.5 }}>ETF</span>}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'right' }}><ReturnCell value={r.r1m} /></td>
                        <td style={{ padding: '11px 14px', textAlign: 'right' }}><ReturnCell value={r.r3m} /></td>
                        <td style={{ padding: '11px 14px', textAlign: 'right' }}><ReturnCell value={r.r6m} /></td>
                        <td style={{ padding: '11px 14px', textAlign: 'center' }}><RatingBadge rating={r.rating} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Skipped */}
          {skipped.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 14, color: '#565a6b', fontWeight: 600 }}>
                Skipped / Errors ({skipped.length})
              </summary>
              <div style={{ marginTop: 8, fontSize: 13, color: '#565a6b' }}>
                {skipped.map((r) => (
                  <div key={r.symbol} style={{ padding: '4px 0' }}>
                    <strong>{r.name || r.symbol}</strong> — {r.note || r.rating}
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Legend */}
          <div style={{ marginTop: 24, padding: '16px 20px', background: '#f7f8fa', borderRadius: 8, fontSize: 13, color: '#565a6b' }}>
            <strong>Scoring:</strong> Stocks = Technical 33% + Fundamental 33% + Momentum 33% · ETFs = Technical 50% + Momentum 50%
            <br />
            <strong>Momentum:</strong> 1M (20%) + 3M (30%) + 6M (50%) · D/E skipped for financial stocks
            <br />
            <strong>RSI:</strong> <span style={{ color: 'var(--neg, #dc2626)' }}>⚠ &gt;70 overbought</span> · <span style={{ color: 'var(--primary, #1355a8)' }}>🔵 &lt;30 oversold</span>
          </div>
        </>
      )}
    </PageShell>
  );
}

// ─────────────────────────────────────────
// ASK THE DATA (LLM → read-only SQL)
// ─────────────────────────────────────────

const ASK_EXAMPLES = [
  'What is my total F&O P&L by month?',
  'Top 10 stocks in the latest Nifty 500 scan',
  'Which of my holdings are rated EXIT or DOWNTREND?',
  'Show RELIANCE universe rank over the last scans',
  'My active recommendations and their targets',
  'Stocks in the Top 25 on every scan day this week',
];

function AskDataPage() {
  const [q, setQ]         = useState('');
  const [busy, setBusy]   = useState(false);
  const [chat, setChat]   = useState([]);     // {role, text, sql, columns, rows, rowCount, error}
  const [configured, setConfigured] = useState(true);
  const [provider, setProvider] = useState(null);

  useEffect(() => { fetchAskDataStatus().then((s) => { setConfigured(!!s.configured); setProvider(s); }).catch(() => {}); }, []);

  async function send(question) {
    const text = (question ?? q).trim();
    if (!text || busy) return;
    setQ('');
    setChat((c) => [...c, { role: 'user', text }]);
    setBusy(true);
    try {
      const r = await askData(text);
      setChat((c) => [...c, { role: 'assistant', ...r }]);
    } catch (e) {
      setChat((c) => [...c, { role: 'assistant', ok: false, error: e.message }]);
    } finally { setBusy(false); }
  }

  return (
    <PageShell title="Ask the Data" subtitle="Ask questions about your data in plain English — answered from the database (read-only)">
      {!configured && (
        <div className="panel" style={{ background: '#fef6e7', border: '1px solid #fcd34d' }}>
          <strong style={{ color: '#9a5b06' }}>⚠ Gemini API key not configured.</strong>
          <p style={{ fontSize: 14, color: '#9a5b06', margin: '6px 0 0' }}>
            Add <code>GEMINI_API_KEY=AIza…</code> to <code>D:\AI Projects\ZTA-Codex\.env</code> (the value is currently blank), then restart the backend.
            You can also set <code>GOOGLE_API_KEY</code> instead. Get a free key at <em>aistudio.google.com/apikey</em>.
          </p>
        </div>
      )}

      {provider && (
        <p style={{ fontSize: 13, color: '#565a6b', margin: '0 0 10px' }}>
          {provider.offline
            ? <span>🔒 <strong>Offline</strong> — local model <code>{provider.model}</code> (nothing leaves your machine). Answers take ~1–2 min on this CPU.</span>
            : <span>☁️ Cloud — <code>{provider.model}</code> (fast, ~3s).</span>}
        </p>
      )}
      <div className="panel">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          {ASK_EXAMPLES.map((ex) => (
            <button key={ex} type="button" onClick={() => send(ex)} disabled={busy || !configured}
              style={{ background: '#f1f5f9', border: '1px solid #e4e6ea', borderRadius: 16, padding: '4px 11px',
                fontSize: 13, color: '#565a6b', cursor: busy ? 'not-allowed' : 'pointer' }}>
              {ex}
            </button>
          ))}
        </div>

        {/* Conversation */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 12 }}>
          {chat.map((m, i) => m.role === 'user' ? (
            <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '85%', background: 'var(--primary, #1355a8)', color: '#fff',
              borderRadius: '12px 12px 2px 12px', padding: '8px 13px', fontSize: 14 }}>{m.text}</div>
          ) : (
            <AskAnswer key={i} m={m} />
          ))}
          {busy && <div style={{ alignSelf: 'flex-start', color: '#565a6b', fontSize: 14 }}>⏳ querying the database…</div>}
        </div>

        {/* Input */}
        <div style={{ display: 'flex', gap: 10 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()}
            disabled={!configured}
            placeholder="Ask about orders, P&L, scores, the Top 25, recommendations…"
            style={{ flex: 1, padding: '9px 13px', border: '1px solid #656974', borderRadius: 8, fontSize: 15 }} />
          <button type="button" onClick={() => send()} disabled={busy || !q.trim() || !configured}
            style={{ background: 'var(--primary, #1355a8)', color: '#fff', border: 'none', borderRadius: 8,
              padding: '9px 20px', fontWeight: 600, fontSize: 15, cursor: (busy || !q.trim()) ? 'not-allowed' : 'pointer' }}>
            Ask
          </button>
        </div>
        <p style={{ fontSize: 12.5, color: '#656974', marginTop: 8 }}>
          Powered by Gemini · read-only (only SELECT queries run; results capped at 200 rows) · not investment advice.
        </p>
      </div>
    </PageShell>
  );
}

function AskAnswer({ m }) {
  const [showSql, setShowSql] = useState(false);
  if (m.error) return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '90%', background: '#fdecea', border: '1px solid #b32d19',
      borderRadius: '12px 12px 12px 2px', padding: '8px 13px', fontSize: 14, color: '#b32d19' }}>
      ❌ {m.error}{m.sql ? <div style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 12.5, color: '#9a3412' }}>{m.sql}</div> : null}
    </div>
  );
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '95%', width: 'fit-content', background: '#f8fafc',
      border: '1px solid #e4e6ea', borderRadius: '12px 12px 12px 2px', padding: '10px 14px' }}>
      {m.answer && <div style={{ fontSize: 14, color: '#0f172a', marginBottom: m.rows?.length ? 8 : 0 }}>{m.answer}</div>}
      {m.rows?.length > 0 && (
        <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto', border: '1px solid #eef2f7', borderRadius: 8 }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
            <thead style={{ position: 'sticky', top: 0, background: '#f1f5f9' }}>
              <tr>{m.columns.map((c) => <th scope="col" key={c} style={{ padding: '5px 9px', textAlign: 'left', color: '#565a6b', whiteSpace: 'nowrap' }}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {m.rows.map((row, ri) => (
                <tr key={ri} style={{ borderTop: '1px solid #f1f5f9' }}>
                  {m.columns.map((c) => <td key={c} style={{ padding: '4px 9px', whiteSpace: 'nowrap' }}>{row[c] == null ? '—' : String(row[c])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ marginTop: 6, fontSize: 12.5, color: '#656974', display: 'flex', gap: 12, alignItems: 'center' }}>
        {m.rowCount != null && <span>{m.rowCount} row(s){m.rowCount > (m.rows?.length || 0) ? ` (showing ${m.rows.length})` : ''}</span>}
        {m.sql && <button type="button" onClick={() => setShowSql((s) => !s)}
          style={{ background: 'none', border: 'none', color: '#1355a8', cursor: 'pointer', fontSize: 12.5, padding: 0 }}>
          {showSql ? 'hide SQL' : 'show SQL'}</button>}
      </div>
      {showSql && m.sql && (
        <pre style={{ margin: '6px 0 0', background: '#0f172a', color: '#e4e6ea', padding: '11px 14px', borderRadius: 6,
          fontSize: 12.5, overflowX: 'auto', whiteSpace: 'pre-wrap' }}>{m.sql}</pre>
      )}
    </div>
  );
}

// ─────────────────────────────────────────
// STOCK SLEUTH — stock position lookups across all 4 scanned universes
// ─────────────────────────────────────────
function StockLookupsPage() {

  return (
    <PageShell title="Stock Sleuth" subtitle="One search across all four scanned universes — Nifty 500, Midcap, Smallcap, and Microcap">
      <StockLookupPanel />
    </PageShell>
  );
}

// ─────────────────────────────────────────
// INDUSTRY SCORECARD — every NSE sector's return profile, from the latest Nifty 500 scan
// ─────────────────────────────────────────
//
// A TABLE, NOT CARDS. Twenty sectors across five time windows is a grid of a hundred numbers,
// and the whole point is comparing them — which sector led over 3 months, which is rolling over
// this week. Cards put each sector in its own box and make exactly that comparison hard.
//
// The number shown is a MEDIAN of the sector's members, equal-weighted. It answers "what did a
// typical stock in this sector do", which is not what Nifty Metal or Nifty Bank report — those
// are cap-weighted, so a few giants set them. Breadth is shown next to it because a +12% median
// on 80% advancing and the same median on 45% advancing are different situations.
function IndustryScorecardPage() {
  return (
    <PageShell title="Industry Scorecard" subtitle="How each NSE sector has moved, measured across the Nifty 500 stocks you scan">
      <IndustryScorecardPanel />
    </PageShell>
  );
}

const SC_WINDOWS = [
  ['r1w', '1W'], ['r1m', '1M'], ['r3m', '3M'], ['r6m', '6M'], ['r1y', '1Y'],
];

// WHAT "TOP PERFORMING" MEANS depends on which question is being asked, and the two answers
// disagree often enough to be worth separating:
//
//   a return window  what the sector DID — the median member's move over that period
//   avgScore         what the sector IS — the average Portfolio-Health score of its members,
//                    which blends technical, fundamental and momentum and says nothing about
//                    the last three months on its own
//   breadth          how MANY members are participating, which is what distinguishes a sector
//                    move from two names carrying an index
//
// A sector can top the 3M table on a score of 48 (a hard bounce in weak businesses) or sit
// mid-table on a score of 62. Both orderings are legitimate; the column head picks between them.
const SC_SORTS = {
  avgScore: 'Score',
  breadth: 'Breadth 3M',
  ...Object.fromEntries(SC_WINDOWS.map(([k, l]) => [k, `${l} median`])),
};

/** The number a given sort key ranks on, or null when this industry has none. */
function scSortValue(row, key) {
  if (key === 'avgScore') return row.avgScore ?? null;
  if (key === 'breadth') return row.windows?.r3m?.breadthPct ?? null;
  return row.windows?.[key]?.median ?? null;
}

function IndustryScorecardPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState('r3m');
  const [open, setOpen] = useState(() => new Set());

  function load() {
    setLoading(true);
    fetchIndustryScorecard()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  const industries = data?.industries || [];
  const market = data?.market || null;

  // BEST FIRST, ALWAYS DESCENDING. The table's job is "which sector is leading", so the answer
  // is the top row and never needs looking for. An industry with no figure for the chosen
  // measure sinks to the bottom rather than sorting as if it were zero — "not measured" is not
  // the same as "flat", and letting it sort as zero would drop it into the middle of the table
  // among genuinely flat sectors.
  const sorted = [...industries].sort((a, b) => {
    const av = scSortValue(a, sortBy);
    const bv = scSortValue(b, sortBy);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });

  // The members panel splits stocks by a RETURN, so a sort on Score or Breadth — neither of
  // which exists per stock — falls back to 3M. Without this, expanding a row while sorted by
  // Score reads every stock's `undefined` and reports the whole sector as having no history.
  const memberWindow = SC_WINDOWS.some(([k]) => k === sortBy) ? sortBy : 'r3m';

  const toggle = (name) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  // Colour scales with size, so a +25% sector reads differently from a +2% one at a glance.
  // Capped at ±20% because beyond that the tint is already saturated and more range only
  // makes the middle of the table harder to tell apart.
  const tint = (v) => {
    if (v == null) return {};
    const k = Math.min(Math.abs(v) / 20, 1);
    const a = 0.07 + k * 0.20;
    return {
      background: v >= 0 ? `rgba(5,102,74,${a.toFixed(3)})` : `rgba(179,45,25,${a.toFixed(3)})`,
      color: Math.abs(v) > 12 ? (v >= 0 ? 'var(--pos)' : 'var(--neg)') : 'inherit',
      fontWeight: Math.abs(v) > 12 ? 700 : 600,
    };
  };
  const pct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`);

  if (loading) {
    return (
      <div className="panel" style={{ marginTop: 18 }}>
        <p className="muted">Building the scorecard from the latest Nifty 500 scan…</p>
      </div>
    );
  }
  if (error) return <div className="panel" style={{ marginTop: 18 }}><p className="negative">{error}</p></div>;
  if (!industries.length) {
    return (
      <div className="panel" style={{ marginTop: 18 }}>
        <p className="muted">{data?.message || 'No scan data yet. Run a Nifty 500 scan from Recommendations first.'}</p>
      </div>
    );
  }

  const th = (key, label, hint) => (
    <th
      key={key}
      scope="col"
      onClick={() => setSortBy(key)}
      title={hint || `Rank the sectors by ${SC_SORTS[key] || label}, best first`}
      style={{ cursor: 'pointer', textAlign: 'right', whiteSpace: 'nowrap',
        color: sortBy === key ? 'var(--text)' : undefined,
        textDecoration: sortBy === key ? 'underline' : undefined }}
    >
      {label}{sortBy === key ? ' ▾' : ''}
    </th>
  );

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>🏭 Industry Scorecard</h2>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {industries.length} industries · {market?.count} stocks
        </span>
        {data?.scanDate && <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          scan {data.scanDate}
        </span>}
        <button type="button" onClick={load} style={{ background: 'transparent', border: '1px solid var(--border-md)', borderRadius: 6, padding: '4px 10px', fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>↻ Reload</button>
      </div>
      <p style={{ margin: '4px 0 12px', fontSize: 12.5, color: 'var(--text-muted)' }}>
        Each figure is the <strong>median return of that sector's Nifty 500 members</strong>, equal-weighted —
        what a typical stock in the sector did. Published sector indices are cap-weighted and will differ.
        <strong> Breadth</strong> is the share of members positive over 3 months: a strong median on thin
        breadth means a few names are carrying it. Click a row to expand it.
      </p>
      <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--text-secondary)' }}>
        Ranked <strong>best first by {SC_SORTS[sortBy] || sortBy}</strong> — the leading sector is the
        top row. Click any other column head to rank by that instead:{' '}
        <span className="muted">
          a return window for what a sector <em>did</em>, Score for the health of what is <em>in</em> it.
        </span>
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table className="data-table compact-table">
          <thead>
            <tr>
              <th scope="col" style={{ width: 28 }}></th>
              <th scope="col" style={{ width: 30, textAlign: 'right' }} title="Rank on the column currently sorted">#</th>
              <th scope="col">Industry</th>
              <th scope="col" style={{ textAlign: 'right' }} title="Members of this sector in the Nifty 500">N</th>
              {SC_WINDOWS.map(([k, l]) => th(k, l))}
              {th('breadth', 'Breadth 3M', 'Share of members positive over 3 months — click to rank by participation, widest first')}
              {th('avgScore', 'Score', 'Average Portfolio-Health combined score across members — click to rank by the health of the sector’s businesses rather than by what they returned')}
              <th scope="col" style={{ textAlign: 'right' }} title="How many members you currently hold">Held</th>
            </tr>
          </thead>
          <tbody>
            {market && (
              <tr style={{ background: 'var(--surface-2, rgba(0,0,0,.03))', fontWeight: 600 }}>
                <td></td>
                <td></td>
                <td>NIFTY 500 <span className="muted" style={{ fontWeight: 400 }}>· all sectors</span></td>
                <td style={{ textAlign: 'right' }}>{market.count}</td>
                {SC_WINDOWS.map(([k]) => (
                  <td key={k} style={{ textAlign: 'right' }}>{pct(market.windows?.[k]?.median)}</td>
                ))}
                <td style={{ textAlign: 'right' }}>{market.windows?.r3m ? `${market.windows.r3m.breadthPct}%` : '—'}</td>
                <td></td><td></td>
              </tr>
            )}
            {sorted.map((row, i) => {
              const isOpen = open.has(row.industry);
              const b = row.windows?.r3m?.breadthPct;
              const ranked = scSortValue(row, sortBy) != null;
              return (
                <React.Fragment key={row.industry}>
                  <tr onClick={() => toggle(row.industry)} style={{ cursor: 'pointer' }}>
                    <td style={{ textAlign: 'center', color: 'var(--text-muted)', fontWeight: 700 }}>
                      {isOpen ? '−' : '+'}
                    </td>
                    {/* The rank is what makes "top performing first" a statement the table makes
                        rather than one the reader has to infer. Sectors with no figure for this
                        measure sit at the bottom unnumbered — ranking them would imply they came
                        last, when in fact they were not measured. */}
                    <td style={{ textAlign: 'right', color: 'var(--text-muted)',
                      fontWeight: ranked && i < 3 ? 700 : 400 }}>
                      {ranked ? i + 1 : '—'}
                    </td>
                    <td><strong>{row.industry}</strong></td>
                    <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{row.count}</td>
                    {SC_WINDOWS.map(([k]) => {
                      const w = row.windows?.[k];
                      return (
                        <td key={k} style={{ textAlign: 'right', ...tint(w?.median) }}
                          title={w ? `median ${w.median}% · mean ${w.mean}% · best ${w.best}% · worst ${w.worst}% · ${w.measured} of ${row.count} measured` : 'not enough history'}>
                          {pct(w?.median)}
                        </td>
                      );
                    })}
                    <td style={{ textAlign: 'right', fontWeight: sortBy === 'breadth' ? 700 : undefined,
                      color: b == null ? undefined : (b >= 60 ? 'var(--pos)' : b <= 40 ? 'var(--neg)' : undefined) }}>
                      {b == null ? '—' : `${b}%`}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: sortBy === 'avgScore' ? 700 : undefined }}>
                      {row.avgScore ?? '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {row.heldCount ? <span style={{ color: 'var(--pos)', fontWeight: 700 }}>{row.heldCount}</span> : <span className="muted">—</span>}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={SC_WINDOWS.length + 6} style={{ padding: '0 0 14px 28px', background: 'var(--surface-2, rgba(0,0,0,.015))' }}>
                        <IndustryMembers row={row} sortBy={memberWindow} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        Sectors follow the NSE industry classification carried in the Nifty 500 constituent list.
        A stock with too little listing history for a window is left out of that window rather than
        counted as flat — hover any figure for the count that went into it.
      </p>
    </div>
  );
}

// Members of one sector, split by the window currently being sorted on. Leaders and laggards
// side by side, because "who is carrying this sector and who is dragging it" is the question
// that follows immediately from a sector-level number.
function IndustryMembers({ row, sortBy }) {
  const navigate = useNavigate();
  const label = (SC_WINDOWS.find(([k]) => k === sortBy) || [, '3M'])[1];

  const withVal = row.stocks.filter((s) => Number.isFinite(s[sortBy]));
  const noVal = row.stocks.filter((s) => !Number.isFinite(s[sortBy]));
  const up = withVal.filter((s) => s[sortBy] > 0).sort((a, b) => b[sortBy] - a[sortBy]);
  const down = withVal.filter((s) => s[sortBy] <= 0).sort((a, b) => a[sortBy] - b[sortBy]);

  const List = ({ title, rows, tone }) => (
    <div style={{ flex: '1 1 320px', minWidth: 280 }}>
      <h4 style={{ margin: '10px 0 6px', fontSize: '0.82rem', fontWeight: 600, color: tone }}>
        {title} ({rows.length})
      </h4>
      {!rows.length && <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>None over {label}.</p>}
      {rows.length > 0 && (
        <table className="data-table compact-table" style={{ fontSize: '0.84rem' }}>
          <thead>
            <tr>
              <th scope="col">Stock</th>
              <th scope="col" style={{ textAlign: 'right' }}>{label}</th>
              <th scope="col" style={{ textAlign: 'right' }}>CMP</th>
              <th scope="col" style={{ textAlign: 'right' }}>Score</th>
              <th scope="col">Trend</th>
              <th scope="col">Held</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.symbol}>
                <td>
                  <button
                    type="button"
                    onClick={() => navigate(`/stock-lookups?symbol=${encodeURIComponent(s.symbol)}`)}
                    title={s.name}
                    style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 700, color: 'var(--link, inherit)', cursor: 'pointer', textDecoration: 'underline dotted' }}
                  >{s.symbol}</button>
                  <div className="muted" style={{ fontSize: 11.5 }}>{s.name}</div>
                </td>
                <td style={{ textAlign: 'right', fontWeight: 700, color: s[sortBy] >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
                  {s[sortBy] > 0 ? '+' : ''}{s[sortBy]}%
                </td>
                <td style={{ textAlign: 'right' }}>{s.cmp == null ? '—' : `₹${Number(s.cmp).toLocaleString('en-IN')}`}</td>
                <td style={{ textAlign: 'right' }}>{s.score ?? '—'}</td>
                <td style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  {s.emaLadder ? s.emaLadder.replace(/_/g, ' ').toLowerCase() : '—'}
                </td>
                <td style={{ fontSize: 11.5 }}>
                  {s.heldBy?.length ? <span style={{ color: 'var(--pos)', fontWeight: 700 }}>{s.heldBy.join(', ')}</span> : <span className="muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  return (
    <div>
      <p className="muted" style={{ fontSize: 12, margin: '10px 0 0' }}>
        {row.industry} — {row.count} members, split by {label} return.
        {noVal.length > 0 && ` ${noVal.length} without ${label} history: ${noVal.map((s) => s.symbol).join(', ')}.`}
      </p>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <List title={`▲ Gainers over ${label}`} rows={up} tone="var(--pos)" />
        <List title={`▼ Laggards over ${label}`} rows={down} tone="var(--neg)" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// APP SHELL
// ─────────────────────────────────────────

// ThemeSwitch removed — app is fully dark-themed (Outskill dark mode)

export default function App() {
  // The instance knows whose it is from the environment the hub started it with; the app
  // has no user table of its own because it serves exactly one person.
  const [owner, setOwner] = useState(null);
  useEffect(() => {
    // The name they are called, falling back to the login id — which is an address, not a
    // name, and a poor thing to greet somebody with on their own screen.
    fetch('/api/whoami').then((r) => r.json())
      .then((d) => setOwner(d.ownerName || d.owner)).catch(() => {});
  }, []);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        {/* The tab icon, repeated here — so the mark you pick out of the tab strip is the
            same one at the top of the app. Sourced straight from /favicon.svg rather than a
            copy, which is what keeps the two from drifting apart.
            alt="" is deliberate: the app name sits right beside it, and describing the image
            would make a screen reader announce that name twice. */}
        <div className="brand">
          <img className="brand-mark" src="/favicon.svg" alt="" width="32" height="32" />
          <div>
            <p className="brand-name">EquiStar</p>
            <p className="brand-tagline">{owner ? `Signed in as ${owner}` : 'Equity & portfolio'}</p>
          </div>
        </div>
        <nav>
          <div className="sidebar-section-label">Overview</div>
          <NavLink to="/" end>📊 Dashboard</NavLink>

          <div className="sidebar-section-label">Decision Tools</div>
          <NavLink to="/action-queue">⚡ Action Queue</NavLink>
          <NavLink to="/ltcg">🧮 LTCG / STCG</NavLink>
          <NavLink to="/performance">📈 Performance</NavLink>

          <div className="sidebar-section-label">Data</div>
          <NavLink to="/portfolio">💼 Portfolio</NavLink>
          <NavLink to="/daily-sync">📥 Daily Sync</NavLink>
          <NavLink to="/brokers">🔗 Brokers</NavLink>
          <NavLink to="/portfolio-health">🏥 Portfolio Health</NavLink>
          <NavLink to="/orders">📋 Orders</NavLink>
          <NavLink to="/recommendations">💡 Recommendations</NavLink>
          <NavLink to="/industry-scorecard">🏭 Industry Scorecard</NavLink>
          <NavLink to="/untracked-holdings">🔍 Untracked Holdings</NavLink>
          <NavLink to="/stock-lookups">🔍 Stock Sleuth</NavLink>
          <NavLink to="/ask-data">💬 Ask the Data</NavLink>
          <button
            type="button"
            className="signout"
            onClick={async () => {
              // The hub owns the session, not this instance — signing out here would leave
              // the participant still authenticated at the front door.
              await fetch('/hub/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
              window.location.href = '/hub/';
            }}
          >
            Sign out
          </button>
        </nav>
      </aside>
      <main className="content-shell">
        <Routes>
          <Route path="/"              element={<DashboardPage />} />
          <Route path="/action-queue"  element={<ActionQueuePage />} />
          <Route path="/ltcg"          element={<LtcgTrackerPage />} />
          <Route path="/portfolio"     element={<PortfolioPage />} />
          <Route path="/orders"        element={<OrdersPage />} />
          <Route path="/recommendations" element={<RecommendationsPage />} />
          <Route path="/industry-scorecard" element={<IndustryScorecardPage />} />
          <Route path="/untracked-holdings" element={<UntrackedHoldingsPage />} />
          <Route path="/stock-lookups" element={<StockLookupsPage />} />
          <Route path="/ask-data" element={<AskDataPage />} />
          <Route path="/performance"        element={<PerformancePage />} />
          <Route path="/daily-sync"        element={<DailySyncPage />} />
          <Route path="/brokers"           element={<BrokerSetupPage />} />
          <Route path="/portfolio-health"   element={<PortfolioHealthPage />} />
        </Routes>
      </main>
    </div>
  );
}