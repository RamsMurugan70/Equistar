#!/usr/bin/env python
"""Fundamentals for one NSE symbol, as JSON on stdout.

Called by the Node backend (fundamentalsService). Uses yfinance because Yahoo's plain JSON
API now demands an auth crumb, while yfinance negotiates it internally — and this project
already depends on yfinance for the health scorer, so there is no new dependency.

WHAT IS DELIBERATELY NOT HERE: FII/DII holdings. Yahoo returns a single blended
`heldPercentInstitutions` for Indian stocks (0.55% for CUPID, with an empty holders table),
which is neither a foreign/domestic split nor trustworthy. Reporting it as "FII holding"
would be inventing a number. It is passed through clearly labelled instead, and the real
source — quarterly NSE/BSE shareholding filings — is a separate ingestion job.

    usage: python fetch_fundamentals.py SYMBOL
"""
import json
import sys
import warnings

warnings.filterwarnings('ignore')


def num(v):
    """None-safe float; yfinance mixes None, nan and numpy types."""
    try:
        if v is None:
            return None
        f = float(v)
        if f != f:            # NaN
            return None
        return f
    except (TypeError, ValueError):
        return None


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'symbol required'}))
        return
    symbol = sys.argv[1].upper()

    import yfinance as yf
    t = yf.Ticker(f'{symbol}.NS')

    try:
        info = t.info or {}
    except Exception as e:                                    # noqa: BLE001
        print(json.dumps({'error': f'info failed: {e}'}))
        return

    out = {
        'symbol': symbol,
        'sector': info.get('sector'),
        'industry': info.get('industry'),
        'marketCap': num(info.get('marketCap')),
        # Valuation
        'trailingPE': num(info.get('trailingPE')),
        'forwardPE': num(info.get('forwardPE')),
        'priceToBook': num(info.get('priceToBook')),
        'bookValue': num(info.get('bookValue')),
        'trailingEps': num(info.get('trailingEps')),
        # Profitability
        'returnOnEquity': num(info.get('returnOnEquity')),
        'returnOnAssets': num(info.get('returnOnAssets')),
        'profitMargins': num(info.get('profitMargins')),
        'operatingMargins': num(info.get('operatingMargins')),
        # Leverage / liquidity
        'debtToEquity': num(info.get('debtToEquity')),
        'currentRatio': num(info.get('currentRatio')),
        # Growth
        'revenueGrowth': num(info.get('revenueGrowth')),
        'earningsGrowth': num(info.get('earningsGrowth')),
        'earningsQuarterlyGrowth': num(info.get('earningsQuarterlyGrowth')),
        # UNIT TRAP: yfinance returns dividendYield ALREADY as a percentage (BEL 0.62 means
        # 0.62%, cross-checks against dividendRate 2.5 / price 410.5), while every other ratio
        # here — margins, ROE, growth — is a 0-1 fraction. Normalise to a fraction so the
        # consumer has exactly one convention; otherwise BEL renders as a 62% yield.
        'dividendYield': (lambda v: v / 100.0 if v is not None else None)(num(info.get('dividendYield'))),
        'dividendRate': num(info.get('dividendRate')),
        # Ownership — see the module docstring; blended and unreliable for Indian names.
        'heldPercentInstitutions': num(info.get('heldPercentInstitutions')),
        'heldPercentInsiders': num(info.get('heldPercentInsiders')),
    }

    # Quarterly trend — the most decision-useful part of this payload. A single "revenue
    # growth" number hides whether growth is accelerating or rolling over; five quarters of
    # revenue and EPS show the direction.
    quarters = []
    try:
        q = t.quarterly_income_stmt
        if q is not None and not q.empty:
            def row(*names):
                for n in names:
                    if n in q.index:
                        return q.loc[n]
                return None

            rev = row('Total Revenue', 'Operating Revenue')
            net = row('Net Income', 'Net Income Common Stockholders')
            eps = row('Diluted EPS', 'Basic EPS')
            opi = row('Operating Income')

            for i, col in enumerate(q.columns):
                quarters.append({
                    'period': str(col)[:10],
                    'revenue': num(rev.iloc[i]) if rev is not None else None,
                    'netIncome': num(net.iloc[i]) if net is not None else None,
                    'eps': num(eps.iloc[i]) if eps is not None else None,
                    'operatingIncome': num(opi.iloc[i]) if opi is not None else None,
                })
            # yfinance returns newest-first; oldest-first reads naturally as a trend.
            quarters.reverse()
    except Exception:                                          # noqa: BLE001
        pass

    out['quarters'] = [x for x in quarters if x['revenue'] is not None or x['eps'] is not None]
    print(json.dumps(out))


if __name__ == '__main__':
    main()
