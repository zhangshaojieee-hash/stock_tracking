#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Audited time-series training and certification for signal quality models.

Protocol:
- remove rows whose forward label window is incomplete;
- reserve the newest date block as a final holdout;
- choose feature set, regularization, and uniqueness weighting only inside
  expanding inner time folds;
- purge training rows whose label window can overlap each validation block;
- report pooled, date-macro, and same-date cross-sectional AUC;
- never activate a model unless the explicit certification gate passes.

This script does not rebuild the dataset. The dataset builder remains the
single source of features and labels; this file audits how those rows are
used for model selection and certification.
"""
import argparse
import json
import os
from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import datetime, timedelta

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

from model import DAY_FEATURES, EXPANDED, FEATURES, expand_features

BASE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DATASET = os.path.join(BASE, "dataset.json")
DEFAULT_OUTPUT = os.path.join(BASE, "model_rigorous_{tf}.json")

# These candidates are fixed before looking at the final holdout.
CANDIDATES = {
    "day": [
        ("day_regime", DAY_FEATURES),
        ("day_technical", [
            "rsi14", "dif_inc_n", "ret20", "ret60", "ma60_pos",
            "ma20_slope", "atr_pct", "idx_ma60_pos", "idx_ret20",
        ]),
        ("day_full_base", FEATURES),
    ],
    "week": [
        ("week_technical", [
            "rsi14", "dif_inc_n", "zero_depth", "price_drop", "ret20",
            "ret60", "vol_ratio", "vol_shrink", "ma60_pos", "ma20_slope",
            "atr_pct", "off_low", "pivot_gap", "hist_rise", "score",
            "kdj_gold", "week_align", "vol_engulf",
        ]),
        ("week_full_base", FEATURES),
        ("week_expanded", EXPANDED),
    ],
}
C_VALUES = (0.01, 0.03, 0.1, 0.3, 1.0)
WEIGHTING = ("none", "uniqueness")


def parse_args():
    p = argparse.ArgumentParser(description="Nested time-series model certification")
    p.add_argument("--dataset", default=DEFAULT_DATASET)
    p.add_argument("--tf", choices=("day", "week"), required=True)
    p.add_argument("--output", default=None)
    p.add_argument("--target", default="label",
                   choices=("label", "label_return10", "label_excess10"))
    p.add_argument("--test-fraction", type=float, default=0.2)
    p.add_argument("--activate", action="store_true",
                   help="activate only when the certification gate passes")
    return p.parse_args()


def _rows(path, tf):
    with open(path, encoding="utf-8") as f:
        rows = [r for r in json.load(f) if r.get("tf") == tf]
    if not rows:
        raise SystemExit(f"dataset.json 中没有 {tf} 样本")
    rows = sorted(rows, key=lambda r: r["confirm"])
    max_date = datetime.fromisoformat(rows[-1]["confirm"])
    # Conservative calendar purge. This is longer than 10 trading bars for
    # both daily and weekly data and removes censored labels at the tail.
    horizon_days = 15 if tf == "day" else 70
    eligible_end = (max_date - timedelta(days=horizon_days)).date().isoformat()
    eligible = [r for r in rows if r["confirm"] <= eligible_end]
    excluded = len(rows) - len(eligible)
    if len(eligible) < 300:
        raise SystemExit(f"完整障碍窗口后的 {tf} 样本不足: {len(eligible)}")
    return eligible, eligible_end, excluded


def _vector(row, name):
    if name in row:
        return float(row[name])
    if "*" in name:
        left, right = name.split("*", 1)
        return float(row[left]) * float(row[right])
    raise KeyError(name)


def _prepare(rows, names, target="label"):
    x = np.asarray([[_vector(r, name) for name in names] for r in rows], dtype=float)
    y = np.asarray([int(r[target]) for r in rows], dtype=int)
    dates = np.asarray([r["confirm"] for r in rows])
    return x, y, dates


def _uniqueness_weights(rows):
    # Overlapping signals from one security are down-weighted. This is derived
    # only from train rows in each fold by the caller.
    weights = np.ones(len(rows), dtype=float)
    grouped = defaultdict(list)
    for i, row in enumerate(rows):
        grouped[row["code"]].append(i)
    for code, indices in grouped.items():
        indices.sort(key=lambda i: rows[i]["confirm"])
        times = [datetime.fromisoformat(rows[i]["confirm"]) for i in indices]
        tf_days = 7 if rows[indices[0]]["tf"] == "week" else 1.5
        horizon = timedelta(days=10 * tf_days)
        for pos, i in enumerate(indices):
            lo = bisect_left(times, times[pos] - horizon)
            hi = bisect_right(times, times[pos] + horizon)
            overlap = hi - lo - 1
            weights[i] = 1.0 / (1.0 + 0.5 * max(0, overlap))
    return weights


def _fit(x, y, names, c_value, weighting, rows):
    lo = np.percentile(x, 1, axis=0)
    hi = np.percentile(x, 99, axis=0)
    x_clip = np.clip(x, lo, hi)
    mean = x_clip.mean(axis=0)
    std = np.where(x_clip.std(axis=0) > 1e-12, x_clip.std(axis=0), 1.0)
    clf = LogisticRegression(max_iter=3000, C=c_value,
                             class_weight="balanced")
    sample_weight = (_uniqueness_weights(rows) if weighting == "uniqueness"
                     else None)
    clf.fit((x_clip - mean) / std, y, sample_weight=sample_weight)
    return clf, lo, hi, mean, std


def _predict(fitted, x):
    clf, lo, hi, mean, std = fitted
    return clf.predict_proba((np.clip(x, lo, hi) - mean) / std)[:, 1]


def _auc(y, p):
    return (float(roc_auc_score(y, p))
            if len(y) and len(np.unique(y)) == 2 else None)


def _date_macro_auc(y, p, dates):
    values = []
    for date in sorted(set(dates)):
        mask = dates == date
        value = _auc(y[mask], p[mask])
        if value is not None:
            values.append(value)
    return float(np.mean(values)) if values else None


def _cross_sectional_auc(y, p, dates):
    # This is the operational ranking metric: among signals confirmed on the
    # same date, can the model rank winners above losers?
    values = []
    for date in sorted(set(dates)):
        mask = dates == date
        value = _auc(y[mask], p[mask])
        if value is not None and mask.sum() >= 2:
            values.append(value)
    return (float(np.mean(values)) if values else None), len(values)


def _metrics(y, p, dates):
    cross, cross_n = _cross_sectional_auc(y, p, dates)
    return {
        "pooled_auc": _auc(y, p),
        "date_macro_auc": _date_macro_auc(y, p, dates),
        "cross_sectional_auc": cross,
        "cross_sectional_dates": cross_n,
        "n": int(len(y)),
        "win_rate": round(float(y.mean()) * 100, 3) if len(y) else None,
    }


def _purged_split(rows, start_date, end_date, horizon_days):
    dates = np.asarray([r["confirm"] for r in rows])
    test = (dates >= start_date) & (dates < end_date)
    cutoff = (datetime.fromisoformat(start_date)
              - timedelta(days=horizon_days)).date().isoformat()
    train = dates < cutoff
    return train, test


def _inner_splits(pool_rows, horizon_days):
    dates = sorted({r["confirm"] for r in pool_rows})
    if len(dates) < 12:
        return []
    starts = [int(len(dates) * ratio) for ratio in (0.45, 0.60, 0.75)]
    splits = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(dates)
        if start >= end:
            continue
        end_date = (dates[end] if end < len(dates)
                    else (datetime.fromisoformat(dates[-1])
                          + timedelta(days=1)).date().isoformat())
        tr, va = _purged_split(pool_rows, dates[start], end_date, horizon_days)
        if tr.sum() and va.sum():
            splits.append((tr, va))
    return splits


def _select(pool_rows, tf, horizon_days, target):
    splits = _inner_splits(pool_rows, horizon_days)
    if not splits:
        raise SystemExit("内层时间折不足，不能选择模型")
    results = []
    for candidate_name, names in CANDIDATES[tf]:
        x, y, dates = _prepare(pool_rows, names, target)
        for c_value in C_VALUES:
            for weighting in WEIGHTING:
                fold_metrics = []
                for tr, va in splits:
                    if len(np.unique(y[tr])) < 2 or len(np.unique(y[va])) < 2:
                        continue
                    fitted = _fit(x[tr], y[tr], names, c_value, weighting,
                                  [pool_rows[i] for i in np.where(tr)[0]])
                    fold_metrics.append(_metrics(y[va], _predict(fitted, x[va]),
                                                 dates[va]))
                if not fold_metrics:
                    continue
                def avg(key):
                    vals = [m[key] for m in fold_metrics if m[key] is not None]
                    return float(np.mean(vals)) if vals else None
                results.append({
                    "candidate": candidate_name,
                    "feature_names": list(names),
                    "C": c_value,
                    "weighting": weighting,
                    "pooled_auc": avg("pooled_auc"),
                    "date_macro_auc": avg("date_macro_auc"),
                    "cross_sectional_auc": avg("cross_sectional_auc"),
                    "folds": fold_metrics,
                })
    if not results:
        raise SystemExit("内层验证没有有效候选")
    # The operational objective is ranking signals on the same confirmation
    # date, so cross-sectional AUC is primary; pooled AUC is only a tie-breaker.
    results.sort(key=lambda r: (
        r["cross_sectional_auc"] if r["cross_sectional_auc"] is not None else -1,
        r["date_macro_auc"] if r["date_macro_auc"] is not None else -1,
        r["pooled_auc"] if r["pooled_auc"] is not None else -1,
    ), reverse=True)
    return results[0], results[:10]


def _bootstrap_date_auc(y, p, dates, seed=20261023, n=1000):
    rng = np.random.default_rng(seed)
    unique = np.asarray(sorted(set(dates)))
    values = []
    for _ in range(n):
        sampled = rng.choice(unique, size=len(unique), replace=True)
        mask = np.concatenate([np.where(dates == d)[0] for d in sampled])
        value = _auc(y[mask], p[mask])
        if value is not None:
            values.append(value)
    if not values:
        return None
    return {
        "low": round(float(np.percentile(values, 2.5)), 3),
        "high": round(float(np.percentile(values, 97.5)), 3),
        "n": len(values),
    }


def _gate(test, baseline):
    reasons = []
    if test["pooled_auc"] is None or test["pooled_auc"] < 0.55:
        reasons.append("最终测试集 pooled AUC < 0.55")
    if (test["cross_sectional_auc"] is None
            or test["cross_sectional_auc"] < 0.52):
        reasons.append("最终测试集同日横截面 AUC < 0.52")
    if (baseline is None or test["pooled_auc"] is None
            or test["pooled_auc"] - baseline < 0.02):
        reasons.append("相对固定基线 pooled AUC 提升不足 0.02")
    return not reasons, reasons


def train(args):
    rows, eligible_end, excluded = _rows(args.dataset, args.tf)
    horizon_days = 15 if args.tf == "day" else 70
    dates = sorted({r["confirm"] for r in rows})
    split = max(1, min(len(dates) - 1, int(len(dates) * (1 - args.test_fraction))))
    test_start = dates[split]
    pool = [r for r in rows if r["confirm"] < test_start]
    test_rows = [r for r in rows if r["confirm"] >= test_start]
    # Final training fit also purges the label window immediately before test.
    cutoff = (datetime.fromisoformat(test_start)
              - timedelta(days=horizon_days)).date().isoformat()
    fit_rows = [r for r in pool if r["confirm"] < cutoff]
    if len(fit_rows) < 200 or len(test_rows) < 50:
        raise SystemExit(f"训练/最终测试样本不足: {len(fit_rows)}/{len(test_rows)}")
    selected, leaderboard = _select(pool, args.tf, horizon_days, args.target)
    names = selected["feature_names"]
    x_fit, y_fit, _ = _prepare(fit_rows, names, args.target)
    fitted = _fit(x_fit, y_fit, names, selected["C"], selected["weighting"], fit_rows)
    x_test, y_test, test_dates = _prepare(test_rows, names, args.target)
    test_pred = _predict(fitted, x_test)
    test_metrics = _metrics(y_test, test_pred, test_dates)
    # A fixed, predeclared baseline is the raw resonance score.
    baseline_pred = np.asarray([float(r["score"]) for r in test_rows])
    baseline = _auc(y_test, baseline_pred)
    qualified, reasons = _gate(test_metrics, baseline)
    # The holdout decision above uses only pre-test rows. Once the decision is
    # made, a qualified model is refit on every eligible historical row so the
    # production artifact can use the newest information without changing the
    # already-recorded certification result.
    production_rows = rows if args.activate and qualified else fit_rows
    x_prod, y_prod, _ = _prepare(production_rows, names, args.target)
    production_fitted = _fit(x_prod, y_prod, names, selected["C"],
                             selected["weighting"], production_rows)
    clf, lo, hi, mean, std = production_fitted
    model = {
        "model_kind": "rigorous_certified_candidate",
        "target": args.target,
        "feature_names": names,
        "C": selected["C"],
        "weighting": selected["weighting"],
        "mean": mean.tolist(), "std": std.tolist(),
        "lo": lo.tolist(), "hi": hi.tolist(),
        "coef": clf.coef_[0].tolist(),
        "intercept": float(clf.intercept_[0]),
        "threshold": 50.0,
        "auc": round(float(_auc(y_prod, _predict(production_fitted, x_prod))), 3),
        "n_samples": len(production_rows),
        "base_win": round(float(y_prod.mean()) * 100, 3),
        "trained_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "certification": {
            "qualified": qualified,
            "reasons": reasons,
            "protocol": "fixed_latest_holdout_nested_time_cv_purged",
            "target": args.target,
            "tf": args.tf,
            "dataset": os.path.basename(args.dataset),
            "eligible_end": eligible_end,
            "excluded_incomplete_tail": excluded,
            "fit_end": fit_rows[-1]["confirm"],
            "final_test_start": test_start,
            "final_test_end": test_rows[-1]["confirm"],
            "final_test": test_metrics,
            "final_test_bootstrap_auc": _bootstrap_date_auc(
                y_test, test_pred, test_dates),
            "fixed_baseline_score_auc": round(float(baseline), 3)
            if baseline is not None else None,
            "inner_selected": selected,
            "inner_leaderboard": leaderboard,
        },
        "wf": {
            "auc": round(float(test_metrics["pooled_auc"]), 3)
            if test_metrics["pooled_auc"] is not None else None,
            "n": len(y_test),
            "base_win": test_metrics["win_rate"],
        },
    }
    return model


def main():
    args = parse_args()
    model = train(args)
    output = args.output or DEFAULT_OUTPUT.format(tf=args.tf)
    cert = model["certification"]
    print(f"{args.tf}/{args.target}: fit={model['n_samples']} "
          f"test={cert['final_test']['n']} test_start={cert['final_test_start']}")
    print("内层选择:", cert["inner_selected"]["candidate"],
          "C=", cert["inner_selected"]["C"],
          "weighting=", cert["inner_selected"]["weighting"])
    print("最终测试:", json.dumps(cert["final_test"], ensure_ascii=False))
    print("固定基线AUC:", cert["fixed_baseline_score_auc"])
    print("认证:", "QUALIFIED" if cert["qualified"] else "NOT QUALIFIED",
          "; ".join(cert["reasons"]))
    with open(output, "w", encoding="utf-8") as f:
        json.dump(model, f, ensure_ascii=False, indent=2)
    print("已写入候选报告:", output)
    if args.activate and cert["qualified"]:
        import model_catalog
        model_catalog.archive_model(output, args.tf, activate=True)
        print("已激活并归档")
    elif args.activate:
        print("未激活: 认证未通过")


if __name__ == "__main__":
    main()
