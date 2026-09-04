#!/usr/bin/env python3
"""
Portfolio Health Scorer v1.1
===========================================
Scores each holding on three equal pillars (33.3% each):
  - Technical Analysis  : RSI, MACD, Price vs 50DMA, 50DMA vs 200DMA
  - Fundamental Analysis: P/E, P/B, ROE, Debt/Equity, Revenue Growth  (stocks only)
  - Price Momentum      : 1M (20%) + 3M (30%) + 6M (50%) weighted return

ETFs get Technical + Momentum only (50/50), no Fundamental.
Usage: python portfolio_health.py [path_to_csv]

v1.1 changes:
  - SYMBOL_MAP updated to use new Demat Holdings CSV Stock codes
  - Fixed broken yfinance ETF tickers
  - CSV_PATH updated to new demat filename pattern
  - Output JSON added for app integration
"""

import os, sys, warnings, json
import pandas as pd
import numpy as np
import yfinance as yf
from datetime import datetime, timedelta

warnings.filterwarnings('ignore')
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# No default path. This used to point at one developer's Downloads folder, at a file named after
# their demat account number. On a shared server that path does not exist — and if it did, one
# participant's holdings would be scored as everybody's. The caller passes the file as argv[1];
# HOLDINGS_CSV is here only so the script stays runnable by hand.
CSV_PATH = os.environ.get("HOLDINGS_CSV")

# ─── ICICI Direct Stock code (from Demat CSV 'Stock' column) → yfinance ticker ─
# Keys are the ICICI broker codes from the 'Stock' column of the new demat CSV
SYMBOL_MAP = {
    # Stocks
    'ANARAT':  'ANANDRATHI.NS',   # Anand Rathi Wealth
    'BAJFI':   'BAJFINANCE.NS',   # Bajaj Finance
    'BHAELE':  'BEL.NS',          # Bharat Electronics
    'BHAPET':  'BPCL.NS',         # BPCL
    'BILGAR':  'GROWW.NS',        # BillionBrains Garage Ventures (Groww)
    'CITUNI':  'CUB.NS',          # City Union Bank
    'GUJMI':   'GMDCLTD.NS',      # GMDC
    'HDFAMC':  'HDFCAMC.NS',      # HDFC AMC
    'HDFBAN':  'HDFCBANK.NS',     # HDFC Bank
    'ICIBAN':  'ICICIBANK.NS',    # ICICI Bank
    'IMAMAR':  None,              # Imagine Marketing (boAt) — unlisted
    'INDOIL':  'IOC.NS',          # Indian Oil
    'LARTOU':  'LT.NS',           # L&T
    'LAULAB':  'LAURUSLABS.NS',   # Laurus Labs
    'MAPHA':   'MANKIND.NS',      # Mankind Pharma
    'MARUTI':  'MARUTI.NS',       # Maruti Suzuki
    'MCX':     'MCX.NS',          # MCX
    'MOHMEA':  None,              # Mohan Meakin — illiquid, face value
    'ORASTA':  None,              # Oravel Stays (OYO) — unlisted
    'POWFIN':  'PFC.NS',          # Power Finance Corporation
    'RELIND':  'RELIANCE.NS',     # Reliance Industries
    'RURELE':  'RECLTD.NS',       # REC Limited
    'STABAN':  'SBIN.NS',         # State Bank of India
    'SUNHIT':  None,              # Sunil Hitech — CMP Rs 0.35, suspended
    'UJJSMA':  'UJJIVANSFB.NS',   # Ujjivan Small Finance Bank
    'ENGIND':  'ENGINERSIN.NS',   # Engineers India Ltd.
    'RBLBAN':  'RBLBANK.NS',      # RBL Bank
    'NIPNIT':  'ITBEES.NS',        # Nippon India ETF Nifty IT Index
    'SHYMET':  'SHYAMMETL.NS',    # Shyam Metalics and Energy
    'EMMPHO':  'EMMVEE.NS',       # Emmvee Photovoltaic Power
    'FIRSOU':  'FSL.NS',          # Firstsource Solutions
    'RAIIND':  'RAIN.NS',         # Rain Industries
    'DATGLO':  'DATAMATICS.NS',   # Datamatics Global Services
    'KARVYS':  'KARURVYSYA.NS',   # Karur Vysya Bank
    'TORPHA':  'TORNTPHARM.NS',   # Torrent Pharmaceuticals
    'BAAUTO':  'BAJAJ-AUTO.NS',   # Bajaj Auto
    # ETFs
    'BANBEE':  'BANKBEES.NS',     # Nippon India ETF Bank BeES
    'GOLDEX':  'GOLDBEES.NS',     # Nippon India ETF Gold BeES
    'HDFGOL':  'HDFCGOLD.NS',     # HDFC Gold ETF
    'ICIGOL':  'GOLD1.NS',        # ICICI Prudential Gold ETF
    'ICINIF':  'NIFTYBEES.NS',    # ICICI Nifty 50 ETF — proxy via NiftyBees
    'ICIPSE':  'SILVER.NS',       # ICICI Prudential Silver ETF
    'NIFBEE':  'NIFTYBEES.NS',    # Nippon India ETF Nifty 50 BeES
    'NIFJUN':  'JUNIORBEES.NS',   # Nippon India ETF NiftyNext50 Jr BeES
    'ZEROGE':  'GOLDCASE.NS',     # Zerodha Gold ETF
}

