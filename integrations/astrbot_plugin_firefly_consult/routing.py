"""Conservative local routing for Firefly's owner-only GPT consultation."""

import re


_NO_CLOUD = re.compile(
    r"(?:只|仅|仅限)(?:能|要|需|在|使用|用|靠|通过){0,2}(?:本地|本机|离线)|纯本地|不联网|离线(?:处理|回答|分析)"
    r"|(?:不要|不用|别|禁止|不许|无需|不需要|不必|不能|不准|不想|拒绝|关掉|关闭|不(?=调用|使用|连接|发送|上传|访问)).{0,20}"
    r"(?:gpt|openai|deepseek|mimo|api|外部|第三方|外网|云|线上|在线|远程|联网|上网)"
    r"|(?:不要|别|禁止|不能).{0,15}(?:发|传|上传|分享|提交).{0,12}(?:外|网络|云|第三方|网上|出去)"
    r"|\b(?:local|offline)\s+only\b|\b(?:do\s+not|don't|never|no)\s+(?:use\s+|call\s+|access\s+)?(?:the\s+)?(?:cloud|external|remote|api|internet|openai|gpt)\b",
    re.I,
)
_EXPLICIT = re.compile(r"(?:问|查|用|咨询|请教|调用|交给|找).{0,12}(?:gpt|openai|deepseek|mimo|外部模型|云端|api)|(?:gpt|openai|deepseek|mimo).{0,8}(?:帮|分析|看看)", re.I)
_TASK = re.compile(r"分析|排查|诊断|调试|设计|对比|比较|推理|方案|原因|为什么|怎么修|如何修|故障")
_DOMAIN = re.compile(r"esp32|pcb|硬件|固件|代码|程序|接口|电路|供电|芯片|设备|板子|传感器|网络|模型|系统|故障|日志|项目", re.I)
_KEY = re.compile(
    r"(?<![A-Za-z0-9_])(?:sk-|tp-|cfat_|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}"
    r"|(?<![A-Za-z0-9_])Bearer\s+[A-Za-z0-9._~+/=-]{12,}"
    r"|(?:api[\s_-]*key|access[\s_-]*token|client[\s_-]*secret|secret(?:[\s_-]*key)?|password|passwd|密钥|令牌|密码)"
    r"\s*(?:=|:|：|是|为|is\b)\s*[\"']?[A-Za-z0-9._~+/=-]{8,}",
    re.I,
)


def cloud_disabled(text):
    return isinstance(text, str) and bool(_NO_CLOUD.search(text))


def should_consult(text):
    if not isinstance(text, str) or not text.strip() or cloud_disabled(text):
        return False
    if _EXPLICIT.search(text):
        return True
    return bool(_TASK.search(text) and (_DOMAIN.search(text) or len(text.strip()) >= 70))


def contains_sensitive(text):
    return isinstance(text, str) and bool(_KEY.search(text))


def redact_key(text):
    return _KEY.sub("[已隐藏密钥]", str(text or ""))


def relevant_context(text, contexts=None):
    current = str(text or "").strip()
    recent = []
    if isinstance(contexts, list):
        for item in reversed(contexts):
            if not isinstance(item, dict) or item.get("role") not in ("user", "assistant"):
                continue
            content = item.get("content")
            if not isinstance(content, str) or not content.strip() or content.strip() == current:
                continue
            recent.append((item["role"], content.strip()))
            if len(recent) == 6:
                break
    return list(reversed(recent))


def contains_sensitive_request(text, contexts=None):
    return contains_sensitive(text) or any(contains_sensitive(value) for _, value in relevant_context(text, contexts))


def _clip_units(text, limit, *, tail=False):
    selected, used = [], 0
    for char in reversed(text) if tail else text:
        width = 2 if ord(char) > 0xffff else 1
        if used + width > limit:
            break
        selected.append(char)
        used += width
    return "".join(reversed(selected) if tail else selected)


def _units(text):
    return sum(2 if ord(char) > 0xffff else 1 for char in text)


def build_question(text, contexts=None):
    current = redact_key(str(text or "").strip())
    if _units(current) > 2500:
        current = _clip_units(current, 1800) + "\n[中间内容已省略]\n" + _clip_units(current, 650, tail=True)
    recent = relevant_context(text, contexts)
    if not recent:
        return current
    budget = 4000 - _units("最近相关对话：\n\n\n当前问题：\n" + current)
    pieces = []
    for role, value in reversed(recent):
        label = ("用户" if role == "user" else "小流萤") + "："
        allowance = min(800, budget - _units(label) - 1)
        if allowance <= 0:
            break
        content = _clip_units(redact_key(value), allowance, tail=True)
        pieces.append(label + content)
        budget -= _units(label + content) + 1
    if not pieces:
        return current
    context = "\n".join(reversed(pieces))
    return "最近相关对话：\n" + context + "\n\n当前问题：\n" + current
