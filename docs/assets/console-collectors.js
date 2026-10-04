/* 手机采集配对与来源管理，复用已有管理员会话。 */
(function (global) {
  "use strict";
  function create(options) {
    const opts = options || {};
    const field = name => opts.query('[data-collector="' + name + '"]');
    let revision = 0, started = false, disposed = false, busy = false, unsubscribe = null;
    const permitted = () => !disposed && opts.isAdmin() && opts.isServerOnline();
    function clearPrivate() {
      revision++; busy = false;
      field("body").hidden = true; field("locked").hidden = false;
      field("code").textContent = ""; field("devices").textContent = "";
      field("message").textContent = "";
    }
    function show() { field("body").hidden = !permitted(); field("locked").hidden = permitted(); }
    async function refresh() {
      if (!permitted()) { clearPrivate(); return {skipped:true}; }
      const current = revision;
      try {
        const result = await opts.request("/api/collectors");
        if (current !== revision || !permitted()) return {skipped:true};
        show(); field("devices").textContent = "";
        for (const device of result.devices || []) {
          const item = document.createElement("div"); item.className = "collector-device";
          const text = document.createElement("span");
          const seen = device.last_seen ? new Date(device.last_seen * 1000).toLocaleString("zh-CN", {hour12:false}) : "尚未上报";
          text.textContent = device.name + " · " + (device.revoked_at ? "已停用" : seen);
          item.appendChild(text);
          for (const action of device.revoked_at ? ["pair"] : ["pair", "revoke"]) {
            const button = document.createElement("button"); button.type = "button"; button.className = "btn btn-ghost";
            button.textContent = action === "pair" ? "重新配对" : "停用";
            button.addEventListener("click", () => action === "pair" ? pair(device) : revoke(device));
            item.appendChild(button);
          }
          field("devices").appendChild(item);
        }
        return {ok:true};
      } catch (error) {
        if (current === revision && permitted()) field("message").textContent = error.message || "暂时无法读取采集设备";
        return {ok:false,status:error.status};
      }
    }
    async function pair(device) {
      if (!permitted() || busy) return;
      const name = device ? device.name : field("name").value.trim();
      if (!name) { field("message").textContent = "先给手机起一个来源名称"; return; }
      const current = revision; busy = true;
      try {
        const body = {name}; if (device) body.device_id = device.uid;
        const result = await opts.request("/api/collectors/pairing", {method:"POST", body:JSON.stringify(body)});
        if (current !== revision || !permitted()) return;
        field("code").textContent = result.pairing_code.match(/.{1,4}/g).join("-");
        field("message").textContent = "在手机 App 输入配对码，10 分钟内有效，仅可使用一次。";
      } catch (error) {
        if (current === revision && permitted()) field("message").textContent = error.message || "暂时无法生成配对码";
      } finally { if (current === revision) busy = false; }
    }
    async function revoke(device) {
      if (!permitted() || busy) return;
      const current = revision; busy = true;
      try {
        await opts.request("/api/collectors/revoke", {method:"POST", body:JSON.stringify({device_id:device.uid})});
        if (current === revision && permitted()) {
          field("code").textContent = "";
          field("message").textContent = device.name + "已停用；手机中的待上传缓存仍保留";
          await refresh();
        }
      } catch (error) {
        if (current === revision && permitted()) field("message").textContent = error.message || "暂时无法停用设备";
      } finally { if (current === revision) busy = false; }
    }
    const job = opts.scheduler.register({id:"collector-devices",label:"手机采集来源",interval:30000,hidden:"pause",
      enabled:permitted,disabledReason:() => "登录后可管理手机采集",run:refresh});
    function start() {
      if (started || disposed) return;
      started = true;
      field("pair").addEventListener("click", () => pair());
      field("refresh").addEventListener("click", () => job.refresh());
      unsubscribe = opts.scheduler.subscribe(() => { if (permitted()) show(); else clearPrivate(); });
      show();
    }
    function dispose() { clearPrivate(); disposed = true; if (unsubscribe) unsubscribe(); job.unregister(); }
    return {start,refresh,clearPrivate,dispose};
  }
  global.FlitFancyCollectors = {create};
})(window);