# IMAMAR (Imagine Marketing/boAt) and ORASTA (OYO) are unlisted — filtered via None above

ETFS = {
    'BANBEE', 'GOLDEX', 'HDFGOL', 'ICIGOL',
    'ICINIF', 'ICIPSE', 'NIFBEE', 'NIFJUN', 'NIPNIT', 'ZEROGE',
}

# Financial sector — skip Debt/Equity ratio (banking D/E is misleadingly high)
#
# BOTH NAMING SCHEMES ON PURPOSE. fundamental_score() is called from two places that identify a
# stock differently: this file's own holdings path passes ICICI demat codes (HDFBAN), while
# nifty500_scanner.py and capscanner.py pass NSE symbols (HDFCBANK). Only the ICICI codes used to
# be listed here, so in the scanner path nothing ever matched and every bank in the NIFTY 500 was
# scored on leverage that is simply what banking is.
FINANCIALS = {
    # ICICI demat codes — the holdings path
    'HDFBAN', 'ICIBAN', 'STABAN', 'CITUNI', 'UJJSMA',
    'POWFIN', 'RURELE', 'HDFAMC', 'ANARAT', 'MCX',
    # NSE symbols — the scanner path
    'HDFCBANK', 'ICICIBANK', 'SBIN', 'KOTAKBANK', 'AXISBANK', 'INDUSINDBK', 'BANKBARODA',
    'PNB', 'CANBK', 'UNIONBANK', 'IDFCFIRSTB', 'FEDERALBNK', 'BANDHANBNK', 'AUBANK',
    'BAJFINANCE', 'BAJAJFINSV', 'CHOLAFIN', 'SHRIRAMFIN', 'MUTHOOTFIN', 'MANAPPURAM',
    'LICHSGFIN', 'PFC', 'RECLTD', 'IRFC', 'HDFCLIFE', 'SBILIFE', 'ICICIPRULI', 'ICICIGI',
    'LICI', 'SBICARD', 'IIFL', 'PEL', 'M&MFIN', 'HUDCO', 'JIOFIN', 'ABCAPITAL', 'POONAWALLA',
}


# ─── Technical Score (0–100) ──────────────────────────────────────────────────
def calc_rsi(close, period=14):
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def ema_trend(hist):
    """EMA 20/50/200 trend ladder + 50EMA 10-day slope (%).
    Faster trend read than the SMA-based signals — flags deterioration earlier.
    Returns (ladder_label, slope_pct) or (None, None) if not enough history."""
    close = hist['Close'].squeeze()
    if len(close) < 50:
        return None, None
    e20  = close.ewm(span=20,  adjust=False).mean()
    e50  = close.ewm(span=50,  adjust=False).mean()
    e200 = close.ewm(span=200, adjust=False).mean()
    p, a, b, c = close.iloc[-1], e20.iloc[-1], e50.iloc[-1], e200.iloc[-1]
    slope = None
    if len(e50) > 10 and e50.iloc[-11] > 0:
        slope = round((e50.iloc[-1] - e50.iloc[-11]) / e50.iloc[-11] * 100, 2)
    if p > a > b > c:            ladder = 'STRONG_UPTREND'
    elif b > c and a > p > b:    ladder = 'PULLBACK'        # dip within an uptrend
    elif b > c and p < b:        ladder = 'DISTRIBUTION'    # uptrend cracking
    elif p < c and b < c:        ladder = 'DOWNTREND'
    else:                        ladder = 'MIXED'
    return ladder, slope


