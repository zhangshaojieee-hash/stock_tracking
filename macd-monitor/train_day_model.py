#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Train the daily-only signal quality model.

The candidate uses only market-regime features and a time-decay weighting scheme.
It writes model_day.json and never changes the default mixed-timeframe model.json.
"""
import argparse
import json
import os
from datetime import datetime, timedelta

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

from model import DAY_FEATURES

BASE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DATASET = os.path.join(BASE, "dataset.json")
DEFAULT_OUTPUT = os.path.join(BASE, "model_day.json")


def parse_args():
    parser = argparse.ArgumentParser(description="Train the daily-only quality model")
    parser.add_argument("--dataset", default=DEFAULT_DATASET)
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--dry-run", action="store_true",
                        help="evaluate and train in memory without writing model_day.json")
    return parser.parse_args()


def _rows(path):
    with open(path, encoding="utf-8") as f:
        rows = json.load(f)
    rows = [r for r in rows if r.get("tf") == "day"]
    if not rows:
        raise SystemExit("dataset.json 中没有日线样本")
    missing = [name for name in DAY_FEATURES if name not in rows[0]]
    if missing:
        raise SystemExit(f"日线数据集缺少特征: {', '.join(missing)}")
    return sorted(rows, key=lambda r: r["confirm"])


def _prepare(rows):
    x = np.array([[float(r[name]) for name in DAY_FEATURES] for r in rows], dtype=float)
    y = np.array([int(r["label"]) for r in rows], dtype=int)
    dates = np.array([r["confirm"] for r in rows])
    return x, y, dates


def _fit(x, y, edge, sample_dates):
    lo = np.percentile(x, 1, axis=0)
    hi = np.percentile(x, 99, axis=0)
    clipped = np.clip(x, lo, hi)
    mean = clipped.mean(axis=0)
    std = np.where(clipped.std(axis=0) > 1e-12, clipped.std(axis=0), 1.0)
    age = np.array([
        (datetime.fromisoformat(edge) - datetime.fromisoformat(d)).days
        for d in sample_dates
    ], dtype=float)
    weights = np.clip(1.0 - age / 120.0, 0.1, 1.0)
    clf = LogisticRegression(max_iter=3000, C=0.03, class_weight="balanced")
    clf.fit((clipped - mean) / std, y, sample_weight=weights)
    return clf, lo, hi, mean, std


def _walk_forward(rows):
    x, y, dates = _prepare(rows)
    unique_dates = sorted(set(dates))
    if len(unique_dates) < 5:
        raise SystemExit("日线确认日期不足，无法进行四折时间验证")
    edges = [unique_dates[int(len(unique_dates) * (i + 1) / 5) - 1]
             for i in range(4)]
    predictions, actual = [], []
    fold_info = []
    for fold, edge in enumerate(edges, 1):
        end = edges[fold] if fold < 4 else unique_dates[-1]
        test = (dates > edge) & (dates <= end)
        cutoff = (datetime.fromisoformat(edge) - timedelta(days=15)).isoformat()
        train = dates <= cutoff
        if not test.any() or len(np.unique(y[train])) < 2:
            continue
        clf, lo, hi, mean, std = _fit(x[train], y[train], edge, dates[train])
        p = clf.predict_proba((np.clip(x[test], lo, hi) - mean) / std)[:, 1]
        predictions.extend(p)
        actual.extend(y[test])
        fold_auc = (roc_auc_score(y[test], p)
                    if len(np.unique(y[test])) > 1 else None)
        fold_info.append({"fold": fold, "train": int(train.sum()),
                          "test": int(test.sum()),
                          "test_win": round(float(y[test].mean()) * 100, 1),
                          "auc": round(float(fold_auc), 3)
                          if fold_auc is not None else None})
    if not actual or len(np.unique(actual)) < 2:
        raise SystemExit("有效时间折不足，无法计算日线样本外AUC")
    auc = roc_auc_score(actual, predictions)
    return round(float(auc), 3), fold_info, np.array(predictions), np.array(actual)


def _buckets(predictions, actual):
    out = []
    for low, high, key in ((0, 40, "0-40"), (40, 60, "40-60"),
                           (60, 75, "60-75"), (75, 101, ">=75")):
        mask = (predictions * 100 >= low) & (predictions * 100 < high)
        if mask.sum() >= 30:
            out.append({"key": key, "n": int(mask.sum()),
                        "win": round(float(actual[mask].mean()) * 100, 1)})
    return out


def train(rows):
    wf_auc, folds, wf_pred, wf_actual = _walk_forward(rows)
    x, y, dates = _prepare(rows)
    edge = dates[-1]
    clf, lo, hi, mean, std = _fit(x, y, edge, dates)
    p = clf.predict_proba((np.clip(x, lo, hi) - mean) / std)[:, 1]
    model = {
        "model_kind": "daily_regime",
        "feature_names": DAY_FEATURES,
        "time_weight": "linear_120_days",
        "C": 0.03,
        "mean": mean.tolist(),
        "std": std.tolist(),
        "lo": lo.tolist(),
        "hi": hi.tolist(),
        "coef": clf.coef_[0].tolist(),
        "intercept": float(clf.intercept_[0]),
        "threshold": 50.0,
        "auc": round(float(roc_auc_score(y, p)), 3),
        "wf": {"auc": wf_auc, "n": int(len(wf_actual)),
               "base_win": round(float(wf_actual.mean()) * 100, 1),
               "folds": folds, "buckets": _buckets(wf_pred, wf_actual)},
        "trained_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "n_samples": len(rows),
        "base_win": round(float(y.mean()) * 100, 1),
    }
    return model


def main():
    args = parse_args()
    rows = _rows(args.dataset)
    model = train(rows)
    print(f"日线样本: {model['n_samples']}, 基线胜率: {model['base_win']:.1f}%")
    print(f"日线严格样本外AUC: {model['wf']['auc']:.3f}")
    for fold in model["wf"]["folds"]:
        print(f"  折{fold['fold']}: train={fold['train']} test={fold['test']} "
              f"胜率={fold['test_win']:.1f}% AUC={fold['auc']}")
    print(f"日线全量AUC: {model['auc']:.3f}")
    if not args.dry_run:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(model, f, ensure_ascii=False, indent=2)
        import model_catalog
        archived_id = model_catalog.archive_model(args.output, "day", activate=True)
        print(f"已保存: {args.output}, 已归档: {archived_id}")
    else:
        print("--dry-run: 未写入模型文件")


if __name__ == "__main__":
    main()
