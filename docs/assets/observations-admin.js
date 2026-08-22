(function () {
  "use strict";

  const $ = function (selector) { return document.querySelector(selector); };
  const ADMIN_KEY = "flitfancy.admin.token";
  const statusNames = { draft: "草稿", public: "公开", archived: "归档" };
  const builtinRelations = new Set(["同源", "因果", "类比", "延伸"]);
  let observations = [];
  let links = [];
  let loaded = false;
  let loading = false;

  function api(path, options) {
    return window.FlitFancyAdmin.request(path, Object.assign({ authMode: "always" }, options));
  }

  function setStatus(selector, text) {
    const target = $(selector);
    if (target) target.textContent = text || "";
  }

  function today() {
    const value = window.FlitFancyAdmin.nowForInput();
    return value.slice(0, 10);
  }

  function splitTags(value) {
    const seen = new Set();
    return String(value || "").split(/[,，、]/).map(function (tag) {
      return tag.trim();
    }).filter(function (tag) {
      if (!tag || seen.has(tag)) return false;
      seen.add(tag);
      return true;
    });
  }

  function starById(uid) {
    return observations.find(function (star) { return star.uid === uid; });
  }

  function starSearchText(star) {
    return [star.title, star.category, (star.tags || []).join(" ")].join(" ").toLowerCase();
  }

  function optionFor(star) {
    const option = document.createElement("option");
    option.value = star.uid;
    option.textContent = star.title + " · " + star.category +
      (star.status === "public" ? "" : " · " + (statusNames[star.status] || star.status));
    return option;
  }

  function fillStarSelects(query) {
    const source = $('[data-role="observation-link-source"]');
    const target = $('[data-role="observation-link-target"]');
    const sourceValue = source.value;
    const targetValue = target.value;
    const needle = String(query || "").trim().toLowerCase();
    source.textContent = "";
    target.textContent = "";
    observations.forEach(function (star) { source.appendChild(optionFor(star)); });
    observations.filter(function (star) {
      return !needle || starSearchText(star).includes(needle);
    }).forEach(function (star) { target.appendChild(optionFor(star)); });
    if (observations.some(function (star) { return star.uid === sourceValue; })) source.value = sourceValue;
    if ([...target.options].some(function (option) { return option.value === targetValue; })) {
      target.value = targetValue;
    }
  }

  function observationRow(star) {
    const item = document.createElement("div");
    item.className = "observation-admin-row";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = star.title || "未命名星球";
    const meta = document.createElement("span");
    meta.textContent = [statusNames[star.status] || star.status, star.category, star.discovered_at]
      .filter(Boolean).join(" · ");
    info.appendChild(title);
    info.appendChild(meta);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn btn-ghost";
    edit.textContent = "编辑";
    edit.addEventListener("click", function () { fillObservation(star); });
    item.appendChild(info);
    item.appendChild(edit);
    return item;
  }

  function renderObservations() {
    const list = $('[data-role="observation-admin-list"]');
    list.textContent = "";
    observations.forEach(function (star) { list.appendChild(observationRow(star)); });
    if (!observations.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "记录库还是空的，新增第一颗星球吧。";
      list.appendChild(empty);
    }
    fillStarSelects($('[data-role="observation-link-search"]').value);
  }

  function linkRow(link) {
    const item = document.createElement("div");
    item.className = "observation-admin-row";
    const source = starById(link.source_uid);
    const target = starById(link.target_uid);
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = (source ? source.title : "未知星球") + " → " +
      (target ? target.title : "未知星球");
    const meta = document.createElement("span");
    const publicLink = source && target && source.status === "public" && target.status === "public";
    meta.textContent = link.relation + (publicLink ? " · 已公开" : " · 随星球暂存本地");
    info.appendChild(title);
    info.appendChild(meta);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn btn-ghost";
    edit.textContent = "编辑";
    edit.addEventListener("click", function () { fillLink(link); });
    item.appendChild(info);
    item.appendChild(edit);
    return item;
  }

  function renderLinks() {
    const list = $('[data-role="observation-link-list"]');
    list.textContent = "";
    links.forEach(function (link) { list.appendChild(linkRow(link)); });
    if (!links.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = observations.length < 2 ? "至少记录两颗星球后才能建立弦。" : "还没有建立弦。";
      list.appendChild(empty);
    }
  }

  function clearObservation(message) {
    $('[data-role="observation-uid"]').value = "";
    $('[data-role="observation-title"]').value = "";
    $('[data-role="observation-category"]').value = "宇宙与自然";
    $('[data-role="observation-tags"]').value = "";
    $('[data-role="observation-summary"]').value = "";
    $('[data-role="observation-content"]').value = "";
    $('[data-role="observation-discovered"]').value = today();
    $('[data-role="observation-source-name"]').value = "";
    $('[data-role="observation-source-url"]').value = "";
    $('[data-role="observation-status"]').value = "draft";
    setStatus('[data-role="observation-status-text"]', message || "正在记录一颗新星球");
    $('[data-role="observation-title"]').focus();
  }

  function fillObservation(star) {
    $('[data-role="observation-uid"]').value = star.uid;
    $('[data-role="observation-title"]').value = star.title || "";
    $('[data-role="observation-category"]').value = star.category || "宇宙与自然";
    $('[data-role="observation-tags"]').value = (star.tags || []).join("，");
    $('[data-role="observation-summary"]').value = star.summary || "";
    $('[data-role="observation-content"]').value = star.content || "";
    $('[data-role="observation-discovered"]').value = star.discovered_at || today();
    $('[data-role="observation-source-name"]').value = star.source_name || "";
    $('[data-role="observation-source-url"]').value = star.source_url || "";
    $('[data-role="observation-status"]').value = star.status || "draft";
    $('[data-role="observation-link-source"]').value = star.uid;
    setStatus('[data-role="observation-status-text"]', "正在编辑既有星球，保存后原地更新");
    $('[data-role="observation-title"]').focus();
  }

  function syncCustomRelation() {
    const custom = $('[data-role="observation-link-relation"]').value === "custom";
    $('[data-role="observation-link-custom-wrap"]').hidden = !custom;
    if (custom) $('[data-role="observation-link-custom"]').focus();
  }

  function clearLink(message) {
    $('[data-role="observation-link-uid"]').value = "";
    $('[data-role="observation-link-relation"]').value = "同源";
    $('[data-role="observation-link-custom"]').value = "";
    $('[data-role="observation-link-custom-wrap"]').hidden = true;
    if (observations[0]) $('[data-role="observation-link-source"]').value = observations[0].uid;
    if (observations[1]) $('[data-role="observation-link-target"]').value = observations[1].uid;
    setStatus('[data-role="observation-link-status"]', message || "选择两颗星球建立一条弦");
  }

  function fillLink(link) {
    $('[data-role="observation-link-search"]').value = "";
    fillStarSelects("");
    $('[data-role="observation-link-uid"]').value = link.uid;
    $('[data-role="observation-link-source"]').value = link.source_uid;
    $('[data-role="observation-link-target"]').value = link.target_uid;
    const builtin = builtinRelations.has(link.relation);
    $('[data-role="observation-link-relation"]').value = builtin ? link.relation : "custom";
    $('[data-role="observation-link-custom"]').value = builtin ? "" : link.relation;
    $('[data-role="observation-link-custom-wrap"]').hidden = builtin;
    setStatus('[data-role="observation-link-status"]', "正在编辑既有弦，保存后原地更新");
  }

  function handleLoadError(error) {
    if (window.FlitFancyAdmin.isUnauthorized(error)) {
      window.FlitFancyAdmin.setToken(ADMIN_KEY, "");
      setStatus('[data-role="observation-status-text"]', "登录已过期，请重新点击旅途导航登录");
      return;
    }
    setStatus('[data-role="observation-status-text"]', error && error.status === 0
      ? "见闻记录库加载超时，登录状态已保留，可重新加载"
      : ((error && error.message) || "见闻记录库加载失败"));
  }

  async function loadAll() {
    if (loading || !window.FlitFancyAdmin.token(ADMIN_KEY)) return;
    loading = true;
    setStatus('[data-role="observation-status-text"]', "正在加载见闻记录库…");
    try {
      const data = await Promise.all([
        api("/api/admin/observations", { method: "GET" }),
        api("/api/admin/observation-links", { method: "GET" })
      ]);
      observations = data[0].rows || [];
      links = data[1].rows || [];
      loaded = true;
      renderObservations();
      renderLinks();
      setStatus('[data-role="observation-status-text"]', "见闻记录库已加载");
    } catch (error) {
      handleLoadError(error);
    }
    loading = false;
  }

  async function saveObservation() {
    const button = $('[data-role="observation-save"]');
    const payload = {
      uid: $('[data-role="observation-uid"]').value.trim(),
      title: $('[data-role="observation-title"]').value.trim(),
      category: $('[data-role="observation-category"]').value,
      tags: splitTags($('[data-role="observation-tags"]').value),
      summary: $('[data-role="observation-summary"]').value.trim(),
      content: $('[data-role="observation-content"]').value.trim(),
      discovered_at: $('[data-role="observation-discovered"]').value,
      source_name: $('[data-role="observation-source-name"]').value.trim(),
      source_url: $('[data-role="observation-source-url"]').value.trim(),
      status: $('[data-role="observation-status"]').value
    };
    if (!payload.title || !payload.summary || !payload.discovered_at) {
      setStatus('[data-role="observation-status-text"]', "标题、短描述和发现时间都要填写");
      return;
    }
    button.disabled = true;
    setStatus('[data-role="observation-status-text"]', "正在保存星球…");
    try {
      const data = await api("/api/observations", {
        method: "POST", body: JSON.stringify(payload)
      });
      await loadAll();
      clearObservation(data.public_sync ? "星球已保存并同步公开星图" : "星球已保存在本机，公网稍后补传");
    } catch (error) {
      handleLoadError(error);
    }
    button.disabled = false;
  }

  async function saveLink() {
    const button = $('[data-role="observation-link-save"]');
    const relationValue = $('[data-role="observation-link-relation"]').value;
    const payload = {
      uid: $('[data-role="observation-link-uid"]').value.trim(),
      source_uid: $('[data-role="observation-link-source"]').value,
      target_uid: $('[data-role="observation-link-target"]').value,
      relation: relationValue === "custom"
        ? $('[data-role="observation-link-custom"]').value.trim()
        : relationValue
    };
    if (!payload.source_uid || !payload.target_uid || !payload.relation) {
      setStatus('[data-role="observation-link-status"]', "请选择两颗星球并填写关系词");
      return;
    }
    button.disabled = true;
    setStatus('[data-role="observation-link-status"]', "正在保存弦…");
    try {
      const data = await api("/api/observation-links", {
        method: "POST", body: JSON.stringify(payload)
      });
      await loadAll();
      clearLink(data.public_sync ? "弦已保存并同步公开星图" : "弦已保存在本机，公网稍后补传");
    } catch (error) {
      if (window.FlitFancyAdmin.isUnauthorized(error)) {
        window.FlitFancyAdmin.setToken(ADMIN_KEY, "");
      }
      setStatus('[data-role="observation-link-status"]', (error && error.message) || "弦保存失败");
    }
    button.disabled = false;
  }

  document.querySelectorAll('[data-role="editor-tab"]').forEach(function (tab) {
    if (tab.getAttribute("data-tab") !== "observations") return;
    tab.addEventListener("click", function () { if (!loaded) loadAll(); });
  });
  $('[data-role="observation-new"]').addEventListener("click", function () { clearObservation(); });
  $('[data-role="observation-reload"]').addEventListener("click", loadAll);
  $('[data-role="observation-save"]').addEventListener("click", saveObservation);
  $('[data-role="observation-link-new"]').addEventListener("click", function () { clearLink(); });
  $('[data-role="observation-link-save"]').addEventListener("click", saveLink);
  $('[data-role="observation-link-search"]').addEventListener("input", function () {
    fillStarSelects(this.value);
  });
  $('[data-role="observation-link-relation"]').addEventListener("change", syncCustomRelation);
  clearObservation("新增或选择一颗星球开始记录");
  clearLink("至少有两颗星球后就可以建立弦");
})();
