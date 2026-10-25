#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""研究/回测行情集。

研究集只接受实时缓存中的有效日线作为原始数据，周线按原作者规则由日线聚合，
不读取实时缓存中的直接周线。构建前必须先完成全市场日线缓存更新。
"""
import argparse
import sqlite3
from collections import defaultdict
from datetime import date, datetime

import db

RULE_VERSION = "daily-source-iso-week-first-trading-day-v1"


def _week_key(label):
    return date.fromisoformat(str(label)[:10]).isocalendar()[:2]


def _valid_daily(row):
    label, o, c, h, l, v = row
    try:
        date.fromisoformat(str(label)[:10])
        values = [float(o), float(c), float(h), float(l), float(v)]
    except (TypeError, ValueError):
        return False
    if any(value <= 0 for value in values[:4]) or values[4] < 0:
        return False
    return h >= max(o, c) and l <= min(o, c) and h >= l


def build_research_dataset(database_path=None):
    """从日线扫描缓存重建独立研究日线和周线表。"""
    if database_path:
        db.DB_PATH = database_path
    db.init()
    source_invalid = 0
    source_rows = []
    with db.conn() as conn:
        raw = conn.execute(
            "SELECT code,label,o,c,h,l,v FROM kline_scan_cache "
            "WHERE tf='day' ORDER BY code,label").fetchall()
        for row in raw:
            values = (row[1], row[2], row[3], row[4], row[5], row[6])
            if _valid_daily(values):
                source_rows.append((row[0], *values))
            else:
                source_invalid += 1

        by_code = defaultdict(list)
        for code, label, o, c, h, l, v in source_rows:
            by_code[code].append((label, o, c, h, l, v))

        weekly = []
        excluded_week_rows = 0
        for code, rows in by_code.items():
            groups = {}
            for row in rows:
                key = _week_key(row[0])
                group = groups.setdefault(key, [])
                group.append(row)
            if not groups:
                continue
            # 首尾周可能因研究窗口边界或当前周未收盘而不完整，研究集排除。
            first_key, last_key = min(groups), max(groups)
            for key, bars in groups.items():
                if key == first_key or key == last_key:
                    excluded_week_rows += len(bars)
                    continue
                bars.sort(key=lambda item: item[0])
                weekly.append((code, bars[0][0], bars[0][1], bars[-1][2],
                               max(item[3] for item in bars),
                               min(item[4] for item in bars),
                               sum(item[5] for item in bars)))

        source_min = min((row[1] for row in source_rows), default=None)
        source_max = max((row[1] for row in source_rows), default=None)
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute("DELETE FROM research_kline")
            conn.executemany(
                "INSERT INTO research_kline(code,tf,label,o,c,h,l,v) VALUES(?,?,?,?,?,?,?,?)",
                [(code, "day", label, o, c, h, l, v)
                 for code, label, o, c, h, l, v in source_rows] +
                [(code, "week", label, o, c, h, l, v)
                 for code, label, o, c, h, l, v in weekly])
            conn.execute("DELETE FROM research_build_meta")
            conn.execute(
                """INSERT INTO research_build_meta(
                    id,built_at,rule_version,source_daily_rows,research_daily_rows,
                    research_weekly_rows,invalid_daily_rows,excluded_week_rows,
                    code_count,source_min,source_max)
                   VALUES(1,?,?,?,?,?,?,?,?,?,?)""",
                (datetime.now().isoformat(timespec="seconds"), RULE_VERSION,
                 len(raw), len(source_rows), len(weekly), source_invalid,
                 excluded_week_rows, len(by_code), source_min, source_max))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return {
        "rule_version": RULE_VERSION,
        "source_daily_rows": len(raw),
        "research_daily_rows": len(source_rows),
        "research_weekly_rows": len(weekly),
        "invalid_daily_rows": source_invalid,
        "excluded_week_rows": excluded_week_rows,
        "code_count": len(by_code),
        "source_min": source_min,
        "source_max": source_max,
    }


def load_research_kline(code, tf="day", n=800):
    """读取研究行情；研究集未构建时明确报错，禁止回退实时缓存。"""
    with db.conn() as conn:
        meta = conn.execute("SELECT rule_version FROM research_build_meta WHERE id=1").fetchone()
        if not meta or meta[0] != RULE_VERSION:
            raise RuntimeError("研究行情集尚未构建，请先运行 research_data.py")
        rows = conn.execute(
            "SELECT label,o,c,h,l,v FROM research_kline "
            "WHERE code=? AND tf=? ORDER BY label DESC LIMIT ?",
            (code, tf if tf in ("day", "week") else "day", int(n))).fetchall()
    return [list(row) for row in reversed(rows)]


def main():
    parser = argparse.ArgumentParser(description="按原作者规则构建研究/回测行情集")
    parser.add_argument("--db", default=db.DB_PATH, help="SQLite 数据库路径")
    args = parser.parse_args()
    stats = build_research_dataset(args.db)
    for key, value in stats.items():
        print(f"{key}: {value}", flush=True)


if __name__ == "__main__":
    main()
