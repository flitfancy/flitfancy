"""Exercise Firefly's owner-only consultation without AstrBot or network access."""

import asyncio
import functools
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
os.environ["FLITFANCY_BACKEND_DIR"] = str(ROOT / "backend")
sys.path.insert(0, str(ROOT / "backend"))


def decorator(*args, **kwargs):
    return lambda function: function


class Star:
    def __init__(self, context):
        self.context = context


astrbot = types.ModuleType("astrbot")
api = types.ModuleType("astrbot.api")
event_module = types.ModuleType("astrbot.api.event")
star_module = types.ModuleType("astrbot.api.star")
message_module = types.ModuleType("astrbot.core.agent.message")
class TextPart:
    def __init__(self, text):
        self.text = text
message_module.TextPart = TextPart
api.logger = types.SimpleNamespace(warning=lambda *args, **kwargs: None)
event_module.AstrMessageEvent = object
event_module.filter = types.SimpleNamespace(on_llm_request=decorator, llm_tool=decorator)
star_module.Context = object
star_module.Star = Star
star_module.register = decorator
sys.modules.update({"astrbot": astrbot, "astrbot.api": api,
                    "astrbot.api.event": event_module, "astrbot.api.star": star_module,
                    "astrbot.core": types.ModuleType("astrbot.core"),
                    "astrbot.core.agent": types.ModuleType("astrbot.core.agent"),
                    "astrbot.core.agent.message": message_module})
spec = importlib.util.spec_from_file_location(
    "firefly_consult_fixture", ROOT / "integrations" / "astrbot_plugin_firefly_consult" / "main.py",
    submodule_search_locations=[str(ROOT / "integrations" / "astrbot_plugin_firefly_consult")])
plugin_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin_module
spec.loader.exec_module(plugin_module)
import flitfancy_openai
from flitfancy_consultations import ConsultationStore


class Context:
    def get_config(self):
        return {"admins_id": ["7"], "platform": [{"id": "qq-fixture", "type": "aiocqhttp"}]}


class Event:
    def __init__(self, sender="7", private=True, text="你好"):
        self.sender = sender
        self.private = private
        self.text = text
        self.unified_msg_origin = f"qq-fixture:FriendMessage:{sender}"
        self.extra = {}

    def get_sender_id(self):
        return self.sender

    def get_message_str(self):
        return self.text

    def is_private_chat(self):
        return self.private

    def get_extra(self, key):
        return self.extra.get(key)

    def set_extra(self, key, value):
        self.extra[key] = value


class ConsultTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="flit-consult-test-")
        root = Path(temporary.name).resolve()
        self.assertTrue(root.is_relative_to(Path(tempfile.gettempdir()).resolve()))
        self.addCleanup(temporary.cleanup)
        env = patch.dict(os.environ, {"FLITFANCY_CONSULT_DB_PATH": str(root / "consultations.db")})
        env.start()
        self.addCleanup(env.stop)
        settings = patch.object(flitfancy_openai, "configured_settings", return_value={
            "configured": True, "provider_label": "OpenAI", "model": "fixture-model",
            "profile_id": "0123456789abcdef",
        })
        settings.start()
        self.addCleanup(settings.stop)
        self.plugin = plugin_module.FireflyConsult(Context())

    def test_prompt_only_for_owner_and_not_duplicated(self):
        owner = Event()
        request = types.SimpleNamespace(system_prompt="原有人格")
        asyncio.run(self.plugin.offer_consultation(owner, request))
        asyncio.run(self.plugin.offer_consultation(owner, request))
        self.assertIn("原有人格", request.system_prompt)
        self.assertEqual(request.system_prompt.count(plugin_module.MARKER), 1)
        stranger = types.SimpleNamespace(system_prompt="原有人格")
        asyncio.run(self.plugin.offer_consultation(Event("8"), stranger))
        self.assertEqual(stranger.system_prompt, "原有人格")

    def test_required_schema_survives_astrbot_bound_handler(self):
        tool = types.SimpleNamespace(handler=functools.partial(plugin_module.FireflyConsult.consult_gpt, self.plugin),
                                     parameters={"type": "object", "properties": {"question": {"type": "string"}}})
        registry = types.ModuleType("astrbot.core.provider.register")
        registry.llm_tools = types.SimpleNamespace(get_func=lambda name: tool)
        with patch.dict(sys.modules, {"astrbot.core": types.ModuleType("astrbot.core"),
                                     "astrbot.core.provider": types.ModuleType("astrbot.core.provider"),
                                     "astrbot.core.provider.register": registry}):
            asyncio.run(self.plugin.initialize())
        self.assertEqual(tool.parameters["required"], ["question"])

    def test_owner_consults_once_and_other_sessions_never_call_cloud(self):
        owner, stranger, group = Event(), Event("8"), Event(private=False)
        with patch.object(plugin_module, "read_config", return_value={"openai_api_key": "fixture"}), \
             patch.object(flitfancy_openai, "ask_openai", return_value={"reply": "需进一步核对"}) as ask:
            self.assertIn("仅供主人", asyncio.run(self.plugin.consult_gpt(stranger, "问题")))
            self.assertIn("仅供主人", asyncio.run(self.plugin.consult_gpt(group, "问题")))
            self.assertIn("咨询问题需为", asyncio.run(self.plugin.consult_gpt(owner)))
            first = asyncio.run(self.plugin.consult_gpt(owner, "具体问题"))
            second = asyncio.run(self.plugin.consult_gpt(owner, "重复问题"))
        self.assertIn("需进一步核对", first)
        self.assertIn("已咨询过", second)
        self.assertEqual(ask.call_count, 1)
        self.assertEqual(ask.call_args.kwargs["purpose"], "consult")
        self.assertEqual(ask.call_args.args[0], [{"role": "user", "content": "具体问题"}])
        events = ConsultationStore().list_events()
        self.assertEqual([(row["phase"], row["content"]) for row in events],
                         [("question", "具体问题"), ("answer", "需进一步核对")])
        self.assertEqual(ConsultationStore().list_events(events[0]["seq"])[0]["content"], "需进一步核对")
        self.assertEqual(events[0]["consultation_id"], events[1]["consultation_id"])

    def test_missing_key_reports_failure_instead_of_inventing_result(self):
        with patch.object(plugin_module, "read_config", return_value={}), \
             patch.object(flitfancy_openai, "ask_openai", side_effect=flitfancy_openai.OpenAIError("尚未配置", 503)):
            result = asyncio.run(self.plugin.consult_gpt(Event(), "问题"))
        self.assertIn("未能咨询", result)
        self.assertIn("不要假装", result)
        self.assertEqual([row["phase"] for row in ConsultationStore().list_events()], ["question", "error"])

    def test_complex_preflight_uses_local_routing_and_minimal_context(self):
        event = Event(text="这个 ESP32 板子电压异常，请分析原因和排查步骤")
        original = types.SimpleNamespace(tools=[types.SimpleNamespace(name="consult_model"), types.SimpleNamespace(name="other")])
        request = types.SimpleNamespace(system_prompt="原有人格", func_tool=original,
            contexts=[{"role": "system", "content": "private system prompt"},
                      {"role": "user", "content": "前情：板子曾经异常"},
                      {"role": "assistant", "content": "板子曾经异常"}], extra_user_content_parts=[])
        with patch.object(plugin_module, "read_config", return_value={"openai_api_key": "fixture"}), \
             patch.object(flitfancy_openai, "ask_openai", return_value={"reply": "先断电检查"}) as ask:
            asyncio.run(self.plugin.offer_consultation(event, request))
        self.assertEqual(ask.call_count, 1)
        sent = ask.call_args.args[0][0]["content"]
        self.assertIn("最近相关对话", sent)
        self.assertNotIn("private system prompt", sent)
        self.assertIn("先断电检查", request.extra_user_content_parts[0].text)
        self.assertTrue(request.extra_user_content_parts[0].text.startswith("<system_reminder>"),
                        "internal reference must not appear as a user message in the existing voice snapshot")
        self.assertEqual([tool.name for tool in request.func_tool.tools], ["other"])
        self.assertEqual([tool.name for tool in original.tools], ["consult_model", "other"], "shared tools must not be mutated")

    def test_simple_and_explicit_local_only_never_trigger_preflight(self):
        for text in ["早上好", "不要用 GPT，帮我分析电路故障"]:
            event = Event(text=text)
            toolset = types.SimpleNamespace(tools=[types.SimpleNamespace(name="consult_model")])
            request = types.SimpleNamespace(system_prompt="", func_tool=toolset, contexts=[], extra_user_content_parts=[])
            with patch.object(flitfancy_openai, "ask_openai") as ask:
                asyncio.run(self.plugin.offer_consultation(event, request))
            self.assertEqual(ask.call_count, 0)
            if "不要" in text:
                self.assertEqual(request.func_tool.tools, [])
                self.assertIn("只用本地", request.system_prompt)

    def test_local_only_policy_and_natural_language_override_cloud(self):
        texts = ["不要用云模型，请分析网络故障", "这次别请求外部 AI，帮我诊断接口",
                 "仅本地回答：请分析接口故障", "只在本机分析接口故障",
                 "不要把我的内容发出去，分析接口故障", "不调用任何云模型，排查网络故障"]
        for text in texts:
            with self.subTest(text=text):
                event = Event(text=text)
                request = types.SimpleNamespace(system_prompt="", func_tool=types.SimpleNamespace(
                    tools=[types.SimpleNamespace(name="consult_model")]), contexts=[], extra_user_content_parts=[])
                with patch.object(flitfancy_openai, "ask_openai") as ask:
                    asyncio.run(self.plugin.offer_consultation(event, request))
                    asyncio.run(self.plugin.consult_gpt(event, "诊断问题"))
                self.assertEqual(ask.call_count, 0)
                self.assertEqual(request.func_tool.tools, [])
        event = Event(text="请咨询 GPT，分析网络故障")
        event.set_extra("firefly_model_policy", "local_only")
        request = types.SimpleNamespace(system_prompt="", func_tool=types.SimpleNamespace(
            tools=[types.SimpleNamespace(name="consult_model")]), contexts=[], extra_user_content_parts=[])
        with patch.object(flitfancy_openai, "ask_openai") as ask:
            asyncio.run(self.plugin.offer_consultation(event, request))
            asyncio.run(self.plugin.consult_gpt(event, "诊断问题"))
        self.assertEqual(ask.call_count, 0, "structured local-only policy overrides explicit cloud requests")
        self.assertEqual(request.func_tool.tools, [])

    def test_credentials_never_reach_consultation_or_ledger(self):
        samples = ["cfat_FIXTURE_ONLY_NOT_A_REAL_TOKEN_123456", "sk-FIXTURE_ONLY_NOT_A_REAL_KEY_123456",
                   "Authorization: Bearer fixtureOnlyTokenValue123456", "API_KEY=fixtureOnlyKeyValue123456"]
        for sample in samples:
            with self.subTest(kind=sample.split("_")[0][:8]):
                event = Event(text="请分析接口配置 " + sample)
                request = types.SimpleNamespace(system_prompt="", func_tool=types.SimpleNamespace(
                    tools=[types.SimpleNamespace(name="consult_model")]), contexts=[], extra_user_content_parts=[])
                with patch.object(flitfancy_openai, "ask_openai") as ask:
                    asyncio.run(self.plugin.offer_consultation(event, request))
                self.assertEqual(ask.call_count, 0)
                self.assertEqual(request.func_tool.tools, [])
                self.assertEqual(ConsultationStore().list_events(), [])
        event = Event(text="请分析这个接口的故障")
        request = types.SimpleNamespace(system_prompt="", func_tool=types.SimpleNamespace(
            tools=[types.SimpleNamespace(name="consult_model")]),
            contexts=[{"role": "user", "content": "令牌 cfat_FIXTURE_ONLY_NOT_A_REAL_TOKEN_123456"}], extra_user_content_parts=[])
        with patch.object(flitfancy_openai, "ask_openai") as ask:
            asyncio.run(self.plugin.offer_consultation(event, request))
        self.assertEqual(ask.call_count, 0, "sensitive referenced context must not be sent")
        self.assertEqual(ConsultationStore().list_events(), [])
        event = Event(text="帮我咨询模型")
        with patch.object(flitfancy_openai, "ask_openai") as ask:
            result = asyncio.run(self.plugin.consult_gpt(event, "接口 cfat_FIXTURE_ONLY_NOT_A_REAL_TOKEN_123456"))
        self.assertEqual(ask.call_count, 0, "tool-generated questions receive the same guard")
        self.assertIn("凭据", result)

    def test_consultation_includes_recent_current_session_context_only(self):
        event = Event(text="请分析网络故障")
        contexts = [{"role": "system", "content": "private system prompt"}]
        contexts += [{"role": "user" if index % 2 == 0 else "assistant", "content": f"历史{index}"}
                     for index in range(8)]
        request = types.SimpleNamespace(system_prompt="", func_tool=None, contexts=contexts, extra_user_content_parts=[])
        with patch.object(flitfancy_openai, "ask_openai", return_value={"reply": "合成答复"}) as ask:
            asyncio.run(self.plugin.offer_consultation(event, request))
        sent = ask.call_args.args[0][0]["content"]
        self.assertIn("历史2", sent)
        self.assertIn("历史7", sent)
        self.assertNotIn("历史0", sent)
        self.assertNotIn("private system prompt", sent)
        self.assertIn("请分析网络故障", sent)
        self.assertLessEqual(len(sent), 4000)

    def test_consultation_context_fits_worker_limit_for_emoji(self):
        event = Event(text="请分析网络故障" + "😀" * 1900)
        contexts = [{"role": "user", "content": "背景" + "😀" * 300} for _ in range(6)]
        request = types.SimpleNamespace(system_prompt="", func_tool=None, contexts=contexts, extra_user_content_parts=[])
        with patch.object(flitfancy_openai, "ask_openai", return_value={"reply": "合成答复"}) as ask:
            asyncio.run(self.plugin.offer_consultation(event, request))
        sent = ask.call_args.args[0][0]["content"]
        self.assertLessEqual(len(sent.encode("utf-16-le")) // 2, 4000)

    def test_local_model_tool_call_includes_current_session_context(self):
        event = Event(text="再帮我看看")
        request = types.SimpleNamespace(system_prompt="", func_tool=None,
            contexts=[{"role": "user", "content": "刚才说的项目背景"},
                      {"role": "assistant", "content": "已有的本地回答"}], extra_user_content_parts=[])
        with patch.object(flitfancy_openai, "ask_openai", return_value={"reply": "合成答复"}) as ask:
            asyncio.run(self.plugin.offer_consultation(event, request))
            self.assertEqual(ask.call_count, 0)
            asyncio.run(self.plugin.consult_gpt(event, "请分析方案"))
        sent = ask.call_args.args[0][0]["content"]
        self.assertIn("刚才说的项目背景", sent)
        self.assertIn("已有的本地回答", sent)
        self.assertIn("请分析方案", sent)


if __name__ == "__main__":
    unittest.main(verbosity=2)
