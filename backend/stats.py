"""A/B-test statistics. Pure functions (no database), so they can be unit-tested on their own.

Frequentist: pooled two-proportion z-test, Wilson confidence intervals, Bonferroni correction when several
variants are compared with one control, and a sample-ratio-mismatch (SRM) check. Bayesian: probability that a
variant beats the control (Beta posteriors, Monte-Carlo). Nothing here is a substitute for deciding the sample
size up front -- the recommendation text says so.
"""
import math
import random
import statistics
from typing import Optional

_N = statistics.NormalDist()


def z_test_p(n_a: int, c_a: int, n_b: int, c_b: int) -> Optional[float]:
    """Two-sided p-value for a difference in conversion rates (pooled z-test)."""
    if n_a < 1 or n_b < 1:
        return None
    p_pool = (c_a + c_b) / (n_a + n_b)
    se = math.sqrt(p_pool * (1 - p_pool) * (1 / n_a + 1 / n_b))
    if se == 0:
        return None
    z = (c_b / n_b - c_a / n_a) / se
    return 2 * (1 - _N.cdf(abs(z)))


def wilson(c: int, n: int, z: float = 1.96) -> tuple:
    """95% Wilson score interval for a conversion rate -- stays inside [0, 1] and behaves for tiny samples."""
    if n <= 0:
        return (0.0, 0.0)
    p = c / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, centre - half), min(1.0, centre + half))


def _gammq(a: float, x: float) -> float:
    """Regularised upper incomplete gamma Q(a, x) (Numerical Recipes series / continued fraction)."""
    if x <= 0:
        return 1.0
    gln = math.lgamma(a)
    if x < a + 1:                       # series for P, then 1 - P
        ap, s, d = a, 1.0 / a, 1.0 / a
        for _ in range(500):
            ap += 1
            d *= x / ap
            s += d
            if abs(d) < abs(s) * 1e-12:
                break
        return max(0.0, 1.0 - s * math.exp(-x + a * math.log(x) - gln))
    b = x + 1 - a                       # continued fraction for Q
    c, dd = 1e300, 1.0 / b
    h = dd
    for i in range(1, 500):
        an = -i * (i - a)
        b += 2
        dd = an * dd + b
        dd = 1e-300 if abs(dd) < 1e-300 else dd
        c = b + an / c
        c = 1e-300 if abs(c) < 1e-300 else c
        dd = 1.0 / dd
        delta = dd * c
        h *= delta
        if abs(delta - 1) < 1e-12:
            break
    return min(1.0, math.exp(-x + a * math.log(x) - gln) * h)


def chi2_sf(x: float, df: int) -> float:
    """P(chi-square with `df` degrees of freedom >= x)."""
    return _gammq(df / 2.0, x / 2.0)


def srm_p_value(observed: list, weights: list) -> Optional[float]:
    """Sample-ratio-mismatch: do the visitor counts per variant match the configured traffic split?
    A tiny p-value (the convention is < 0.001) means assignment or tracking is broken and the results can't be trusted."""
    total, wsum = sum(observed), sum(weights)
    if len(observed) < 2 or total < 20 or wsum <= 0:
        return None
    chi = 0.0
    for o, w in zip(observed, weights):
        exp = total * w / wsum
        if exp <= 0:
            return None
        chi += (o - exp) ** 2 / exp
    return chi2_sf(chi, len(observed) - 1)


def prob_beat_control(c_ctrl: int, n_ctrl: int, c_var: int, n_var: int, draws: int = 4000, seed: int = 7) -> Optional[float]:
    """Bayesian probability that the variant's true rate exceeds the control's (uniform Beta(1,1) priors)."""
    if n_ctrl < 1 or n_var < 1:
        return None
    rng = random.Random(seed)
    a1, b1 = 1 + c_ctrl, 1 + n_ctrl - c_ctrl
    a2, b2 = 1 + c_var, 1 + n_var - c_var
    wins = sum(1 for _ in range(draws) if rng.betavariate(a2, b2) > rng.betavariate(a1, b1))
    return wins / draws


