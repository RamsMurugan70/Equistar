"""
ZTA Data Health  —  READ-ONLY diagnostic for the Options Recommendations page.

Opens both DuckDB files in read_only mode and prints a single JSON blob to stdout
describing (a) data freshness per source and (b) the expiry / DTE situation for
NIFTY and SENSEX so the UI can warn when 0DTE / 1DTE is the wrong choice for today.

This script NEVER writes to the databases and NEVER modifies the recommendation
or updater scripts. It only reads.

Output marker:  the JSON is printed after the line  HEALTH_JSON:
"""

import json
from datetime import date, datetime, timedelta

import duckdb

NSE_DB = r"D:\AI Projects\ZTA\Options_Data_Agent\options_history.duckdb"
BSE_DB = r"D:\AI Projects\ZTA\Options_Data_Agent\bse_options_history.duckdb"

# (label, db, sql)  — mirrors daily_updater.step7_staleness_summary checks,
# plus the directly-relevant raw option tables for each index.
CHECKS = [
    ("NIFTY options (nse_bhavcopy)", NSE_DB,
     "SELECT MAX(trade_date) FROM nse_bhavcopy WHERE symbol='NIFTY' AND instrument='OPTIDX'"),
    ("NIFTY spot + VIX",            NSE_DB, "SELECT MAX(date) FROM nifty_vix_master"),
    ("iv_percentile_daily",        NSE_DB, "SELECT MAX(date) FROM iv_percentile_daily"),
    ("iv_skew_daily",              NSE_DB, "SELECT MAX(trade_date) FROM iv_skew_daily"),
    ("nifty_futures_basis",        NSE_DB, "SELECT MAX(trade_date) FROM nifty_futures_basis"),
    ("morning_context_daily",      NSE_DB, "SELECT MAX(trade_date) FROM morning_context_daily"),
    ("global_signals_daily",       NSE_DB, "SELECT MAX(trade_date) FROM global_signals_daily"),
    ("zta_backtest_raw NIFTY",     NSE_DB, "SELECT MAX(trade_date) FROM zta_backtest_raw WHERE instrument='NIFTY'"),
    ("SENSEX bhavcopy",            BSE_DB, "SELECT MAX(trade_date) FROM bse_bhavcopy WHERE symbol='SENSEX'"),
    ("SENSEX clean options",       BSE_DB, "SELECT MAX(trade_date) FROM bse_sensex_options_clean"),
    ("SENSEX research view",       BSE_DB, "SELECT MAX(trade_date) FROM sensex_0_4dte_research"),
    ("sensex_pcr_daily",           NSE_DB, "SELECT MAX(trade_date) FROM sensex_pcr_daily"),
    ("sensex_otm_oi_profile",      NSE_DB, "SELECT MAX(trade_date) FROM sensex_otm_oi_profile"),
    ("zta_backtest_raw SENSEX",    NSE_DB, "SELECT MAX(trade_date) FROM zta_backtest_raw WHERE instrument='SENSEX'"),
]

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def status_for(days_old):
    if days_old is None:
        return "NO_DATA"
    if days_old > 5:
        return "STALE"
    if days_old > 2:
        return "WARN"
    return "OK"


def _as_date(v):
    if v is None:
        return None
    if isinstance(v, datetime):  # datetime is a subclass of date — check first
        return v.date()
    return v


def get_max(db, sql):
    try:
        con = duckdb.connect(db, read_only=True)
        val = con.execute(sql).fetchone()[0]
        con.close()
        return _as_date(val), None
    except Exception as e:  # missing table etc.
        return None, str(e).splitlines()[0][:160]


def trading_days_between(start, end):
    """Mon-Fri count from the day AFTER start through end (holidays not modelled)."""
    if end <= start:
        return 0
    n, cur = 0, start + timedelta(days=1)
    while cur <= end:
        if cur.weekday() < 5:
            n += 1
        cur += timedelta(days=1)
    return n


