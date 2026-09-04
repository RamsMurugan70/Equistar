// Parses free-text EQUITY tips from a 1-on-1 advisor chat (WhatsApp export or paste).
//
// Deliberately separate from the options parser in services/telegram: that one reads
// multi-leg structures (strikes, lots, CE/PE) and values them with a payoff model. An equity
// tip is a different animal — one stock, an entry, a stop and a target range — so it gets its
// own parser and its own tracking rather than being bent into the options shape.
//
// Real sample this was built against:
//
//   Good morning !
//
//   Kusumgar
//   Adding cmp 650
//   Weak below 620 Clbs
//   Potential upside 680-710+
//
// Notable: the stock is given by NAME not ticker, "Clbs" means the stop is on a CLOSING
// basis (a daily close below the level, not an intraday touch), and the target is a RANGE.
// Each of those is captured rather than flattened, because each changes how the call is
// judged later.

const GREETING_RE = /^(good\s*(morning|afternoon|evening)|hi|hello|hey|namaste|gm|gn)\b[!.\s]*$/i;

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

// When the tip was given. Without it every call looks like it was made today, which destroys
// the whole point of tracking — a stop hit three days after the advice reads identically to
// one hit the same morning.
//
// Formats seen / expected:
//   "Advice came on 04 June 2026 :"      free text prefix, month by name
//   "4 Jun 2026" / "04 June 2026"
//   "04/06/2026" / "04-06-2026"          DD/MM (Indian convention, see note below)
//   "2026-06-04"                          ISO
//   "04/06/2026, 9:15 am - Niti:"        WhatsApp export line
function parseAdviceDate(text, now = new Date()) {
  const t = String(text || '');

  // ISO first — unambiguous, so it can never be misread as DD/MM.
  let m = t.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return build(+m[1], +m[2], +m[3], m[0], false);

  // "04 June 2026" / "4 Jun 26" — month by name, also unambiguous.
  m = t.match(/\b(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(20\d{2}|\d{2})\b/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toUpperCase()];
    if (mon) return build(yr(m[3]), mon, +m[1], m[0], false);
  }
  // "June 04 2026"
  m = t.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*(?:st|nd|rd|th)?,?\s+(20\d{2}|\d{2})\b/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toUpperCase()];
    if (mon) return build(yr(m[3]), mon, +m[2], m[0], false);
  }

  // Numeric d/m/y. AMBIGUOUS when both parts are <= 12: 04/06 is 4 June here but 6 April in
  // US notation. Indian convention (and WhatsApp's export locale) is DD/MM, so that is the
  // assumption — and it is reported so the caller can flag it rather than hide it.
  m = t.match(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](20\d{2}|\d{2})\b/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const ambiguous = a <= 12 && b <= 12;
    // If the first number can't be a month, it must be the day — no ambiguity at all.
    const day = a > 12 ? a : a;
    const mon = a > 12 ? b : b;
    return build(yr(m[3]), mon, day, m[0], ambiguous);
  }
  return null;

  function yr(s) { return s.length === 2 ? 2000 + Number(s) : Number(s); }

  function build(year, mon, day, raw, ambiguous) {
    if (!(mon >= 1 && mon <= 12) || !(day >= 1 && day <= 31)) return null;
    const iso = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    // A date in the future is almost certainly a misread (day/month swapped, or a typo), so
    // it is surfaced rather than silently stored as the advice date.
    const future = d > new Date(now.getTime() + 24 * 3600 * 1000);
    return { date: iso, raw, ambiguous, future };
  }
}

// Remove a leading date/prefix so the rest of the line can be read normally. The advisor
// writes "Advice came on 04 June 2026 : Data Patterns" — the stock name shares the line with
// the date, and guessStockLine skips any line containing digits, so without this the stock
// would never be found.
function stripDatePrefix(line, dateRaw) {
  let out = dateRaw ? line.replace(dateRaw, ' ') : line;

  // Strip leading noise REPEATEDLY, not in one pass. A WhatsApp export line is a stack of
  // prefixes — "04/06/2026, 9:15 am - Niti: Data Patterns" — and removing the date leaves
  // ", 9:15 am - Niti: ...", where the next pattern no longer sits at the start. A single
  // ordered pass left the timestamp behind, and any digit makes the line look like an
  // instruction rather than a stock name, so the stock vanished entirely.
  const strippers = [
    /^[\s:,\-–—\[\]]+/,                                             // leftover punctuation
    /^\[?\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\s*\]?/i,          // timestamp
    /^(advice\s+came\s+on|advice\s+on|advised\s+on|dated|date)\b/i, // free-text lead-in
  ];
  let changed = true;
  let guard = 0;
  while (changed && guard < 10) {
    changed = false;
    guard += 1;
    for (const re of strippers) {
      const next = out.replace(re, '');
      if (next !== out) { out = next; changed = true; }
    }
  }

  // "Niti:" sender prefix — but never strip a label that carries a level ("Target: 4265").
  out = out.replace(/^\s*[A-Za-z][A-Za-z .]{0,19}:\s*/, (mm) => (
    /\b(cmp|sl|target|tgt|stop|upside|buy|sell|add)\b/i.test(mm) ? mm : ''
  ));

  return out.trim();
}

