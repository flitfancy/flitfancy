"""Authenticated Cloudflare model gateway; provider keys never persist locally."""
import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request

from flitfancy_sync import WORKER_UA

WORKER_ORIGIN = "https://api.flitfancy.com"
CF_SECRET_URL = ("https://api.cloudflare.com/client/v4/accounts/"
                 "99007f44dc64030aa39ddba200194c89/workers/scripts/flitfancy/secrets")
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
ERRORS = {
    "invalid_provider": "请选择有效的模型服务。",
    "invalid_model": "请输入有效的模型名称。",
    "invalid_base_url": "接口地址必须是有效的 HTTPS 地址。",
    "invalid_key": "API 密钥格式不正确。",
    "key_required": "更换接口地址后，请重新输入该服务的密钥。",
    "setup_required": "请先在控制台配置 Cloudflare 管理令牌。",
    "not_configured": "模型接口尚未配置，请在控制台设置。",
    "chat_disabled": "网页模型直聊未开放。",
    "profile_changed": "模型配置已改变，请开启新对话。",
    "daily_limit": "访客今日对话次数已用完。",
    "invalid_messages": "对话内容为空或过长。",
    "upstream_error": "模型服务暂时无法完成请求。",
    "invalid_api_key": "模型服务拒绝了 API 密钥，请检查密钥是否有效。",
    "insufficient_balance": "模型服务账户余额不足，请检查所选服务的额度。",
    "provider_forbidden": "模型服务拒绝了访问，请检查账户权限。",
    "model_not_found": "模型或接口地址不存在，请检查配置。",
    "provider_rate_limit": "模型服务请求过于频繁，请稍后再试。",
    "invalid_request": "模型服务无法处理请求，请检查模型和接口配置。",
    "provider_connection": "云端无法连接所选模型服务，请稍后重试。",
    "provider_redirect": "模型接口发生跳转；为保护密钥，请在控制台填写最终接口地址。",
    "provider_unavailable": "模型服务暂时不可用，请稍后重试。",
    "invalid_response": "模型服务返回格式异常。",
    "incomplete_response": "模型未完成本次回答，请重试。",
    "empty_response": "模型没有返回文字，请重试。",
    "manager_error": "Cloudflare 未能保存密钥，请检查管理令牌权限。",
    "partial_save": "密钥可能已保存，但模型设置未完成。请先刷新状态确认，再决定是否重试。",
}


class OpenAIError(Exception):
    def __init__(self, message, status=502, code="gateway_error"):
        super().__init__(message)
        self.status = status
        self.code = code


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _transport(opener=None):
    return opener or urllib.request.build_opener(NoRedirect())


def _worker_credentials(config):
    config = config if isinstance(config, dict) else {}
    url = str(config.get("worker_admin_url") or "").rstrip("/")
    token = config.get("worker_admin_token")
    # A configured URL cannot redirect administrative credentials elsewhere.
    if url != WORKER_ORIGIN or not isinstance(token, str) or len(token) < 32:
        raise OpenAIError("网站与 Cloudflare 的管理连接尚未配置。", 503, "gateway_unavailable")
    return token


def _response_json(response):
    raw = response.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise OpenAIError("云端接口返回内容过大。", 502, "gateway_error")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError):
        raise OpenAIError("云端接口返回格式异常，请确认网站已更新。", 502, "gateway_error") from None
    if not isinstance(data, dict):
        raise OpenAIError("云端接口返回格式异常。", 502, "gateway_error")
    return data


