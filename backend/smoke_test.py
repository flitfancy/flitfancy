"""flitfancy 服务冒烟测试：启动服务 -> 写入数据 -> 读回 -> 关闭并清理。"""

import json
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(ROOT, "data", "flitfancy.db")
BASE = "http://127.0.0.1:2671"


def request(path, method="GET", body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    if os.path.exists(DB):
        os.remove(DB)
    proc = subprocess.Popen(
        [sys.executable, "server.py"], cwd=ROOT,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(2)
        status = request("/api/status")
        print("STATUS:", status["msg"])
        ingested = request("/api/ingest", "POST", {
            "channel": "CH0", "sensor": "CH0 SHT41",
            "ok": 1, "temp_c": 28.5, "rh_pct": 41.2,
        })
        print("INGEST: ok=%s rows=%s" % (ingested["ok"], ingested["ingested"]))
        latest = request("/api/sensors/latest")
        row = latest["rows"][0]
        print("LATEST: %s %.1f C" % (row["channel"], row["temp_c"]))
        request("/api/notes", "POST", {"author": "test", "content": "冒烟测试"})
        notes = request("/api/notes")
        print("NOTES:", notes["rows"][0]["content"])
        with urllib.request.urlopen(BASE + "/console.html", timeout=10) as r:
            html = r.read().decode("utf-8")
            print("PAGE: HTTP %d len=%d" % (r.status, len(html)))
        print("SMOKE TEST OK")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        if os.path.exists(DB):
            os.remove(DB)


if __name__ == "__main__":
    main()
