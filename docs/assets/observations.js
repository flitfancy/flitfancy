(function () {
  "use strict";

  const WORLD = { width: 2800, height: 1900 };
  const API = (location.hostname === "localhost" || location.hostname === "127.0.0.1")
    ? "/api/observations"
    : "https://api.flitfancy.com/observations";
  const categoryColors = {
    "宇宙与自然": "#78c8e8",
    "生命与感知": "#8bd3aa",
    "技术与造物": "#f5b84b",
    "历史与文明": "#d7a6e8",
    "语言与艺术": "#ef9eb5",
    "思想与日常": "#9daee8"
  };
  const root = document.querySelector('[data-role="observations-root"]');
  if (!root) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const camera = { x: WORLD.width / 2, y: WORLD.height / 2, zoom: 1 };
  const origin = { x: camera.x, y: camera.y, zoom: 1 };
  const positions = new Map();
  let observations = [];
  let links = [];
  let selectedUid = "";
  let listMode = false;
  let animationFrame = 0;
  let mapFrame = 0;

  function hash(text) {
    let value = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    return value >>> 0;
  }

  function stablePosition(uid) {
    return {
      x: 180 + (hash(uid + ":x") % (WORLD.width - 360)),
      y: 160 + (hash(uid + ":y") % (WORLD.height - 320))
    };
  }

  function wrap(value, size) {
    return ((value % size) + size) % size;
  }

  function wrappedDelta(value, center, size) {
    let delta = value - center;
    if (delta > size / 2) delta -= size;
    if (delta < -size / 2) delta += size;
    return delta;
  }

  function starById(uid) {
    return observations.find(function (star) { return star.uid === uid; });
  }

  function safeSourceUrl(value) {
    try {
      const url = new URL(String(value || ""), location.href);
      return (url.protocol === "http:" || url.protocol === "https:") ? url.href : "";
    } catch (error) {
      return "";
    }
  }

  function normalizeStar(row) {
    return {
      uid: String(row.uid || ""),
      title: String(row.title || "未命名星球"),
      category: String(row.category || "思想与日常"),
      tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
      summary: String(row.summary || ""),
      content: String(row.content || ""),
      discovered_at: String(row.discovered_at || "").slice(0, 10),
      source_name: String(row.source_name || ""),
      source_url: safeSourceUrl(row.source_url)
    };
  }

  function normalizeLink(row, known) {
    const sourceUid = String(row.source_uid || "");
    const targetUid = String(row.target_uid || "");
    if (!known.has(sourceUid) || !known.has(targetUid) || sourceUid === targetUid) return null;
    return {
      uid: String(row.uid || sourceUid + "-" + targetUid),
      source_uid: sourceUid,
      target_uid: targetUid,
      relation: String(row.relation || "相关")
    };
  }

  function svgElement(name, attrs) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.keys(attrs).forEach(function (key) { element.setAttribute(key, String(attrs[key])); });
    return element;
  }

  function createPlanet(star) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "obs-planet";
    button.dataset.star = star.uid;
    button.setAttribute("aria-label", star.title + "；" + star.category + "；" + star.summary);
    button.style.setProperty("--planet-color", categoryColors[star.category] || "#f5b84b");

    const ringOne = document.createElement("span");
    ringOne.className = "obs-ring obs-ring-one";
    const ringTwo = document.createElement("span");
    ringTwo.className = "obs-ring obs-ring-two";
    const core = document.createElement("span");
    core.className = "obs-planet-core";
    core.textContent = star.title;
    const category = document.createElement("span");
    category.className = "obs-orbit-label";
    category.textContent = star.category;
    const summary = document.createElement("span");
    summary.className = "obs-orbit-label obs-orbit-summary";
    summary.textContent = star.summary;

    button.appendChild(ringTwo);
    button.appendChild(ringOne);
    button.appendChild(core);
    button.appendChild(category);
    button.appendChild(summary);
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      focusStar(star.uid, true);
    });
    button.addEventListener("focus", function () {
      selectedUid = star.uid;
      renderDetail();
      scheduleMap();
    });
    return button;
  }

  function buildPlanets() {
    const layer = root.querySelector('[data-role="planets"]');
    layer.textContent = "";
    observations.forEach(function (star) { layer.appendChild(createPlanet(star)); });
    root.querySelector('[data-role="empty"]').hidden = observations.length !== 0;
  }

  function screenPoint(uid, width, height) {
    const point = positions.get(uid);
    return {
      x: width / 2 + wrappedDelta(point.x, camera.x, WORLD.width) * camera.zoom,
      y: height / 2 + wrappedDelta(point.y, camera.y, WORLD.height) * camera.zoom
    };
  }

  function renderStrings(width, height) {
    const svg = root.querySelector('[data-role="strings"]');
    svg.textContent = "";
    links.forEach(function (connection) {
      const from = positions.get(connection.source_uid);
      const to = positions.get(connection.target_uid);
      if (!from || !to) return;
      const start = screenPoint(connection.source_uid, width, height);
      const end = {
        x: start.x + wrappedDelta(to.x, from.x, WORLD.width) * camera.zoom,
        y: start.y + wrappedDelta(to.y, from.y, WORLD.height) * camera.zoom
      };
      const active = selectedUid === connection.source_uid || selectedUid === connection.target_uid;
      const line = svgElement("line", {
        x1: start.x, y1: start.y, x2: end.x, y2: end.y,
        class: "obs-string" + (active ? " is-active" : "")
      });
      const label = svgElement("text", {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2 - 6,
        class: "obs-string-label",
        "text-anchor": "middle"
      });
      label.textContent = connection.relation;
      svg.appendChild(line);
      svg.appendChild(label);
    });
  }

  function renderMap() {
    mapFrame = 0;
    const viewport = root.querySelector('[data-role="viewport"]');
    if (!viewport || viewport.hidden) return;
    const rect = viewport.getBoundingClientRect();
    root.querySelectorAll("[data-star]").forEach(function (node) {
      const uid = node.getAttribute("data-star");
      const point = screenPoint(uid, rect.width, rect.height);
      node.style.left = point.x + "px";
      node.style.top = point.y + "px";
      node.style.transform = "translate(-50%, -50%) scale(" +
        Math.max(0.72, Math.min(1.22, camera.zoom)) + ")";
      node.hidden = point.x < -210 || point.x > rect.width + 210 ||
        point.y < -210 || point.y > rect.height + 210;
      node.classList.toggle("is-selected", selectedUid === uid);
    });
    renderStrings(rect.width, rect.height);
    root.querySelector('[data-role="state"]').textContent =
      observations.length + " 颗星 · " + links.length + " 条弦 · " +
      Math.round(camera.zoom * 100) + "%";
  }

  function scheduleMap() {
    if (!mapFrame) mapFrame = requestAnimationFrame(renderMap);
  }

  function closeDetail() {
    selectedUid = "";
    root.querySelector('[data-role="detail"]').hidden = true;
    scheduleMap();
  }

  function renderDetail() {
    const panel = root.querySelector('[data-role="detail"]');
    const star = starById(selectedUid);
    panel.textContent = "";
    panel.hidden = !star;
    if (!star) return;

    const inner = document.createElement("div");
    inner.className = "obs-detail-inner";
    const head = document.createElement("div");
    head.className = "obs-detail-head";
    const heading = document.createElement("div");
    const kicker = document.createElement("p");
    kicker.className = "kicker";
    kicker.textContent = star.category;
    const title = document.createElement("h2");
    title.textContent = star.title;
    heading.appendChild(kicker);
    heading.appendChild(title);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn btn-ghost";
    close.textContent = "关闭";
    close.addEventListener("click", closeDetail);
    head.appendChild(heading);
    head.appendChild(close);

    const summary = document.createElement("p");
    summary.className = "obs-detail-summary";
    summary.textContent = star.summary;
    const content = document.createElement("p");
    content.textContent = star.content || star.summary;
    const tags = document.createElement("div");
    tags.className = "obs-detail-tags";
    star.tags.forEach(function (tag) {
      const chip = document.createElement("span");
      chip.textContent = tag;
      tags.appendChild(chip);
    });
    const meta = document.createElement("div");
    meta.className = "obs-detail-meta";
    const discovered = document.createElement("span");
    discovered.textContent = star.discovered_at ? "发现于 " + star.discovered_at : "未记录发现时间";
    meta.appendChild(discovered);
    if (star.source_url) {
      const source = document.createElement("a");
      source.href = star.source_url;
      source.target = "_blank";
      source.rel = "noopener noreferrer";
      source.textContent = star.source_name || "查看来源";
      meta.appendChild(source);
    } else if (star.source_name) {
      const sourceName = document.createElement("span");
      sourceName.textContent = "来源 · " + star.source_name;
      meta.appendChild(sourceName);
    }

    const relatedLinks = links.filter(function (link) {
      return link.source_uid === star.uid || link.target_uid === star.uid;
    });
    if (relatedLinks.length) {
      const related = document.createElement("div");
      related.className = "obs-related";
      relatedLinks.forEach(function (link) {
        const targetUid = link.source_uid === star.uid ? link.target_uid : link.source_uid;
        const target = starById(targetUid);
        if (!target) return;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = link.relation + " · " + target.title;
        button.addEventListener("click", function () { focusStar(targetUid, true); });
        related.appendChild(button);
      });
      meta.appendChild(related);
    }

    inner.appendChild(head);
    inner.appendChild(summary);
    inner.appendChild(content);
    if (star.tags.length) inner.appendChild(tags);
    inner.appendChild(meta);
    panel.appendChild(inner);
  }

  function renderAccessibleList() {
    const list = root.querySelector('[data-role="accessible-list"]');
    list.textContent = "";
    observations.forEach(function (star) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "obs-accessible-card";
      const title = document.createElement("strong");
      title.textContent = star.title;
      const meta = document.createElement("span");
      meta.textContent = [star.discovered_at, star.category, star.tags.join(" / ")]
        .filter(Boolean).join(" · ");
      const summary = document.createElement("span");
      summary.textContent = star.summary;
      button.appendChild(title);
      button.appendChild(meta);
      button.appendChild(summary);
      button.addEventListener("click", function () {
        setListMode(false);
        focusStar(star.uid, true);
      });
      list.appendChild(button);
    });
  }

  function moveTo(x, y, zoom) {
    cancelAnimationFrame(animationFrame);
    if (reducedMotion) {
      camera.x = wrap(x, WORLD.width);
      camera.y = wrap(y, WORLD.height);
      camera.zoom = zoom || camera.zoom;
      scheduleMap();
      return;
    }
    const start = { x: camera.x, y: camera.y, zoom: camera.zoom };
    const dx = wrappedDelta(x, start.x, WORLD.width);
    const dy = wrappedDelta(y, start.y, WORLD.height);
    const targetZoom = zoom || camera.zoom;
    const started = performance.now();
    function frame(now) {
      const progress = Math.min(1, (now - started) / 520);
      const eased = 1 - Math.pow(1 - progress, 3);
      camera.x = wrap(start.x + dx * eased, WORLD.width);
      camera.y = wrap(start.y + dy * eased, WORLD.height);
      camera.zoom = start.zoom + (targetZoom - start.zoom) * eased;
      renderMap();
      if (progress < 1) animationFrame = requestAnimationFrame(frame);
    }
    animationFrame = requestAnimationFrame(frame);
  }

  function focusStar(uid, move) {
    const point = positions.get(uid);
    if (!point) return;
    selectedUid = uid;
    renderDetail();
    if (move) moveTo(point.x, point.y, Math.max(camera.zoom, 1));
    else scheduleMap();
  }

  function setZoom(value) {
    camera.zoom = Math.max(0.55, Math.min(1.7, value));
    scheduleMap();
  }

  function setListMode(enabled) {
    listMode = enabled;
    root.querySelector('[data-role="list-panel"]').hidden = !enabled;
    root.querySelector('[data-role="viewport"]').hidden = enabled;
    const button = root.querySelector('[data-action="list"]');
    button.textContent = enabled ? "星图模式" : "列表模式";
    if (!enabled) scheduleMap();
  }

  function bindViewport() {
    const viewport = root.querySelector('[data-role="viewport"]');
    let drag = null;
    viewport.addEventListener("pointerdown", function (event) {
      if (event.target.closest("[data-star]")) return;
      cancelAnimationFrame(animationFrame);
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      viewport.setPointerCapture(event.pointerId);
    });
    viewport.addEventListener("pointermove", function (event) {
      if (!drag || drag.id !== event.pointerId) return;
      camera.x = wrap(camera.x - (event.clientX - drag.x) / camera.zoom, WORLD.width);
      camera.y = wrap(camera.y - (event.clientY - drag.y) / camera.zoom, WORLD.height);
      drag.x = event.clientX;
      drag.y = event.clientY;
      renderMap();
    });
    function endDrag(event) {
      if (drag && drag.id === event.pointerId) drag = null;
    }
    viewport.addEventListener("pointerup", endDrag);
    viewport.addEventListener("pointercancel", endDrag);
    viewport.addEventListener("wheel", function (event) {
      event.preventDefault();
      setZoom(camera.zoom * (event.deltaY > 0 ? 0.9 : 1.1));
    }, { passive: false });
    viewport.addEventListener("keydown", function (event) {
      const step = 90 / camera.zoom;
      const key = event.key.toLowerCase();
      if (key === "a" || event.key === "ArrowLeft") camera.x = wrap(camera.x - step, WORLD.width);
      else if (key === "d" || event.key === "ArrowRight") camera.x = wrap(camera.x + step, WORLD.width);
      else if (key === "w" || event.key === "ArrowUp") camera.y = wrap(camera.y - step, WORLD.height);
      else if (key === "s" || event.key === "ArrowDown") camera.y = wrap(camera.y + step, WORLD.height);
      else if (event.key === "Home") moveTo(origin.x, origin.y, origin.zoom);
      else if (event.key === "Escape") closeDetail();
      else return;
      event.preventDefault();
      scheduleMap();
    });
  }

  function bindControls() {
    root.querySelector('[data-action="home"]').addEventListener("click", function () {
      moveTo(origin.x, origin.y, origin.zoom);
    });
    root.querySelector('[data-action="list"]').addEventListener("click", function () {
      setListMode(!listMode);
    });
    root.querySelector('[data-action="list-close"]').addEventListener("click", function () {
      setListMode(false);
    });
    root.querySelector('[data-action="zoom-in"]').addEventListener("click", function () {
      setZoom(camera.zoom * 1.15);
    });
    root.querySelector('[data-action="zoom-out"]').addEventListener("click", function () {
      setZoom(camera.zoom / 1.15);
    });
    bindViewport();
    window.addEventListener("resize", scheduleMap);
  }

  async function loadData() {
    const status = root.querySelector('[data-role="load-status"]');
    status.textContent = "正在接住远方的星光…";
    try {
      const response = await fetch(API, { headers: { Accept: "application/json" } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
      observations = (Array.isArray(data.rows) ? data.rows : [])
        .map(normalizeStar).filter(function (star) { return star.uid; });
      const known = new Set(observations.map(function (star) { return star.uid; }));
      links = (Array.isArray(data.links) ? data.links : [])
        .map(function (link) { return normalizeLink(link, known); }).filter(Boolean);
      positions.clear();
      observations.forEach(function (star) { positions.set(star.uid, stablePosition(star.uid)); });
      if (observations[0]) {
        const first = positions.get(observations[0].uid);
        camera.x = first.x;
        camera.y = first.y;
        origin.x = first.x;
        origin.y = first.y;
      }
      buildPlanets();
      renderAccessibleList();
      renderDetail();
      scheduleMap();
      status.textContent = observations.length ? "" : "等待第一颗星球";
    } catch (error) {
      observations = [];
      links = [];
      buildPlanets();
      renderAccessibleList();
      scheduleMap();
      status.textContent = "星图暂时没有连接上：" + ((error && error.message) || "未知错误");
    }
  }

  bindControls();
  loadData();
})();