def technical_score(hist):
    close = hist['Close'].squeeze()
    if len(close) < 50:
        return None

    # ── RSI
    rsi = calc_rsi(close).iloc[-1]
    if rsi > 65:        rsi_s = 85
    elif rsi > 55:      rsi_s = 72
    elif rsi > 45:      rsi_s = 55
    elif rsi > 35:      rsi_s = 38
    else:               rsi_s = 22

    # ── MACD histogram direction
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd_line = ema12 - ema26
    signal    = macd_line.ewm(span=9, adjust=False).mean()
    hist_val  = macd_line - signal
    if hist_val.iloc[-1] > 0 and hist_val.iloc[-1] > hist_val.iloc[-2]:
        macd_s = 85
    elif hist_val.iloc[-1] > 0:
        macd_s = 68
    elif hist_val.iloc[-1] > hist_val.iloc[-2]:
        macd_s = 45
    else:
        macd_s = 28

    # ── Price vs 50 DMA
    ma50  = close.rolling(50).mean().iloc[-1]
    price = close.iloc[-1]
    vs50  = (price - ma50) / ma50 * 100
    if vs50 > 8:        vs50_s = 85
    elif vs50 > 3:      vs50_s = 72
    elif vs50 > 0:      vs50_s = 60
    elif vs50 > -5:     vs50_s = 42
    else:               vs50_s = 25

    # ── 50 DMA vs 200 DMA (golden / death cross)
    if len(close) >= 200:
        ma200  = close.rolling(200).mean().iloc[-1]
        cross_s = 80 if ma50 > ma200 else 32
    else:
        cross_s = 55   # not enough history → neutral

    score = (rsi_s + macd_s + vs50_s + cross_s) / 4
    return round(score, 1), round(rsi, 1)


# ─── Fundamental Score (0–100) — stocks only ─────────────────────────────────
def fundamental_score(ticker_obj, stock_code):
    try:
        info = ticker_obj.info
    except Exception:
        return None

    parts = []
    is_fin = stock_code in FINANCIALS

    # P/E
    pe = info.get('trailingPE') or info.get('forwardPE')
    if pe and 0 < pe < 300:
        if pe < 12:     pe_s = 90
        elif pe < 20:   pe_s = 75
        elif pe < 30:   pe_s = 60
        elif pe < 45:   pe_s = 42
        else:           pe_s = 22
        parts.append(pe_s)

    # P/B
    pb = info.get('priceToBook')
    if pb and pb > 0:
        if pb < 1:      pb_s = 92
        elif pb < 2:    pb_s = 78
        elif pb < 4:    pb_s = 62
        elif pb < 8:    pb_s = 42
        else:           pb_s = 22
        parts.append(pb_s)

    # ROE
    roe = info.get('returnOnEquity')
    if roe is not None:
        r = roe * 100
        if r > 25:      roe_s = 92
        elif r > 18:    roe_s = 78
        elif r > 12:    roe_s = 62
        elif r > 6:     roe_s = 42
        else:           roe_s = 22
        parts.append(roe_s)

    # Debt/Equity — skip for financial sector
    if not is_fin:
        de = info.get('debtToEquity')
        if de is not None and de >= 0:
            # ALWAYS A PERCENTAGE from Yahoo: 36.653 for Reliance means 0.37x, and 9.541 for
            # Infosys means 0.095x — a company that is effectively debt-free. These bands are
            # ratios, so the raw value has to be divided by 100 first. Without that, 318 of the
            # 366 non-financials in the NIFTY 500 land past the last band and score 22, Infosys
            # among them, dragging the whole fundamental leg down by roughly 11 points.
            de = de / 100.0
            if de < 0.2:    de_s = 92
            elif de < 0.5:  de_s = 78
            elif de < 1.0:  de_s = 62
            elif de < 2.0:  de_s = 42
            else:           de_s = 22
            parts.append(de_s)

    # Revenue growth (YoY)
    rev_g = info.get('revenueGrowth')
    if rev_g is not None:
        g = rev_g * 100
        if g > 20:      rg_s = 90
        elif g > 10:    rg_s = 72
        elif g > 0:     rg_s = 55
        elif g > -10:   rg_s = 35
        else:           rg_s = 18
        parts.append(rg_s)

    if not parts:
        return None
    return round(np.mean(parts), 1)


