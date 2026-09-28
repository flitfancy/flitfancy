/* Private local launch cards. Saved paths stay on this computer, never in the public Worker. */
(function (global) {
  "use strict";
  function fallbackIcon(path) {
    const script = /\.(bat|cmd|ps1|py)$/i.test(path);
    const drawing = script
      ? '<rect x="7" y="10" width="42" height="36" rx="7" fill="#253541" stroke="#8499a5"/><path d="m16 23 7 5-7 5m13 1h10" fill="none" stroke="#c5d7dd" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'
      : '<rect x="9" y="8" width="38" height="40" rx="9" fill="#383b42" stroke="#a5a8ae"/><path d="M9 19h38" stroke="#a5a8ae"/><circle cx="16" cy="14" r="1.5" fill="#ccb997"/><path d="M20 27h16v12H20z" fill="#b6b3a6" opacity=".7"/>';
    return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56">' + drawing + '</svg>');
  }
  function create(opts) {
    const root = opts.query('[data-role="launcher-panel"]');
    const field = name => root.querySelector('[data-launcher="' + name + '"]');
    let cards = [], jobs = [], online = false, loading = false, busy = false, editing = "", pickId = "";
    let rendered = "", generation = 0;
    const canUse = () => opts.isServerOnline() && opts.isAdmin();
    const note = message => { field("status").textContent = message || ""; };
    const post = (action, body) => opts.request("/api/launcher/" + action, { method: "POST", body: JSON.stringify(body || {}) });
    let forceNext = false;
    const refreshJob = opts.scheduler ? opts.scheduler.register({
      id:'launcher-status', label:'本机启动', page:'console', requiresAuth:true,
      interval:()=>pickId || jobs.some(job=>['pending','dispatched'].includes(job.state)) ? 2000 : 5000,
      enabled:canUse, hidden:'pause', disabledReason:()=> '等待登录',
      run:()=>{const force=forceNext;forceNext=false;return poll(force);},
    }) : null;
    function clearPrivate() {
      generation++;
      root.hidden = true; cards = []; jobs = []; rendered = ""; pickId = "";
      field("cards").replaceChildren(); closeEditor();
      ["name", "path", "args", "working-dir", "interpreter"].forEach(name => { field(name).value = ""; });
      note("");
    }
    function closeEditor() { field("editor").hidden = true; editing = ""; pickId = ""; }
    function edit(card) {
      card = card || {};
      editing = card.id || "";
      field("name").value = card.name || "";
      field("path").value = card.path || "";
      field("args").value = (card.args || []).join("\n");
      field("working-dir").value = card.working_dir || "";
      field("interpreter").value = card.interpreter || "";
      field("hidden").checked = card.hidden !== false;
      field("advanced").open = Boolean(card.args?.length || card.working_dir || card.interpreter);
      field("editor").hidden = false;
      field("save").textContent = editing ? "保存修改" : "添加卡片";
      field("path").focus();
    }
    function acceptPath(value) {
      const path = String(value || "").trim().replace(/^"(.*)"$/, "$1");
      field("path").value = path;
      if (!field("name").value) field("name").value = path.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
      field("hidden").checked = !/\.(exe|lnk)$/i.test(path);
    }
    async function action(work) {
      if (busy || !canUse()) return;
      busy = true; field("editor").inert = true; note("");
      try { await work(); }
      catch (error) {
        if (global.FlitFancyAdmin.isUnauthorized(error)) clearPrivate();
        else note(error.message || "操作失败，请重试");
      } finally { busy = false; field("editor").inert = false; render(); }
    }
    function button(text, callback, className) {
      const el = document.createElement("button"); el.type = "button";
      el.className = className || "btn btn-ghost"; el.textContent = text;
      el.addEventListener("click", callback); return el;
    }
    function render() {
      const signature = JSON.stringify([cards, jobs, online, busy]);
      if (signature === rendered) return;
      rendered = signature;
      field("connection").textContent = online ? "桌面已连接" : "桌面未连接";
      field("pick").disabled = !online || busy || Boolean(pickId);
      field("empty").hidden = cards.length > 0;
      field("cards").replaceChildren();
      cards.forEach(card => {
        const item = document.createElement("article"); item.className = "launcher-card";
        const launch = button("", () => action(async () => {
          await post("run", { id: card.id }); note("已发送，等待本机启动…"); await refresh(true);
        }), "launcher-open");
        launch.disabled = !online || busy || jobs.some(j => ["pending", "dispatched"].includes(j.state));
        const icon = document.createElement("img"); icon.className = "launcher-icon";
        const fallback = fallbackIcon(card.path);
        icon.alt = ""; icon.width = 48; icon.height = 48;
        icon.src = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(card.icon || "") && card.icon.length <= 65558 ? card.icon : fallback;
        icon.addEventListener("error", () => { if (icon.src !== fallback) icon.src = fallback; });
        const title = document.createElement("strong"); title.textContent = card.name;
        const status = document.createElement("span"); status.className = "launcher-card-state";
        const last = jobs.find(j => j.card_id === card.id);
        status.textContent = last ? ({ pending: "等待启动…", dispatched: "正在启动…", cancelled: "已取消" }[last.state] || last.message || "点击启动") : "点击启动";
        launch.append(icon, title, status); launch.title = card.path;
        const controls = document.createElement("div"); controls.className = "launcher-card-actions";
        controls.append(button("编辑", () => { if (!busy && !pickId) edit(card); }), button("移除", () => {
          if (global.confirm("移除“" + card.name + "”这张启动卡片？原文件会保留。")) action(async () => {
            await post("delete", { id: card.id }); if (editing === card.id) closeEditor(); await refresh(true);
          });
        }));
        item.append(launch, controls); field("cards").appendChild(item);
      });
    }
    function refresh(force) {
      if (force) forceNext=true;
      return refreshJob ? refreshJob.refresh({rerun:!!force}) : poll(force);
    }
    async function poll(force) {
      if (!canUse()) { clearPrivate(); return {skipped:true,reason:'auth'}; }
      if (loading || (busy && !force)) return {skipped:true,reason:'busy'};
      loading = true;
      const epoch = generation;
      try {
        const data = await opts.request("/api/launcher");
        if (!canUse() || epoch !== generation) return {skipped:true};
        root.hidden = false; cards = data.cards || []; jobs = data.jobs || []; online = data.agent_online;
        if (pickId) {
          const job = jobs.find(j => j.id === pickId);
          if (job && !["pending", "dispatched"].includes(job.state)) {
            pickId = ""; if (job.path) acceptPath(job.path); note(job.message || "已取消选择");
          }
        }
        render();
        return {ok:true};
      } catch (error) {
        if (!canUse() || epoch !== generation) return {skipped:true};
        if (global.FlitFancyAdmin.isUnauthorized(error)) clearPrivate();
        else { root.hidden = false; online = false; note(error.message || "启动区加载失败"); render(); }
        return {ok:false,status:error.status};
      } finally { loading = false; }
    }
    async function drop(event) {
      event.preventDefault(); root.classList.remove("is-dragging");
      if (!canUse() || busy) return;
      const transfer = event.dataTransfer;
      edit();
      const text = transfer.getData("text/plain").trim();
      if (/^"?[a-z]:[\\/]/i.test(text)) { acceptPath(text); return; }
      const file = transfer.files && transfer.files[0];
      if (!file) { note("请拖入应用或脚本，或粘贴完整路径"); return; }
      await action(async () => {
        const result = await post("resolve", { name: file.name });
        if (result.path) acceptPath(result.path);
        else { field("name").value = file.name.replace(/\.[^.]+$/, ""); note("已识别“" + file.name + "”，请粘贴完整路径，或点“本机选择”。"); }
      });
    }
    function start() {
      field("add").addEventListener("click", () => { if (!busy && !pickId) { edit(); note(""); } });
      field("cancel").addEventListener("click", closeEditor);
      field("path").addEventListener("change", () => acceptPath(field("path").value));
      field("save").addEventListener("click", () => action(async () => {
        await post("save", { id: editing, name: field("name").value, path: field("path").value.trim().replace(/^"(.*)"$/, "$1"),
          args: field("args").value ? field("args").value.split(/\r?\n/) : [], working_dir: field("working-dir").value.trim(),
          interpreter: field("interpreter").value.trim(), hidden: field("hidden").checked });
        closeEditor(); note("已保存，点击卡片即可启动"); await refresh(true);
      }));
      field("pick").addEventListener("click", () => action(async () => {
        const result = await post("pick"); pickId = result.job_id; note("请在本机弹出的窗口中选择文件");
      }));
      root.addEventListener("dragover", event => { event.preventDefault(); root.classList.add("is-dragging"); });
      root.addEventListener("dragleave", event => { if (!root.contains(event.relatedTarget)) root.classList.remove("is-dragging"); });
      root.addEventListener("drop", drop);
      refresh();
    }
    function dispose() { if (refreshJob) refreshJob.unregister(); clearPrivate(); }
    return { start, refresh, clearPrivate, dispose };
  }
  global.FlitFancyConsoleLauncher = { create };
})(window);
