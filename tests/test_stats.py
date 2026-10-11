"""Pure statistics: no database, no HTTP."""
import math

from backend import stats


def test_wilson_interval_is_sane():
    lo, hi = stats.wilson(10, 100)
    assert 0.05 < lo < 0.10 < hi < 0.18
    assert stats.wilson(0, 0) == (0.0, 0.0)
    lo0, hi0 = stats.wilson(0, 50)          # zero conversions: lower bound stays at 0, upper bound > 0
    assert lo0 == 0.0 and hi0 > 0.05
    lo1, hi1 = stats.wilson(50, 50)
    assert hi1 == 1.0 and lo1 < 1.0


def test_z_test_detects_a_real_difference_and_ignores_noise():
    assert stats.z_test_p(1000, 100, 1000, 150) < 0.001            # 10% vs 15%
    assert stats.z_test_p(1000, 100, 1000, 102) > 0.5              # basically the same
    assert stats.z_test_p(0, 0, 10, 1) is None
    assert stats.z_test_p(50, 0, 50, 0) is None                    # no conversions anywhere


def test_chi2_survival_matches_known_values():
    # reference values: chi2 with 1 df -> P(X >= 3.841) = 0.05 ; 2 df -> P(X >= 5.991) = 0.05
    assert math.isclose(stats.chi2_sf(3.841, 1), 0.05, abs_tol=2e-4)
    assert math.isclose(stats.chi2_sf(5.991, 2), 0.05, abs_tol=2e-4)
    assert math.isclose(stats.chi2_sf(0, 3), 1.0)
    assert stats.chi2_sf(60, 1) < 1e-10


def test_srm_flags_a_broken_split_but_not_a_normal_one():
    assert stats.srm_p_value([5000, 5030], [50, 50]) > 0.5          # fine
    assert stats.srm_p_value([5000, 4400], [50, 50]) < 0.001        # 53/47 on 9400 visitors: broken
    assert stats.srm_p_value([300, 100], [75, 25]) > 0.5            # unequal split respected
    assert stats.srm_p_value([5, 5], [50, 50]) is None              # too little data to say


def test_prob_beat_control_is_directional():
    assert stats.prob_beat_control(100, 1000, 150, 1000) > 0.99
    assert stats.prob_beat_control(150, 1000, 100, 1000) < 0.01
    assert 0.35 < stats.prob_beat_control(100, 1000, 100, 1000) < 0.65
    assert stats.prob_beat_control(0, 0, 1, 1) is None


def test_min_sample_size_matches_textbook():
    # 10% baseline, 10% relative lift (10% -> 11%), alpha .05, power .8  ->  ~14,750 per arm (standard calculators)
    n = stats.min_sample_per_variant(0.10, 0.10)
    assert 14000 < n < 15500
    assert stats.min_sample_per_variant(0, 0.1) is None
    assert stats.min_sample_per_variant(0.1, 0) is None


def V(name, n, c):
    return {"variant": name, "visitors": n, "conversions": c}


def test_evaluate_declares_a_clear_winner():
    r = stats.evaluate([V("control", 2000, 200), V("b", 2000, 280)], {"control": 50, "b": 50}, "control",
                       min_visitors=500, runtime_days=10, min_days=7, auto=True)
    assert r["winner"] == "b" and r["auto_ready"] and not r["srm"]["flag"]
    b = r["variants"][1]
    assert b["significant"] and b["uplift"] > 0.3 and b["prob_beat_control"] > 0.99 and b["ci_low"] < b["rate"] < b["ci_high"]


def test_evaluate_waits_for_enough_data_and_time():
    r = stats.evaluate([V("control", 2000, 200), V("b", 2000, 280)], {"control": 50, "b": 50}, "control",
                       min_visitors=500, runtime_days=2, min_days=7, auto=True)
    assert r["winner"] is None and not r["auto_ready"] and "Keep running" in r["recommendation"]
    r = stats.evaluate([V("control", 100, 10), V("b", 100, 14)], {"control": 50, "b": 50}, "control", min_visitors=500, runtime_days=30)
    assert r["winner"] is None


def test_evaluate_refuses_to_trust_a_broken_split():
    r = stats.evaluate([V("control", 5000, 500), V("b", 4000, 600)], {"control": 50, "b": 50}, "control", runtime_days=30)
    assert r["srm"]["flag"] and r["winner"] is None and "mismatch" in r["recommendation"].lower()


def test_evaluate_bonferroni_is_stricter_with_more_variants():
    two = stats.evaluate([V("control", 1500, 150), V("b", 1500, 190)], {"control": 50, "b": 50}, "control", runtime_days=30)
    four = stats.evaluate([V("control", 1500, 150), V("b", 1500, 190), V("c", 1500, 151), V("d", 1500, 149)],
                          {k: 25 for k in ("control", "b", "c", "d")}, "control", runtime_days=30)
    assert two["variants"][1]["significant"] is True      # p ≈ 0.009 < 0.05
    assert four["alpha"] == 0.05 / 3
    assert four["variants"][1]["p_adjusted"] > two["variants"][1]["p_adjusted"]


def test_evaluate_control_wins_when_variants_are_significantly_worse():
    r = stats.evaluate([V("control", 3000, 450), V("b", 3000, 300)], {"control": 50, "b": 50}, "control", runtime_days=30)
    assert r["winner"] == "control"
