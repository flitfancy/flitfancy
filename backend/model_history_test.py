"""Conversation history is private, durable and scoped to one model session."""
import copy
import json
import os
import sqlite3
import subprocess
import tempfile
import threading
import unittest
import uuid
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import fields
from datetime import timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path

from flitfancy_openai import OpenAIError
from flitfancy_model_history import ModelHistoryError, ModelHistoryService
import flitfancy_http


class ModelHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="flit-model-history-")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "test.db"
        self.calls = []
        def db():
            connection = sqlite3.connect(self.path, timeout=5)
            connection.row_factory = sqlite3.Row
            return connection
        def model(messages, config, *, profile_id, provider=None, model=None, effort=None):
            self.calls.append(copy.deepcopy(messages))
            return {"reply": "答复 " + messages[-1]["content"], "model": "fixture-model", "provider_label": "fixture"}
        self.db, self.model = db, model
        self.service = ModelHistoryService(db, lambda: {}, model)
        self.profile = "1234567890abcdef"

    def send(self, session, text, *, request=None, profile=None):
        return self.service.send(session, request or str(uuid.uuid4()), text, profile or self.profile)

    def test_history_survives_restart_and_context_stays_in_current_session(self):
        first = self.service.create_conversation()["id"]
        second = self.service.create_conversation()["id"]
        self.send(first, "旧会话第一句")
        self.send(first, "旧会话第二句")
        self.send(second, "新会话第一句")
        self.assertEqual(self.calls[-1], [{"role": "user", "content": "新会话第一句"}])
        resumed = ModelHistoryService(self.db, lambda: {}, self.model)
        self.assertEqual(len(resumed.get_conversation(first)["turns"]), 2)
        self.assertEqual(len(resumed.list_conversations()["conversations"]), 2)
        resumed.send(first, str(uuid.uuid4()), "继续旧会话", self.profile)
        contents = [item["content"] for item in self.calls[-1]]
        self.assertIn("旧会话第一句", contents)
        self.assertIn("旧会话第二句", contents)
        self.assertNotIn("新会话第一句", contents)
        self.assertEqual(contents[-1], "继续旧会话")

    def test_context_is_bounded_and_old_history_remains_viewable(self):
        session = self.service.create_conversation()["id"]
        for index in range(12):
            self.send(session, "问题%d" % index)
        self.assertLessEqual(len(self.calls[-1]), 19)
        self.assertNotIn("问题0", [item["content"] for item in self.calls[-1]])
        first_page = self.service.get_conversation(session, limit=5)
        self.assertTrue(first_page["has_more"])
        older = self.service.get_conversation(session, before=first_page["next_before"], limit=20)
        self.assertEqual(older["turns"][0]["text"], "问题0")

    def test_context_fits_worker_byte_limit_for_multibyte_text(self):
        session = self.service.create_conversation()["id"]
        def model(messages, config, *, profile_id):
            self.calls.append(copy.deepcopy(messages))
            return {"reply": "答" * 6000, "model": "fixture", "provider_label": "fixture"}
        self.service.call_model = model
        for _ in range(8): self.send(session, "问" * 3900)
        encoded = json.dumps({"messages": self.calls[-1], "purpose": "chat", "profile_id": self.profile}, ensure_ascii=False).encode("utf-8")
        self.assertLess(len(encoded), 64 * 1024)

    def test_context_fits_worker_byte_limit_for_json_escaping(self):
        session = self.service.create_conversation()["id"]
        def model(messages, config, *, profile_id):
            self.calls.append(copy.deepcopy(messages))
            return {"reply": "\\\"" * 6000, "model": "fixture", "provider_label": "fixture"}
        self.service.call_model = model
        for _ in range(8): self.send(session, "\\\"" * 1900)
        encoded = json.dumps({"messages": self.calls[-1], "purpose": "chat", "profile_id": self.profile}, ensure_ascii=False).encode("utf-8")
        self.assertLess(len(encoded), 64 * 1024)

    def test_failure_is_saved_but_not_implicitly_sent_again(self):
        session = self.service.create_conversation()["id"]
        self.send(session, "成功问题")
        def fail(messages, config, *, profile_id):
            raise OpenAIError("模型暂不可用", 502, "upstream_error")
        self.service.call_model = fail
        with self.assertRaises(OpenAIError): self.send(session, "失败问题")
        self.service.call_model = self.model
        self.send(session, "新的问题")
        contents = [item["content"] for item in self.calls[-1]]
        self.assertNotIn("失败问题", contents)
        self.assertEqual(self.service.get_conversation(session)["turns"][-2]["status"], "failed")

    def test_profile_change_does_not_send_old_context_to_another_model(self):
        session = self.service.create_conversation()["id"]
        self.send(session, "原会话")
        with self.assertRaises(ModelHistoryError) as caught:
            self.send(session, "换一个服务", profile="fedcba0987654321")
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(len(self.calls), 1)

    def test_provider_switch_requires_choice_and_reset_survives_reopening(self):
        session = self.service.create_conversation()["id"]
        def model(messages, config, **options):
            self.calls.append((copy.deepcopy(messages), options))
            return {"reply": "reply", "model": "fixture", "provider_label": options.get("provider", "")}
        self.service.call_model = model
        self.service.send(session, str(uuid.uuid4()), "old question", self.profile, provider="openai", effort="low")
        other = "fedcba0987654321"
        with self.assertRaises(ModelHistoryError) as caught:
            self.service.send(session, str(uuid.uuid4()), "unapproved switch", other, provider="deepseek")
        self.assertEqual(caught.exception.code, "context_choice_required")
        self.service.send(session, str(uuid.uuid4()), "carry question", other, provider="deepseek", effort="high", context_policy="carry")
        self.assertIn("old question", [row["content"] for row in self.calls[-1][0]])
        self.service.send(session, str(uuid.uuid4()), "new boundary", self.profile, provider="openai", context_policy="reset")
        self.assertEqual([row["content"] for row in self.calls[-1][0]], ["new boundary"])
        reopened = ModelHistoryService(self.db, lambda: {}, model)
        reopened.send(session, str(uuid.uuid4()), "follow up", self.profile, provider="openai", effort="medium")
        self.assertEqual([row["content"] for row in self.calls[-1][0]], ["new boundary", "reply", "follow up"])
        turns = reopened.get_conversation(session)["turns"]
        self.assertEqual(len(turns), 4, "reset does not remove older visible history")
        self.assertEqual(turns[2]["context_reset"], 1)
        self.assertEqual(turns[-1]["effort"], "medium")

    def test_additive_migration_preserves_existing_history(self):
        session = str(uuid.uuid4())
        connection = self.db()
        try:
            connection.execute("CREATE TABLE model_conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,profile_id TEXT NOT NULL,provider_label TEXT NOT NULL,model TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)")
            connection.execute("CREATE TABLE model_conversation_turns(seq INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL,request_id TEXT UNIQUE NOT NULL,text TEXT NOT NULL,reply TEXT NOT NULL,status TEXT NOT NULL,error TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)")
            connection.execute("INSERT INTO model_conversations VALUES(?,?,?,?,?,?,?)", (session, "old", self.profile, "OpenAI", "model", "now", "now"))
            connection.execute("INSERT INTO model_conversation_turns(conversation_id,request_id,text,reply,status,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", (session,str(uuid.uuid4()),"before upgrade","saved reply","complete","","now","now"))
            connection.commit()
        finally:
            connection.close()
        loaded = self.service.get_conversation(session)
        self.assertEqual(loaded["turns"][0]["text"], "before upgrade")
        self.assertEqual((loaded["turns"][0]["provider"], loaded["turns"][0]["model"]), ("openai", "model"))
        self.send(session, "after upgrade")
        self.assertIn("before upgrade", [row["content"] for row in self.calls[-1]])

    def test_same_provider_model_switch_keeps_selected_conversation(self):
        session = self.service.create_conversation()["id"]
        calls = []
        def model(messages, config, **options):
            calls.append((copy.deepcopy(messages), options))
            return {"reply": "answer", "model": options.get("model", ""), "provider_label": "OpenAI"}
        self.service.call_model = model
        self.service.send(session, str(uuid.uuid4()), "first", self.profile, provider="openai", model="gpt-6.1-sol")
        self.service.send(session, str(uuid.uuid4()), "second", "3333333333333333", provider="openai", model="gpt-6-astra", effort="high", context_policy="carry")
        self.assertEqual([m["content"] for m in calls[-1][0]], ["first", "answer", "second"])
        self.assertEqual(calls[-1][1]["model"], "gpt-6-astra")
        with self.assertRaises(ModelHistoryError):
            self.service.send(session, str(uuid.uuid4()), "x", self.profile, provider="openai", model="sk-fixture-key-not-a-model-123456789", context_policy="carry")

    def test_request_id_deduplicates_pending_and_completed_calls(self):
        session = self.service.create_conversation()["id"]
        request = str(uuid.uuid4())
        entered, release = threading.Event(), threading.Event()
        def slow(messages, config, *, profile_id):
            self.calls.append(copy.deepcopy(messages)); entered.set(); release.wait(5)
            return {"reply": "完成", "model": "fixture-model", "provider_label": "fixture"}
        self.service.call_model = slow
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(self.send, session, "一次请求", request=request)
            self.assertTrue(entered.wait(3))
            self.assertEqual(self.send(session, "一次请求", request=request)["state"], "pending")
            release.set()
            self.assertEqual(pending.result(timeout=5)["state"], "complete")
        self.assertEqual(self.send(session, "一次请求", request=request)["state"], "complete")
        self.assertEqual(len(self.calls), 1)
        with self.assertRaises(ModelHistoryError): self.send(session, "不同内容", request=request)

    def test_interrupted_turn_is_not_automatically_retried(self):
        session = self.service.create_conversation()["id"]
        self.service.begin_turn(session, str(uuid.uuid4()), "中断问题", self.profile)
        restarted = ModelHistoryService(self.db, lambda: {}, self.model)
        turns = restarted.get_conversation(session)["turns"]
        self.assertEqual(turns[0]["status"], "interrupted")
        self.assertEqual(self.calls, [])

    def test_http_history_requires_admin_and_reloads_same_session(self):
        class Domain:
            def __getattr__(self, name): raise AssertionError("unexpected access to " + name)
        deps = {field.name: lambda *args, **kwargs: None for field in fields(flitfancy_http.HttpDependencies)}
        for name in ("audio_service", "sensor_device_service", "activity_service", "bridge_service", "launcher_service", "collector_service", "observation_service", "essay_service", "resource_service", "worker_client", "ai_opener"):
            deps[name] = Domain()
        deps.update(model_history_service=self.service, read_local_config=lambda: {},
                    admin_token_valid=lambda token, ip: token == "fixture-admin", cst=timezone(timedelta(hours=8)),
                    cfg_bool=lambda value, default: default if value is None else bool(value),
                    site_root="", mime={}, memories_select="*", sensor_retention_days=14)
        handler = flitfancy_http.create_handler(flitfancy_http.HttpDependencies(**deps))
        handler.log_message = lambda *args: None
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        def request(path, method="GET", body=None, auth=False, headers=None):
            send_headers = {"Content-Type": "application/json", **(headers or {})}
            if auth: send_headers["Authorization"] = "Bearer fixture-admin"
            request = urllib.request.Request("http://127.0.0.1:%d%s" % (server.server_port, path),
                data=json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None,
                headers=send_headers, method=method)
            try: response = urllib.request.urlopen(request, timeout=3)
            except urllib.error.HTTPError as error: response = error
            with response: return response.status, json.loads(response.read())
        try:
            base = "/api/model-gateway/conversations"
            self.assertEqual(request(base)[0], 401)
            self.assertEqual(request(base, "POST")[0], 401)
            self.assertEqual(request(base, "POST", auth=True, headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
            status, created = request(base, "POST", {}, True)
            self.assertEqual(status, 200)
            session = created["conversation"]["id"]
            turn = {"request_id": str(uuid.uuid4()), "text": "你好", "profile_id": self.profile}
            status, result = request(base + "/" + session + "/turns", "POST", turn, True)
            self.assertEqual((status, result["state"], result["turn"]["reply"]), (200, "complete", "答复 你好"))
            status, saved = request(base + "/" + session, auth=True)
            self.assertEqual((status, saved["turns"][0]["text"]), (200, "你好"))
            self.assertEqual(request(base + "/" + session)[0], 401)
            self.assertEqual(len(request(base, auth=True)[1]["conversations"]), 1)
            javascript = r'''
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const {randomUUID} = require('node:crypto');
class Element {
  constructor(){this.children=[];this.handlers={};this.value='';this.hidden=false;this.disabled=false;this.textContent='';this.scrollHeight=20;this.scrollTop=0;}
  appendChild(item){this.children.push(item)} replaceChildren(){this.children=[]}
  addEventListener(name,fn){this.handlers[name]=fn} setAttribute(){}
}
const selections=new Map();
const window={crypto:{randomUUID},setTimeout,clearTimeout,sessionStorage:{getItem:k=>selections.get(k)||null,setItem:(k,v)=>selections.set(k,v),removeItem:k=>selections.delete(k)}};
vm.runInNewContext(fs.readFileSync('docs/assets/console-model-history.js','utf8'),{window,Date,Promise,Error,Object,String,Number,Array,JSON,RegExp});
vm.runInNewContext(fs.readFileSync('docs/assets/console-gpt.js','utf8'),{window,document:{createElement:()=>new Element()},Map,Set});
const profiles=[{provider:'openai',provider_label:'OpenAI',model:'fixture-model',profile_id:'1234567890abcdef',efforts:['auto','high']},
                {provider:'deepseek',provider_label:'DeepSeek',model:'fixture-ds',profile_id:'fedcba0987654321',efforts:['auto','high']}];
const request=async(url,options={})=>{
  if(url==='/api/model-gateway/status')return {configured:true,access:'admin',selected_provider:'openai',...profiles[0]};
  if(url==='/api/model-gateway/catalog')return {profiles,selected_provider:'openai'};
  const response=await fetch('http://127.0.0.1:'+process.env.FIXTURE_PORT+url,{method:options.method||'GET',headers:{'Authorization':'Bearer fixture-admin','Content-Type':'application/json'},body:options.body});
  const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error),{status:response.status,data});return data;
};
function mount(){const nodes=new Map(),query=k=>{if(!nodes.has(k))nodes.set(k,new Element());return nodes.get(k)};return {get:r=>query('[data-role="'+r+'"]'),chat:window.FlitFancyConsoleGPT.create({query,request})};}
const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
(async()=>{
  const a=mount();a.chat.start();a.chat.setAuthenticated(true);await a.chat.refreshStatus();await tick();await a.chat.selectSession('');
  a.get('gpt-input').value='first session';await a.chat.send();const first=selections.get('flitfancy-model-admin-active');
  await a.chat.selectSession('');a.get('gpt-input').value='other session';await a.chat.send();
  await a.chat.selectSession(first);a.chat.dispose();
  const b=mount();b.chat.start();b.chat.setAuthenticated(true);await b.chat.refreshStatus();await tick();
  assert.equal(b.get('gpt-log').children[0].children[1].textContent,'first session');
  b.get('gpt-input').value='continue first';await b.chat.send();
  b.get('gpt-provider').value=profiles[1].profile_id;b.get('gpt-provider').handlers.change();
  assert.equal(b.get('gpt-switch-choice').hidden,false);
  b.get('gpt-switch-reset').handlers.click();b.get('gpt-effort').value='high';
  b.get('gpt-input').value='reset boundary';await b.chat.send();
  b.get('gpt-input').value='after boundary';await b.chat.send();b.chat.dispose();
  console.log('admin UI to backend history passed');
})().catch(error=>{console.error(error);process.exit(1)});
'''
            env = {**os.environ, "FIXTURE_PORT": str(server.server_port)}
            result = subprocess.run(["node", "-e", javascript], cwd=Path(__file__).resolve().parent.parent,
                                    env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("admin UI to backend history passed", result.stdout)
            self.assertEqual([item["content"] for item in self.calls[-3]],
                             ["first session", "答复 first session", "continue first"])
            self.assertEqual([item["content"] for item in self.calls[-2]], ["reset boundary"])
            self.assertEqual([item["content"] for item in self.calls[-1]], ["reset boundary", "答复 reset boundary", "after boundary"])
        finally:
            server.shutdown(); server.server_close(); thread.join(3)


if __name__ == "__main__": unittest.main(verbosity=2)
