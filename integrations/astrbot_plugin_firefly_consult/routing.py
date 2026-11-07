"""Conservative local routing for Firefly's owner-only GPT consultation."""

import re


_NO_CLOUD = re.compile(r"(?:不要|不用|别|禁止|不许|无需|不需要).{0,8}(?:gpt|openai|deepseek|mimo|外部模型|云端|联网|api)|只用本地|仅用本地|不联网", re.I)
_EXPLICIT = re.compile(r"(?:问|查|用|咨询|请教|调用|交给|找).{0,12}(?:gpt|openai|deepseek|mimo|外部模型|云端|api)|(?:gpt|openai|deepseek|mimo).{0,8}(?:帮|分析|看看)", re.I)
_TASK = re.compile(r"分析|排查|诊断|调试|设计|对比|比较|推理|方案|原因|为什么|怎么修|如何修|故障")
_DOMAIN = re.compile(r"esp32|pcb|硬件|固件|代码|程序|接口|电路|供电|芯片|设备|板子|传感器|网络|模型|系统|故障|日志|项目", re.I)
_REFERENCE = re.compile(r"这个|那个|刚才|上次|之前|继续|它的|这块|那块")
_KEY = re.compile(r"\b(?:sk-|tp-)[A-Za-z0-9_-]{12,}")


def cloud_disabled(text):
    return isinstance(text, str) and bool(_NO_CLOUD.search(text))


def should_consult(text):
    if not isinstance(text, str) or not text.strip() or cloud_disabled(text):
        return False
    if _EXPLICIT.search(text):
        return True
    return bool(_TASK.search(text) and (_DOMAIN.search(text) or len(text.strip()) >= 70))


def redact_key(text):
    return _KEY.sub("[已隐藏密钥]", str(text or ""))


def build_question(text, contexts=None):
    current = redact_key(str(text or "").strip())
    if len(current) > 3000:
        current = current[:2200] + "\n[中间内容已省略]\n" + current[-700:]
    recent = []
    if _REFERENCE.search(current) and isinstance(contexts, list):
        for item in reversed(contexts):
            if not isinstance(item, dict) or item.get("role") not in ("user", "assistant"):
                continue
            content = item.get("content")
            if not isinstance(content, str) or not content.strip() or content.strip() == current:
                continue
            recent.append((item["role"], redact_key(content.strip())[-400:]))
            if len(recent) == 2:
                break
    if not recent:
        return current
    context = "\n".join(("用户" if role == "user" else "小流萤") + "：" + value for role, value in reversed(recent))
    return "最近相关对话：\n" + context + "\n\n当前问题：\n" + current