def min_sample_per_variant(baseline: float, rel_mde: float = 0.10, alpha: float = 0.05, power: float = 0.8) -> Optional[int]:
    """Visitors needed in EACH variant to detect a `rel_mde` relative lift on `baseline` (two-sided)."""
    if baseline is None or baseline <= 0 or baseline >= 1 or rel_mde <= 0:
        return None
    p1, p2 = baseline, min(0.999, baseline * (1 + rel_mde))
    za, zb = _N.inv_cdf(1 - alpha / 2), _N.inv_cdf(power)
    pbar = (p1 + p2) / 2
    num = (za * math.sqrt(2 * pbar * (1 - pbar)) + zb * math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2
    return int(math.ceil(num / (p2 - p1) ** 2))


def evaluate(variants: list, weights: dict, control: str, *, min_visitors: int = 0, runtime_days: float = 0.0,
             min_days: float = 0.0, auto: bool = False, alpha: float = 0.05) -> dict:
    """variants: [{"variant", "visitors", "conversions"}] (control first). Returns per-variant stats plus a verdict.

    Winner rule (used for the recommendation and for auto-completion): a non-control variant must beat the control
    with a Bonferroni-adjusted p < alpha AND >= 95% Bayesian probability, after every variant has `min_visitors`
    and the test has run `min_days`, and the sample split must not look broken (SRM). A significantly WORSE variant
    is never declared a winner; if the control is significantly better than every variant, the control wins."""
    ctrl = next(v for v in variants if v["variant"] == control)
    n_c, c_c = ctrl["visitors"], ctrl["conversions"]
    k = max(1, len(variants) - 1)
    adj_alpha = alpha / k
    out = []
    for v in variants:
        n, c = v["visitors"], v["conversions"]
        rate = c / n if n else 0.0
        lo, hi = wilson(c, n)
        item = {**v, "rate": rate, "ci_low": lo, "ci_high": hi, "weight": weights.get(v["variant"], 0),
                "is_control": v["variant"] == control, "uplift": None, "p_value": None, "p_adjusted": None,
                "significant": False, "prob_beat_control": None}
        if v["variant"] != control and n_c and n:
            base = c_c / n_c
            item["uplift"] = ((rate - base) / base) if base else None
            p = z_test_p(n_c, c_c, n, c)
            item["p_value"] = p
            item["p_adjusted"] = None if p is None else min(1.0, p * k)
            item["significant"] = p is not None and p < adj_alpha
            item["prob_beat_control"] = prob_beat_control(c_c, n_c, c, n)
        out.append(item)

    obs = [v["visitors"] for v in variants]
    srm_p = srm_p_value(obs, [weights.get(v["variant"], 0) for v in variants])
    srm_flag = srm_p is not None and srm_p < 0.001

    baseline = (c_c / n_c) if n_c else None
    needed = min_sample_per_variant(baseline) if baseline else None
    enough = all(v["visitors"] >= max(min_visitors, 1) for v in out) and runtime_days >= min_days

    winner, rec = None, None
    others = [v for v in out if not v["is_control"]]
    if srm_flag:
        rec = ("Sample ratio mismatch: the number of visitors per version doesn't match the planned split "
               f"(p={srm_p:.5f}). Something is off with assignment or tracking — fix it before trusting these results.")
    elif not enough:
        rec = "Keep running: not enough visitors" + (f" or days yet (needs {min_visitors:,} per version and {min_days:g} days)." if (min_visitors or min_days) else " yet.")
    else:
        best = max((v for v in others if v["uplift"] is not None), key=lambda v: v["uplift"], default=None)
        if best and best["significant"] and best["uplift"] > 0 and (best["prob_beat_control"] or 0) >= 0.95:
            winner = best["variant"]
            rec = (f"{winner} is the winner: +{best['uplift'] * 100:.1f}% conversion, "
                   f"{best['prob_beat_control'] * 100:.0f}% probability to beat control.")
        elif others and all(v["significant"] and (v["uplift"] or 0) < 0 for v in others):
            winner = control
            rec = "The original (control) beats every variant. Keep the original."
        else:
            rec = ("No clear winner yet. " + (f"Plan for about {needed:,} visitors per version to detect a 10% lift, " if needed else "")
                   + "and avoid stopping at the first lucky reading.")
    return {"variants": out, "srm": {"p_value": srm_p, "flag": srm_flag}, "alpha": adj_alpha,
            "needed_per_variant": needed, "baseline_rate": baseline, "enough_data": enough,
            "winner": winner, "recommendation": rec, "auto_ready": bool(auto and winner)}
