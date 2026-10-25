#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""交易日早上执行严格的日线模型认证与候选发布。

由 systemd timer(或 cron) 在周一~周五 06:00 触发; 脚本内再校验当天是否为 A股交易日,
节假日/周末即使被 cron 误触发也会被跳过。只有固定最终测试集认证通过的候选才会归档并激活。

首次为当前年份烘焙了官方休市(工作日)表: 见 HOLIDAYS_2026, 来源为沪深北交易所
2025-12-22 发布的《2026年部分节假日休市安排》。换年份时按其年度通知同步更新即可。

前置依赖(训练需要): pip3 install scikit-learn numpy requests
"""
import datetime
import json
import os
import subprocess
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(BASE, "retrain.log")
DATASET_PATH = os.path.join(BASE, "dataset_historical.json")
REPORT_PATH = os.path.join(BASE, "rigorous_excess_day_report.json")
MODEL_PATH = os.path.join(BASE, "model_day.json")

# ---- 2026年 A股非交易日(仅列"落在工作日的休市日"; 周六日由 weekday 判断兜底) ----
HOLIDAYS_2026 = {
    "2026-01-01", "2026-01-02",                                   # 元旦
    "2026-02-16", "2026-02-17", "2026-02-18",
    "2026-02-19", "2026-02-20", "2026-02-23",                      # 春节
    "2026-04-06",                                                 # 清明
    "2026-05-01", "2026-05-04", "2026-05-05",                     # 劳动节
    "2026-06-19",                                                 # 端午
    "2026-09-25",                                                 # 中秋
    "2026-10-01", "2026-10-02", "2026-10-05",
    "2026-10-06", "2026-10-07",                                   # 国庆
}


def log(msg):
    line = "[{}] {}".format(datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line, flush=True)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def is_trading_day(d):
    """当天是否 A股交易日(周末排除; 若当年烘焙了休市表则进一步排除节假日)"""
    if d.weekday() >= 5:                     # 周六 / 周日
        return False
    key = "HOLIDAYS_{}".format(d.strftime("%Y"))
    table = globals().get(key)
    if table is None:                        # 当年无休市表: 默认周一~五视为交易日
        return True
    return d.strftime("%Y-%m-%d") not in table


def weekly_maintenance():
    """每周一次库维护: 修剪过期K线扫描缓存 + VACUUM回收空间 + 统计信息优化。
    注: 本脚本由cron在周一~周五触发, 故挂在周一执行(原方案的周日不会被触发)"""
    import db
    try:
        db.kscan_prune(1200)
        c = db.conn()
        old_il = c.isolation_level
        c.isolation_level = None       # VACUUM/PRAGMA不能在事务内执行
        try:
            c.execute("PRAGMA optimize;")
            c.execute("VACUUM;")
        finally:
            c.isolation_level = old_il
        log("周维护: VACUUM + K线缓存修剪 完成")
    except Exception as e:
        log("周维护失败: {!r}".format(e))


def main():
    today = datetime.date.today()
    if today.weekday() == 0:            # 周一: 顺带周维护(节假日也不跳过)
        weekly_maintenance()
    if not is_trading_day(today):
        log("跳过: {} 非交易日".format(today))
        return
    log("== 交易日, 开始严格日线模型认证 ==")
    try:
        # 先从研究库重建历史样本，再用固定最终测试集认证。
        build = subprocess.run(
            [sys.executable, "build_historical_dataset.py",
             "--output", DATASET_PATH],
            capture_output=True, text=True, cwd=BASE)
        out = ((build.stdout or "") + (build.stderr or "")).strip()
        if out:
            log("\n".join("  " + l for l in out.splitlines()))
        if build.returncode != 0:
            log("历史数据集重建失败, 保留旧模型")
            return
        report = subprocess.run(
            [sys.executable, "train_rigorous.py", "--tf", "day",
             "--target", "label_excess10", "--dataset", DATASET_PATH,
             "--output", REPORT_PATH, "--activate"],
            capture_output=True, text=True, cwd=BASE)
        out = ((report.stdout or "") + (report.stderr or "")).strip()
        if out:
            log("\n".join("  " + l for l in out.splitlines()))
        if report.returncode != 0:
            log("严格认证失败, 保留旧模型")
            return
        with open(REPORT_PATH, encoding="utf-8") as f:
            result = json.load(f)
        cert = result.get("certification") or {}
        if not cert.get("qualified"):
            log("候选未通过固定最终测试集认证, 保留旧模型")
            return
        log("严格认证通过, 日线模型已归档并激活")
    except Exception as e:
        log("严格重训异常: {!r}".format(e))


if __name__ == "__main__":
    main()