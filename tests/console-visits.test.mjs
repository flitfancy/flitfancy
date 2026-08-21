import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../docs/assets/console-visits.js", import.meta.url), "utf8"
);

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.className = "";
    this.hidden = false;
    this.textContent = "";
    this.title = "";
    this.dataset = {};
    this.handlers = {};
    this.classList = {
      add: (name) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        names.add(name);
        this.className = [...names].join(" ");
      },
    };
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = children;
  }

  querySelector(selector) {
    if (selector.startsWith(".")) {
      const name = selector.slice(1);
      return this.children.find((child) => child.className.split(/\s+/).includes(name)) || null;
    }
    return null;
  }

  addEventListener(name, handler) {
    this.handlers[name] = handler;
  }

  click() {
    if (this.handlers.click) this.handlers.click();
  }
}

const elements = {
  '[data-role="visits-stats"]': new FakeElement(),
  '[data-role="visits-list"]': new FakeElement("tbody"),
  '[data-role="visits-empty"]': new FakeElement(),
  '[data-role="visits-status"]': new FakeElement(),
};
const window = {};
vm.runInNewContext(source, {
  window,
  URL,
  document: { createElement: (tagName) => new FakeElement(tagName) },
});

assert.equal(window.FlitFancyVisits.hostOf("https://example.com/path"), "example.com");
assert.equal(window.FlitFancyVisits.hostOf("not a url"), "—");
const grouped = window.FlitFancyVisits.groupConsecutive([
  { ip: "A" }, { ip: "A" }, { ip: "B" }, { ip: "A" },
]);
assert.deepEqual(
  JSON.parse(JSON.stringify(grouped.map((group) => [group.ip, group.rows.length]))),
  [["A", 2], ["B", 1], ["A", 1]],
  "只折叠相邻的同 IP 访问，保持原始时间顺序"
);

let requestedPath = "";
const visits = window.FlitFancyVisits.create({
  query: (selector) => elements[selector],
  request: async (path) => {
    requestedPath = path;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          stats: { total: 3, today: 2, uniq: 2 },
          recent: [
            { ts: 3, ip: "A", page: "/", ref: "https://search.example/a", w: 1200, h: 800 },
            { ts: 2, ip: "A", page: "/about", ref: "", w: 390, h: 844 },
            { ts: 1, ip: "B", page: "/journal" },
          ],
        };
      },
    };
  },
  authFailed: () => false,
  setStatus: (element, text) => { element.textContent = text; },
  formatTime: (ts) => "time-" + ts,
});

await visits.load();
assert.equal(requestedPath, "/api/visits");
assert.equal(elements['[data-role="visits-stats"]'].children.length, 3);
assert.equal(elements['[data-role="visits-list"]'].children.length, 3);
assert.equal(elements['[data-role="visits-empty"]'].hidden, true);
assert.equal(elements['[data-role="visits-status"]'].textContent, "共 3 条记录");
assert.deepEqual(
  elements['[data-role="visits-list"]'].children[0].children.map((cell) => cell.dataset.label),
  ["时间", "IP", "页面", "来源", "设备"],
  "窄面板卡片模式必须为每个字段提供统一标签"
);
assert.equal(
  elements['[data-role="visits-list"]'].children[0].children[1]
    .querySelector(".visit-ip-content").textContent,
  "A",
  "IP 内容必须使用单一布局边界"
);
assert.equal(
  elements['[data-role="visits-list"]'].children[0].children[3].textContent,
  "search.example"
);

const toggle = new FakeElement("button");
visits.toggleGrouping(toggle);
assert.equal(toggle.textContent, "展开全部");
assert.equal(elements['[data-role="visits-list"]'].children.length, 2);
const collapsed = elements['[data-role="visits-list"]'].children[0];
assert.equal(
  collapsed.querySelector(".visit-ip").querySelector(".visit-ip-content").textContent,
  "A · 共 2 次 ▸",
  "IP 与汇总信息应像旧版一样保持在同一段文本流内"
);
assert.match(
  collapsed.querySelector(".visit-ip").querySelector(".visit-ip-content").textContent,
  /共 2 次 ▸$/
);
collapsed.click();
assert.equal(elements['[data-role="visits-list"]'].children.length, 3);
assert.match(
  elements['[data-role="visits-list"]'].children[0]
    .querySelector(".visit-ip").querySelector(".visit-ip-content").textContent,
  /共 2 次 ▾$/
);

console.log("console visits module test ok");
