#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""训练行情周线标签与信号库日期口径的回归测试。"""
import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

import webui


def test_training_week_labels_use_first_trading_day():
    weekly = [["2026-10-16", 10.0, 11.0, 12.0, 9.0, 100.0]]
    daily = [
        ["2026-10-12", 10.0, 10.5, 11.0, 9.5, 20.0],
        ["2026-10-13", 10.5, 11.0, 12.0, 10.0, 30.0],
    ]

    normalized = webui._normalize_training_week_labels(weekly, daily)

    assert normalized == [["2026-10-12", 10.0, 11.0, 12.0, 9.0, 100.0]]