# ─── Momentum Score (0–100) ──────────────────────────────────────────────────
def momentum_score(hist):
    close = hist['Close'].squeeze()
    price = close.iloc[-1]

    def ret(days):
        if len(close) > days:
            return (price / close.iloc[-days] - 1) * 100
        return None

    r1m, r3m, r6m = ret(21), ret(63), ret(126)

    def score_ret(r, good, ok, bad):
        if r is None: return None
        if r > good:  return 88
        if r > ok:    return 70
        if r > 0:     return 54
        if r > bad:   return 36
        return 18

    s1 = score_ret(r1m, good=5,  ok=2,  bad=-5)
    s3 = score_ret(r3m, good=15, ok=7,  bad=-10)
    s6 = score_ret(r6m, good=25, ok=12, bad=-15)

    weighted = [(s, w) for s, w in [(s1, 0.2), (s3, 0.3), (s6, 0.5)] if s is not None]
    if not weighted:
        return None, r1m, r3m, r6m
    total_w = sum(w for _, w in weighted)
    score   = sum(s * w for s, w in weighted) / total_w
    return round(score, 1), r1m, r3m, r6m


# ─── Rating label ─────────────────────────────────────────────────────────────
def rating(score):
    if score is None: return '?'
    if score >= 70: return 'STRONG HOLD'
    if score >= 60: return 'HOLD'
    if score >= 50: return 'WATCH'
    if score >= 40: return 'WEAK'
    return 'REVIEW'


