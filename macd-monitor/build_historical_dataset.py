#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Rebuild a historical divergence dataset from the isolated research DB.

The source is research_kline only. Signals are reconstructed with the same
MACD pivot detector used by monitor.py; no live API, scan cache, or current
div_signal rows participate.
"""
import argparse
import json
import os
import sqlite3
import time
from collections import defaultdict
from datetime import datetime

import db
import model
import monitor
import webui

BASE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUTPUT = os.path.join(BASE, "dataset_historical.json")
DATASET_VERSION = 3


def parse_args():
    p = argparse.ArgumentParser(description="Build historical research training dataset")
    p.add_argument("--db", default=db.DB_PATH)
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.add_argument("--limit-codes", type=int, default=0,
                   help="debug limit; 0 means all codes")
    return p.parse_args()


def _bars(conn, code, tf):
    rows = conn.execute(
        "SELECT label,o,c,h,l,v FROM research_kline "
        "WHERE code=? AND tf=? ORDER BY label", (code, tf)).fetchall()
    return [list(row) for row in rows]


def _index_bars(conn, tf):
    # The Tencent cache uses sz000001 for the Shanghai Composite index;
    # accept sh000001 as well for databases built by other sources.
    rows = conn.execute(
        "SELECT label,o,c,h,l,v FROM research_kline "
        "WHERE code IN ('sz000001','sh000001') AND tf=? "
        "ORDER BY label", (tf,)).fetchall()
    return [list(row) for row in rows]


def _contexts(conn):
    idx_day = _index_bars(conn, "day")
    idx_week = _index_bars(conn, "week")
    mood_map = db.zt_mood_map()
    return {"day": idx_day, "week": idx_week}, mood_map


def _signal_rows(code, tf, klines, idx, mood_map):
    if len(klines) < 80:
        return []
    closes = [bar[2] for bar in klines]
    dif, _, _ = model.macd_series(closes)
    last = len(klines) - 1
    # Only bottom divergences are part of the production dataset.
    divs = monitor.detect_divergences(
        [(bar[0], bar[2]) for bar in klines], dif, last, pairs=999)
    atr = model.atr_series([bar[3] for bar in klines],
                           [bar[4] for bar in klines], closes, 14)
    out = []
    for div in divs:
        if div["div"] != "bull":
            continue
        cidx = div["confirm"]
        if cidx >= len(klines) or atr[cidx] is None:
            continue
        confirm = klines[cidx][0]
        sig = {
            "date1": klines[div["p1"]][0],
            "date2": klines[div["p2"]][0],
            "price1": div["c1"], "price2": div["c2"],
            "dif1": div["d1"], "dif2": div["d2"],
            "confirm": confirm,
        }
        tags, score = webui._resonance(
            klines, closes, div["p1"], div["p2"], cidx, tf)
        sig["tags"] = ",".join(tags)
        sig["score"] = score
        ctx = {"idx": idx, "mood": mood_map.get(confirm), "ind_mom": 0.0}
        feats = model.build_features(klines, sig, ctx)
        label = model.triple_barrier_label(klines, cidx, atr[cidx])
        if feats is None or label is None:
            continue
        # Do not train on a label whose ten-bar outcome is censored by the
        # end of this security's research history.
        if cidx + 10 >= len(klines):
            continue
        future_return = closes[cidx + 10] / closes[cidx] - 1.0
        idx_dates = {bar[0]: i for i, bar in enumerate(idx)}
        ii = idx_dates.get(confirm)
        future_label = klines[cidx + 10][0]
        ij = idx_dates.get(future_label)
        if ii is None or ij is None or idx[ii][2] == 0:
            continue
        index_return = idx[ij][2] / idx[ii][2] - 1.0
        excess_return = future_return - index_return
        out.append({"_dataset_version": DATASET_VERSION,
                    "source": "research_kline_reconstructed",
                    "id": f"hist:{code}:{tf}:{confirm}:{div['p1']}:{div['p2']}",
                    "code": code, "tf": tf, "confirm": confirm,
                    "label": label,
                    "label_return10": int(future_return > 0),
                    "label_excess10": int(excess_return > 0),
                    "fwd_return10": round(future_return * 100, 6),
                    "fwd_excess10": round(excess_return * 100, 6),
                    **feats})
    return out


def build(args):
    db.DB_PATH = args.db
    db.init()
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    try:
        contexts, mood_map = _contexts(conn)
        codes = [row[0] for row in conn.execute(
            "SELECT DISTINCT code FROM research_kline ORDER BY code")]
        if args.limit_codes:
            codes = codes[:args.limit_codes]
        rows = []
        stats = defaultdict(int)
        started = time.time()
        for pos, code in enumerate(codes, 1):
            for tf in ("day", "week"):
                klines = _bars(conn, code, tf)
                if not klines:
                    continue
                result = _signal_rows(code, tf, klines,
                                      contexts[tf], mood_map)
                rows.extend(result)
                stats[f"{tf}_codes"] += 1
                stats[f"{tf}_signals"] += len(result)
            if pos % 100 == 0:
                print(f"进度 {pos}/{len(codes)} codes, 样本 {len(rows)}, "
                      f"用时 {time.time() - started:.0f}s", flush=True)
    finally:
        conn.close()
    rows.sort(key=lambda r: (r["confirm"], r["code"], r["tf"]))
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False)
    print(json.dumps({"output": args.output, "samples": len(rows),
                      "stats": dict(stats),
                      "date_min": min((r["confirm"] for r in rows), default=None),
                      "date_max": max((r["confirm"] for r in rows), default=None)},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    build(parse_args())
