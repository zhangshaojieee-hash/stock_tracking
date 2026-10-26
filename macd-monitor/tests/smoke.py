#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""每个任务 commit 前必跑: python3 tests/smoke.py"""
import sys, os
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)


def test_db():
    import db
    db.init()
    rows = db.div_rows(30)
    assert isinstance(rows, list)
    print("ok db")


def test_divergence_confirmation_lag():
    """The default remains four bars, while shorter confirmations expose earlier labels."""
    from monitor import detect_divergences
    closes = [100.0] * 32
    closes[7], closes[10], closes[20] = 110.0, 100.0, 90.0
    bars = [(f"2026-01-{i + 1:02d}", closes[i]) for i in range(32)]
    dif = [0.0] * len(bars)
    dif[7], dif[10], dif[20] = -4.0, -3.0, -2.0
    stages = {
        lag: next(item for item in detect_divergences(
            bars, dif, 30, pairs=999, confirm_bars=lag)
            if item["p2"] == 20)
        for lag in (2, 3, 4)
    }
    assert [stages[lag]["confirm"] for lag in (2, 3, 4)] == [22, 23, 24]
    assert stages[2]["p1"] == 10
    assert stages[3]["p1"] == stages[4]["p1"] == 7
    assert stages[2]["p1"] != stages[4]["p1"]
    print("ok independent_divergence_structures")


def test_historical_div_backtest_maturity():
    """历史列表回测只把已经走满对应交易日的样本计入该周期统计。"""
    import tempfile
    import db
    path = tempfile.mktemp(suffix=".db")
    previous_path = db.DB_PATH
    try:
        db.DB_PATH = path
        db._local.__dict__.clear()
        db.init()
        base = {"code": "000001", "tf": "day", "date2": "2026-10-20",
                "date1": "2026-10-10", "price1": 100, "price2": 90,
                "dif1": -3, "dif2": -2, "score": 5,
                "confirm": "2026-10-20", "confirm_close": 100, "lag": 4}
        early2 = {**base, "code": "000002", "lag": 2, "score": 2}
        rows = [{**base}, {**early2, "_lag_only": True}]
        db.upsert_signals(rows, "2026-10-20")
        snapshot_id = db.create_div_snapshot(rows, "2026-10-20", "2026-10-20")
        c = db.conn()
        bars = [
            ("000001", "day", "2026-10-20", 100),
            ("000001", "day", "2026-10-21", 102),
            ("000001", "day", "2026-10-22", 101),
            ("000001", "day", "2026-10-23", 103),
            ("000002", "day", "2026-10-20", 100),
            ("000002", "day", "2026-10-21", 98),
        ]
        c.executemany(
            "INSERT INTO kline_scan_cache(code,tf,label,c) VALUES(?,?,?,?)", bars)
        c.commit()
        result = db.historical_div_backtest(snapshot_id, 4, (1, 3, 5, 10))
        assert result["overall"]["n1"] == 1
        assert result["overall"]["n3"] == 1
        assert result["overall"]["win1"] == 100.0
        assert result["overall"]["win3"] == 100.0
        result2 = db.historical_div_backtest(snapshot_id, 2, (1, 3))
        assert result2["overall"]["n1"] == 1
    finally:
        active_conn = getattr(db._local, "conn", None)
        if active_conn is not None:
            active_conn.close()
        db._local.__dict__.clear()
        db.DB_PATH = previous_path
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
    print("ok historical_div_backtest_maturity")


