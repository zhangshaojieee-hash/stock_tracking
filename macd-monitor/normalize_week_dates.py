#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统一周线缓存和周线信号日期到原作者的周初口径。

每个 ISO 周使用该标的日线缓存中第一根交易日作为标签；日线缓存未覆盖的
历史周回退到 ISO 周一。迁移前通过 SQLite online backup 保留可恢复副本。
"""
import argparse
import os
import sqlite3
from datetime import date, datetime


CACHE_COLUMNS = "code, tf, label, o, c, h, l, v"


def week_key(label):
    return date.fromisoformat(str(label)[:10]).isocalendar()[:2]


def canonical_label(label, local_labels):
    key = week_key(label)
    return local_labels.get(key) or date.fromisocalendar(key[0], key[1], 1).isoformat()


def backup_database(db_path, backup_path):
    if os.path.exists(backup_path):
        raise FileExistsError(backup_path)
    src = sqlite3.connect(db_path, timeout=60)
    try:
        dst = sqlite3.connect(backup_path)
        try:
            src.backup(dst, pages=2000, sleep=0.1)
        finally:
            dst.close()
    finally:
        src.close()
    check = sqlite3.connect(backup_path, timeout=60)
    try:
        result = check.execute("PRAGMA quick_check").fetchone()[0]
    finally:
        check.close()
    if result != "ok":
        raise RuntimeError(f"backup quick_check failed: {result}")


def local_week_labels(conn, code):
    labels = {}
    rows = conn.execute(
        "SELECT label FROM kline_scan_cache WHERE code=? AND tf='day' "
        "ORDER BY label",
        (code,),
    )
    for (label,) in rows:
        try:
            labels.setdefault(week_key(label), label)
        except (TypeError, ValueError):
            continue
    return labels


def normalize_week_cache(conn):
    codes = [r[0] for r in conn.execute(
        "SELECT DISTINCT code FROM kline_scan_cache WHERE tf='week'"
    )]
    conn.execute(
        "CREATE TEMP TABLE normalized_week_cache ("
        "code TEXT NOT NULL, label TEXT NOT NULL, o REAL, c REAL, h REAL, l REAL, v REAL,"
        "PRIMARY KEY(code, label))"
    )
    stats = {"codes": len(codes), "rows_before": 0, "rows_after": 0,
             "exact": 0, "fallback": 0, "collisions": 0}
    for code in codes:
        labels = local_week_labels(conn, code)
        rows = conn.execute(
            "SELECT label,o,c,h,l,v FROM kline_scan_cache "
            "WHERE code=? AND tf='week' ORDER BY label",
            (code,),
        ).fetchall()
        stats["rows_before"] += len(rows)
        by_week = {}
        for row in rows:
            try:
                key = week_key(row[0])
                target = canonical_label(row[0], labels)
            except (TypeError, ValueError):
                continue
            if key in labels:
                stats["exact"] += 1
            else:
                stats["fallback"] += 1
            if key in by_week:
                stats["collisions"] += 1
            # 旧标签按日期升序读取，后面的记录是同周最新快照。
            by_week[key] = (target, *row[1:])
        normalized = [(code, *row) for row in by_week.values()]
        stats["rows_after"] += len(normalized)
        conn.executemany(
            "INSERT INTO normalized_week_cache(code,label,o,c,h,l,v) VALUES(?,?,?,?,?,?,?)",
            normalized,
        )

    conn.execute("DELETE FROM kline_scan_cache WHERE tf='week'")
    conn.execute(
        "INSERT INTO kline_scan_cache(" + CACHE_COLUMNS + ") "
        "SELECT code,'week',label,o,c,h,l,v FROM normalized_week_cache"
    )
    conn.execute("DROP TABLE normalized_week_cache")
    return stats


def normalize_week_signals(conn):
    rows = conn.execute(
        "SELECT id,code,date1,date2,confirm,scan_last FROM div_signal "
        "WHERE tf='week' ORDER BY id"
    ).fetchall()
    labels_by_code = {}
    updates = []
    groups = {}
    for row in rows:
        code = row[1]
        labels = labels_by_code.setdefault(code, local_week_labels(conn, code))
        mapped = []
        for value in row[2:5]:
            try:
                mapped.append(canonical_label(value, labels) if value else value)
            except (TypeError, ValueError):
                mapped.append(value)
        item = (row[0], code, *mapped, row[5])
        updates.append(item)
        groups.setdefault((code, mapped[1]), []).append(item)

    tracks = {
        row[0]: row[1:]
        for row in conn.execute(
            "SELECT signal_id,fwd3,fwd5,fwd10,fwd20,fwd60,upd FROM signal_track"
        )
    }
    winners = {}
    winner_by_group = {}
    losers = []
    for key, items in groups.items():
        winner = max(items, key=lambda item: (item[5] or "", item[0]))
        winners[winner[0]] = winner
        winner_by_group[key] = winner
        losers.extend(item for item in items if item[0] != winner[0])

    for loser in losers:
        loser_id = loser[0]
        winner_id = winner_by_group[(loser[1], loser[3])][0]
        if loser_id in tracks:
            if winner_id not in tracks:
                conn.execute(
                    "UPDATE signal_track SET signal_id=? WHERE signal_id=?",
                    (winner_id, loser_id),
                )
                tracks[winner_id] = tracks[loser_id]
            else:
                conn.execute("DELETE FROM signal_track WHERE signal_id=?", (loser_id,))
        conn.execute("DELETE FROM div_signal WHERE id=?", (loser_id,))

    for row in winners.values():
        conn.execute(
            "UPDATE div_signal SET date1=?, date2=?, confirm=? WHERE id=?",
            (row[2], row[3], row[4], row[0]),
        )
    return {
        "rows_before": len(rows),
        "rows_after": len(winners),
        "duplicates_removed": len(losers),
        "date_fields_updated": len(winners) * 3,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=os.path.join(os.path.dirname(__file__), "data.db"))
    parser.add_argument("--backup", default="")
    args = parser.parse_args()
    db_path = os.path.abspath(args.db)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = os.path.abspath(args.backup or f"{db_path}.pre-week-date-fix-{stamp}.bak")
    print(f"database: {db_path}", flush=True)
    print(f"backup: {backup_path}", flush=True)
    backup_database(db_path, backup_path)
    print("backup: verified", flush=True)

    conn = sqlite3.connect(db_path, timeout=120)
    conn.execute("PRAGMA busy_timeout=120000")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        conn.execute("BEGIN IMMEDIATE")
        cache_stats = normalize_week_cache(conn)
        signal_stats = normalize_week_signals(conn)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    print(f"cache: {cache_stats}", flush=True)
    print(f"signals: {signal_stats}", flush=True)
    print("migration: committed", flush=True)


if __name__ == "__main__":
    main()
