(function (global) {
  "use strict";

  function create(options) {
    const opts = options || {}, query = opts.query || (selector => document.querySelector(selector));
    const elements = {};
    for (const name of ["toggle", "panel", "file", "select", "start", "name", "status", "version", "progress"])
      elements[name] = query('[data-role="sensor-ota-' + name + '"]');
    let device = null, file = null, phase = "", message = "", revision = 0, stopped = false;
    let job = null, xhr = null, waitTimer = null, waitResolve = null;
    const authenticated = () => opts.isAdmin() && opts.isServerOnline();
    const busy = () => phase === "uploading" || phase === "rebooting";

    function render() {
      const connected = Boolean(device && device.board_connected);
      elements.version.textContent = device && device.firmware_version ? "当前 v" + device.firmware_version : "版本未获取";
      elements.name.textContent = file ? file.name + " · " + (file.size / 1048576).toFixed(2) + " MiB" : "选择 FIREFLY-SENSE 应用固件";
      elements.select.disabled = !authenticated() || busy() || Boolean(device && device.busy);
      elements.start.disabled = Boolean(!authenticated() || busy() || !file || !connected || !device.ota_supported || device.busy);
      elements.toggle.disabled = busy();
      elements.status.textContent = message || (!authenticated() ? "登录管理后可升级感知板固件" :
        !connected ? "请先连接感知板" : !device.ota_supported ? "当前固件不支持 OTA" :
        device.busy ? "感知板正在处理升级" : file ? "固件已就绪，可以开始升级" : "选择固件后即可升级");
    }

    async function refresh() {
      if (stopped || !authenticated() || busy() || elements.panel.hidden) return {skipped: true};
      const epoch = revision;
      try {
        const next = await opts.request("/api/sensors/device");
        if (epoch !== revision) return {skipped: true};
        device = next;
        render();
        return {ok: true};
      } catch (error) {
        if (epoch !== revision) return {skipped: true};
        if (error.status === 401) { clearPrivate(); if (opts.onLoginRequired) opts.onLoginRequired(); }
        else { device = null; message = error.message; render(); }
        return {ok: false, status: error.status};
      }
    }

    function pause() {
      return new Promise(resolve => {
        waitResolve = resolve;
        waitTimer = global.setTimeout(() => { waitResolve = null; waitTimer = null; resolve(); }, 2000);
      });
    }

    function upload(selected) {
      return new Promise((resolve, reject) => {
        const request = new global.XMLHttpRequest();
        xhr = request;
        request.open("POST", "/api/sensors/firmware");
        request.timeout = 180000;
        request.setRequestHeader("Content-Type", "application/octet-stream");
        request.setRequestHeader("Authorization", "Bearer " + global.FlitFancyAdmin.token());
        const epoch = revision;
        request.upload.onprogress = event => {
          if (epoch !== revision || !event.lengthComputable) return;
          const percent = Math.round(100 * event.loaded / event.total);
          elements.progress.value = percent;
          message = percent === 100 ? "固件已传输，正在写入与校验…" : "正在传输固件 · " + percent + "%";
          render();
        };
        request.onload = () => {
          if (xhr === request) xhr = null;
          let data;
          try { data = JSON.parse(request.responseText); } catch (_) { reject(new Error("升级服务响应异常")); return; }
          if (request.status === 200 && data.ok) resolve(data);
          else reject(Object.assign(new Error(data.error || "固件上传失败"), {status: request.status}));
        };
        request.onerror = () => reject(new Error("固件上传连接中断，请检查服务连接"));
        request.ontimeout = () => reject(new Error("固件上传超时，请重新选择文件"));
        request.onabort = () => reject(new Error("固件上传已中止"));
        request.send(selected);
      });
    }

    async function upgrade() {
      if (!authenticated() || !file || elements.start.disabled || busy()) return;
      const epoch = revision;
      phase = "uploading"; message = "正在传输固件…";
      elements.progress.hidden = false; elements.progress.value = 0;
      render();
      try {
        const result = await upload(file);
        if (epoch !== revision) return;
        phase = "rebooting"; message = "校验通过，等待感知板重启…";
        elements.progress.value = 100; render();
        const deadline = Date.now() + 90000;
        let complete = false;
        while (Date.now() < deadline && epoch === revision && !stopped) {
          await pause();
          if (epoch !== revision || stopped) return;
          try {
            const next = await opts.request("/api/sensors/device");
            if (epoch !== revision) return;
            if (next.board_connected && next.boot_partition !== result.previous_partition) {
              device = next; complete = true; break;
            }
          } catch (error) {
            if (error.status === 401) throw error;
          }
        }
        if (epoch !== revision) return;
        if (complete) {
          file = null; elements.file.value = "";
          message = "升级完成，感知板已重新连接";
        } else { device = null; message = "固件已写入，暂未重新连接；请稍后重新展开面板确认"; }
      } catch (error) {
        if (epoch !== revision) return;
        if (error.status === 401) { clearPrivate(); if (opts.onLoginRequired) opts.onLoginRequired(); return; }
        message = error.message;
      } finally {
        if (epoch === revision) { phase = ""; xhr = null; render(); }
      }
    }

    function clearPrivate() {
      revision++;
      if (xhr) { xhr.abort(); xhr = null; }
      if (waitTimer !== null) global.clearTimeout(waitTimer);
      if (waitResolve) waitResolve();
      waitTimer = waitResolve = null;
      device = file = null; phase = message = "";
      elements.file.value = ""; elements.panel.hidden = true;
      elements.progress.hidden = true; elements.progress.value = 0;
      elements.toggle.setAttribute("aria-expanded", "false");
      render();
    }

    function start() {
      elements.toggle.addEventListener("click", () => {
        elements.panel.hidden = !elements.panel.hidden;
        elements.toggle.setAttribute("aria-expanded", String(!elements.panel.hidden));
        message = ""; render();
        if (opts.scheduler) opts.scheduler.reconcile();
        if (!elements.panel.hidden) {
          if (job) void job.refresh();
          else void refresh();
        }
      });
      elements.select.addEventListener("click", () => { if (!elements.select.disabled) elements.file.click(); });
      elements.file.addEventListener("change", () => {
        if (!authenticated() || busy()) return;
        const selected = elements.file.files[0];
        file = selected && /\.bin$/i.test(selected.name) && selected.size >= 320 && selected.size <= 0x640000 ? selected : null;
        message = selected && !file ? "请选择不超过 6.25 MiB 的感知板应用固件 .bin" : "";
        elements.progress.hidden = true; render();
      });
      elements.start.addEventListener("click", upgrade);
      if (opts.scheduler) job = opts.scheduler.register({
        id: "sensor-device", label: "感知板固件", page: "presence", interval: 5000,
        requiresAuth: true, hidden: "pause", enabled: () => !stopped && authenticated() && !elements.panel.hidden && !busy(),
        disabledReason: () => !authenticated() ? "登录后刷新" : busy() ? "正在升级" : "升级面板已收起", run: refresh,
      });
      render();
    }

    function dispose() {
      stopped = true; clearPrivate();
      if (job) { job.unregister(); job = null; }
    }
    return {start, refresh, clearPrivate, dispose};
  }
  global.FlitFancySensorOta = {create};
})(window);
