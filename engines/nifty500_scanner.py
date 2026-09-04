"""
NIFTY 500 Daily Scanner
=======================
Scores every NIFTY 500 stock with the SAME functions as portfolio_health.py
(technical / fundamental / momentum + EMA trend ladder) and emits JSON for the
ZTA app's "Daily Top 20" panel.

Design:
  • Prices  : batch-downloaded daily via yfinance (fast, ~5 min for 500).
  • Fundamentals: slow + rate-limited, so cached in fund_cache_nifty500.json
    and refreshed only when older than --max-fund-age-days (default 7).
    The crawl is throttled and resumable (cache saved as it goes).
  • Output  : JSON after the marker  SCAN_JSON:

Usage:
    python nifty500_scanner.py --json                     # normal daily run
    python nifty500_scanner.py --json --refresh-fundamentals   # force full crawl
"""

import sys, os, json, time, argparse, warnings
from datetime import datetime, date

warnings.filterwarnings("ignore")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import pandas as pd
import numpy as np
import yfinance as yf

import portfolio_health as ph   # reuse the EXACT scoring functions

BASE          = os.path.dirname(os.path.abspath(__file__))
CONSTITUENTS  = os.path.join(BASE, "nifty500_constituents.csv")
FUND_CACHE    = os.path.join(BASE, "fund_cache_nifty500.json")
CONSTIT_URL   = "https://niftyindices.com/IndexConstituent/ind_nifty500list.csv"
BATCH_SIZE    = 50      # tickers per yfinance batch download
FUND_THROTTLE = 1.2     # seconds between fundamental fetches (rate-limit safety)


def log(msg, json_mode=False):
    if json_mode:
        # In --json mode stdout must stay clean for SCAN_JSON; progress → stderr
        print(msg, file=sys.stderr, flush=True)
    else:
        print(msg, flush=True)


