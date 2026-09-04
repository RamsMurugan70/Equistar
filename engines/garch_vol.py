"""GARCH(1,1) conditional volatility for a single stock, now and at 1/3/6 months ago.

WHY GARCH RATHER THAN A ROLLING STANDARD DEVIATION
A trailing 30-day sigma treats a shock 30 days ago and one yesterday as equally informative,
then drops the old one off a cliff. GARCH weights recent shocks more heavily and decays them
smoothly, which is why the number moves when the stock's behaviour actually changes rather than
when a big day rolls out of an arbitrary window.

    sigma2_t = omega + alpha * eps2_{t-1} + beta * sigma2_{t-1}

Fitted by maximum likelihood under a normal innovation assumption. Returns are scaled by 100
(percent) purely for numerical conditioning - a daily log return of 0.012 squares to 1.4e-4,
small enough that the optimiser struggles to separate omega from zero.

ONE FIT, READ AT FOUR DATES - not four fits.
The 1/3/6-month figures come from the SAME fitted model, reading its conditional variance on
those dates. Refitting on truncated history instead would mix genuine volatility movement with
parameter-estimation noise, so a "change" could be nothing more than omega landing differently
on a shorter sample. One parameter set means the change is the volatility moving, which is the
question being asked.

HONEST FAILURE. If the optimiser does not converge, or the fit is not stationary
(alpha + beta >= 1, which means shocks never decay and the unconditional variance is
undefined), no number is returned for that stock rather than a plausible-looking one.
"""
import json
import math
import sys

import numpy as np
from scipy.optimize import minimize

TRADING_DAYS = 252
MIN_OBS = 250          # a year of daily data; below this the fit is not worth reporting


def fit_garch11(r):
    """MLE fit of GARCH(1,1). r is a 1-D array of returns in PERCENT."""
    r = np.asarray(r, dtype=float)
    r = r - r.mean()
    n = len(r)
    var0 = float(np.var(r))
    if not np.isfinite(var0) or var0 <= 0:
        return None

    def neg_llh(params):
        omega, alpha, beta = params
        if omega <= 0 or alpha < 0 or beta < 0 or alpha + beta >= 0.999:
            return 1e10
        s2 = np.empty(n)
        s2[0] = var0
        for t in range(1, n):
            s2[t] = omega + alpha * r[t - 1] ** 2 + beta * s2[t - 1]
            if s2[t] <= 0:
                return 1e10
        return 0.5 * np.sum(np.log(s2) + r ** 2 / s2)

    best = None
    # Several starts: the likelihood is flat in places and a single start can settle on a
    # corner (alpha ~ 0) that fits badly but looks converged.
    for a0, b0 in ((0.10, 0.85), (0.05, 0.90), (0.15, 0.75), (0.20, 0.60)):
        w0 = max(var0 * (1 - a0 - b0), 1e-8)
        try:
            res = minimize(neg_llh, [w0, a0, b0], method='Nelder-Mead',
                           options={'maxiter': 4000, 'xatol': 1e-9, 'fatol': 1e-9})
        except Exception:
            continue
        if res.success and res.fun < 1e9 and (best is None or res.fun < best.fun):
            best = res
    if best is None:
        return None

    omega, alpha, beta = best.x
    if omega <= 0 or alpha < 0 or beta < 0 or alpha + beta >= 0.999:
        return None

    s2 = np.empty(n)
    s2[0] = var0
    for t in range(1, n):
        s2[t] = omega + alpha * r[t - 1] ** 2 + beta * s2[t - 1]
    return {'omega': omega, 'alpha': alpha, 'beta': beta, 'sigma2': s2,
            'persistence': alpha + beta, 'llh': -best.fun}


def annualised(sigma2):
    """Daily variance (percent^2) -> annualised volatility in percent."""
    return float(math.sqrt(sigma2) * math.sqrt(TRADING_DAYS))


def main():
    payload = json.loads(sys.stdin.read())
    closes = [float(c) for c in payload['closes'] if c is not None]
    dates = payload.get('dates') or []
    if len(closes) < MIN_OBS + 1:
        print(json.dumps({'ok': False, 'reason':
              'needs %d daily closes, got %d' % (MIN_OBS + 1, len(closes))}))
        return

    px = np.asarray(closes, dtype=float)
    ret = 100.0 * np.diff(np.log(px))
    ok = np.isfinite(ret)
    ret = ret[ok]
    rdates = [dates[i + 1] for i in range(len(ok)) if ok[i]] if dates else []

    fit = fit_garch11(ret)
    if fit is None:
        print(json.dumps({'ok': False, 'reason': 'GARCH(1,1) did not converge to a stationary fit'}))
        return

    s2 = fit['sigma2']
    n = len(s2)
    # Trading-day offsets. Calendar months are ~21 trading days.
    marks = {'now': 0, 'm1': 21, 'm3': 63, 'm6': 126}
    out = {}
    for key, back in marks.items():
        idx = n - 1 - back
        if idx < 0:
            out[key] = None
            continue
        out[key] = {'vol': round(annualised(s2[idx]), 2),
                    'asOf': rdates[idx] if idx < len(rdates) else None}

    print(json.dumps({
        'ok': True,
        'observations': int(n),
        'params': {k: round(float(fit[k]), 6) for k in ('omega', 'alpha', 'beta')},
        'persistence': round(float(fit['persistence']), 4),
        # Long-run vol the model implies: omega / (1 - alpha - beta), annualised. Useful context
        # for whether today's reading is high or low FOR THIS STOCK.
        'longRunVol': round(annualised(fit['omega'] / (1 - fit['persistence'])), 2),
        'points': out,
    }))


if __name__ == '__main__':
    main()
