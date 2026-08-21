"""传感器输入的解析、归一和公开序列化；不负责数据库写入。"""

import json
from datetime import datetime, timedelta

from flitfancy_core import CST, now_iso


SENSOR_CSV_FIELDS = (
    "uptime_ms", "cycle", "channel_index", "sensor", "ok", "temp_c",
    "rh_pct", "als_raw", "uv_raw", "f1_415", "f2_445", "f3_480",
    "f4_515", "f5_555", "f6_590", "f7_630", "f8_680", "clear_raw",
    "nir_raw", "voc_index", "nox_index", "sraw_voc", "sraw_nox",
    "co2_ppm", "pressure_pa", "as7341_atime", "as7341_astep",
    "as7341_gainx", "sample_age_ms", "sample_seq", "error_streak",
    "firmware_version", "schema_version", "scheduler", "flicker_hz",
    "rssi_dbm",
)
SENSOR_TEXT_FIELDS = {"firmware_version", "scheduler"}
SENSOR_VALUE_FIELDS = (
    "temp_c", "rh_pct", "pressure_pa", "als_raw", "uv_raw", "voc_index",
    "nox_index", "co2_ppm",
)


def sensor_number(value, integer=False):
    if value in (None, "", "NA", "N/A", "null"):
        return None
    try:
        number = float(value)
        return int(number) if integer else number
    except (TypeError, ValueError):
        return None


def sensor_timestamp(value):
    text = str(value or "").strip()
    if not text:
        return now_iso()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=CST)
        parsed = parsed.astimezone(CST)
        if parsed > datetime.now(CST) + timedelta(minutes=10):
            return now_iso()
        return parsed.isoformat(timespec="milliseconds")
    except ValueError:
        return now_iso()


def normalize_sensor_row(row, board=None):
    """把 JSON/CSV 输入统一成可存储、可公开同步的一行。"""
    source = dict(row or {})
    extra = source.pop("extra", {})
    if isinstance(extra, str):
        try:
            extra = json.loads(extra)
        except ValueError:
            extra = {}
    if not isinstance(extra, dict):
        extra = {}

    sensor = str(source.get("sensor") or "").strip()[:80]
    channel = str(source.get("channel") or "").strip().upper()
    channel_index = sensor_number(source.get("channel_index"), integer=True)
    if channel.isascii() and channel.isdigit():
        channel_index = int(channel)
        channel = "CH" + channel
    if not channel and channel_index is not None:
        channel = "CH%d" % channel_index
    if not channel and sensor:
        channel = sensor.split()[0].upper()

    board_id = str(board or source.get("board") or "firefly-r1-1").strip()
    board_id = board_id[:80] or "firefly-r1-1"
    ok_value = source.get("ok")
    ok = 1 if ok_value in (None, 1, "1", True, "true", "True") else 0
    normalized = {
        "ts": sensor_timestamp(source.get("ts")),
        "board": board_id,
        "uptime_ms": sensor_number(source.get("uptime_ms"), integer=True),
        "cycle": sensor_number(source.get("cycle"), integer=True),
        "channel": channel[:16] or None,
        "sensor": sensor or None,
        "ok": ok,
    }
    for name in SENSOR_VALUE_FIELDS:
        normalized[name] = sensor_number(source.get(name))

    known = set(normalized) | {"channel_index"}
    for key, value in source.items():
        if key not in known:
            if key in SENSOR_TEXT_FIELDS:
                extra[key] = str(value).strip()[:80]
            else:
                extra[key] = sensor_number(value) if key in SENSOR_CSV_FIELDS else value
    if channel_index is not None:
        extra["channel_index"] = channel_index
    normalized["extra"] = extra
    return normalized


def sensor_row_public(row):
    result = dict(row)
    extra = result.pop("extra", {})
    if isinstance(extra, str):
        try:
            extra = json.loads(extra)
        except ValueError:
            extra = {}
    if isinstance(extra, dict):
        for key, value in extra.items():
            if key not in result:
                result[key] = value
    result.pop("id", None)
    return result


def parse_sensor_csv_line(line):
    """解析固件原始 CSV 或 PC 监听器加过时间戳的 CSV，返回未入库字典。"""
    parts = line.rstrip("\r\n").split(",")
    if parts and parts[0] == "CSV":
        parts = parts[1:]
    if "uptime_ms" in parts or len(parts) < 6:
        return None
    timestamp = None
    if not parts[0].strip().isdigit():
        timestamp = parts.pop(0).strip()
    if len(parts) < 5:
        return None
    row = {
        name: parts[index].strip()
        for index, name in enumerate(SENSOR_CSV_FIELDS)
        if index < len(parts)
    }
    row["ts"] = timestamp or now_iso()
    row["channel"] = "CH" + str(row.get("channel_index", "")).strip()
    return row