# ── Constituents ──────────────────────────────────────────────────────────────
def load_constituents(json_mode):
    """Load the NIFTY 500 list; refresh from NSE if file is older than 7 days."""
    need_fetch = True
    if os.path.exists(CONSTITUENTS):
        age_days = (time.time() - os.path.getmtime(CONSTITUENTS)) / 86400
        need_fetch = age_days > 7
    if need_fetch:
        try:
            import requests
            r = requests.get(CONSTIT_URL, timeout=30,
                             headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
            if r.ok and b"Symbol" in r.content[:200]:
                with open(CONSTITUENTS, "wb") as f:
                    f.write(r.content)
                log("Constituents list refreshed from NSE.", json_mode)
        except Exception as e:
            log(f"Constituents refresh failed ({e}) — using cached file.", json_mode)
    df = pd.read_csv(CONSTITUENTS)
    df = df.rename(columns={c: c.strip() for c in df.columns})
    df = df[["Company Name", "Industry", "Symbol"]].dropna(subset=["Symbol"])
    # NSE keeps placeholder rows (e.g. DUMMYVEDL1) for pending index changes — skip.
    return df[~df["Symbol"].str.upper().str.startswith("DUMMY")]


# ── Fundamentals cache ────────────────────────────────────────────────────────
def load_fund_cache():
    try:
        with open(FUND_CACHE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_fund_cache(cache):
    try:
        with open(FUND_CACHE, "w", encoding="utf-8") as f:
            json.dump(cache, f)
    except Exception:
        pass


def refresh_fundamentals(symbols, cache, max_age_days, force, json_mode):
    """Fetch fundamental scores for symbols whose cache entry is stale/missing.
    Throttled and resumable — cache is persisted every 20 stocks."""
    today = date.today().isoformat()
    stale = []
    for sym in symbols:
        ent = cache.get(sym)
        if force or not ent:
            stale.append(sym)
            continue
        try:
            age = (date.today() - date.fromisoformat(ent.get("asof", "2000-01-01"))).days
        except Exception:
            age = 9999
        if age > max_age_days:
            stale.append(sym)

    if not stale:
        log("Fundamentals cache fresh — no crawl needed.", json_mode)
        return cache, 0

    log(f"Refreshing fundamentals for {len(stale)} stocks (throttled, ~{len(stale)*FUND_THROTTLE/60:.0f}+ min)...", json_mode)
    done = 0
    for sym in stale:
        try:
            t = yf.Ticker(f"{sym}.NS")
            f_score = ph.fundamental_score(t, sym)
        except Exception:
            f_score = None
        cache[sym] = {"f": f_score, "asof": today}
        done += 1
        if done % 20 == 0:
            save_fund_cache(cache)
            log(f"  ... {done}/{len(stale)}", json_mode)
        time.sleep(FUND_THROTTLE)
    save_fund_cache(cache)
    log(f"Fundamentals refreshed: {done}.", json_mode)
    return cache, done


# ── Price history (batched) ───────────────────────────────────────────────────
def download_prices(symbols, json_mode):
    """Batch-download 1y daily history for all symbols. Returns {sym: DataFrame}."""
    out = {}
    for i in range(0, len(symbols), BATCH_SIZE):
        chunk = symbols[i:i + BATCH_SIZE]
        tickers = [f"{s}.NS" for s in chunk]
        try:
            data = yf.download(tickers, period="1y", interval="1d", group_by="ticker",
                               auto_adjust=True, progress=False, threads=True)
        except Exception as e:
            log(f"  batch {i//BATCH_SIZE+1} failed: {e}", json_mode)
            continue
        for sym in chunk:
            tk = f"{sym}.NS"
            try:
                df = data[tk].dropna(subset=["Close"]) if isinstance(data.columns, pd.MultiIndex) else data.dropna(subset=["Close"])
                if len(df) >= 30:
                    out[sym] = df
            except Exception:
                continue
        log(f"  prices {min(i+BATCH_SIZE,len(symbols))}/{len(symbols)}", json_mode)
        time.sleep(0.8)   # be polite between batches
    return out


# ── Main scan ─────────────────────────────────────────────────────────────────
def run(args):
    json_mode = args.json
    cons = load_constituents(json_mode)
    symbols = cons["Symbol"].tolist()
    names = dict(zip(cons["Symbol"], cons["Company Name"]))
    industries = dict(zip(cons["Symbol"], cons["Industry"]))
    log(f"NIFTY 500 scan — {len(symbols)} constituents", json_mode)

    # 1) Fundamentals (cached weekly)
    cache = load_fund_cache()
    cache, refreshed = refresh_fundamentals(
        symbols, cache, args.max_fund_age_days, args.refresh_fundamentals, json_mode)
    fund_asof_vals = [v.get("asof") for v in cache.values() if v.get("asof")]
    fund_asof = max(fund_asof_vals) if fund_asof_vals else None
    fund_coverage = sum(1 for s in symbols if cache.get(s, {}).get("f") is not None)

    # 2) Prices (batched daily)
    hists = download_prices(symbols, json_mode)
    log(f"Price history loaded for {len(hists)} stocks.", json_mode)

    # 3) Score
    rows = []
    for sym, hist in hists.items():
        try:
            t_result = ph.technical_score(hist)
            t_score, rsi_val = (t_result if t_result else (None, None))
            m_score, r1m, r3m, r6m = ph.momentum_score(hist)
            ladder, slope = ph.ema_trend(hist)
            f_score = cache.get(sym, {}).get("f")
            valid = [s for s in [t_score, f_score, m_score] if s is not None]
            health = round(float(np.mean(valid)), 1) if valid else None
            close = hist["Close"].squeeze()
            # 1-week return: latest close vs 5 trading days ago
            r1w = None
            if len(close) > 5 and close.iloc[-6] > 0:
                r1w = (close.iloc[-1] / close.iloc[-6] - 1) * 100
            rows.append(dict(
                Symbol=sym, Name=names.get(sym, sym), Industry=industries.get(sym, ""),
                CMP=round(float(close.iloc[-1]), 2),
                Tech=t_score, Fund=f_score, Mom=m_score, Score=health,
                RSI=rsi_val,
                R1W=round(r1w, 1) if r1w is not None else None,
                R1M=round(r1m, 1) if r1m is not None else None,
                R3M=round(r3m, 1) if r3m is not None else None,
                R6M=round(r6m, 1) if r6m is not None else None,
                EmaLadder=ladder, Ema50Slope=slope,
                Components=len(valid),
            ))
        except Exception:
            continue

    result = {
        "scanDate": date.today().isoformat(),
        "generatedAt": datetime.now().isoformat(),
        "universe": len(symbols),
        "scored": len(rows),
        "fundamentalsAsOf": fund_asof,
        "fundamentalsCoverage": fund_coverage,
        "fundamentalsRefreshed": refreshed,
        "rows": rows,
    }
    if json_mode:
        print("SCAN_JSON:")
        print(json.dumps(result, default=str))
    else:
        top = sorted([r for r in rows if r["Score"] is not None and r["EmaLadder"] in ("STRONG_UPTREND", "PULLBACK")],
                     key=lambda r: -r["Score"])[:20]
        print(f"\nTop 20 (score, trend-filtered) — fundamentals as of {fund_asof}:")
        for i, r in enumerate(top, 1):
            print(f"  {i:>2}. {r['Symbol']:<12} {str(r['Name'])[:32]:<32} {r['Score']:>5}  {r['EmaLadder']}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--json", action="store_true", help="emit JSON for app integration")
    p.add_argument("--refresh-fundamentals", action="store_true", help="force full fundamentals crawl")
    p.add_argument("--max-fund-age-days", type=int, default=7)
    run(p.parse_args())
