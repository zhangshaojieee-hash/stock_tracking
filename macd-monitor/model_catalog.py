#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Persistent model history and active-model selection."""
import hashlib
import json
import os
import shutil
import threading
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
HISTORY_DIR = os.path.join(BASE, "model_history")
REGISTRY_PATH = os.path.join(BASE, "model_registry.json")
DEFAULT_PATHS = {"week": os.path.join(BASE, "model.json"),
                 "day": os.path.join(BASE, "model_day.json")}
_LOCK = threading.RLock()


def _read():
    try:
        with open(REGISTRY_PATH, encoding="utf-8") as f:
            value = json.load(f)
        if not isinstance(value, dict):
            raise ValueError("registry is not an object")
    except Exception:
        value = {}
    value.setdefault("active", {})
    value.setdefault("models", [])
    return value


def _write(value):
    tmp = REGISTRY_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
    os.replace(tmp, REGISTRY_PATH)


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_model(path):
    with open(path, encoding="utf-8") as f:
        value = json.load(f)
    required = ("mean", "std", "coef", "intercept")
    if not all(value.get(key) is not None for key in required):
        raise ValueError("模型缺少推理字段")
    if not isinstance(value["coef"], list) or len(value["coef"]) == 0:
        raise ValueError("模型系数为空")
    return value


def _tf_for_path(path):
    return "day" if os.path.basename(path).startswith("model_day") else "week"


def _metadata(path, model_id, tf, archive):
    value = _read_model(path)
    rel = os.path.relpath(path, BASE).replace(os.sep, "/")
    target = value.get("target", "label")
    target_label = {
        "label": "三重障碍",
        "label_return10": "未来10根收益",
        "label_excess10": "未来10根相对大盘超额",
    }.get(target, target)
    return {
        "id": model_id,
        "tf": tf,
        "label": ("日线" if tf == "day" else "周线") + " · " + target_label,
        "path": rel,
        "archive": bool(archive),
        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "trained_at": value.get("trained_at", ""),
        "n_samples": value.get("n_samples"),
        "auc": value.get("auc"),
        "wf_auc": (value.get("wf") or {}).get("auc"),
        "base_win": value.get("base_win"),
        "model_kind": value.get("model_kind", "default"),
        "target": value.get("target", "label"),
        "certification": _certification_summary(value.get("certification")),
        "sha256": _sha256(path),
    }


def _certification_summary(certification):
    """Keep auditable gate results without duplicating the tuning leaderboard."""
    if not isinstance(certification, dict):
        return None
    keys = ("qualified", "protocol", "tf", "eligible_end", "fit_end",
            "final_test_start", "final_test_end", "final_test",
            "final_test_bootstrap_auc", "fixed_baseline_score_auc", "reasons")
    return {key: certification[key] for key in keys if key in certification}


def _ensure_defaults(registry):
    known = {item.get("id") for item in registry["models"]}
    changed = False
    for tf, path in DEFAULT_PATHS.items():
        model_id = "current-" + tf
        if not os.path.isfile(path) or model_id in known:
            continue
        try:
            registry["models"].append(_metadata(path, model_id, tf, False))
            changed = True
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    for tf in DEFAULT_PATHS:
        active = registry["active"].get(tf)
        if not active or not any(item.get("id") == active and
                                 item.get("tf") == tf for item in registry["models"]):
            fallback = "current-" + tf
            if any(item.get("id") == fallback for item in registry["models"]):
                registry["active"][tf] = fallback
                changed = True
    return changed


def list_models():
    with _LOCK:
        registry = _read()
        changed = _ensure_defaults(registry)
        valid = []
        for item in registry["models"]:
            path = os.path.join(BASE, item.get("path", ""))
            if item.get("id") and item.get("tf") in DEFAULT_PATHS and os.path.isfile(path):
                valid.append(item)
        # 当前文件是可变入口，训练后刷新其元数据；历史归档保持不可变。
        refreshed = []
        for item in valid:
            if item.get("id") in ("current-day", "current-week"):
                path = os.path.join(BASE, item["path"])
                try:
                    created_at = item.get("created_at")
                    item = _metadata(path, item["id"], item["tf"], False)
                    if created_at:
                        item["created_at"] = created_at
                    changed = True
                except (OSError, ValueError, json.JSONDecodeError):
                    pass
            refreshed.append(item)
        registry["models"] = refreshed
        if changed:
            _write(registry)
        return {"active": dict(registry["active"]),
                "models": sorted(refreshed,
                                  key=lambda x: (x.get("trained_at") or x.get("created_at") or ""),
                                  reverse=True)}


def active_model_path(tf):
    with _LOCK:
        registry = _read()
        _ensure_defaults(registry)
        active_id = registry["active"].get(tf)
        for item in registry["models"]:
            if item.get("id") == active_id and item.get("tf") == tf:
                path = os.path.join(BASE, item["path"])
                if os.path.isfile(path):
                    return path
        return DEFAULT_PATHS.get(tf)


def select_model(tf, model_id):
    if tf not in DEFAULT_PATHS:
        raise ValueError("不支持的模型周期")
    with _LOCK:
        registry = _read()
        _ensure_defaults(registry)
        found = next((item for item in registry["models"]
                      if item.get("id") == model_id and item.get("tf") == tf), None)
        if not found:
            raise ValueError("模型版本不存在")
        path = os.path.join(BASE, found["path"])
        _read_model(path)
        registry["active"][tf] = model_id
        _write(registry)
        return dict(found)


def archive_model(path, tf, activate=True):
    """Create an immutable snapshot after a successful training save."""
    if tf not in DEFAULT_PATHS:
        raise ValueError("不支持的模型周期")
    with _LOCK:
        model = _read_model(path)
        digest = _sha256(path)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        model_id = f"{tf}-{stamp}-{digest[:10]}"
        os.makedirs(HISTORY_DIR, exist_ok=True)
        target = os.path.join(HISTORY_DIR, model_id + ".json")
        shutil.copyfile(path, target)
        registry = _read()
        _ensure_defaults(registry)
        registry["models"] = [item for item in registry["models"]
                               if item.get("id") != model_id]
        registry["models"].append(_metadata(target, model_id, tf, True))
        if activate:
            registry["active"][tf] = model_id
        _write(registry)
        return model_id


def active_model_info(tf):
    data = list_models()
    active_id = data["active"].get(tf)
    return next((item for item in data["models"] if item.get("id") == active_id), None)