def gateway_request(config, endpoint, body=None, *, opener=None, timeout=95):
    if endpoint not in ("/admin/model/status", "/admin/model/config", "/admin/model/chat"):
        raise OpenAIError("云端接口路径无效。", 500, "gateway_error")
    token = _worker_credentials(config)
    path = endpoint
    if endpoint == "/admin/model/status" and isinstance(body, dict) and body.get("provider"):
        path += "?" + urllib.parse.urlencode({"provider": body["provider"]})
    data = None if endpoint == "/admin/model/status" else json.dumps(body or {}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(WORKER_ORIGIN + path, data=data,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token, "User-Agent": WORKER_UA},
        method="GET" if data is None else "POST")
    try:
        with _transport(opener).open(request, timeout=timeout) as response:
            result = _response_json(response)
    except urllib.error.HTTPError as exc:
        try:
            result = _response_json(exc)
        except OpenAIError:
            result = {}
        finally:
            exc.close()
        code = result.get("code") if result.get("code") in ERRORS else "gateway_error"
        message = ERRORS.get(code, "云端接口暂不可用，请确认网站已更新。")
        status_code = exc.code if exc.code in (400, 403, 409, 429, 503) else 502
        raise OpenAIError(message, status_code, code) from None
    except (urllib.error.URLError, TimeoutError, socket.timeout, OSError):
        raise OpenAIError("无法连接 Cloudflare，请检查网络与网站发布状态。", 503, "gateway_unavailable") from None
    if result.get("ok") is not True:
        raise OpenAIError("云端接口暂不可用，请确认网站已更新。", 502, "gateway_error")
    return result


def public_status(config=None, environ=None, provider=None, *, opener=None):
    result = gateway_request(config, "/admin/model/status", {"provider": provider} if provider else None, opener=opener, timeout=12)
    fields = ("configured", "provider", "provider_label", "selected_provider", "model", "base_url",
              "profile_id", "access", "public_daily_limit", "manager_ready", "storage")
    return {name: result[name] for name in fields if name in result}


def configured_settings(config=None, environ=None, provider=None):
    return public_status(config, environ, provider)


def save_gateway_config(config, data, *, opener=None):
    allowed = ("provider", "model", "base_url", "api_key", "access", "public_daily_limit")
    payload = {key: data[key] for key in allowed if key in data}
    result = gateway_request(config, "/admin/model/config", payload, opener=opener, timeout=35)
    return {name: result[name] for name in ("configured", "provider", "provider_label", "selected_provider", "model",
            "base_url", "profile_id", "access", "public_daily_limit", "manager_ready", "storage", "pending") if name in result}


def bootstrap_secret_manager(value, *, opener=None):
    """Install the scoped CF token directly into this one Worker and discard it."""
    if not isinstance(value, str) or not re.fullmatch(r"[\x21-\x7e]{15,512}", value):
        raise OpenAIError("Cloudflare 管理令牌格式不正确。", 400, "invalid_manager_token")
    request = urllib.request.Request(CF_SECRET_URL,
        data=json.dumps({"name": "CF_SECRET_MANAGER_TOKEN", "text": value, "type": "secret_text"}).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + value, "User-Agent": WORKER_UA}, method="PUT")
    try:
        with _transport(opener).open(request, timeout=25) as response:
            result = _response_json(response)
    except (urllib.error.URLError, TimeoutError, socket.timeout, OSError):
        raise OpenAIError("无法保存 Cloudflare 管理令牌，请检查网络、权限和 Worker 范围。", 502, "manager_error") from None
    if result.get("success") is not True:
        raise OpenAIError("Cloudflare 未接受管理令牌，请检查权限和 Worker 范围。", 502, "manager_error")
    return {"ok": True}


def ask_openai(messages, config=None, *, purpose="chat", opener=None, timeout=95, environ=None, profile_id=None):
    body = {"messages": messages, "purpose": purpose}
    if profile_id:
        body["profile_id"] = profile_id
    result = gateway_request(config, "/admin/model/chat", body, opener=opener, timeout=timeout)
    reply = result.get("reply")
    if not isinstance(reply, str) or not reply.strip():
        raise OpenAIError("模型没有返回文字，请重试。", 502, "gateway_error")
    return {name: result[name] for name in ("reply", "model", "provider", "provider_label", "usage") if name in result}