def expiry_weekday_from_data(db, table, where):
    """Infer the weekly-expiry weekday as the most common weekday among the
    listed expiries in the most recent snapshot. Returns (weekday_int, listed[])."""
    try:
        con = duckdb.connect(db, read_only=True)
        lt = con.execute(f"SELECT MAX(trade_date) FROM {table} WHERE {where}").fetchone()[0]
        rows = con.execute(
            f"SELECT DISTINCT expiry_date FROM {table} WHERE {where} AND trade_date=? "
            f"AND expiry_date>=? ORDER BY expiry_date LIMIT 8",
            [lt, lt],
        ).fetchall()
        con.close()
        lt = _as_date(lt)
        listed = [_as_date(r[0]) for r in rows if r[0] is not None]
        if not listed:
            return None, [], lt
        # most common weekday among the nearest listed weekly expiries
        counts = {}
        for d in listed:
            counts[d.weekday()] = counts.get(d.weekday(), 0) + 1
        wd = max(counts, key=counts.get)
        return wd, listed, lt
    except Exception:
        return None, [], None


def next_expiry_on_or_after(today, weekday, listed):
    """Prefer a real listed expiry >= today; else project forward by weekday."""
    future_listed = sorted(d for d in listed if d >= today)
    if future_listed:
        return future_listed[0], "listed"
    if weekday is None:
        return None, None
    delta = (weekday - today.weekday()) % 7
    return today + timedelta(days=delta), "projected"


def expiry_block(index, db, table, where):
    today = date.today()
    weekday, listed, opt_latest = expiry_weekday_from_data(db, table, where)
    nxt, source = next_expiry_on_or_after(today, weekday, listed)
    block = {
        "index": index,
        "today": today.isoformat(),
        "today_weekday": WEEKDAYS[today.weekday()],
        "market_open_today": today.weekday() < 5,
        "expiry_weekday": WEEKDAYS[weekday] if weekday is not None else None,
        "next_expiry": nxt.isoformat() if nxt else None,
        "next_expiry_weekday": WEEKDAYS[nxt.weekday()] if nxt else None,
        "next_expiry_source": source,
        "options_data_latest": opt_latest.isoformat() if opt_latest else None,
        "options_data_days_old": (today - opt_latest).days if opt_latest else None,
    }
    if nxt:
        cal = (nxt - today).days
        tdte = trading_days_between(today, nxt)
        block["calendar_dte"] = cal
        block["trading_dte"] = tdte
        block["is_0dte_today"] = (nxt == today)
        block["is_1dte_today"] = (tdte == 1)
        if nxt == today:
            block["verdict"] = "0DTE"
        elif tdte == 1:
            block["verdict"] = "1DTE"
        else:
            block["verdict"] = f"{tdte}DTE"
    return block


def main():
    today = date.today()
    sources, gaps = [], []
    for name, db, sql in CHECKS:
        val, err = get_max(db, sql)
        days_old = (today - val).days if val else None
        st = "ERROR" if err else status_for(days_old)
        rec = {
            "name": name,
            "latest": val.isoformat() if val else None,
            "days_old": days_old,
            "status": st,
            "error": err,
        }
        sources.append(rec)
        if st in ("STALE", "NO_DATA", "WARN", "ERROR"):
            gaps.append(rec)

    out = {
        "checked_at": datetime.now().isoformat(),
        "today": today.isoformat(),
        "today_weekday": WEEKDAYS[today.weekday()],
        "market_open_today": today.weekday() < 5,
        "all_fresh": len(gaps) == 0,
        "gap_count": len(gaps),
        "sources": sources,
        "gaps": gaps,
        "expiry": {
            "NIFTY": expiry_block(
                "NIFTY", NSE_DB, "nse_bhavcopy",
                "symbol='NIFTY' AND instrument='OPTIDX'"),
            "SENSEX": expiry_block(
                "SENSEX", BSE_DB, "bse_bhavcopy", "symbol='SENSEX'"),
        },
    }
    print("HEALTH_JSON:")
    print(json.dumps(out))


if __name__ == "__main__":
    main()
