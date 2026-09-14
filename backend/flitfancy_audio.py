"""本机 FIREFLY VOICE 服务代理。

网站后端只负责固定目标、参数校验和流式转发；音频解码、Wi-Fi 设备会话与
SenseVoice 仍由 127.0.0.1:7865 上的 FFV-transfer 服务负责。
"""

from __future__ import annotations

import http.client
import json
import os
import urllib.parse


MAX_AUDIO_BYTES = 500 * 1024 * 1024
ALLOWED_AUDIO_EXTENSIONS = {
    ".ncm", ".flac", ".mp3", ".wav", ".aac", ".m4a", ".ogg", ".opus",
}


class AudioServiceError(RuntimeError):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = int(status)


class AudioService:
    """访问固定在回环地址上的 FFV-transfer HTTP 服务。"""

    def __init__(self, base_url=None):
        value = (base_url or os.environ.get("FLITFANCY_AUDIO_URL")
                 or "http://127.0.0.1:7865").strip()
        parsed = urllib.parse.urlsplit(value)
        if (parsed.scheme != "http" or parsed.hostname not in
                {"127.0.0.1", "localhost", "::1"} or parsed.username
                or parsed.password or parsed.path not in ("", "/")):
            raise ValueError("FLITFANCY_AUDIO_URL 必须是无凭证的本机 HTTP 地址")
        self.host = parsed.hostname
        self.port = parsed.port or 80

    def _connection(self, timeout=8):
        return http.client.HTTPConnection(self.host, self.port, timeout=timeout)

    @staticmethod
    def _decode_response(response):
        body = response.read(2 * 1024 * 1024 + 1)
        if len(body) > 2 * 1024 * 1024:
            raise AudioServiceError("音频服务返回内容异常", 502)
        try:
            data = json.loads(body.decode("utf-8")) if body else {}
        except (UnicodeDecodeError, ValueError):
            data = {}
        if response.status < 200 or response.status >= 300:
            detail = data.get("detail") or data.get("error") or "音频服务请求失败"
            raise AudioServiceError(str(detail), response.status)
        if not isinstance(data, dict):
            raise AudioServiceError("音频服务返回格式异常", 502)
        return data

    def _json(self, method, path, payload=None, timeout=8):
        connection = self._connection(timeout)
        body = None
        headers = {}
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        try:
            connection.request(method, path, body=body, headers=headers)
            return self._decode_response(connection.getresponse())
        except AudioServiceError:
            raise
        except (OSError, http.client.HTTPException) as exc:
            raise AudioServiceError("FIREFLY VOICE 本机服务未连接", 503) from exc
        finally:
            connection.close()

    def status(self):
        try:
            data = self._json("GET", "/status", timeout=3)
            return {"available": True, **data}
        except AudioServiceError as exc:
            return {"available": False, "board_connected": False,
                    "model": "offline", "error": str(exc)}

    def history(self, span='24h', end=None):
        import math
        if span not in ('5m', '1h', '24h', '7d', '30d', 'all'):
            raise AudioServiceError('时间范围无效', 400)
        params = {'span': span}
        if end is not None:
            try:
                end = float(end)
                if not math.isfinite(end) or not 0 <= end <= 32503680000:
                    raise ValueError()
            except (ValueError, TypeError):
                raise AudioServiceError('结束时间无效', 400) from None
            params['end'] = end
        return self._json('GET', '/v1/audio/history?' + urllib.parse.urlencode(params))

    def control(self, action, value=None):
        if action == "aec":
            if not isinstance(value, bool):
                raise AudioServiceError("回声消除开关必须为布尔值", 400)
            path = "/aec/" + str(int(value))
        elif action == "wakeword":
            if not isinstance(value, bool):
                raise AudioServiceError("语音唤醒开关必须为布尔值", 400)
            path = "/wakeword/" + str(int(value))
        elif action == "mic":
            if value not in ("left", "right", "both"):
                raise AudioServiceError("麦克风模式必须是 left、right 或 both", 400)
            path = "/mic/" + value
        elif action == "gain":
            if value not in (1, 2, 4, 8):
                raise AudioServiceError("麦克风增益必须是 1、2、4 或 8", 400)
            path = "/gain/" + str(value)
        elif action == "volume":
            if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 100:
                raise AudioServiceError("播放音量必须在 0 到 100 之间", 400)
            path = "/volume/" + str(value)
        elif action == "record-start":
            if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 600:
                raise AudioServiceError("录音时长必须在 1 到 600 秒之间", 400)
            path = "/start?seconds=" + str(value)
        elif action == "record-stop":
            path = "/stop"
        elif action == "play-stop":
            path = "/stop-playback"
        elif action == "play-pause":
            path = "/pause-playback"
        elif action == "play-resume":
            path = "/resume-playback"
        elif action == "device-reboot":
            path = "/device/reboot"
        else:
            raise AudioServiceError("未知音频控制命令", 400)
        return self._json("POST", path, timeout=8)

    def send_dialogue(self, text, request_id):
        if not isinstance(text, str) or not text.strip() or len(text) > 2000:
            raise AudioServiceError("消息长度需为 1–2000 字", 400)
        import uuid
        try:
            if str(uuid.UUID(request_id)) != request_id:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise AudioServiceError("请求编号无效", 400) from None
        return self._json("POST", "/v1/dialogue/messages", {"text": text, "request_id": request_id})

    @staticmethod
    def validate_filename(filename):
        raw = str(filename or "").strip().replace("\\", "/")
        name = raw.rsplit("/", 1)[-1][:240]
        extension = os.path.splitext(name)[1].lower()
        if not name or extension not in ALLOWED_AUDIO_EXTENSIONS:
            raise AudioServiceError("不支持的音频格式", 400)
        return name

    def upload(self, stream, length, filename):
        name = self.validate_filename(filename)
        if not isinstance(length, int) or length <= 0:
            raise AudioServiceError("音频文件为空", 400)
        if length > MAX_AUDIO_BYTES:
            raise AudioServiceError("音频文件超过 500 MB 上限", 413)
        target = "/play-file?filename=" + urllib.parse.quote(name)
        connection = self._connection(30)
        received = 0
        # BufferedReader.read(n) waits for all n bytes. Forward available bytes
        # immediately so slow tunnel uploads expose progress and stay responsive.
        read_chunk = getattr(stream, "read1", stream.read)
        try:
            connection.putrequest("POST", target)
            connection.putheader("Content-Type", "application/octet-stream")
            connection.putheader("Content-Length", str(length))
            connection.endheaders()
            while received < length:
                chunk = read_chunk(min(64 * 1024, length - received))
                if not chunk:
                    break
                connection.send(chunk)
                received += len(chunk)
            if received != length:
                raise AudioServiceError(
                    "音频文件传输不完整：%d/%d" % (received, length), 400,
                )
            return self._decode_response(connection.getresponse())
        except AudioServiceError:
            raise
        except TimeoutError as exc:
            raise AudioServiceError("音频文件上传停滞超过 30 秒，请重新拖入", 408) from exc
        except (OSError, http.client.HTTPException) as exc:
            raise AudioServiceError("FIREFLY VOICE 本机服务未连接", 503) from exc
        finally:
            connection.close()

    def open_recording(self, name):
        filename = str(name or "")
        if (os.path.basename(filename) != filename or not filename.endswith(".wav")
                or len(filename) > 160):
            raise AudioServiceError("录音文件名无效", 400)
        connection = self._connection(30)
        try:
            path = "/recordings/" + urllib.parse.quote(filename)
            connection.request("GET", path)
            response = connection.getresponse()
            if response.status != 200:
                try:
                    self._decode_response(response)
                finally:
                    connection.close()
            return connection, response
        except AudioServiceError:
            raise
        except (OSError, http.client.HTTPException) as exc:
            connection.close()
            raise AudioServiceError("录音文件暂不可用", 503) from exc

    def upload_firmware(self, stream, length):
        if not isinstance(length, int) or not 288 <= length <= 0x640000:
            raise AudioServiceError("请选择不超过 6.25 MiB 的应用固件", 413)
        connection = self._connection(30)
        read_chunk = getattr(stream, "read1", stream.read)
        try:
            connection.putrequest("POST", "/device/firmware")
            connection.putheader("Content-Type", "application/octet-stream")
            connection.putheader("Content-Length", str(length))
            connection.endheaders()
            received = 0
            while received < length:
                chunk = read_chunk(min(65536, length - received))
                if not chunk:
                    raise AudioServiceError("固件上传不完整", 400)
                connection.send(chunk)
                received += len(chunk)
            return self._decode_response(connection.getresponse())
        except AudioServiceError:
            raise
        except TimeoutError as exc:
            raise AudioServiceError("固件上传停滞，请重新选择文件", 408) from exc
        except (OSError, http.client.HTTPException) as exc:
            raise AudioServiceError("固件服务暂不可用", 503) from exc
        finally:
            connection.close()
