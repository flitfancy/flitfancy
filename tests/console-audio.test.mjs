import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../docs/assets/console-audio.js", import.meta.url), "utf8"
);
const consoleSource = fs.readFileSync(
  new URL("../docs/assets/console.js", import.meta.url), "utf8"
);
const httpSource = fs.readFileSync(
  new URL("../backend/flitfancy_http.py", import.meta.url), "utf8"
);
const window = {};
vm.runInNewContext(source, { window, document: { hidden: false, createElement: () => ({ style: {} }) }, performance,
  setTimeout, clearTimeout });

const audio = window.FlitFancyConsoleAudio;
const spectrum = { active: true, step_ms: 50, frames: [Array(16).fill(20), Array(16).fill(80)] };
assert.equal(audio.spectrumFrame(spectrum, 0)[0], .2);
assert.equal(audio.spectrumFrame(spectrum, 50)[0], .8);
assert.equal(audio.spectrumFrame(spectrum, 100), null, 'no invented frames after available PCM');
assert.equal(audio.spectrumFrame(spectrum, 800), null, 'expired telemetry must settle to idle');
assert.equal(audio.spectrumFrame({ ...spectrum, active: false }, 0), null);
assert.equal(audio.spectrumFrame(null, 0), null);
assert.match(audio.wakePresentation({}), /更新/);
assert.match(audio.wakePresentation({ wakeword: { enabled: false } }), /已关闭/);
assert.match(audio.wakePresentation({ recording: true, wakeword: { enabled: true } }), /正在语音识别/);
assert.match(audio.wakePresentation({ board_connected: true, model: "ready", wakeword: { enabled: true, status: "armed", keyword: "小萤小萤" } }), /小萤小萤/);
assert.match(audio.wakePresentation({ board_connected: true, model: "ready", wakeword: { enabled: true, status: "armed", keyword: "测试词" } }), /测试词/);
assert.match(audio.wakePresentation({ wakeword: { status: "error", error: "missing model" } }), /missing model/);
assert.match(audio.wakePresentation({ recording: true, wakeword: {}, voice_turn: { phase: "waiting-speech", wait_remaining: 7 } }), /我在听.*7 秒/);
assert.match(audio.wakePresentation({ recording: true, wakeword: {}, voice_turn: { phase: "listening" } }), /自动提交/);
assert.match(audio.wakePresentation({ recording: true, wakeword: {}, voice_turn: { phase: "cue" } }), /提示音后/);
assert.match(audio.wakePresentation({ board_connected: true, model: "ready", wakeword: { enabled: true, status: "armed" }, voice_turn: { phase: "timeout" } }), /未听到指令.*小萤小萤/);
for (const [status, text] of [["active", /正在消除/], ["aligning", /对齐/], ["disabled", /原始收音/], ["error", /回退/]]) {
  assert.match(audio.vadPresentation({ board_connected: true, aec: { status: status }, vad: { status: "ready" } }).note, text);
}
assert.match(audio.vadPresentation({ board_connected: false }).status, /等待板子/);
assert.match(audio.vadPresentation({ board_connected: true }).status, /更新/);
const vadView = audio.vadPresentation({ board_connected: true, vad: {
  status: "ready", speech: true, left_probability: 0.95, right_probability: 0.02,
  segments: 3, processing_ms_per_32ms: 0.3, playback_overlap: true,
} });
assert.equal(vadView.status, "检测到语音");
assert.match(vadView.metrics, /左麦 95% · 右麦 2%/);
assert.match(vadView.note, /回声消除尚未启用/);
assert.match(audio.vadPresentation({ board_connected: true, vad: { status: "waiting", speech: true } }).status, /等待音频/);
assert.equal(audio.levelPercent(-100), 0);
assert.equal(audio.levelPercent(-50), 50);
assert.equal(audio.levelPercent(0), 100);
assert.equal(audio.levelPercent(2), 100);
assert.equal(audio.levelPercent("bad"), 0);
assert.equal(audio.transportText({ playing: false }), "");
assert.match(audio.transportText({
  playing: true,
  play_rate: 48000,
  buffered_frames: 144000,
  retry_count: 1,
  rebuffer_events: 0,
}), /缓冲 3\.0 秒 · 重传 1 · 重缓存 0/);
assert.equal(audio.displayError("Traceback\nRuntimeError: board missing"), "board missing");
assert.equal(audio.currentLyric([], 3), "");
assert.equal(audio.currentLyric([
  { time: 1.2, text: "第一句" },
  { time: 3.5, text: "第二句" },
], 3.4), "第一句");
assert.equal(audio.currentLyric([
  { time: 1.2, text: "第一句" },
  { time: 3.5, text: "第二句" },
], 3.5), "第二句");

assert.doesNotMatch(source, /127\.0\.0\.1:7865|localhost:7865/,
  "前端不得绕过网站后端直连音频服务");
assert.match(source, /\/api\/audio\/play-file\?filename=/,
  "文件播放必须经过同源音频代理");
assert.match(consoleSource, /async function request\(url, options\)[\s\S]*?request\(url, options\)/,
  "控制台请求包装器必须透传 POST 选项");
