/* 关于页卡牌库：浏览与编辑留在本地，明确选择后才更新展示文章。 */
(function () {
  "use strict";
  const $ = function (selector) { return document.querySelector(selector); };
  const ADMIN_KEY = "flitfancy.admin.token";
  const adminSurface = window.FlitFancyAdmin.isAdminHost();
  const statusNames = { draft: "草稿", public: "公开", archived: "归档" };
  const PROLOGUE_UID = "builtin-prologue-0001";
  const deck = $('[data-role="essay-admin-list"]');
  const compose = $('[data-role="essay-compose"]');
  const panel = $('[data-role="essay-editor"]');
  let rows = [];
  let featured = null;
  let editing = null;
  let initialForm = "";
  let busy = false;
  let position = 0;

  function prologue() {
    const original = $('[data-role="essay-prologue"]');
    return {
      uid: PROLOGUE_UID,
      title: original.querySelector("h2").textContent,
      content: Array.from(original.querySelectorAll(":scope > p")).map(function (p) {
        return p.textContent;
      }).join("\n\n"),
      status: "draft", display_order: 100, builtin: true
    };
  }
  function currentUid() { return featured ? featured.uid : PROLOGUE_UID; }
  function formValue() {
    return JSON.stringify([$('[data-role="essay-title"]').value, $('[data-role="essay-content"]').value]);
  }
  function canLeave() {
    return !busy && (!editing || formValue() === initialForm || window.confirm("这张卡牌有尚未保存的文字，要放弃这些修改吗？"));
  }
  function parkForm() {
    if (compose.parentNode) delete compose.parentNode.dataset.editing;
    compose.hidden = true;
    panel.appendChild(compose);
    editing = null;
  }
  function moveTo(index) {
    position = Math.max(0, Math.min(index, deck.children.length - 1));
    const card = deck.children[position];
    if (card) deck.scrollTo({ left: card.offsetLeft - deck.children[0].offsetLeft, behavior: "auto" });
    updatePosition();
  }
  function updatePosition() {
    if (!deck.children.length) return;
    let distance = Infinity;
    Array.from(deck.children).forEach(function (card, index) {
      const delta = Math.abs(card.offsetLeft - deck.children[0].offsetLeft - deck.scrollLeft);
      if (delta < distance) { distance = delta; position = index; }
    });
    setStatus('[data-role="essay-position"]', (position + 1) + " / " + deck.children.length);
    $('[data-role="essay-prev"]').disabled = position === 0;
    $('[data-role="essay-next"]').disabled = position === deck.children.length - 1;
  }
  function startEditing(row, card) {
    if (!canLeave()) return;
    parkForm();
    editing = row;
    $('[data-role="essay-uid"]').value = row.uid || "";
    $('[data-role="essay-title"]').value = row.title || "";
    $('[data-role="essay-content"]').value = row.content || "";
    initialForm = formValue();
    card.dataset.editing = "true";
    card.appendChild(compose);
    compose.hidden = false;
    moveTo(Array.from(deck.children).indexOf(card));
    setStatus('[data-role="essay-write-status"]', row.uid ? "正在编辑卡牌；保存不会切换展示文章" : "正在写一张新卡牌");
    $('[data-role="essay-title"]').focus({ preventScroll: true });
  }

  function token() { return window.FlitFancyAdmin.token(ADMIN_KEY); }
  function setToken(value) { window.FlitFancyAdmin.setToken(ADMIN_KEY, value); }
  function api(path, options) {
    return window.FlitFancyAdmin.request(path, Object.assign({ authMode: "always" }, options));
  }
  function setStatus(selector, text) {
    const target = $(selector);
    if (target) target.textContent = text || "";
  }

  const panelShell = window.FlitFancyPanelShell.init({
    panel: $('[data-role="essay-editor"]'),
    grab: $('[data-role="essay-editor-grab"]'),
    collapseBtn: $('[data-role="essay-collapse"]'),
    expandTab: $('[data-role="essay-expand-tab"]'),
    storageKey: "flitfancy.essay.panelW",
    openClass: "editor-open",
    min: 320,
    max: 900
  });

  function newCard() {
    if (!deck.lastElementChild) { setStatus('[data-role="essay-write-status"]', "请先重新加载卡牌库"); return; }
    startEditing({ uid: "", title: "", content: "", status: "draft", display_order: 100 }, deck.lastElementChild);
  }

  function action(label, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-ghost";
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  async function featureCard(row) {
    if (!canLeave()) return;
    busy = true;
    setStatus('[data-role="essay-write-status"]', "正在更新展示文章…");
    try {
      if (row.builtin || row.status !== "public") {
        const saved = await savePayload(Object.assign({}, row, { status: "public" }));
        row = saved.essay;
      }
      const data = await api("/api/essays/featured", {
        method: "POST", body: JSON.stringify({ uid: row.uid })
      });
      featured = data.essay;
      parkForm();
      await loadRowsWithStatus(row.uid);
      document.dispatchEvent(new CustomEvent("flitfancy:essay-saved"));
      setStatus('[data-role="essay-write-status"]', data.public_sync
        ? "已设为展示；公网可能需要片刻更新"
        : "本机已选定，公网尚未更新。请稍后点“更新展示”重试。");
    } catch (error) {
      setStatus('[data-role="essay-write-status"]', error.message || "展示更新失败，请重试");
    } finally { busy = false; }
  }

  async function archiveCard(row) {
    if (!canLeave() || !window.confirm("归档后卡牌仍会保留，之后可以恢复。确定归档吗？")) return;
    busy = true;
    try {
      await savePayload(Object.assign({}, row, { status: "archived" }));
      parkForm();
      await loadRowsWithStatus(row.uid);
      setStatus('[data-role="essay-write-status"]', "卡牌已归档");
    } catch (error) {
      setStatus('[data-role="essay-write-status"]', error.message || "归档失败");
    } finally { busy = false; }
  }

  function renderRows(focusUid) {
    parkForm();
    deck.textContent = "";
    rows.forEach(function (row, index) {
      const card = document.createElement("article");
      card.className = "essay-library-card";
      card.dataset.featured = String(row.uid === currentUid());
      card.setAttribute("aria-label", row.title || "未命名短文");
      const number = document.createElement("span");
      number.className = "essay-card-number";
      number.textContent = "CARD " + String(index + 1).padStart(2, "0") + (row.uid === currentUid() ? " · 当前展示" : " · " + (statusNames[row.status] || "草稿"));
      const title = document.createElement("h3");
      title.textContent = row.title || "未命名短文";
      const content = document.createElement("p");
      content.className = "essay-card-text";
      content.textContent = row.content || "";
      const actions = document.createElement("div");
      actions.className = "essay-card-actions";
      actions.appendChild(action(row.status === "archived" ? "恢复并编辑" : "编辑卡牌", function () {
        startEditing(Object.assign({}, row, { status: row.status === "archived" ? "draft" : row.status }), card);
      }));
      if (row.status !== "archived") {
        actions.appendChild(action(row.uid === currentUid() ? "更新展示" : "设为展示", function () { return featureCard(row); }));
        if (row.uid !== currentUid()) actions.appendChild(action("归档", function () { return archiveCard(row); }));
      }
      card.appendChild(number);
      card.appendChild(title);
      card.appendChild(content);
      card.appendChild(actions);
      deck.appendChild(card);
    });
    const blank = document.createElement("article");
    blank.className = "essay-library-card essay-new-card";
    const label = document.createElement("h3");
    label.textContent = "下一篇，留给此刻的你";
    const help = document.createElement("p");
    help.className = "hint";
    help.textContent = "新建一张卡牌，装下新的文字。";
    blank.appendChild(label);
    blank.appendChild(help);
    blank.appendChild(action("＋ 新建卡牌", newCard));
    deck.appendChild(blank);
    const target = rows.findIndex(function (row) { return row.uid === (focusUid || currentUid()); });
    moveTo(target < 0 ? 0 : target);
  }

  async function loadRows(focusUid) {
    const data = await api("/api/admin/essays", { method: "GET" });
    rows = data.rows || [];
    if (!rows.some(function (row) { return row.uid === PROLOGUE_UID; })) rows.unshift(prologue());
    featured = data.featured_essay || null;
    renderRows(focusUid);
  }

  function openPanel() {
    panelShell.show();
    $('[data-role="essay-login-overlay"]').hidden = true;
  }

  async function loadRowsWithStatus(focusUid) {
    setStatus('[data-role="essay-library-status"]', "正在加载短文库…");
    try {
      await loadRows(focusUid);
      setStatus('[data-role="essay-library-status"]', "短文库已加载");
      return true;
    } catch (error) {
      if (window.FlitFancyAdmin.isUnauthorized(error)) {
        setToken("");
        panelShell.hide();
        showLogin("登录已过期，请重新登录");
        return false;
      }
      const message = error && error.status === 0
        ? "短文库加载超时，可重试"
        : "短文库加载失败，可重试：" + ((error && error.message) || "未知错误");
      setStatus('[data-role="essay-library-status"]', message);
      return false;
    }
  }

  function showLogin(message) {
    $('[data-role="essay-login-overlay"]').hidden = false;
    $('[data-role="essay-password"]').value = "";
    setStatus('[data-role="essay-login-status"]', message || "");
    ($('[data-role="essay-username"]').value
      ? $('[data-role="essay-password"]')
      : $('[data-role="essay-username"]')).focus();
  }

  async function openManager() {
    if (!adminSurface) {
      window.location.href = "https://console.flitfancy.com/about.html#write";
      return;
    }
    if (!token()) {
      showLogin("");
      return;
    }
    openPanel();
    if (canLeave()) await loadRowsWithStatus();
  }

  async function login() {
    const username = $('[data-role="essay-username"]').value.trim();
    const password = $('[data-role="essay-password"]').value;
    const button = $('[data-role="essay-login"]');
    if (!username || !password) {
      setStatus('[data-role="essay-login-status"]', "请输入用户名和密码");
      return;
    }
    button.disabled = true;
    setStatus('[data-role="essay-login-status"]', "正在验证…");
    try {
      const data = await api("/api/admin/login", {
        method: "POST",
        authMode: "none",
        body: JSON.stringify({ username: username, password: password })
      });
      setToken(data.token);
      openPanel();
      await loadRowsWithStatus();
    } catch (error) {
      setStatus('[data-role="essay-login-status"]', error.message || "登录失败");
    }
    button.disabled = false;
  }

  async function savePayload(payload) {
    setStatus('[data-role="essay-write-status"]', "正在保存卡牌…");
    const data = await api("/api/essays", {
      method: "POST",
      body: JSON.stringify({
        uid: payload.uid || "",
        title: String(payload.title || "").trim(),
        content: String(payload.content || "").trim(),
        status: payload.status || "draft",
        display_order: Number.parseInt(payload.display_order, 10) || 0
      })
    });
    return data;
  }

  async function save() {
    if (busy || !editing) return;
    const payload = Object.assign({}, editing, {
      title: $('[data-role="essay-title"]').value.trim(),
      content: $('[data-role="essay-content"]').value.trim()
    });
    if (!payload.title || !payload.content) {
      setStatus('[data-role="essay-write-status"]', "标题和正文都要填写");
      return;
    }
    busy = true;
    $('[data-role="essay-save"]').disabled = true;
    try {
      const data = await savePayload(payload);
      parkForm();
      await loadRowsWithStatus(data.essay.uid);
      setStatus('[data-role="essay-write-status"]', "卡牌已保存。想让访客看到这篇，请点“设为展示”或“更新展示”。");
    } catch (error) {
      if (window.FlitFancyAdmin.isUnauthorized(error)) setToken("");
      setStatus('[data-role="essay-write-status"]', error.message || "保存失败");
    } finally {
      busy = false;
      $('[data-role="essay-save"]').disabled = false;
    }
  }

  async function logout() {
    if (!canLeave()) return;
    parkForm();
    try { await api("/api/admin/logout", { method: "POST" }); } catch (error) { /* ignore */ }
    setToken("");
    $('[data-role="essay-editor"]').hidden = true;
    document.body.classList.remove("editor-open");
    panelShell.clearCollapsed();
  }

  window.FlitFancyAdmin.installErrorHandler('[data-role="js-error"]');
  $('.nav nav a[href="about.html"]').addEventListener("click", function (event) {
    event.preventDefault();
    openManager();
  });
  $('[data-role="essay-login"]').addEventListener("click", login);
  $('[data-role="essay-login-cancel"]').addEventListener("click", function () {
    $('[data-role="essay-login-overlay"]').hidden = true;
  });
  $('[data-role="essay-password"]').addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); login(); }
  });
  $('[data-role="essay-save"]').addEventListener("click", save);
  $('[data-role="essay-new"]').addEventListener("click", newCard);
  $('[data-role="essay-reload"]').addEventListener("click", function () { if (canLeave()) loadRowsWithStatus(); });
  $('[data-role="essay-cancel"]').addEventListener("click", function () { if (canLeave()) parkForm(); });
  $('[data-role="essay-prev"]').addEventListener("click", function () { moveTo(position - 1); });
  $('[data-role="essay-next"]').addEventListener("click", function () { moveTo(position + 1); });
  deck.addEventListener("scroll", updatePosition, { passive: true });
  deck.addEventListener("keydown", function (event) {
    if (event.target !== deck) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault(); moveTo(position + (event.key === "ArrowRight" ? 1 : -1));
    }
  });
  window.addEventListener("beforeunload", function (event) {
    if (editing && formValue() !== initialForm) { event.preventDefault(); event.returnValue = ""; }
  });
  $('[data-role="essay-logout"]').addEventListener("click", logout);
  if (window.location.hash === "#write") openManager();
})();
