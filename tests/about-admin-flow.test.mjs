import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../docs/assets/about-admin.js", import.meta.url), "utf8"
);
const html = fs.readFileSync(
  new URL("../docs/about.html", import.meta.url), "utf8"
);

function element() {
  const listeners = new Map();
  return {
    hidden: false,
    value: "",
    textContent: "",
    disabled: false,
    className: "",
    listeners,
    addEventListener(type, listener) { listeners.set(type, listener); },
    async dispatch(type) {
      const listener = listeners.get(type);
      if (!listener) return undefined;
      return listener({ preventDefault() {}, key: type === "keydown" ? "Enter" : "" });
    },
    appendChild() {},
    focus() {},
  };
}

function createHarness({ adminSurface = true, essayError = null } = {}) {
  const elements = new Map();
  const query = (selector) => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  let storedToken = "";
  let panelShows = 0;
  const location = {
    hostname: adminSurface ? "console.flitfancy.com" : "flitfancy.com",
    hash: "",
    href: "",
  };
  const context = {
    console,
    CustomEvent: class CustomEvent {},
    document: {
      body: { classList: { add() {}, remove() {} } },
      querySelector: query,
      createElement: element,
      dispatchEvent() {},
    },
    window: {
      location,
      confirm: () => true,
      FlitFancyAdmin: {
        isAdminHost: () => adminSurface,
        token: () => storedToken,
        setToken: (_key, value) => { storedToken = value; },
        isUnauthorized: (value) => Boolean(value && value.status === 401),
        installErrorHandler() {},
        async request(path) {
          if (path === "/api/admin/login") return { token: "fresh-token" };
          if (path === "/api/admin/essays" && essayError) throw essayError;
          if (path === "/api/admin/essays") return { rows: [] };
          return { ok: true };
        },
      },
      FlitFancyPanelShell: {
        init: () => ({
          show() { panelShows += 1; },
          hide() {},
          clearCollapsed() {},
        }),
      },
    },
  };
  context.window.document = context.document;
  vm.runInNewContext(source, context, { filename: "about-admin.js" });
  return {
    query,
    location,
    token: () => storedToken,
    panelShows: () => panelShows,
  };
}

async function loginWith(harness) {
  harness.query('[data-role="essay-username"]').value = "admin";
  harness.query('[data-role="essay-password"]').value = "correct-password";
  await harness.query('[data-role="essay-login"]').dispatch("click");
}

const timeout = Object.assign(new Error("请求超时，请重试"), { status: 0 });
const timeoutHarness = createHarness({ essayError: timeout });
await loginWith(timeoutHarness);
assert.equal(timeoutHarness.token(), "fresh-token",
  "短文库超时不能注销刚刚成功的登录");
assert.equal(timeoutHarness.panelShows(), 1,
  "认证成功后必须先打开管理面板，再异步加载短文库");
assert.match(timeoutHarness.query('[data-role="essay-library-status"]').textContent,
  /短文库加载超时.*可重试/,
  "短文库超时必须显示可重试的数据加载状态");

const unauthorized = Object.assign(new Error("未授权"), { status: 401 });
const unauthorizedHarness = createHarness({ essayError: unauthorized });
await loginWith(unauthorizedHarness);
assert.equal(unauthorizedHarness.token(), "", "只有 401 必须清除管理令牌");
assert.equal(unauthorizedHarness.query('[data-role="essay-login-overlay"]').hidden, false);
assert.match(unauthorizedHarness.query('[data-role="essay-login-status"]').textContent,
  /登录已过期/);

const publicHarness = createHarness({ adminSurface: false });
await publicHarness.query('.nav nav a[href="about.html"]').dispatch("click");
assert.equal(publicHarness.location.href,
  "https://console.flitfancy.com/about.html#write",
  "公网页点击当前关于导航必须进入管理域名");

assert.doesNotMatch(html, /data-role="essay-manage-open"/,
  "访客界面不应单独暴露记录按钮");
assert.match(html, /data-role="essay-reload"/,
  "短文管理面板必须提供重新加载按钮");

console.log("about admin auth/data separation test ok");
