import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../docs/assets/console-services.js", import.meta.url), "utf8"
);

function makeButton(action) {
  return {
    dataset: { action },
    disabled: false,
    alive: false,
    handlers: {},
    classList: {
      toggle(name, on) {
        if (name === "alive") this.owner.alive = on;
      },
      owner: null,
    },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    click() { this.handlers.click(); },
  };
}

const buttons = [makeButton("backend"), makeButton("listener"), makeButton("tunnel")];
buttons.forEach((button) => { button.classList.owner = button; });
const window = {};
vm.runInNewContext(source, { window, document: { querySelectorAll: () => buttons } });

const navigated = [];
const services = window.FlitFancyConsoleServices.create({
  buttons,
  navigate: (url) => navigated.push(url),
});

services.update(null);
assert.ok(buttons.every((button) => button.disabled),
  "后端尚未下发随机协议名时所有服务按钮必须禁用");
buttons[1].click();
assert.deepEqual(navigated, []);

services.setProtocolName("bad:name");
services.update({ listener: true, tunnel: false });
assert.ok(buttons.every((button) => button.disabled), "非法协议名必须被拒绝");

services.setProtocolName("flitfancy-a1b2c3d4");
services.update({ listener: true, tunnel: false });
assert.ok(buttons.every((button) => !button.disabled));
assert.equal(buttons[0].alive, true, "收到服务状态即代表后端自身在线");
assert.equal(buttons[1].alive, true);
assert.equal(buttons[2].alive, false);
buttons[1].click();
assert.deepEqual(navigated, ["flitfancy-a1b2c3d4://start/listener"]);

console.log("console services module test ok");
