"""
Small / Mid / Micro-Cap Daily Scanner
======================================
Same design as nifty500_scanner.py (same scoring functions from
portfolio_health.py), parameterized by --universe so one script covers all
three NSE cap-size indices that sit outside the Nifty 500:

    --universe midcap     -> Nifty Midcap 150   (~150 stocks)
    --universe smallcap   -> Nifty Smallcap 250  (~250 stocks)
    --universe microcap   -> Nifty Microcap 250  (~250 stocks)

Usage:
    python capscanner.py --universe smallcap --json
    python capscanner.py --universe smallcap --json --refresh-fundamentals
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

BASE = os.path.dirname(os.path.abspath(__file__))
BATCH_SIZE    = 50      # tickers per yfinance batch download
FUND_THROTTLE = 1.2     # seconds between fundamental fetches (rate-limit safety)

UNIVERSES = {
    "midcap": {
        "label": "Nifty Midcap 150",
        "constituents_file": os.path.join(BASE, "nifty_midcap150_constituents.csv"),
        "fund_cache_file":   os.path.join(BASE, "fund_cache_midcap150.json"),
        "constit_url":       "https://niftyindices.com/IndexConstituent/ind_niftymidcap150list.csv",
    },
    "smallcap": {
        "label": "Nifty Smallcap 250",
        "constituents_file": os.path.join(BASE, "nifty_smallcap250_constituents.csv"),
        "fund_cache_file":   os.path.join(BASE, "fund_cache_smallcap250.json"),
        "constit_url":       "https://niftyindices.com/IndexConstituent/ind_niftysmallcap250list.csv",
    },
    "microcap": {
        "label": "Nifty Microcap 250",
        "constituents_file": os.path.join(BASE, "nifty_microcap250_constituents.csv"),
        "fund_cache_file":   os.path.join(BASE, "fund_cache_microcap250.json"),
        "constit_url":       "https://niftyindices.com/IndexConstituent/ind_niftymicrocap250_list.csv",
    },
}


def log(msg, json_mode=False):
    if json_mode:
        print(msg, file=sys.stderr, flush=True)
    else:
        print(msg, flush=True)


# ── Constituents ──────────────────────────────────────────────────────────────
def load_constituents(cfg, json_mode):
    """Load the index constituent list; refresh from NSE if file is older than 7 days."""
    path = cfg["constituents_file"]
    need_fetch = True
    if os.path.exists(path):
        age_days = (time.time() - os.path.getmtime(path)) / 86400
        need_fetch = age_days > 7
    if need_fetch:
        try:
            import requests
            r = requests.get(cfg["constit_url"], timeout=30,
                             headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
            if r.ok and b"Symbol" in r.content[:200]:
                with open(path, "wb") as f:
                    f.write(r.content)
                log(f"Constituents list refreshed from NSE ({cfg['label']}).", json_mode)
        except Exception as e:
            log(f"Constituents refresh failed ({e}) — using cached file.", json_mode)
    df = pd.read_csv(path)
    df = df.rename(columns={c: c.strip() for c in df.columns})
    df = df[["Company Name", "Industry", "Symbol"]].dropna(subset=["Symbol"])
    return df[~df["Symbol"].str.upper().str.startswith("DUMMY")]


# ── Fundamentals cache ────────────────────────────────────────────────────────
def load_fund_cache(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_fund_cache(path, cache):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(cache, f)
    except Exception:
        pass


def refresh_fundamentals(symbols, cache, cache_path, max_age_days, force, json_mode):
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
            save_fund_cache(cache_path, cache)
            log(f"  ... {done}/{len(stale)}", json_mode)
        time.sleep(FUND_THROTTLE)
    save_fund_cache(cache_path, cache)
    log(f"Fundamentals refreshed: {done}.", json_mode)
    return cache, done


# ── Price history (batched) ───────────────────────────────────────────────────
def download_prices(symbols, json_mode):
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
        time.sleep(0.8)
    return out


# ── Main scan ─────────────────────────────────────────────────────────────────
def run(args):
    json_mode = args.json
    cfg = UNIVERSES[args.universe]
    cons = load_constituents(cfg, json_mode)
    symbols = cons["Symbol"].tolist()
    names = dict(zip(cons["Symbol"], cons["Company Name"]))
    industries = dict(zip(cons["Symbol"], cons["Industry"]))
    log(f"{cfg['label']} scan — {len(symbols)} constituents", json_mode)

    cache = load_fund_cache(cfg["fund_cache_file"])
    cache, refreshed = refresh_fundamentals(
        symbols, cache, cfg["fund_cache_file"], args.max_fund_age_days, args.refresh_fundamentals, json_mode)
    fund_asof_vals = [v.get("asof") for v in cache.values() if v.get("asof")]
    fund_asof = max(fund_asof_vals) if fund_asof_vals else None
    fund_coverage = sum(1 for s in symbols if cache.get(s, {}).get("f") is not None)

    hists = download_prices(symbols, json_mode)
    log(f"Price history loaded for {len(hists)} stocks.", json_mode)

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
        "universe": args.universe,
        "scanDate": date.today().isoformat(),
        "generatedAt": datetime.now().isoformat(),
        "universeSize": len(symbols),
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
                     key=lambda r: -r["Score"])[:25]
        print(f"\n{cfg['label']} — Top 25 (score, trend-filtered) — fundamentals as of {fund_asof}:")
        for i, r in enumerate(top, 1):
            print(f"  {i:>2}. {r['Symbol']:<12} {str(r['Name'])[:32]:<32} {r['Score']:>5}  {r['EmaLadder']}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--universe", required=True, choices=list(UNIVERSES.keys()))
    p.add_argument("--json", action="store_true", help="emit JSON for app integration")
    p.add_argument("--refresh-fundamentals", action="store_true", help="force full fundamentals crawl")
    p.add_argument("--max-fund-age-days", type=int, default=7)
    run(p.parse_args())