# ─── Main ─────────────────────────────────────────────────────────────────────
def run(csv_path, output_json=False):
    df = pd.read_csv(csv_path)
    df.columns = df.columns.str.strip()
    # Filter out rows with no Stock code (unlisted / no NSE symbol)
    df = df[df['Stock'].notna() & (df['Stock'].astype(str).str.strip() != '')]

    end   = datetime.today()
    start = end - timedelta(days=420)   # 420 days → enough for 200-DMA

    results = []

    if not output_json:
        print(f"\nFetching market data for {len(df)} holdings...\n")

    for _, row in df.iterrows():
        code  = str(row['Stock']).strip()
        name  = str(row['Stock Name']).strip()
        cmp   = row.get('Current Market Price', 0)
        qty   = row.get('Allocated Quantity', 0) + row.get('Block For Margin', 0) + row.get('Blocked for Trade', 0)
        yfsym = SYMBOL_MAP.get(code)

        # ── Auto-fallback for codes not in SYMBOL_MAP (e.g. Geetha/Zerodha NSE codes) ──
        if yfsym is None and code not in SYMBOL_MAP:
            # Try code directly as NSE ticker
            for suffix in ['.NS', '.BO']:
                candidate = code + suffix
                try:
                    test_hist = yf.Ticker(candidate).history(period='5d')
                    if not test_hist.empty:
                        yfsym = candidate
                        break
                except Exception:
                    pass
            if yfsym is None:
                # Confirmed unlisted/suspended
                results.append(dict(Name=name, Code=code, CMP=cmp, Qty=qty,
                                    Tech=None, Fund=None, Mom=None,
                                    Score=None, Rating='SKIP', RSI=None,
                                    R1M=None, R3M=None, R6M=None, Note='Suspended/Unlisted'))
                if not output_json:
                    print(f"  [SKIP] {name}")
                continue
        elif yfsym is None:
            # Explicitly mapped to None → suspended
            results.append(dict(Name=name, Code=code, CMP=cmp, Qty=qty,
                                Tech=None, Fund=None, Mom=None,
                                Score=None, Rating='SKIP', RSI=None,
                                R1M=None, R3M=None, R6M=None, Note='Suspended/Unlisted'))
            if not output_json:
                print(f"  [SKIP] {name}")
            continue

        is_etf = code in ETFS
        if not output_json:
            print(f"  [...] {name[:45]:<45} ({yfsym})", end='', flush=True)

        try:
            ticker = yf.Ticker(yfsym)
            hist   = ticker.history(start=start, end=end)

            if hist.empty or len(hist) < 30:
                raise ValueError("Insufficient price history")

            # Technical
            t_result = technical_score(hist)
            t_score, rsi_val = (t_result if t_result else (None, None))

            # Fundamental (stocks only)
            f_score = None if is_etf else fundamental_score(ticker, code)

            # Momentum
            m_score, r1m, r3m, r6m = momentum_score(hist)

            # EMA trend ladder (20/50/200) + 50EMA slope
            ema_ladder, ema50_slope = ema_trend(hist)

            # Combined health score
            if is_etf:
                valid  = [s for s in [t_score, m_score] if s is not None]
                health = round(np.mean(valid), 1) if valid else None
                note   = 'ETF'
            else:
                valid  = [s for s in [t_score, f_score, m_score] if s is not None]
                health = round(np.mean(valid), 1) if valid else None
                note   = 'No Fundamental data' if f_score is None else ''

            if not output_json:
                print(f"  Score={health}  ({rating(health)})")

            results.append(dict(
                Name=name, Code=code, CMP=cmp, Qty=qty,
                Tech=t_score,
                Fund=f_score if not is_etf else None,
                Mom=m_score,
                Score=health,
                Rating=rating(health),
                RSI=rsi_val,
                R1M=round(r1m, 1) if r1m is not None else None,
                R3M=round(r3m, 1) if r3m is not None else None,
                R6M=round(r6m, 1) if r6m is not None else None,
                IsETF=is_etf,
                Note=note,
                EmaLadder=ema_ladder,
                Ema50Slope=ema50_slope,
            ))

        except Exception as e:
            if not output_json:
                print(f"  ERROR: {e}")
            results.append(dict(Name=name, Code=code, CMP=cmp, Qty=qty,
                                Tech=None, Fund=None, Mom=None,
                                Score=None, Rating='ERROR', RSI=None,
                                R1M=None, R3M=None, R6M=None,
                                IsETF=is_etf, Note=str(e),
                                EmaLadder=None, Ema50Slope=None))

    # ── JSON output mode (for app integration) ────────────────────────────────
    if output_json:
        print(json.dumps({
            'scoreDate': datetime.now().strftime('%Y-%m-%d'),
            'generatedAt': datetime.now().isoformat(),
            'rows': results,
        }, default=str))
        return

    # ── Render ranked table ───────────────────────────────────────────────────
    out    = pd.DataFrame(results)
    stocks = out[(out['Note'] != 'ETF') & (out['Rating'].isin(['STRONG HOLD','HOLD','WATCH','WEAK','REVIEW','']))].copy()
    stocks = stocks[stocks['Score'].notna()].sort_values('Score', ascending=False)
    etfs   = out[out['Note'] == 'ETF'].copy().sort_values('Score', ascending=False)
    skips  = out[out['Rating'].isin(['SKIP','ERROR'])].copy()

    SEP = "=" * 100

    print(f"\n\n{SEP}")
    print(f"  PORTFOLIO HEALTH SCORECARD — {datetime.now().strftime('%d-%b-%Y %H:%M')}")
    print(f"  Scoring: Technical (33%) + Fundamental (33%) + Momentum (33%)  |  ETFs: Tech+Mom 50/50")
    print(SEP)

    hdr = f"  {'Rank':<5} {'Stock':<32} {'CMP':>8}  {'Tech':>5} {'Fund':>5} {'Mom':>5}  {'Score':>6}  {'RSI':>5}  {'1M%':>6} {'3M%':>6} {'6M%':>6}  Rating"
    print(f"\n{hdr}")
    print("  " + "-" * 96)

    for i, (_, r) in enumerate(stocks.iterrows(), 1):
        fs  = f"{r['Fund']:>5.1f}" if isinstance(r['Fund'], float) else f"{'--':>5}"
        r1  = f"{r['R1M']:>+6.1f}" if r['R1M'] is not None else f"{'--':>6}"
        r3  = f"{r['R3M']:>+6.1f}" if r['R3M'] is not None else f"{'--':>6}"
        r6  = f"{r['R6M']:>+6.1f}" if r['R6M'] is not None else f"{'--':>6}"
        ts  = f"{r['Tech']:>5.1f}" if r['Tech'] is not None else f"{'--':>5}"
        ms  = f"{r['Mom']:>5.1f}"  if r['Mom']  is not None else f"{'--':>5}"
        rsi = f"{r['RSI']:>5.1f}" if r['RSI'] is not None else f"{'--':>5}"
        sc  = f"{r['Score']:>6.1f}"
        print(f"  {i:<5} {r['Name'][:31]:<32} {r['CMP']:>8,.2f}  {ts} {fs} {ms}  {sc}  {rsi}  {r1} {r3} {r6}  {r['Rating']}")

    if not etfs.empty:
        print(f"\n  {'─'*40}  ETFs (Technical + Momentum only)  {'─'*20}")
        for i, (_, r) in enumerate(etfs.iterrows(), 1):
            r1 = f"{r['R1M']:>+6.1f}" if r['R1M'] is not None else f"{'--':>6}"
            r3 = f"{r['R3M']:>+6.1f}" if r['R3M'] is not None else f"{'--':>6}"
            r6 = f"{r['R6M']:>+6.1f}" if r['R6M'] is not None else f"{'--':>6}"
            ts = f"{r['Tech']:>5.1f}" if r['Tech'] is not None else f"{'--':>5}"
            ms = f"{r['Mom']:>5.1f}"  if r['Mom']  is not None else f"{'--':>5}"
            sc = f"{r['Score']:>6.1f}" if r['Score'] is not None else f"{'--':>6}"
            print(f"  E{i:<4} {r['Name'][:31]:<32} {r['CMP']:>8,.2f}  {ts} {'--':>5} {ms}  {sc}  {'--':>5}  {r1} {r3} {r6}  {r['Rating']}")

    if not skips.empty:
        print(f"\n  {'─'*40}  Skipped  {'─'*47}")
        for _, r in skips.iterrows():
            print(f"  {'--':<5} {r['Name'][:31]:<32} {r['CMP']:>8,.2f}  {r['Note']}")

    print(f"\n  Rating guide:  STRONG HOLD >= 70  |  HOLD 60-69  |  WATCH 50-59  |  WEAK 40-49  |  REVIEW < 40")
    print(f"  Momentum:      1M = last 21 days (20%) | 3M = 63 days (30%) | 6M = 126 days (50%)")
    print(f"  D/E skipped for financials: HDFC Bk, ICICI, SBI, CUB, Ujjivan, PFC, REC, HDFC AMC, Anand Rathi, MCX")
    print(SEP)

    # Save CSV beside the holdings file it scored, rather than in a fixed personal folder. In
    # --json mode the caller reads stdout and nothing is written at all.
    save_path = os.path.join(os.path.dirname(os.path.abspath(csv_path)) if csv_path else '.',
                             'portfolio_health_scores.csv')
    out_save  = pd.concat([stocks, etfs, skips], ignore_index=True)
    out_save.to_csv(save_path, index=False)
    print(f"\n  Saved to: {save_path}\n")


if __name__ == '__main__':
    path = sys.argv[1] if len(sys.argv) > 1 else CSV_PATH
    if not path:
        sys.exit('Pass the holdings CSV to score: portfolio_health.py <file.csv> [--json]')
    json_mode   = '--json' in sys.argv
    run(path, output_json=json_mode)
