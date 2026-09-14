(function () {
  "use strict";

  const $ = function (selector) { return document.querySelector(selector); };
  const ADMIN_KEY = "flitfancy.admin.token";
  const statusNames = { draft: "草稿", public: "公开", archived: "归档" };
  const strengthNames = { weak: "弱", medium: "中", strong: "强" };
  const builtinRelations = new Set(["同源", "因果", "类比", "延伸"]);
  let observations = [];
  let links = [];
  let loaded = false;
  let loading = false;
  let saving = false;
  let observationBaseline = "";
  let linkBaseline = "";
  const kinds = ["事", "理", "物", "人", "地"];
  const observationFields = ["uid", "category", "title", "content", "tags", "summary", "discovered", "source-name", "source-url", "status"];

  function observationState() {
    return JSON.stringify(observationFields.map(function (name) { return $('[data-role="observation-' + name + '"]').value; }));
  }
  function linkState() {
    return JSON.stringify(["uid", "source", "target", "relation", "custom", "strength"].map(function (name) {
      return $('[data-role="observation-link-' + name + '"]').value;
    }));
  }
  function leaveObservation() {
    return !saving && (observationState() === observationBaseline || window.confirm("这颗星球有未保存的文字，要放弃这些修改吗？"));
  }
  function leaveLink() {
    return !saving && ($('[data-role="observation-link-editor"]').hidden || linkState() === linkBaseline || window.confirm("这条弦还没有保存，要放弃修改吗？"));
  }
  function setSaving(value) {
    saving = value;
    $('[data-role="observation-compose"]').inert = value;
    $('[data-role="observation-link-editor"]').inert = value;
  }
  function autoSummary(content) {
    return Array.from(String(content || "").trim().replace(/\s+/g, " ")).slice(0, 160).join("");
  }
  function selectKind(value) {
    $('[data-role="observation-category"]').value = value;
    document.querySelectorAll("[data-observation-kind]").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-observation-kind") === value));
    });
    const legacy = $('[data-role="observation-legacy-category"]');
    legacy.hidden = kinds.includes(value);
    legacy.textContent = legacy.hidden ? "" : "原分类：" + value;
  }
  function updateSaveActions(star) {
    const published = star && star.status === "public";
    $('[data-role="observation-save"]').textContent = published ? "保存修改" : "存草稿";
    $('[data-role="observation-publish"]').hidden = !!published;
    $('[data-role="observation-withdraw"]').hidden = !published;
    $('[data-role="observation-archive"]').hidden = !star || star.status === "archived";
    $('[data-role="observation-connect"]').hidden = !star;
  }
  function action(label, callback) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "btn btn-ghost"; button.textContent = label;
    button.addEventListener("click", callback);
    return button;
  }

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
    const sourceUid = $('[data-role="observation-link-source"]').value;
    const target = $('[data-role="observation-link-target"]');
    const targetValue = target.value;
    const needle = String(query || "").trim().toLowerCase();
    target.textContent = "";
    const empty = document.createElement("option");
    empty.value = ""; empty.textContent = "选择另一颗星球";
    target.appendChild(empty);
    observations.filter(function (star) {
      return star.uid !== sourceUid && (!needle || starSearchText(star).includes(needle));
    }).forEach(function (star) { target.appendChild(optionFor(star)); });
    target.value = [...target.options].some(function (option) { return option.value === targetValue; }) ? targetValue : "";
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
    const actions = document.createElement("div");
    actions.className = "observation-actions";
    actions.appendChild(action("编辑", function () {
      if (leaveObservation() && leaveLink()) fillObservation(star, true);
    }));
    actions.appendChild(action("连接", function () { if (leaveLink()) beginLink(star); }));
    item.appendChild(info);
    item.appendChild(actions);
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
    meta.textContent = link.relation + " · " + (strengthNames[link.strength] || "中") +
      (publicLink ? " · 已公开" : " · 随星球暂存本地");
    info.appendChild(title);
    info.appendChild(meta);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "btn btn-ghost";
    edit.textContent = "编辑";
    edit.addEventListener("click", function () { if (leaveLink()) fillLink(link); });
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
    selectKind("事");
    $('[data-role="observation-tags"]').value = "";
    $('[data-role="observation-summary"]').value = "";
    $('[data-role="observation-content"]').value = "";
    $('[data-role="observation-discovered"]').value = today();
    $('[data-role="observation-source-name"]').value = "";
    $('[data-role="observation-source-url"]').value = "";
    $('[data-role="observation-status"]').value = "draft";
    $('[data-role="observation-more"]').open = false;
    $('[data-role="observation-link-editor"]').hidden = true;
    updateSaveActions(null);
    observationBaseline = observationState();
    setStatus('[data-role="observation-status-text"]', message || "");
  }

  function fillObservation(star, focus) {
    $('[data-role="observation-uid"]').value = star.uid;
    $('[data-role="observation-title"]').value = star.title || "";
    selectKind(star.category || "事");
    $('[data-role="observation-tags"]').value = (star.tags || []).join("，");
    const content = star.content || star.summary || "";
    $('[data-role="observation-summary"]').value = star.summary === autoSummary(content) ? "" : (star.summary || "");
    $('[data-role="observation-content"]').value = content;
    $('[data-role="observation-discovered"]').value = star.discovered_at || today();
    $('[data-role="observation-source-name"]').value = star.source_name || "";
    $('[data-role="observation-source-url"]').value = star.source_url || "";
    $('[data-role="observation-status"]').value = star.status || "draft";
    $('[data-role="observation-more"]').open = false;
    updateSaveActions(star);
    observationBaseline = observationState();
    setStatus('[data-role="observation-status-text"]', statusNames[star.status] || "");
    if (focus) {
      $('[data-role="observation-link-editor"]').hidden = true;
      $('[data-role="observation-title"]').focus();
    }
  }

  function syncCustomRelation() {
    const custom = $('[data-role="observation-link-relation"]').value === "custom";
    $('[data-role="observation-link-custom-wrap"]').hidden = !custom;
    if (custom) $('[data-role="observation-link-custom"]').focus();
  }

  function beginLink(star) {
    if (!star || saving) return;
    $('[data-role="observation-link-editor"]').hidden = false;
    $('[data-role="observation-link-source"]').value = star.uid;
    setStatus('[data-role="observation-link-origin"]', "从“" + star.title + "”连接到");
    clearLink();
    $('[data-role="observation-link-target"]').focus();
  }

  function clearLink(message) {
    $('[data-role="observation-link-uid"]').value = "";
    $('[data-role="observation-link-search"]').value = "";
    $('[data-role="observation-link-target"]').value = "";
    $('[data-role="observation-link-relation"]').value = "同源";
    $('[data-role="observation-link-strength"]').value = "medium";
    $('[data-role="observation-link-custom"]').value = "";
    $('[data-role="observation-link-custom-wrap"]').hidden = true;
    fillStarSelects("");
    linkBaseline = linkState();
    setStatus('[data-role="observation-link-status"]', message || (observations.length < 2 ? "保存另一颗星球后，就可以连弦了。" : ""));
  }

  function fillLink(link) {
    const source = starById(link.source_uid);
    if (!source) return;
    beginLink(source);
    $('[data-role="observation-link-uid"]').value = link.uid;
    $('[data-role="observation-link-target"]').value = link.target_uid;
    $('[data-role="observation-link-strength"]').value = strengthNames[link.strength] ? link.strength : "medium";
    const builtin = builtinRelations.has(link.relation);
    $('[data-role="observation-link-relation"]').value = builtin ? link.relation : "custom";
    $('[data-role="observation-link-custom"]').value = builtin ? "" : link.relation;
    $('[data-role="observation-link-custom-wrap"]').hidden = builtin;
    linkBaseline = linkState();
    setStatus('[data-role="observation-link-status"]', "正在编辑这条弦");
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
    if (loading || saving || !window.FlitFancyAdmin.token(ADMIN_KEY)) return;
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

  async function saveObservation(status) {
    if (saving || loading) return;
    const content = $('[data-role="observation-content"]').value.trim();
    const payload = {
      uid: $('[data-role="observation-uid"]').value.trim(),
      title: $('[data-role="observation-title"]').value.trim(),
      category: $('[data-role="observation-category"]').value,
      tags: splitTags($('[data-role="observation-tags"]').value),
      summary: $('[data-role="observation-summary"]').value.trim() || autoSummary(content),
      content: content,
      discovered_at: $('[data-role="observation-discovered"]').value || today(),
      source_name: $('[data-role="observation-source-name"]').value.trim(),
      source_url: $('[data-role="observation-source-url"]').value.trim(),
      status: status
    };
    if (!payload.title || !payload.content) {
      setStatus('[data-role="observation-status-text"]', "写上标题和内容就可以保存了");
      return;
    }
    setSaving(true);
    setStatus('[data-role="observation-status-text"]', "正在保存…");
    try {
      const data = await api("/api/observations", { method: "POST", body: JSON.stringify(payload) });
      const saved = data.observation;
      observations = observations.filter(function (star) { return star.uid !== saved.uid; });
      observations.unshift(saved);
      renderObservations();
      renderLinks();
      fillObservation(saved, false);
      setStatus('[data-role="observation-status-text"]', status === "public"
        ? (data.public_sync ? "已公开，可以继续连接其他星球" : "已保存在本机，公开内容等待同步")
        : ((status === "archived" ? "已归档" : "草稿已保存") + (data.public_sync ? "" : "；公网变更等待同步")));
    } catch (error) {
      handleLoadError(error);
    } finally { setSaving(false); }
  }

  async function saveLink() {
    if (saving || loading) return;
    const button = $('[data-role="observation-link-save"]');
    const relationValue = $('[data-role="observation-link-relation"]').value;
    const payload = {
      uid: $('[data-role="observation-link-uid"]').value.trim(),
      source_uid: $('[data-role="observation-link-source"]').value,
      target_uid: $('[data-role="observation-link-target"]').value,
      strength: $('[data-role="observation-link-strength"]').value,
      relation: relationValue === "custom"
        ? $('[data-role="observation-link-custom"]').value.trim()
        : relationValue
    };
    if (!payload.source_uid || !payload.target_uid || payload.source_uid === payload.target_uid || !payload.relation) {
      setStatus('[data-role="observation-link-status"]', "请选择两颗星球并填写关系词");
      return;
    }
    setSaving(true);
    button.disabled = true;
    setStatus('[data-role="observation-link-status"]', "正在保存弦…");
    try {
      const data = await api("/api/observation-links", {
        method: "POST", body: JSON.stringify(payload)
      });
      links = links.filter(function (link) { return link.uid !== data.link.uid; });
      links.unshift(data.link);
      renderLinks();
      $('[data-role="observation-link-uid"]').value = data.link.uid;
      linkBaseline = linkState();
      setStatus('[data-role="observation-link-status"]', data.public_sync ? "弦已保存" : "弦已保存在本机，公网变更等待同步");
    } catch (error) {
      if (window.FlitFancyAdmin.isUnauthorized(error)) {
        window.FlitFancyAdmin.setToken(ADMIN_KEY, "");
      }
      setStatus('[data-role="observation-link-status"]', (error && error.message) || "弦保存失败");
    }
    button.disabled = false;
    setSaving(false);
  }

  document.querySelectorAll('[data-role="editor-tab"]').forEach(function (tab) {
    if (tab.getAttribute("data-tab") !== "observations") return;
    tab.addEventListener("click", function () { if (!loaded) loadAll(); });
  });
  document.querySelectorAll("[data-observation-kind]").forEach(function (button) {
    button.addEventListener("click", function () { if (!saving) selectKind(button.getAttribute("data-observation-kind")); });
  });
  $('[data-role="observation-new"]').addEventListener("click", function () {
    if (leaveObservation() && leaveLink()) { clearObservation(); $('[data-role="observation-title"]').focus(); }
  });
  $('[data-role="observation-reload"]').addEventListener("click", loadAll);
  $('[data-role="observation-save"]').addEventListener("click", function () {
    return saveObservation($('[data-role="observation-status"]').value === "public" ? "public" : "draft");
  });
  $('[data-role="observation-publish"]').addEventListener("click", function () { return saveObservation("public"); });
  $('[data-role="observation-withdraw"]').addEventListener("click", function () {
    if (!saving && window.confirm("撤回后星球及关联弦会从公开星图下架，内容保留为草稿。继续吗？")) saveObservation("draft");
  });
  $('[data-role="observation-archive"]').addEventListener("click", function () {
    if (!saving && window.confirm("归档后保留记录，并从公开星图下架。继续吗？")) saveObservation("archived");
  });
  $('[data-role="observation-connect"]').addEventListener("click", function () {
    if (leaveLink()) beginLink(starById($('[data-role="observation-uid"]').value));
  });
  $('[data-role="observation-link-new"]').addEventListener("click", function () { if (leaveLink()) clearLink(); });
  $('[data-role="observation-link-close"]').addEventListener("click", function () {
    if (leaveLink()) $('[data-role="observation-link-editor"]').hidden = true;
  });
  $('[data-role="observation-link-save"]').addEventListener("click", saveLink);
  $('[data-role="observation-link-search"]').addEventListener("input", function () { fillStarSelects(this.value); });
  $('[data-role="observation-link-relation"]').addEventListener("change", syncCustomRelation);
  window.addEventListener("beforeunload", function (event) {
    if (observationState() !== observationBaseline || (!$('[data-role="observation-link-editor"]').hidden && linkState() !== linkBaseline)) {
      event.preventDefault(); event.returnValue = "";
    }
  });
  clearObservation();
  clearLink();
})();