assert.match(source, /Authorization.*Bearer/,
  "隧道上传必须携带已有管理员会话令牌");
assert.match(source, /if \(!isServerOnline\(\)\)/,
  "公开站点必须保持音频控制禁用");
assert.match(source, /play-pause/,
  "播放控制必须提供暂停命令");
assert.doesNotMatch(source, /wifi-config|wifi-password|wifi-ssid/,
  "固件直连模式下前端不应保留配网入口");
assert.doesNotMatch(httpSource, /_api_audio_wifi_config|\/api\/audio\/wifi-config/,
  "网站后端不应暴露已移除的配网接口");

const nodes = new Map();
function node(role) {
  const selector = '[data-role="' + role + '"]';
  if (!nodes.has(selector)) nodes.set(selector, {
    style: {}, dataset: {}, classList: { toggle() {}, remove() {}, add() {}, contains() { return false; } },
    listeners: {},
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
    appendChild() {},
    setAttribute() {}, removeAttribute() {},
    parentNode: { setAttribute() {}, removeAttribute() {} },
  });
  return nodes.get(selector);
}
const idle = { available: true, board_connected: true, wifi_connected: true,
  wifi_ip: '192.168.1.40', wifi_rssi: -55, model: 'ready', playing: false };
const view = audio.create({
  query: selector => node(selector.match(/data-role="([^"]+)/)[1]),
  request: async () => idle,
  isServerOnline: () => true,
  upload: async () => { throw new Error('音频上传超时'); },
});
view.render(idle);
assert.equal(node('audio-wifi-status').textContent, '192.168.1.40 · -55 dBm');
view.render({ ...idle, wifi_rssi: null });
assert.equal(node('audio-wifi-status').textContent, '192.168.1.40');
view.render({ ...idle, board_connected: false });
assert.equal(node('audio-wifi-status').textContent, 'WiFi未连接');
view.render({ ...idle, playing: true, upload_active: true,
  upload_received: 1048576, upload_total: 2097152, play_status: '接收文件' });
assert.equal(node('audio-play-percent').textContent, '50.0%');
assert.equal(node('audio-play-transport').textContent, '已接收 1.0 / 2.0 MB');
assert.equal(node('audio-play-pause').disabled, true);
view.render({ ...idle, play_name: 'interrupted.ncm', play_status: '文件接收失败',
  play_error: '文件上传连接中断，请重新拖入', upload_received: 1048576, upload_total: 2097152 });
assert.equal(node('audio-play-panel').hidden, false, 'failed upload must retain its card');
assert.equal(node('audio-play-percent').textContent, '50.0%');
assert.match(node('audio-play-transport').textContent, /1.0.*2.0 MB/);
assert.equal(node('audio-play-retry').hidden, false);
await view.playFile({ name: 'song.wav', size: 100 });
await view.refresh();
assert.equal(node('audio-error').textContent, '音频上传超时',
  'the immediate status refresh must not erase an upload failure');
view.dispose();

let dragOnline = false;
const uploaded = [];
const dragView = audio.create({
  query: selector => node(selector.match(/data-role="([^"]+)/)[1]),
  request: async () => idle,
  isServerOnline: () => dragOnline,
  upload: async file => { uploaded.push(file.name); },
});
dragView.start();
dragOnline = true;
dragView.render({ ...idle, play_name: 'failed.ncm', play_error: '连接中断' });
assert.equal(node('audio-drop').hidden, true, 'failure card covers the original drop prompt');
const dropHandlers = node('audio-source').listeners.drop || [];
assert.ok(dropHandlers.length, 'the visible source container must accept replacement files');
const dropEvent = { preventDefault() {}, dataTransfer: { files: [{ name: 'replacement.wav', size: 100 }] } };
for (const handler of dropHandlers) await handler(dropEvent);
assert.deepEqual(uploaded, ['replacement.wav']);
dragView.render({ ...idle, playing: true });
for (const handler of dropHandlers) await handler(dropEvent);
assert.equal(uploaded.length, 1, 'dropping while playing must not start a second upload');
dragView.render({ ...idle, board_connected: false });
for (const handler of dropHandlers) await handler(dropEvent);
assert.equal(uploaded.length, 1, 'offline controls stay disabled');
dragView.render({ ...idle, ota: { phase: 'writing', busy: true, received: 500, total: 1000,
  firmware: { version: '0.4.0', pending_verify: false } } });
assert.match(node('audio-ota-status').textContent, /写入固件.*50.0%/);
assert.equal(node('audio-device-reboot').disabled, true, 'reboot must not interrupt OTA');
assert.equal(node('audio-recognition-toggle').disabled, true);
assert.equal(node('audio-ota-select').disabled, true);
dragView.render({ ...idle, ota: { phase: 'complete', busy: false,
  firmware: { version: '0.4.1', pending_verify: false } } });
assert.match(node('audio-ota-status').textContent, /升级完成/);
assert.equal(node('audio-ota-version').textContent, '当前 v0.4.1');
assert.equal(node('audio-device-reboot').disabled, false);
assert.equal(node('audio-ota-select').disabled, false);
dragView.dispose();

console.log("console audio module and local-boundary test ok");
