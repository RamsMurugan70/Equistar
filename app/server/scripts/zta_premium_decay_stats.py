#!/usr/bin/env python3
"""
ZTA Premium-Decay Stats  —  READ-ONLY historical backtest aggregation.

For each (index, days-to-expiry 0/1, option side, OTM% bucket) it computes the
percentage of historical instances where the option premium FELL — i.e. a sell
in the morning / buy-back in the afternoon would have been profitable (decay).

Two data sources, merged per bucket (true preferred, proxy fills the gaps):
  • real_10am_3pm   — NIFTY true 10 AM -> 3 PM intraday  (zta_intraday_backtest_real)
                      buckets 1.0/1.5/2.0 only.
  • open_close_proxy— daily OPEN -> CLOSE, nearest strike to each OTM% bucket:
                      NIFTY : clean_nifty_options + nifty_vix_master (spot_open)
                      SENSEX: bse_sensex_options_clean (cleaned close + underlying)
                      covers 1.0/2.0/3.0/4.0 (SENSEX has no true intraday data).

Each emitted bucket carries its own "source" so the UI can label proxy values.
Output: one JSON line to stdout after the marker  DECAY_JSON:
This script NEVER writes to the databases.
"""
import json
from datetime import datetime

import duckdb

NSE_DB = r"D:\AI Projects\ZTA\Options_Data_Agent\options_history.duckdb"
BSE_DB = r"D:\AI Projects\ZTA\Options_Data_Agent\bse_options_history.duckdb"

PROXY_BUCKETS = "(VALUES (1.0),(2.0),(3.0),(4.0)) AS x(pct)"

# Only count days where the option was actually sellable for a meaningful premium.
# Deep-OTM options that open at the exchange floor (~₹0.05) and stay there are
# break-even, not decay, and distort the far-OTM hit-rate downward. ₹0.50 floor.
MIN_ENTRY = 0.5


def _key(v):
    return f"{float(v):.1f}"


def _rows_to_dict(rows, source, with_stops=False):
    d = {}
    for row in rows:
        if with_stops:
            dte, otype, otm, n, pct, med_open, med_close, stop_2x, stop_3x = row
        else:
            dte, otype, otm, n, pct, med_open, med_close = row
            stop_2x = stop_3x = None
        cell = {
            "pct": pct, "n": int(n), "source": source,
            # Median (typical day) — robust to the rare premium-spike days that
            # distort the mean and make it disagree with the decay hit-rate.
            "med_open":  round(float(med_open), 2)  if med_open  is not None else None,
            "med_close": round(float(med_close), 2) if med_close is not None else None,
        }
        if with_stops:
            # % of days the intraday high breached a 2x / 3x stop-loss vs entry.
            cell["stop_2x"] = stop_2x
            cell["stop_3x"] = stop_3x
        d.setdefault(str(int(dte)), {}).setdefault(otype, {})[_key(otm)] = cell
    return d


def _merge(true_d, proxy_d):
    """Per dte/side/bucket: prefer the true decay/median, fall back to proxy.
    Stop-breach rates always come from the proxy (the true table has no high)."""
    out = {}
    for dte in set(list(true_d) + list(proxy_d)):
        for side in ("CE", "PE"):
            tb = true_d.get(dte, {}).get(side, {})
            pb = proxy_d.get(dte, {}).get(side, {})
            merged = {}
            for bucket in set(list(tb) + list(pb)):
                p = pb.get(bucket)
                t = tb.get(bucket)
                cell = dict(t) if t else dict(p) if p else None
                if cell is None:
                    continue
                if p:   # stop-breach is open→high, only available from the proxy
                    cell["stop_2x"] = p.get("stop_2x")
                    cell["stop_3x"] = p.get("stop_3x")
                merged[bucket] = cell
            if merged:
                out.setdefault(dte, {})[side] = merged
    return out


def nifty_true(con):
    rows = con.execute(f"""
        SELECT trading_dte, option_type, otm_pct, COUNT(*) AS n,
               ROUND(100.0 * SUM(CASE WHEN exit_prem < entry_prem THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct,
               MEDIAN(entry_prem) AS med_open, MEDIAN(exit_prem) AS med_close
        FROM zta_intraday_backtest_real
        WHERE instrument = 'NIFTY' AND trading_dte IN (0, 1)
          AND entry_prem >= {MIN_ENTRY} AND exit_prem IS NOT NULL
        GROUP BY trading_dte, option_type, otm_pct
    """).fetchall()
    rng = con.execute("SELECT MIN(trade_date), MAX(trade_date) FROM zta_intraday_backtest_real WHERE instrument='NIFTY'").fetchone()
    return _rows_to_dict(rows, "real_10am_3pm"), [str(rng[0]), str(rng[1])]


