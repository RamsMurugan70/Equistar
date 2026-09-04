#!/usr/bin/env python
"""Quarterly shareholding pattern for one NSE symbol, as JSON on stdout.

Source: the company's own SEBI LODR Reg 31 filing, published by NSE. Two steps —

  1. https://www.nseindia.com/api/corporate-share-holdings-master?index=equities&symbol=X
     returns every filing with headline promoter/public percentages AND a link to the
     full XBRL instance document for each quarter.
  2. That XBRL carries the real category breakdown: foreign institutions (FII),
     domestic institutions (DII) and the DII sub-categories.

WHY XBRL AND NOT THE HEADLINE JSON: the master JSON only splits promoter vs public. "Public"
lumps FII, DII and retail into one number, which cannot answer "is FII holding rising?". The
dimensioned XBRL facts separate them exactly.

CADENCE — THE THING TO UNDERSTAND: shareholding is filed QUARTERLY, within 21 days of quarter
end. There is no continuous series, so "change over 3 months" means one quarter's change and
"6 months" means two. A comparison is only meaningful between quarter-END filings, so interim
filings (made after a capital change, e.g. 08-APR-2025) are excluded from the series — mixing
them in would compare a stub period against a full quarter.

Percentages in the XBRL are FRACTIONS (0.5114 = 51.14%); they are returned as percentages here.

    usage: python fetch_shareholding.py SYMBOL [max_quarters]
"""
import json
import re
import sys
import xml.etree.ElementTree as ET

BASE = 'https://www.nseindia.com'
MASTER = BASE + '/api/corporate-share-holdings-master?index=equities&symbol={}'

# XBRL dimension members -> the categories we report.
MEMBERS = {
    'ShareholdingOfPromoterAndPromoterGroupMember': 'promoter',
    'PublicShareholdingMember': 'public',
    'InstitutionsForeignMember': 'fii',
    'InstitutionsDomesticMember': 'dii',
    'MutualFundsOrUTIMember': 'mutualFunds',
    'InsuranceCompaniesMember': 'insurance',
    'BanksMember': 'banks',
    'NonInstitutionsMember': 'nonInstitutions',
}

MONTHS = {'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
          'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12}


def to_iso(d):
    """'30-JUN-2026' -> '2026-06-30'."""
    try:
        dd, mon, yy = d.strip().split('-')
        return f'{int(yy):04d}-{MONTHS[mon.upper()[:3]]:02d}-{int(dd):02d}'
    except Exception:                                          # noqa: BLE001
        return None


def is_quarter_end(iso):
    """Only 31-Mar / 30-Jun / 30-Sep / 31-Dec filings form a comparable series."""
    return iso in [f'{iso[:4]}-03-31', f'{iso[:4]}-06-30', f'{iso[:4]}-09-30', f'{iso[:4]}-12-31']


def session():
    import requests
    s = requests.Session()
    s.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': BASE + '/'})
    # NSE requires a cookie handshake before its API will answer; hitting the home page and
    # the relevant section page sets them.
    s.get(BASE + '/', timeout=15)
    s.get(BASE + '/companies-listing/corporate-filings-shareholding-pattern', timeout=15)
    return s


def local(tag):
    return tag.split('}')[-1]


def parse_xbrl(text):
    """Pull percentage facts out of an XBRL instance, keyed by dimension member."""
    root = ET.fromstring(text)

    # contextRef -> the explicit dimension members that context carries
    ctx = {}
    for c in root.iter():
        if local(c.tag) == 'context':
            members = [(e.text or '').split(':')[-1] for e in c.iter()
                       if local(e.tag) == 'explicitMember']
            ctx[c.get('id')] = members

    pct_tag = re.compile(r'ShareholdingAsAPercentage', re.I)
    out = {}
    for e in root.iter():
        name = local(e.tag)
        ref = e.get('contextRef')
        if not ref or not pct_tag.search(name):
            continue
        val = (e.text or '').strip()
        if not val:
            continue
        for m in ctx.get(ref, []):
            key = MEMBERS.get(m)
            # First fact wins: the same percentage is reported under several tags (e.g. also
            # "assuming full conversion of convertibles"); they agree, so don't overwrite.
            if key and key not in out:
                try:
                    out[key] = round(float(val) * 100, 4)
                except ValueError:
                    pass
    return out


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'symbol required'}))
        return
    symbol = sys.argv[1].upper()
    max_q = int(sys.argv[2]) if len(sys.argv) > 2 else 3      # current + 3M back + 6M back

    try:
        s = session()
        rows = s.get(MASTER.format(symbol), timeout=20).json()
    except Exception as e:                                     # noqa: BLE001
        print(json.dumps({'symbol': symbol, 'error': f'master fetch failed: {e}'}))
        return

    if not isinstance(rows, list) or not rows:
        print(json.dumps({'symbol': symbol, 'error': 'no shareholding filings listed'}))
        return

    # Newest first, quarter-ends only, one filing per quarter (the first is the latest
    # submission for that quarter, so revisions supersede the original).
    seen = set()
    picked = []
    for r in rows:
        iso = to_iso(r.get('date') or '')
        if not iso or not is_quarter_end(iso) or iso in seen:
            continue
        seen.add(iso)
        picked.append((iso, r))
        if len(picked) >= max_q:
            break

    quarters = []
    for iso, r in picked:
        entry = {
            'quarter': iso,
            'filedOn': to_iso(r.get('submissionDate') or '') or None,
            # Headline numbers are present even when the XBRL is missing or unparseable.
            'promoter': safe_float(r.get('pr_and_prgrp')),
            'public': safe_float(r.get('public_val')),
        }
        url = r.get('xbrl')
        if url:
            try:
                x = parse_xbrl(s.get(url, timeout=25).text)
                # XBRL wins for promoter/public too — same filing, more precision.
                for k, v in x.items():
                    entry[k] = v
                entry['detail'] = True
            except Exception:                                  # noqa: BLE001
                entry['detail'] = False
        else:
            entry['detail'] = False
        quarters.append(entry)

    quarters.reverse()          # oldest -> newest, so it reads as a trend
    print(json.dumps({'symbol': symbol, 'quarters': quarters}))


def safe_float(v):
    try:
        return round(float(v), 4)
    except (TypeError, ValueError):
        return None


if __name__ == '__main__':
    main()
