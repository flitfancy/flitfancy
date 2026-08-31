/* 控制台资源管理：上传（两段式）、列表、删除、一键发布。
   所有请求经 FlitFancyAdmin.request 带管理员令牌。 */
(function (global) {
  "use strict";

  const ADMIN_KEY = "flitfancy.admin.token";
  const UPLOAD_TIMEOUT_MS = 30 * 60000;   // 大文件上传：30 分钟上限

  function create(options) {
    const opts = options || {};
    const query = opts.query || function (s) { return document.querySelector(s); };
    const request = opts.request || function () { throw new Error("no request"); };
    const token = opts.token || function () { return ""; };
    let listTimer = null;

    function el(role) { return query('[data-role="' + role + '"]'); }

    function setStatus(text, bad) {
      const el2 = el("res-status");
      if (!el2) return;
      el2.textContent = text || "";
      el2.classList.toggle("bad", !!bad);
    }

    function groupOptions(selected) {
      return ["firefly", "naturecraft", "flitfancy"].map(function (g) {
        return '<option value="' + g + '"' + (g === selected ? " selected" : "") + '>' + g + '</option>';
      }).join("");
    }

    async function refreshList() {
      try {
        const data = await request("/api/resources");
        renderList(data.resources || []);
      } catch (e) {
        setStatus("资源列表加载失败：" + (e.message || e), true);
      }
    }

    function renderList(entries) {
      const list = el("res-list");
      if (!list) return;
      if (!entries.length) { list.textContent = "暂无上传资源"; return; }
      list.textContent = "";
      entries.forEach(function (entry) {
        const card = document.createElement("div");
        card.className = "res-entry";
        const head = document.createElement("div");
        head.className = "res-entry-head";
        const name = document.createElement("b");
        name.textContent = entry.title + "（" + entry.group + " · " + entry.id + "）";
        head.appendChild(name);
        const del = document.createElement("button");
        del.className = "btn btn-ghost res-del";
        del.textContent = "删除";
        del.addEventListener("click", function () {
          if (!window.confirm("删除「" + entry.title + "」及其全部版本文件？")) return;
          request("/api/resources/delete", { method: "POST", body: JSON.stringify({ id: entry.id }) })
            .then(function () { refreshList(); })
            .catch(function (e2) { setStatus("删除失败：" + e2.message, true); });
        });
        head.appendChild(del);
        card.appendChild(head);
        const meta = document.createElement("div");
        meta.className = "res-entry-meta";
        const parts = (entry.versions || []).map(function (v) {
          return (v.label ? v.label + " · " : "") + String(v.date || "").slice(0, 10) +
            (v.file ? " · " + Math.round((v.size || 0) / 1024) + "KB" : " · 文字更新");
        });
        meta.textContent = "版本： " + parts.join(" ｜ ");
        card.appendChild(meta);
        list.appendChild(card);
      });
    }

    function fillResourceSelect(entries) {
      const sel = el("res-target");
      if (!sel) return;
      const keep = sel.value;
      sel.textContent = "";
      const newOpt = document.createElement("option");
      newOpt.value = "__new__";
      newOpt.textContent = "＋ 新建资源";
      sel.appendChild(newOpt);
      entries.forEach(function (e) {
        const o = document.createElement("option");
        o.value = e.id;
        o.textContent = e.title + "（" + e.group + "）";
        sel.appendChild(o);
      });
      sel.value = entries.some(function (e) { return e.id === keep; }) ? keep : "__new__";
    }

    async function refresh() {
      try {
        const data = await request("/api/resources");
        const entries = data.resources || [];
        fillResourceSelect(entries);
        renderList(entries);
      } catch (e) {
        setStatus("资源列表加载失败：" + (e.message || e), true);
      }
    }

    function readFields() {
      const isNew = el("res-target").value === "__new__";
      const fileInput = el("res-file");
      const file = fileInput && fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      return {
        isNew: isNew,
        id: isNew ? "" : el("res-target").value,
        group: isNew ? (el("res-group").value || "naturecraft") : "",
        title: el("res-title").value.trim(),
        desc: el("res-desc").value.trim(),
        details: el("res-details").value.trim(),
        label: el("res-label").value.trim(),
        note: el("res-note").value.trim(),
        file: file,
        filename: file ? file.name : (el("res-filename") ? el("res-filename").value.trim() : ""),
      };
    }

    async function submit() {
      const fields = readFields();
      if (!fields.isNew && !fields.id) { setStatus("请选择目标资源", true); return; }
      if (fields.isNew && !fields.title && !fields.filename) { setStatus("新建资源至少需要标题或文件", true); return; }
      if (!fields.file && !fields.title && !fields.label && !fields.note && !fields.desc && !fields.details) {
        setStatus("整条提交都是空的", true); return;
      }
      setStatus("上传中…");
      const meta = {
        id: fields.id || undefined,
        group: fields.group || undefined,
        title: fields.title || undefined,
        desc: fields.desc || undefined,
        details: fields.details || undefined,
        label: fields.label || undefined,
        note: fields.note || undefined,
        filename: fields.filename || undefined,
        size: fields.file ? fields.file.size : 0,
      };
      let prep;
      try {
        prep = await request("/api/resources/prepare", {
          method: "POST", body: JSON.stringify(meta),
        });
      } catch (e) {
        setStatus("准备失败：" + e.message, true); return;
      }
      try {
        await uploadBytes(prep.token, fields.file);
      } catch (e) {
        setStatus("上传失败：" + e.message, true); return;
      }
      setStatus("上传完成，发布中…");
      try {
        const pub = await request("/api/resources/publish", { method: "POST", body: "{}" });
        setStatus("已发布：" + (pub.note || "ok") + "（Pages 约 10 分钟生效）");
      } catch (e) {
        setStatus("发布失败（本地已保存）：" + e.message, true);
        return;
      }
      clearForm();
      refresh();
    }

    function uploadBytes(uploadToken, file) {
      return new Promise(function (resolve, reject) {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/resources/upload?token=" + encodeURIComponent(uploadToken));
        xhr.setRequestHeader("Authorization", "Bearer " + token());
        xhr.timeout = UPLOAD_TIMEOUT_MS;
        xhr.upload.onprogress = function (ev) {
          if (ev.lengthComputable) {
            setStatus("上传中… " + Math.round(ev.loaded / ev.total * 100) + "%");
          }
        };
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
          let msg = "HTTP " + xhr.status;
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e2) { }
          reject(new Error(msg));
        };
        xhr.onerror = function () { reject(new Error("网络错误")); };
        if (file) { xhr.send(file); } else { xhr.send(new Blob([])); }
      });
    }

    function clearForm() {
      ["res-title", "res-desc", "res-details", "res-label", "res-note", "res-file"].forEach(function (role) {
        const x = el(role); if (x) x.value = "";
      });
    }

    function start() {
      const btn = el("res-submit");
      if (btn) btn.addEventListener("click", submit);
      const refreshBtn = el("res-refresh");
      if (refreshBtn) refreshBtn.addEventListener("click", refresh);
      const target = el("res-target");
      if (target) target.addEventListener("change", function () {
        const isNew = target.value === "__new__";
        ["res-title", "res-group", "res-desc", "res-details"].forEach(function (role) {
          const x = el(role); if (x) x.closest(".res-field").hidden = !isNew;
        });
        if (!isNew) loadCardFields(target.value);
      });
      refresh();
    }

    async function loadCardFields(id) {
      try {
        const data = await request("/api/resources");
        const entry = (data.resources || []).find(function (e) { return e.id === id; });
        if (!entry) return;
        const t = el("res-title"); if (t) t.value = entry.title || "";
        const d = el("res-desc"); if (d) d.value = entry.desc || "";
        const dt = el("res-details"); if (dt) dt.value = entry.details || "";
      } catch (e) { }
    }

    return { start: start, refresh: refresh, stop: function () { if (listTimer) clearInterval(listTimer); } };
  }

  global.FlitFancyConsoleResources = { create: create };
})(window);
