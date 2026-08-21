"""FlitFancy 后端共享的纯配置与文本归一函数。"""

import re
from datetime import datetime, timedelta, timezone


CST = timezone(timedelta(hours=8))

MODEL_BASE_URLS = {
    "deepseek-chat": "https://api.deepseek.com",
    "deepseek-reasoner": "https://api.deepseek.com",
    "qwen-turbo": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "qwen-plus": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "qwen-max": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "qwen-vl-plus": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "qwen-vl-max": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "kimi-latest": "https://api.moonshot.cn/v1",
    "moonshot-v1-8k": "https://api.moonshot.cn/v1",
    "moonshot-v1-32k": "https://api.moonshot.cn/v1",
    "moonshot-v1-128k": "https://api.moonshot.cn/v1",
    "glm-4-flash": "https://open.bigmodel.cn/api/paas/v4",
    "glm-4": "https://open.bigmodel.cn/api/paas/v4",
    "mimo-v2.5": "https://api.xiaomimimo.com/v1",
}


def now_iso():
    return datetime.now(CST).isoformat(timespec="seconds")


def cfg_bool(value, default=True):
    """安全解析配置布尔值，避免字符串 ``false`` 被 bool() 判成真。"""
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() not in ("false", "0", "no", "off", "")


def base_url_for_model(model, fallback):
    """按模型名推断兼容接口地址；认不出的模型保留现有地址。"""
    if model in MODEL_BASE_URLS:
        return MODEL_BASE_URLS[model]
    for prefix, url in (
        ("deepseek", "https://api.deepseek.com"),
        ("qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        ("kimi", "https://api.moonshot.cn/v1"),
        ("moonshot", "https://api.moonshot.cn/v1"),
        ("glm", "https://open.bigmodel.cn/api/paas/v4"),
        ("mimo", "https://api.xiaomimimo.com/v1"),
    ):
        if model.startswith(prefix):
            return url
    return fallback


def normalize_reflections(values):
    """清理随笔：仅保留字符串、去空去重、单条 120 字、最多 100 条。"""
    if not isinstance(values, list):
        return []
    rows = []
    seen = set()
    for value in values:
        if not isinstance(value, str):
            continue
        text = value.strip()[:120]
        if not text or text in seen:
            continue
        seen.add(text)
        rows.append(text)
        if len(rows) >= 100:
            break
    return rows


def normalize_protocol_name(value):
    """只接受安装器生成格式；缺失或非法时返回空串并保持失败关闭。"""
    text = value.strip() if isinstance(value, str) else ""
    return text if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", text) else ""