def nifty_proxy(con):
    rows = con.execute(f"""
        WITH base AS (
          SELECT o.trade_date, o.option_type, o.dte, o.strike_price AS strike,
                 o.open_price, o.close_price, o.high_price, m.spot_open AS spot
          FROM clean_nifty_options o
          JOIN nifty_vix_master m ON m.date = o.trade_date
          WHERE o.dte IN (0, 1) AND o.option_type IN ('CE', 'PE')
            AND o.open_price >= {MIN_ENTRY} AND o.close_price IS NOT NULL AND m.spot_open > 0
        ),
        expanded AS (
          SELECT b.*, x.pct,
                 CASE WHEN b.option_type = 'CE' THEN b.spot * (1 + x.pct / 100)
                      ELSE b.spot * (1 - x.pct / 100) END AS target
          FROM base b CROSS JOIN {PROXY_BUCKETS}
        ),
        ranked AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY trade_date, option_type, dte, pct
                                       ORDER BY abs(strike - target)) AS rn
          FROM expanded
        )
        SELECT dte, option_type, pct, COUNT(*) AS n,
               ROUND(100.0 * SUM(CASE WHEN close_price < open_price THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_decay,
               MEDIAN(open_price) AS med_open, MEDIAN(close_price) AS med_close,
               ROUND(100.0 * SUM(CASE WHEN high_price >= 2 * open_price THEN 1 ELSE 0 END) / COUNT(*), 1) AS stop_2x,
               ROUND(100.0 * SUM(CASE WHEN high_price >= 3 * open_price THEN 1 ELSE 0 END) / COUNT(*), 1) AS stop_3x
        FROM ranked WHERE rn = 1
        GROUP BY dte, option_type, pct
    """).fetchall()
    rng = con.execute("SELECT MIN(trade_date), MAX(trade_date) FROM clean_nifty_options WHERE dte IN (0,1)").fetchone()
    return _rows_to_dict(rows, "open_close_proxy", with_stops=True), [str(rng[0]), str(rng[1])]


def sensex_proxy(con):
    rows = con.execute(f"""
        WITH base AS (
          SELECT trade_date, option_type, dte, strike,
                 open_price, option_close, high_price, underlying_price AS spot
          FROM bse_sensex_options_clean
          WHERE symbol = 'SENSEX' AND dte IN (0, 1) AND option_type IN ('CE', 'PE')
            AND is_valid_close AND open_price >= {MIN_ENTRY} AND option_close IS NOT NULL AND underlying_price > 0
        ),
        expanded AS (
          SELECT b.*, x.pct,
                 CASE WHEN b.option_type = 'CE' THEN b.spot * (1 + x.pct / 100)
                      ELSE b.spot * (1 - x.pct / 100) END AS target
          FROM base b CROSS JOIN {PROXY_BUCKETS}
        ),
        ranked AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY trade_date, option_type, dte, pct
                                       ORDER BY abs(strike - target)) AS rn
          FROM expanded
        )
        SELECT dte, option_type, pct, COUNT(*) AS n,
               ROUND(100.0 * SUM(CASE WHEN option_close < open_price THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_decay,
               MEDIAN(open_price) AS med_open, MEDIAN(option_close) AS med_close,
               ROUND(100.0 * SUM(CASE WHEN high_price >= 2 * open_price THEN 1 ELSE 0 END) / COUNT(*), 1) AS stop_2x,
               ROUND(100.0 * SUM(CASE WHEN high_price >= 3 * open_price THEN 1 ELSE 0 END) / COUNT(*), 1) AS stop_3x
        FROM ranked WHERE rn = 1
        GROUP BY dte, option_type, pct
    """).fetchall()
    rng = con.execute("""SELECT MIN(trade_date), MAX(trade_date) FROM bse_sensex_options_clean
                         WHERE symbol='SENSEX' AND dte IN (0,1) AND is_valid_close""").fetchone()
    return _rows_to_dict(rows, "open_close_proxy", with_stops=True), [str(rng[0]), str(rng[1])]


def main():
    out = {"ok": False, "computed_at": datetime.now().isoformat()}

    # NIFTY: true intraday + open→close proxy, merged.
    try:
        con = duckdb.connect(NSE_DB, read_only=True)
        t, t_rng = nifty_true(con)
        p, p_rng = nifty_proxy(con)
        con.close()
        block = _merge(t, p)
        block["true_range"]  = t_rng
        block["proxy_range"] = p_rng
        out["NIFTY"] = block
    except Exception as e:
        out["NIFTY"] = {"error": str(e).splitlines()[0][:160]}

    # SENSEX: proxy only (no true intraday data exists).
    try:
        con = duckdb.connect(BSE_DB, read_only=True)
        p, p_rng = sensex_proxy(con)
        con.close()
        block = _merge({}, p)
        block["proxy_range"] = p_rng
        out["SENSEX"] = block
    except Exception as e:
        out["SENSEX"] = {"error": str(e).splitlines()[0][:160]}

    out["ok"] = True
    print("DECAY_JSON:")
    print(json.dumps(out))


if __name__ == "__main__":
    main()