def test_features_no_lookahead():
    """篡改确认日之后的K线, 特征值必须不变"""
    import model
    base = [[f"2025-{1+i//28:02d}-{1+i%28+1:02d}", 100, 100+i*0.1,
             100+i*0.1+1, 100+i*0.1-1, 1000+i] for i in range(100)]
    sig = {"date1": base[10][0], "date2": base[50][0],
           "price1": base[10][2], "price2": base[50][2],
           "dif1": 0.1, "dif2": 0.05, "score": 5, "tags": "kdj_gold",
           "confirm": base[70][0], "confirm_close": base[70][2]}
    # ctx: 与个股K线同构的指数序列(build_features 需要指数严格对齐到确认日)
    idx = [r[:] for r in base]
    ctx = {"idx": idx, "mood": {"temp": 50, "zb_rate": 30}, "ind_mom": 0.0}
    f1 = model.build_features(base, sig, ctx)
    tampered = [r[:] for r in base]
    for i in range(71, 100):
        tampered[i][2] = 999.0
    f2 = model.build_features(tampered, sig, ctx)
    assert f1 is not None and f2 is not None, "特征构建失败"
    for k in f1:
        assert abs(f1[k] - f2[k]) < 1e-9, f"特征{k}存在未来函数泄漏"
    # 指数K线确认日之后被篡改, 指数特征同样必须不变
    idx2 = [r[:] for r in idx]
    for i in range(71, 100):
        idx2[i][2] = 777.0
    f3 = model.build_features(base, sig, {**ctx, "idx": idx2})
    for k in ("idx_ma60_pos", "idx_ret20"):
        assert abs(f1[k] - f3[k]) < 1e-9, f"ctx特征{k}存在未来函数泄漏"
    print("ok no-lookahead")


def test_model_score_range():
    import model
    if not model.load_model():
        print("skip model_score (no model.json)")
        return
    # 用任意合法 feats 验证输出在 0-100
    import random
    feats = {k: random.uniform(0, 1) for k in model.FEATURES}
    s = model.model_score(feats)
    assert s is None or 0 <= s <= 100, f"model_score 越界: {s}"
    print("ok model_score")


def test_active_day_model_score():
    """当前激活日线模型的特征格式必须能在线上推理。"""
    import model
    from model_catalog import active_model_path
    path = active_model_path("day")
    assert model.load_model(path), f"无法加载激活日线模型: {path}"
    names = model._DAY_MODEL.get("feature_names") or model.DAY_FEATURES
    features = {name: 0.0 for name in names}
    score = model.model_score_for_tf(features, "day")
    assert score is not None and 0 <= score <= 100, f"激活日线模型无法打分: {score}"
    print("ok active_day_model")


def test_rigorous_protocol_helpers():
    """认证评估必须按日期计算指标，并保留失败门槛。"""
    import numpy as np
    import train_rigorous
    y = np.array([0, 1, 0, 1])
    p = np.array([0.1, 0.9, 0.2, 0.8])
    dates = np.array(["2026-01-01", "2026-01-01", "2026-01-02", "2026-01-02"])
    metrics = train_rigorous._metrics(y, p, dates)
    assert metrics["pooled_auc"] == 1.0
    assert metrics["cross_sectional_auc"] == 1.0
    ok, reasons = train_rigorous._gate(
        {"pooled_auc": 0.51, "cross_sectional_auc": 0.51}, 0.50)
    assert not ok and reasons
    print("ok rigorous_protocol")