// Words that appear on their own line but are never a stock name.
const NOT_A_STOCK = new Set([
  'ADDING', 'ADD', 'BUY', 'SELL', 'EXIT', 'BOOK', 'HOLD', 'CMP', 'TARGET', 'TGT', 'SL',
  'STOPLOSS', 'STOP', 'WEAK', 'BELOW', 'ABOVE', 'CLBS', 'CLOSING', 'BASIS', 'POTENTIAL',
  'UPSIDE', 'DOWNSIDE', 'VIEW', 'NOTE', 'UPDATE', 'LEVELS', 'LEVEL', 'RANGE', 'ZONE',
  'SUPPORT', 'RESISTANCE', 'BREAKOUT', 'THANKS', 'REGARDS', 'PLEASE', 'KINDLY',
]);

const ACTION_PATTERNS = [
  { re: /\b(adding|add\s+more|accumulat\w*)\b/i, action: 'ADD' },
  { re: /\b(buy|initiate|enter|long)\b/i,        action: 'BUY' },
  { re: /\b(exit|sell|book\s+out|square\s*off)\b/i, action: 'EXIT' },
  { re: /\b(book\s+partial|partial\s+profit|trim)\b/i, action: 'BOOK_PARTIAL' },
  { re: /\b(hold|stay\s+invested)\b/i,           action: 'HOLD' },
];

