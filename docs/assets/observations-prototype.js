/* PROTOTYPE — Three variants of the observations star map, switchable via ?variant=A|B|C. */
(function () {
  "use strict";

  const WORLD = { width: 2400, height: 1600 };
  const variants = ["A", "B", "C"];
  const variantNames = {
    A: "A — 沉浸星海",
    B: "B — 观测台",
    C: "C — 弦谱档案"
  };
  const categoryColors = {
    "宇宙与自然": "#78c8e8",
    "生命与感知": "#8bd3aa",
    "技术与造物": "#f5b84b",
    "历史与文明": "#dca778",
    "语言与艺术": "#d89fc7",
    "思想与日常": "#b9a6e8"
  };
  const observations = [
    {
      uid: "obs-trees-network-01",
      title: "森林会交换讯息",
      category: "生命与感知",
      tags: ["菌根", "生态", "网络"],
      summary: "地下菌丝让树木共享资源与信号。",
      content: "植物并不是彼此孤立的个体。菌根网络会参与养分交换，也让森林呈现出一种缓慢而复杂的关系结构。这里先作为星弦交互的示例内容。",
      discovered: "2026-08-18",
      source: "Nature · 示例来源",
      sourceUrl: "https://www.nature.com/"
    },
    {
      uid: "obs-pulsar-clock-02",
      title: "脉冲星像宇宙时钟",
      category: "宇宙与自然",
      tags: ["脉冲星", "时间", "导航"],
      summary: "极稳定的脉冲可以成为深空参照。",
      content: "快速旋转的中子星会周期性扫过地球。某些脉冲星的稳定性极高，因此常被比作散布在银河中的天然时钟。",
      discovered: "2026-07-02",
      source: "NASA · 示例来源",
      sourceUrl: "https://www.nasa.gov/"
    },
    {
      uid: "obs-memory-smell-03",
      title: "气味为何会突然唤醒记忆",
      category: "生命与感知",
      tags: ["嗅觉", "记忆", "情绪"],
      summary: "嗅觉与情绪、记忆系统联系紧密。",
      content: "有些气味会绕过语言，直接把人带回很久以前的一刻。星弦可以把这种见闻连接到记忆、时间和感知。",
      discovered: "2026-06-11",
      source: "Scientific American · 示例来源",
      sourceUrl: "https://www.scientificamerican.com/"
    },
    {
      uid: "obs-antikythera-04",
      title: "两千年前的齿轮宇宙",
      category: "历史与文明",
      tags: ["机械", "天文", "古希腊"],
      summary: "安提基特拉机械模拟天体周期。",
      content: "复杂齿轮并不是近代才出现。安提基特拉机械把天文知识压进金属结构中，像一台来自古代的宇宙计算器。",
      discovered: "2025-12-24",
      source: "Smithsonian · 示例来源",
      sourceUrl: "https://www.si.edu/"
    },
    {
      uid: "obs-error-correction-05",
      title: "噪声里也能找回原文",
      category: "技术与造物",
      tags: ["编码", "通信", "冗余"],
      summary: "精心加入冗余，反而让信息更可靠。",
      content: "纠错码说明冗余并不总是浪费。只要结构设计得当，即使信号在旅途中被损坏，接收者仍然能推回原始信息。",
      discovered: "2026-08-01",
      source: "IEEE · 示例来源",
      sourceUrl: "https://www.ieee.org/"
    },
    {
      uid: "obs-untranslatable-06",
      title: "有些词是一整片经验",
      category: "语言与艺术",
      tags: ["语言", "翻译", "文化"],
      summary: "词语的边界并不在不同语言间重合。",
      content: "翻译并不是给词换标签。同一个词可能携带天气、习俗和共同记忆，因此一对一替换经常会漏掉它原本照亮的那片经验。",
      discovered: "2026-03-16",
      source: "Aeon · 示例来源",
      sourceUrl: "https://aeon.co/"
    },
    {
      uid: "obs-ship-theseus-07",
      title: "忒修斯之船还在航行",
      category: "思想与日常",
      tags: ["同一性", "变化", "自我"],
      summary: "当组成部分全部更换，还是原来的它吗？",
      content: "一个古老思想实验可以连接到身体、软件版本、记忆乃至长期项目：持续变化中的事物，凭什么仍被我们叫作同一个名字？",
      discovered: "2025-11-03",
      source: "Stanford Encyclopedia of Philosophy · 示例来源",
      sourceUrl: "https://plato.stanford.edu/"
    },
    {
      uid: "obs-origami-space-08",
      title: "折纸结构进入太空",
      category: "技术与造物",
      tags: ["折纸", "结构", "航天"],
      summary: "平面折叠让大型结构穿过狭小空间。",
      content: "太阳翼和遮阳罩需要在发射时紧凑收纳、入轨后可靠展开。折纸提供的不是装饰，而是一套可计算的形变语言。",
      discovered: "2026-05-29",
      source: "JPL · 示例来源",
      sourceUrl: "https://www.jpl.nasa.gov/"
    },
    {
      uid: "obs-ocean-snow-09",
      title: "深海里一直下着雪",
      category: "宇宙与自然",
      tags: ["海洋", "碳循环", "微生物"],
      summary: "有机碎屑缓慢沉降，连接表层与深海。",
      content: "海洋雪由死亡生物、排泄物和其他微小颗粒组成。它从明亮表层落向深海，也把能量和碳带到看不见的地方。",
      discovered: "2026-02-08",
      source: "NOAA · 示例来源",
      sourceUrl: "https://www.noaa.gov/"
    },
    {
      uid: "obs-blue-hour-10",
      title: "蓝调时刻不是蓝色滤镜",
      category: "语言与艺术",
      tags: ["光线", "摄影", "天空"],
      summary: "太阳位于地平线下时，散射塑造短暂蓝光。",
      content: "日出前和日落后的一小段时间里，天空与地景的亮度接近，冷蓝色调格外明显。它既是光学现象，也成为摄影语言。",
      discovered: "2026-01-14",
      source: "Royal Museums Greenwich · 示例来源",
      sourceUrl: "https://www.rmg.co.uk/"
    },
    {
      uid: "obs-sleep-memory-11",
      title: "睡眠也在整理白天",
      category: "生命与感知",
      tags: ["睡眠", "学习", "记忆"],
      summary: "休息不是停机，记忆仍在被重新组织。",
      content: "学习之后的睡眠会参与记忆巩固。看似没有产出的时间，可能正是大脑重新排列线索、减弱噪声的阶段。",
      discovered: "2025-10-19",
      source: "NIH · 示例来源",
      sourceUrl: "https://www.nih.gov/"
    },
    {
      uid: "obs-kintsugi-12",
      title: "修补痕迹也可以成为历史",
      category: "思想与日常",
      tags: ["金继", "修复", "时间"],
      summary: "裂痕不必被伪装成从未发生。",
      content: "修复可以追求隐形，也可以承认时间留下的变化。金继提供了一种观看方式：完整并不等于没有经历过破损。",
      discovered: "2026-04-07",
      source: "Met Museum · 示例来源",
      sourceUrl: "https://www.metmuseum.org/"
    }
  ];
  const strings = [
    ["obs-trees-network-01", "obs-error-correction-05", "类比"],
    ["obs-pulsar-clock-02", "obs-blue-hour-10", "同源"],
    ["obs-memory-smell-03", "obs-sleep-memory-11", "延伸"],
    ["obs-antikythera-04", "obs-origami-space-08", "造物"],
    ["obs-error-correction-05", "obs-untranslatable-06", "转译"],
    ["obs-untranslatable-06", "obs-ship-theseus-07", "边界"],
    ["obs-ship-theseus-07", "obs-kintsugi-12", "变化"],
    ["obs-ocean-snow-09", "obs-trees-network-01", "循环"],
    ["obs-blue-hour-10", "obs-kintsugi-12", "观看"],
    ["obs-pulsar-clock-02", "obs-antikythera-04", "计时"]
  ];

  const root = document.querySelector('[data-role="prototype-root"]');
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const camera = { x: WORLD.width / 2, y: WORLD.height / 2, zoom: 1 };
  const origin = { x: camera.x, y: camera.y, zoom: camera.zoom };
  const positions = new Map();
  let currentVariant = variantFromUrl();
  let selectedUid = "";
  let matches = observations.slice();
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

  function placeStars() {
    const placed = [];
    observations.forEach(function (star, index) {
      let x = 150 + (hash(star.uid + ":x") % (WORLD.width - 300));
      let y = 130 + (hash(star.uid + ":y") % (WORLD.height - 260));
      let attempts = 0;
      while (placed.some(function (point) {
        return Math.hypot(point.x - x, point.y - y) < 230;
      }) && attempts < 10) {
        x = 150 + ((x + 377 + index * 41) % (WORLD.width - 300));
        y = 130 + ((y + 233 + index * 29) % (WORLD.height - 260));
        attempts += 1;
      }
      const point = { x: x, y: y };
      positions.set(star.uid, point);
      placed.push(point);
    });
    const first = positions.get(observations[0].uid);
    camera.x = first.x;
    camera.y = first.y;
    origin.x = first.x;
    origin.y = first.y;
  }

  function variantFromUrl() {
    const value = new URLSearchParams(location.search).get("variant") || "A";
    return variants.includes(value.toUpperCase()) ? value.toUpperCase() : "A";
  }

  function titleBlock() {
    return '<div class="obs-title-block"><h1>见闻 · 星弦</h1>' +
      '<p>PROTOTYPE · 假数据 · 坐标与弦刷新后保持稳定</p></div>';
  }

  function searchField() {
    return '<label class="obs-field">检索星球' +
      '<input type="search" data-role="search" placeholder="标题、正文、标签或来源" autocomplete="off">' +
      '</label>';
  }

  function dateFields() {
    return '<div class="obs-date-range">' +
      '<label class="obs-date-field">起始日期<input type="date" data-role="date-from"></label>' +
      '<label class="obs-date-field">结束日期<input type="date" data-role="date-to"></label>' +
      '</div>';
  }

  function quickFilters() {
    return '<div class="obs-quick-filters" aria-label="快捷时间筛选">' +
      '<button class="obs-mini-button" type="button" data-quick="all">全部时间</button>' +
      '<button class="obs-mini-button" type="button" data-quick="year">今年</button>' +
      '<button class="obs-mini-button" type="button" data-quick="recent">最近一年</button>' +
      '</div>';
  }

  function mapActions() {
    return '<div class="obs-map-actions">' +
      '<button class="obs-mini-button" type="button" data-action="home">回到起点</button>' +
      '<button class="obs-mini-button" type="button" data-action="list">列表模式</button>' +
      '<button class="obs-mini-button" type="button" data-action="zoom-out" aria-label="缩小">−</button>' +
      '<button class="obs-mini-button" type="button" data-action="zoom-in" aria-label="放大">＋</button>' +
      '</div>';
  }

  function viewport() {
    return '<section class="obs-viewport" data-role="viewport" tabindex="0" ' +
      'aria-label="可拖动的循环星图；WASD 移动，Home 回到起点，滚轮缩放">' +
      '<svg class="obs-strings" data-role="strings" aria-hidden="true"></svg>' +
      '<div class="obs-planets" data-role="planets"></div>' +
      '</section>';
  }

  function detailPanel() {
    return '<aside class="obs-detail" data-role="detail" aria-live="polite"></aside>';
  }

  function results() {
    return '<div class="obs-results" data-role="results" aria-label="检索结果"></div>';
  }

  function listPanel() {
    return '<section class="obs-list-mode" data-role="list-panel" hidden>' +
      '<div class="obs-accessible-list" data-role="accessible-list"></div></section>';
  }

  function templateA() {
    return '<div class="obs-shell obs-variant-a">' + viewport() +
      '<header class="obs-a-header">' + titleBlock() + '</header>' +
      '<section class="obs-a-tools">' + searchField() + dateFields() + quickFilters() +
      mapActions() + '<span class="obs-state" data-role="state"></span>' + results() + '</section>' +
      detailPanel() + listPanel() + '</div>';
  }

  function templateB() {
    return '<div class="obs-shell obs-variant-b">' +
      '<aside class="obs-b-catalog">' + titleBlock() + searchField() + dateFields() +
      quickFilters() + mapActions() + results() + '</aside>' +
      '<div class="obs-viewport-wrap"><div class="obs-b-status"><span>循环坐标观测区</span>' +
      '<span class="obs-state" data-role="state"></span></div>' + viewport() + '</div>' +
      detailPanel() + listPanel() + '</div>';
  }

  function templateC() {
    return '<div class="obs-shell obs-variant-c">' +
      '<header class="obs-c-ribbon">' + titleBlock() +
      '<div class="obs-c-search">' + searchField() + dateFields() + '</div>' +
      '<div>' + mapActions() + '</div></header>' +
      '<div class="obs-c-map">' + viewport() + detailPanel() + '</div>' +
      '<section class="obs-c-ledger"><div>' + quickFilters() +
      '<span class="obs-state" data-role="state"></span></div>' + results() + '</section>' +
      listPanel() + '</div>';
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

  function createPlanet(star) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "obs-planet";
    button.dataset.star = star.uid;
    button.setAttribute("aria-label", star.title + "；" + star.category + "；" + star.summary);
    button.style.setProperty("--planet-color", categoryColors[star.category]);
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
    observations.forEach(function (star) { layer.appendChild(createPlanet(star)); });
  }

  function screenPoint(uid, width, height) {
    const point = positions.get(uid);
    return {
      x: width / 2 + wrappedDelta(point.x, camera.x, WORLD.width) * camera.zoom,
      y: height / 2 + wrappedDelta(point.y, camera.y, WORLD.height) * camera.zoom
    };
  }

  function svgElement(name, attrs) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.keys(attrs).forEach(function (key) { element.setAttribute(key, String(attrs[key])); });
    return element;
  }

  function renderStrings(width, height) {
    const svg = root.querySelector('[data-role="strings"]');
    svg.textContent = "";
    strings.forEach(function (connection) {
      const from = positions.get(connection[0]);
      const to = positions.get(connection[1]);
      const start = screenPoint(connection[0], width, height);
      const end = {
        x: start.x + wrappedDelta(to.x, from.x, WORLD.width) * camera.zoom,
        y: start.y + wrappedDelta(to.y, from.y, WORLD.height) * camera.zoom
      };
      const active = selectedUid === connection[0] || selectedUid === connection[1];
      const line = svgElement("line", {
        x1: start.x, y1: start.y, x2: end.x, y2: end.y,
        class: "obs-string" + (active ? " is-active" : "")
      });
      const label = svgElement("text", {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2 - 5,
        class: "obs-string-label",
        "text-anchor": "middle"
      });
      label.textContent = connection[2];
      svg.appendChild(line);
      svg.appendChild(label);
    });
  }

  function renderMap() {
    mapFrame = 0;
    const viewportElement = root.querySelector('[data-role="viewport"]');
    if (!viewportElement || viewportElement.hidden) return;
    const rect = viewportElement.getBoundingClientRect();
    const matchedIds = new Set(matches.map(function (star) { return star.uid; }));
    root.querySelectorAll("[data-star]").forEach(function (node) {
      const uid = node.getAttribute("data-star");
      const point = screenPoint(uid, rect.width, rect.height);
      node.style.left = point.x + "px";
      node.style.top = point.y + "px";
      node.style.transform = "translate(-50%, -50%) scale(" +
        Math.max(0.76, Math.min(1.25, camera.zoom)) + ")";
      node.hidden = point.x < -180 || point.x > rect.width + 180 ||
        point.y < -180 || point.y > rect.height + 180;
      node.classList.toggle("is-muted", !matchedIds.has(uid));
      node.classList.toggle("is-match", matches.length < observations.length && matchedIds.has(uid));
      node.classList.toggle("is-selected", selectedUid === uid);
    });
    renderStrings(rect.width, rect.height);
    const state = root.querySelector('[data-role="state"]');
    if (state) {
      state.textContent = "X " + Math.round(camera.x).toString().padStart(4, "0") +
        " · Y " + Math.round(camera.y).toString().padStart(4, "0") +
        " · " + Math.round(camera.zoom * 100) + "% · " + matches.length + "/" + observations.length;
    }
  }

  function scheduleMap() {
    if (!mapFrame) mapFrame = requestAnimationFrame(renderMap);
  }

  function renderDetail() {
    const panel = root.querySelector('[data-role="detail"]');
    panel.textContent = "";
    const inner = document.createElement("div");
    inner.className = "obs-detail-inner";
    const star = starById(selectedUid);
    if (!star) {
      const kicker = document.createElement("p");
      kicker.className = "kicker";
      kicker.textContent = "SELECT A STAR";
      const text = document.createElement("p");
      text.textContent = "点击、聚焦或从搜索结果中选择一颗星。这里会展开正文、发现时间、来源与相关星球。";
      inner.appendChild(kicker);
      inner.appendChild(text);
      panel.appendChild(inner);
      return;
    }
    const kicker = document.createElement("p");
    kicker.className = "kicker";
    kicker.textContent = star.category;
    const title = document.createElement("h2");
    title.textContent = star.title;
    const summary = document.createElement("p");
    summary.textContent = star.summary;
    const content = document.createElement("p");
    content.textContent = star.content;
    const tags = document.createElement("div");
    tags.className = "obs-detail-tags";
    star.tags.forEach(function (tag) {
      const chip = document.createElement("span");
      chip.textContent = tag;
      tags.appendChild(chip);
    });
    const meta = document.createElement("div");
    meta.className = "obs-detail-meta";
    const date = document.createElement("span");
    date.textContent = "发现于 " + star.discovered;
    const source = document.createElement("a");
    source.href = star.sourceUrl;
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    source.textContent = star.source;
    meta.appendChild(date);
    meta.appendChild(source);
    const related = strings.filter(function (edge) {
      return edge[0] === star.uid || edge[1] === star.uid;
    });
    if (related.length) {
      const relatedWrap = document.createElement("div");
      relatedWrap.className = "obs-map-actions";
      related.forEach(function (edge) {
        const uid = edge[0] === star.uid ? edge[1] : edge[0];
        const target = starById(uid);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "obs-mini-button";
        button.textContent = edge[2] + " · " + target.title;
        button.addEventListener("click", function () { focusStar(uid, true); });
        relatedWrap.appendChild(button);
      });
      meta.appendChild(relatedWrap);
    }
    inner.appendChild(kicker);
    inner.appendChild(title);
    inner.appendChild(summary);
    inner.appendChild(content);
    inner.appendChild(tags);
    inner.appendChild(meta);
    panel.appendChild(inner);
  }

  function searchableText(star) {
    return [star.title, star.category, star.tags.join(" "), star.summary,
      star.content, star.source].join(" ").toLowerCase();
  }

  function applyFilters() {
    const search = root.querySelector('[data-role="search"]');
    const from = root.querySelector('[data-role="date-from"]');
    const to = root.querySelector('[data-role="date-to"]');
    const query = (search ? search.value : "").trim().toLowerCase();
    const start = from ? from.value : "";
    const end = to ? to.value : "";
    matches = observations.filter(function (star) {
      return (!query || searchableText(star).includes(query)) &&
        (!start || star.discovered >= start) && (!end || star.discovered <= end);
    });
    renderResults();
    renderAccessibleList();
    scheduleMap();
  }

  function resultButton(star) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "obs-result";
    const title = document.createElement("span");
    title.textContent = star.title;
    const meta = document.createElement("small");
    meta.textContent = star.discovered + " · " + star.category;
    button.appendChild(title);
    button.appendChild(meta);
    button.addEventListener("click", function () { focusStar(star.uid, true); });
    return button;
  }

  function renderResults() {
    const container = root.querySelector('[data-role="results"]');
    if (!container) return;
    container.textContent = "";
    matches.forEach(function (star) { container.appendChild(resultButton(star)); });
    if (!matches.length) {
      const empty = document.createElement("span");
      empty.className = "obs-state";
      empty.textContent = "没有命中的星球";
      container.appendChild(empty);
    }
  }

  function renderAccessibleList() {
    const list = root.querySelector('[data-role="accessible-list"]');
    if (!list) return;
    list.textContent = "";
    matches.forEach(function (star) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "obs-accessible-card";
      const title = document.createElement("strong");
      title.textContent = star.title;
      const meta = document.createElement("span");
      meta.textContent = star.discovered + " · " + star.category + " · " + star.tags.join(" / ");
      button.appendChild(title);
      button.appendChild(meta);
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
      if (zoom) camera.zoom = zoom;
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
    const panel = root.querySelector('[data-role="list-panel"]');
    const viewportElement = root.querySelector('[data-role="viewport"]');
    panel.hidden = !enabled;
    viewportElement.hidden = enabled;
    const button = root.querySelector('[data-action="list"]');
    if (button) button.textContent = enabled ? "星图模式" : "列表模式";
    if (!enabled) scheduleMap();
  }

  function bindViewport() {
    const viewportElement = root.querySelector('[data-role="viewport"]');
    let drag = null;
    viewportElement.addEventListener("pointerdown", function (event) {
      if (event.target.closest("[data-star]")) return;
      cancelAnimationFrame(animationFrame);
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      viewportElement.setPointerCapture(event.pointerId);
    });
    viewportElement.addEventListener("pointermove", function (event) {
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
    viewportElement.addEventListener("pointerup", endDrag);
    viewportElement.addEventListener("pointercancel", endDrag);
    viewportElement.addEventListener("wheel", function (event) {
      event.preventDefault();
      setZoom(camera.zoom * (event.deltaY > 0 ? 0.9 : 1.1));
    }, { passive: false });
    viewportElement.addEventListener("keydown", function (event) {
      const step = 90 / camera.zoom;
      if (event.key.toLowerCase() === "a") camera.x = wrap(camera.x - step, WORLD.width);
      else if (event.key.toLowerCase() === "d") camera.x = wrap(camera.x + step, WORLD.width);
      else if (event.key.toLowerCase() === "w") camera.y = wrap(camera.y - step, WORLD.height);
      else if (event.key.toLowerCase() === "s") camera.y = wrap(camera.y + step, WORLD.height);
      else if (event.key === "Home") moveTo(origin.x, origin.y, origin.zoom);
      else return;
      event.preventDefault();
      scheduleMap();
    });
  }

  function bindControls() {
    const search = root.querySelector('[data-role="search"]');
    const from = root.querySelector('[data-role="date-from"]');
    const to = root.querySelector('[data-role="date-to"]');
    [search, from, to].forEach(function (field) {
      if (field) field.addEventListener("input", applyFilters);
    });
    search.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && matches[0]) {
        event.preventDefault();
        focusStar(matches[0].uid, true);
      }
    });
    root.querySelectorAll("[data-quick]").forEach(function (button) {
      button.addEventListener("click", function () {
        const type = button.getAttribute("data-quick");
        const now = new Date();
        if (type === "all") {
          from.value = "";
          to.value = "";
        } else if (type === "year") {
          from.value = now.getFullYear() + "-01-01";
          to.value = now.getFullYear() + "-12-31";
        } else {
          const prior = new Date(now);
          prior.setFullYear(now.getFullYear() - 1);
          from.value = prior.toISOString().slice(0, 10);
          to.value = now.toISOString().slice(0, 10);
        }
        applyFilters();
      });
    });
    root.querySelector('[data-action="home"]').addEventListener("click", function () {
      moveTo(origin.x, origin.y, origin.zoom);
    });
    root.querySelector('[data-action="list"]').addEventListener("click", function () {
      setListMode(!listMode);
    });
    root.querySelector('[data-action="zoom-in"]').addEventListener("click", function () {
      setZoom(camera.zoom * 1.15);
    });
    root.querySelector('[data-action="zoom-out"]').addEventListener("click", function () {
      setZoom(camera.zoom / 1.15);
    });
    bindViewport();
  }

  function renderVariant() {
    root.innerHTML = currentVariant === "B" ? templateB() :
      currentVariant === "C" ? templateC() : templateA();
    document.querySelector('[data-role="variant-label"]').textContent = variantNames[currentVariant];
    buildPlanets();
    renderDetail();
    renderResults();
    renderAccessibleList();
    bindControls();
    setListMode(listMode);
    scheduleMap();
  }

  function changeVariant(direction) {
    const index = variants.indexOf(currentVariant);
    currentVariant = variants[(index + direction + variants.length) % variants.length];
    const url = new URL(location.href);
    url.searchParams.set("variant", currentVariant);
    history.replaceState(null, "", url);
    renderVariant();
  }

  document.querySelector('[data-role="variant-prev"]').addEventListener("click", function () {
    changeVariant(-1);
  });
  document.querySelector('[data-role="variant-next"]').addEventListener("click", function () {
    changeVariant(1);
  });
  document.addEventListener("keydown", function (event) {
    const target = event.target;
    if (target && (target.matches("input, textarea, select") || target.isContentEditable)) return;
    if (event.key === "ArrowLeft") changeVariant(-1);
    else if (event.key === "ArrowRight") changeVariant(1);
    else return;
    event.preventDefault();
  });
  window.addEventListener("resize", scheduleMap);

  placeStars();
  renderVariant();
})();