def test_intraday_entry_rules():
    """规则多选配置兼容旧单值，且稳健规则必须突破确认K线高点。"""
    import webui
    assert webui._intraday_timeframes({"intraday_timeframes": ["1m", "15m", "day", "week", "1m", "invalid"]}) == ["1m", "15m", "day", "week"]
    assert webui._intraday_timeframes({"intraday_timeframes": []}) == ["60m"]
    assert set(("day", "week")).issubset(set(webui.INTRADAY_TF_OPTIONS))
    assert webui._entry_rules({"entry_rules": ["steady", "aggressive", "steady", "bad"]}) == ["steady", "aggressive"]
    assert webui._sell_rules({"sell_rules": ["balanced", "aggressive"]}) == ["balanced", "aggressive"]
    assert webui._entry_rules({"entry_rule": "balanced"}) == ["balanced"]
    assert webui._sell_rules({"sell_rule": "invalid"}) == ["steady"]
    original_divergences = webui.detect_divergences
    try:
        webui.detect_divergences = lambda bars, dif, last, pairs=3: [{
            "div": "bull", "p1": 1, "p2": 6, "c1": 10.0, "c2": 9.5,
            "d1": -1.0, "d2": -0.8, "confirm": 10,
        }]
        test_bars = [(f"2026-01-01 10:{i:02d}", 10.0) for i in range(121)]
        assert webui._intraday_divs("sh000001", "测试", test_bars, "15m")[0]["tf"] == "15m"
    finally:
        webui.detect_divergences = original_divergences
    bars = [(f"2026-01-01 10:{i:02d}", 10.0 + i * 0.1) for i in range(20)]
    signal = {
        "confirm_index": 18, "confirm": bars[18][0], "price2": 10.5,
    }
    ohlc = [(label, close, close, close + 0.2, close - 0.2)
            for label, close in bars]
    assert webui._entry_candidate("steady", signal, bars, ohlc, 12.0)
    original_macd = webui.calc_macd
    try:
        webui.calc_macd = lambda closes: (
            [float(i) for i in range(len(closes))],
            [0.0] * len(closes),
            [float(i) for i in range(len(closes))])
        assert webui._entry_candidate("balanced", signal, bars, ohlc, 12.0)
    finally:
        webui.calc_macd = original_macd
    assert webui._entry_candidate("aggressive", signal, bars, ohlc, 10.6)
    sell_signal = {**signal, "price2": 11.5}
    assert webui._sell_candidate("steady", sell_signal, bars, ohlc, 11.0) is None
    original_macd = webui.calc_macd
    try:
        webui.calc_macd = lambda closes: (
            [float(len(closes) - i) for i in range(len(closes))],
            [0.0] * len(closes),
            [float(len(closes) - i) for i in range(len(closes))])
        assert webui._sell_candidate("balanced", sell_signal, bars, ohlc, 10.0)
    finally:
        webui.calc_macd = original_macd
    assert webui._sell_candidate("aggressive", sell_signal, bars, ohlc, 10.6)
    stale = {**signal, "confirm_index": 5}
    assert webui._entry_candidate("aggressive", stale, bars, ohlc, 12.0)
    assert webui._sell_candidate("aggressive", stale, bars, ohlc, 10.0)
    assert webui._top_structure_candidate({"confirm_index": 10}, bars) is None
    test_key = f"test|event|{os.getpid()}"
    try:
        assert webui._mark_entry_event(test_key, webui.now_cst())
        assert not webui._mark_entry_event(test_key, webui.now_cst())
    finally:
        with webui.ENTRY_STATE_LOCK:
            webui.ENTRY_PUSHED.pop(test_key, None)
            webui._save_entry_state()
    print("ok intraday_entry_rules")


def test_calibrated_score():
    """概率校准: 有wf分桶时按样本外胜率插值, 无wf数据原样返回"""
    import model
    # 1) 无 wf 数据: 原样返回, 不抛异常
    model.load_model()
    saved = dict(model._MODEL)
    try:
        model._MODEL.pop("wf", None)
        assert model.calibrated_score(66.6) == 66.6, "无wf数据应原样返回"
        assert model.calibrated_score(None) is None
        # 2) 注入 wf 分桶验证插值映射
        model._MODEL["wf"] = {"buckets": [
            {"key": "0-40", "n": 100, "win": 38.0},
            {"key": "40-60", "n": 80, "win": 45.0},
            {"key": "60-75", "n": 50, "win": 58.0},
            {"key": ">=75", "n": 40, "win": 71.0},
        ]}
        # 控制点: (0,38)(40,38)(60,45)(75,58)(100,71)
        assert model.calibrated_score(20) == 38.0     # 段内平坦
        assert model.calibrated_score(50) == 41.5      # 40-60线性中点
        assert model.calibrated_score(72.5) == 55.8   # 60-75段内插值
        assert model.calibrated_score(75) == 58.0      # 桶边界取分桶胜率
        assert model.calibrated_score(90) == 65.8     # 顶桶内插值(75-100段)
        assert model.calibrated_score(0) == 38.0 and model.calibrated_score(100) == 71.0
        out = model.calibrated_score(66.6)
        assert out != 66.6, "有wf数据时cal与raw应不同(映射生效)"
    finally:
        model._MODEL.update(saved)
    print("ok calibrated_score")


if __name__ == "__main__":
    test_db()
    test_divergence_confirmation_lag()
    test_historical_div_backtest_maturity()
    test_features_no_lookahead()
    test_model_score_range()
    test_active_day_model_score()
    test_rigorous_protocol_helpers()
    test_intraday_entry_rules()
    test_calibrated_score()
    print("SMOKE ALL PASS")