function num(x) {
  const n = parseFloat(String(x).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// "Adding cmp 650" / "Buy at 650" / "cmp 650-655"
function parseEntry(text) {
  const m = text.match(/\b(?:cmp|around|near|at|@)\s*([\d,]+(?:\.\d+)?)(?:\s*[-–]\s*([\d,]+(?:\.\d+)?))?/i);
  if (!m) return null;
  return { low: num(m[1]), high: m[2] ? num(m[2]) : null, raw: m[0].trim() };
}

// "Weak below 620 Clbs" / "SL 620" / "stop loss 620 closing basis"
function parseStop(text) {
  const m = text.match(/\b(?:weak\s+below|below|sl|stop\s*-?\s*loss|stop)\s*:?\s*([\d,]+(?:\.\d+)?)/i);
  if (!m) return null;
  // "Clbs" / "closing basis" — the stop triggers on a DAILY CLOSE below the level, not an
  // intraday spike through it. Tracking this wrongly would fire false stops on every wick.
  const closingBasis = /\bcl(?:b|bs|osing)\b|\bclosing\s+basis\b|\bcb\b/i.test(text);
  return { level: num(m[1]), closingBasis, raw: m[0].trim() };
}

// "Potential upside 680-710+" / "Target 680-710" / "tgt 700"
function parseTarget(text) {
  const m = text.match(/\b(?:potential\s+upside|upside|target|tgt|goal)\s*:?\s*([\d,]+(?:\.\d+)?)(?:\s*[-–]\s*([\d,]+(?:\.\d+)?))?\s*(\+)?/i);
  if (!m) return null;
  return {
    low: num(m[1]),
    high: m[2] ? num(m[2]) : null,
    openEnded: Boolean(m[3]),   // the trailing "+" — advisor sees room beyond the range
    raw: m[0].trim(),
  };
}

// The stock is named on its own line, before the instruction lines. Resolved against the
// scan universe by the caller — the advisor writes plain names ("Kusumgar"), not tickers.
function guessStockLine(lines) {
  for (const line of lines) {
    const t = line.trim().replace(/[!.:,]+$/, '');
    if (!t || GREETING_RE.test(t)) continue;
    if (/\d/.test(t)) continue;                                   // instruction lines carry numbers
    const words = t.split(/\s+/);
    if (words.length > 4) continue;                               // prose, not a name
    if (words.every((w) => NOT_A_STOCK.has(w.toUpperCase()))) continue;
    return t;
  }
  return null;
}

// Split a pasted blob into individual tips. A blank line between blocks is the usual
// separator in these chats; a single tip pasted alone stays one block.
function splitBlocks(raw) {
  return String(raw || '')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b && !GREETING_RE.test(b));
}

function parseOne(block, { knownNames = new Map(), now = new Date() } = {}) {
  const rawLines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const flags = [];

  // Date first, then strip it — the advisor puts it on the same line as the stock
  // ("Advice came on 04 June 2026 : Data Patterns"), and guessStockLine skips any line
  // containing digits, so leaving it in place hides the stock name entirely.
  const advisedOnInfo = parseAdviceDate(block, now);
  const lines = rawLines.map((l) => (advisedOnInfo && l.includes(advisedOnInfo.raw)
    ? stripDatePrefix(l, advisedOnInfo.raw) : l)).filter(Boolean);

  if (advisedOnInfo?.ambiguous) {
    flags.push({
      level: 'confirm', code: 'AMBIGUOUS_DATE',
      message: `"${advisedOnInfo.raw}" read as ${advisedOnInfo.date} (day/month order assumed Indian) — confirm`,
    });
  }
  if (advisedOnInfo?.future) {
    flags.push({
      level: 'warn', code: 'FUTURE_DATE',
      message: `"${advisedOnInfo.raw}" resolves to ${advisedOnInfo.date}, which is in the future — check the day/month order`,
    });
  }

  const stockText = guessStockLine(lines);
  // Parse levels from the DATE-STRIPPED text: "04 June 2026" contains numbers that a
  // price regex would happily grab (e.g. reading 2026 as a target).
  const body = lines.join('\n');
  const entry = parseEntry(body);
  const stop = parseStop(body);
  const target = parseTarget(body);

  let action = null;
  for (const p of ACTION_PATTERNS) {
    if (p.re.test(block)) { action = p.action; break; }
  }

  // Resolve the plain name to a tradable symbol. Never guessed: an unresolved name is
  // flagged for a human rather than mapped to whatever looks closest, because a wrong
  // symbol would silently track an entirely different company.
  let symbol = null;
  let matchedName = null;
  if (stockText) {
    const norm = normName(stockText);
    const exact = knownNames.get(norm);
    if (exact) { symbol = exact.symbol; matchedName = exact.name; }
    else {
      const hits = [...knownNames.entries()].filter(([k]) => k.length >= 4 && (k.startsWith(norm) || norm.startsWith(k)));
      // DEDUPE BY SYMBOL FIRST. The index is keyed by BOTH company name and ticker, so one
      // stock legitimately appears under several keys ("TITAGARHRAILSYSTEMS" and "TITAGARH").
      // Counting keys instead of symbols reported "matches 2 stocks (TITAGARH, TITAGARH)" —
      // a resolvable name pushed to manual review for no reason.
      const bySymbol = new Map();
      for (const [, v] of hits) if (!bySymbol.has(v.symbol)) bySymbol.set(v.symbol, v);
      const distinct = [...bySymbol.values()];

      if (distinct.length === 1) {
        symbol = distinct[0].symbol; matchedName = distinct[0].name;
        flags.push({ level: 'confirm', code: 'FUZZY_NAME', message: `"${stockText}" matched to ${symbol} (${matchedName}) by prefix — confirm before relying on it` });
      } else if (distinct.length > 1) {
        flags.push({ level: 'confirm', code: 'AMBIGUOUS_NAME', message: `"${stockText}" matches ${distinct.length} stocks (${distinct.slice(0, 4).map((h) => h.symbol).join(', ')}) — pick one` });
      } else {
        flags.push({ level: 'warn', code: 'UNKNOWN_NAME', message: `"${stockText}" does not match any listed stock — map it manually` });
      }
    }
  } else {
    flags.push({ level: 'warn', code: 'NO_STOCK', message: 'No stock name found in this block' });
  }

  if (!entry) flags.push({ level: 'info', code: 'NO_ENTRY', message: 'No entry price stated — will track from the price when saved' });
  if (!stop) flags.push({ level: 'info', code: 'NO_STOP', message: 'No stop level stated' });
  if (!target) flags.push({ level: 'info', code: 'NO_TARGET', message: 'No target stated' });

  return {
    raw: block,
    advisedOn: advisedOnInfo?.date || null,
    advisedOnRaw: advisedOnInfo?.raw || null,
    advisedOnAmbiguous: advisedOnInfo?.ambiguous || false,
    stockText,
    symbol,
    matchedName,
    action: action || 'BUY',     // a tip with no verb is an entry call by default
    actionInferred: !action,
    entryLow: entry?.low ?? null,
    entryHigh: entry?.high ?? null,
    stopLevel: stop?.level ?? null,
    stopClosingBasis: stop?.closingBasis ?? false,
    targetLow: target?.low ?? null,
    targetHigh: target?.high ?? null,
    targetOpenEnded: target?.openEnded ?? false,
    flags,
    confidence: score({ symbol, entry, stop, target, flags }),
    parsedAt: now.toISOString(),
  };
}

function score({ symbol, entry, stop, target, flags }) {
  let s = 1;
  if (!symbol) s -= 0.5;
  if (!entry) s -= 0.15;
  if (!stop) s -= 0.1;
  if (!target) s -= 0.1;
  for (const f of flags) {
    if (f.level === 'warn') s -= 0.2;
    else if (f.level === 'confirm') s -= 0.15;
  }
  return Math.max(0, Math.round(s * 100) / 100);
}

function normName(s) {
  return String(s || '').toUpperCase()
    .replace(/\b(LTD|LIMITED|CORPORATION|CORPORATES|CORP|COMPANY|CO|INDIA|INDIAN|THE|AND|&)\b/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

function parsePaste(raw, opts = {}) {
  return splitBlocks(raw).map((b) => parseOne(b, opts));
}

module.exports = { parsePaste, parseOne, splitBlocks, normName };
