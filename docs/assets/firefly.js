/* flitfancy 夜空特效
 * 所有可调参数集中在 CFG，后续可从控制台配置接口覆盖。
 *
 * 全局契约（sitefx.js）：
 *   本文件依赖 sitefx.js 定义的 window.__pointerFx / window.__cursorFx
 *   （指针避让坐标与光标爆发接口）。但 HTML 里 firefly.js 先于 sitefx.js
 *   加载——成立的前提是所有读取都推迟到 requestAnimationFrame 回调里，
 *   那时 sitefx 已执行完毕。调整脚本加载顺序时，此契约必须保持：
 *   firefly 先加载 + 读取延迟到 RAF，或改用事件解耦。违反时不会报错，
 *   只会静默失去避让/爆发效果（有 null 守卫）。
 */
(function () {
  const canvas = document.getElementById("sky");
  if (!canvas) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    canvas.style.display = "none";
    return;
  }

  const CFG = {
    flies: {
      areaDivisor: 72,         // 密度除数：数量 = round(√(宽×高) ÷ 72)，全设备同一公式
      maxCount: 48,            // 性能保险上限（超大视口不失控）
      breathPeriodMin: 6000,   // 自然偏慢：单只约 6~7.5 秒一轮
      breathPeriodRange: 1500,
      inhaleRatio: 0.4         // 亮起稍短，暗下稍长
    },
    flyBurst: {
      durationMin: 30000,      // 萤火爆发时长（ms）
      durationRange: 15000,
      globalCycle: 1860000,    // 全球统一周期：31 分钟一场
      popCount: 15,            // 开场涌出
      maxFlies: 70,
      spawnEvery: 120,         // 补充间隔
      sizeMul: 2,              // 体积 ×2
      brightAdd: 0.3,          // 亮度 +30%
      fadeMs: 4000             // 结束后渐隐时长
    },
    flyBright: {
      maxLevel: 2,             // 点 1/2 次的两档
      keepMs: 6000,            // 档位保持时长
      sizeStep: 0.4,
      brightStep: 0.25
    },
    meteor: {
      spawnMin: 4500,          // 平时出现间隔
      spawnRange: 9000,
      burstSpawnMin: 400,      // 流星雨期间间隔
      burstSpawnRange: 1200,
      fireChance: 0.18,        // 火流星概率
      burstFireChance: 0.35,
      blueChance: 0.4,         // 非火流星里天蓝占比
      flashReach: 3600,        // 爆闪触发距离²（约 60px）
      fireFadeMs: 700,         // 爆闪后拖尾渐暗
      lenMin: 73,
      lenRange: 60,
      fireLenMin: 127,
      fireLenRange: 93,
      speedMul: 1.7             // 流星整体速度倍率
    },
    meteorBurst: {
      durationMin: 45000,      // 流星雨时长 45~60 秒
      durationRange: 15000,
      globalCycle: 3120000     // 全球统一周期：52 分钟一场
    },
    flash: {
      max: 20,
      smallDur: 450,
      bigDur: 750,
      emberCount: 8
    },
    meet: {
      dist2: 36,               // 萤火虫相遇距离²
      meteorReach: 12,         // 流星撞萤火虫半径
      cooldown: 1200
    },
    pointer: {
      glowReach2: 10000,       // 鼠标 100px 内感知发光
      repelReach2: 3600,       // 鼠标 60px 内避让
      repelImpulse: 0.07,      // 避让推力
      cruiseMaxSpeed: 0.8,     // 避让限速
      relax: 0.03,             // 速度松弛：逃离后平滑滑回自然漂游（飘逸感）
      startleAlpha: 0.32,      // 受惊光晕增量（独立于呼吸暗相位）
      startleCoreAlpha: 0.25   // 受惊核心增量
    },
    fireflyFlashMs: 800        // 全屏闪一下时长
  };

  const ctx = canvas.getContext("2d");
  const PERF_TO_WALL = Date.now() - performance.now();  // 页面计时 → 真实世界时间

  /* ---------- 屏幕环境 ----------
   * 引擎只关心三个画布事实：CSS 视口宽高 + 设备像素比（上限 2）。
   * 没有任何设备分支：萤火虫数量 = round(√(宽×高) ÷ CFG.flies.areaDivisor)，
   * 流星频率 = CFG.meteor 的全局间隔——所有设备共用同一套公式，
   * 小屏自然少、大屏自然多。 */
  let w = window.innerWidth;
  let h = window.innerHeight;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  function computeEnv() {
    w = window.innerWidth;
    h = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
  }
  let flies = [];
  let meteors = [];
  let flashes = [];
  let nextMeteor = 0;
  let burstUntil = 0;
  let forcedBurstUntil = 0;
  let nextBurst = 0;
  let burstStats = { total: 0, fire: 0 };
  let flyBurstUntil = 0;
  let forcedFlyUntil = 0;
  let nextFlyBurst = 0;
  let flyBurstMax = 0;
  let flyMeetCount = 0;
  let flyFade = 0;
  let lastT = 0;
  let flyLevel = 0;
  let flyLevelUntil = 0;
  let flyFlashT0 = -99999;
  let lastFlySpawn = 0;
  let refW = w;              // 比例重排的参考视口（每次重排后立即更新）
  let refH = h;
  let resizeTimer = null;
  let lastDt = 0;
  let line1 = null;
  let line2 = null;
  let lastPreviewUpdate = 0;

  function resize() {
    computeEnv();
    /* 显式锁定 CSS 尺寸：没有这行时，DPR≠1 的屏幕（如 4K@150%）会按画布
       固有尺寸显示——整个夜空被放大 1.5~2 倍并从左上角裁切，萤火虫渲染位置
       与光标错位（全部症状：数量显得少、发光躲闪位置不对、"圈在右下角"）。 */
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawnFly(init) {
    const vx0 = (Math.random() - 0.5) * 0.18;
    const vy0 = -0.15 - Math.random() * 0.35;
    return {
      x: Math.random() * w,
      y: init ? Math.random() * h : h + 10,
      r: 1 + Math.random() * 1.6,
      vx: vx0,
      vy: vy0,
      vx0: vx0,                // 基础漂游速度：逃离结束后平滑滑回
      vy0: vy0,
      phase: Math.random() * Math.PI * 2,
      breathOffset: Math.random(),
      breathPeriod: CFG.flies.breathPeriodMin + Math.random() * CFG.flies.breathPeriodRange,
      meetCd: 0,
      mouseGlowUntil: 0
    };
  }

  /* ---------- 跨页保持 ----------
   * 同一标签页内导航时，萤火虫的位置与呼吸节奏通过 sessionStorage 延续，
   * 让整个站点像同一片连续的夜空（新标签页/超时后仍会重新随机出生）。
   * 只保存基础漂游状态；相遇冷却、鼠标受惊等瞬时状态不跨页。 */
  const FLY_STORE_KEY = "flitfancy.fireflies.v1";
  const FLY_STORE_MAX_AGE_MS = 30 * 60 * 1000;

  function saveFlies() {
    try {
      if (!w || !h || !flies.length || !sessionStorage) return;
      const payload = flies.slice(0, 80).map(function (f) {
        return {
          nx: f.x / w, ny: f.y / h,          // 归一化坐标：跨视口尺寸仍能对位
          r: f.r,
          vx: f.vx, vy: f.vy, vx0: f.vx0, vy0: f.vy0,
          phase: f.phase, breathOffset: f.breathOffset, breathPeriod: f.breathPeriod
        };
      });
      /* 爆发类状态的剩余时长换算成墙钟绝对时刻保存：
         performance.now() 每页从零开始，直接存会被导航"卡掉"。 */
      const perfNow = performance.now();
      const endWall = function (perfUntil) {
        return perfUntil > perfNow ? Date.now() + (perfUntil - perfNow) : 0;
      };
      sessionStorage.setItem(FLY_STORE_KEY, JSON.stringify({
        t: Date.now(), w: w, h: h, flies: payload,
        burst: {
          flyForcedEndWall: endWall(forcedFlyUntil),
          flyGlobalEndWall: endWall(flyBurstUntil),
          meteorForcedEndWall: endWall(forcedBurstUntil),
          meteorUntilEndWall: endWall(burstUntil),
          level: flyLevel,
          levelEndWall: endWall(flyLevelUntil),
          stats: { total: burstStats.total, fire: burstStats.fire }
        }
      }));
    } catch (e) { /* 存储不可用（隐私模式等）时静默跳过 */ }
  }

  /* 爆发状态恢复：剩余时长钳制到各 CFG 上限；萤火爆发必须走
     beginFlyBurst 入口——它同时负责 flyBurstMax 与开场涌入，
     裸赋值 forcedFlyUntil 会得到一次"没有涌入"的假爆发。 */
  function applyBurstSnapshot(burst) {
    if (!burst) return;
    const now = performance.now();
    const remainingFromWall = function (endWall, maxMs) {
      if (!endWall || endWall <= Date.now()) return 0;
      return Math.min(endWall - Date.now(), maxMs);
    };
    const flyEndWall = Math.max(burst.flyForcedEndWall || 0, burst.flyGlobalEndWall || 0);
    const flyRemain = remainingFromWall(
      flyEndWall, CFG.flyBurst.durationMin + CFG.flyBurst.durationRange
    );
    if (flyRemain > 0) beginFlyBurst(now + flyRemain);
    const meteorEndWall = Math.max(
      burst.meteorForcedEndWall || 0, burst.meteorUntilEndWall || 0
    );
    const meteorRemain = remainingFromWall(
      meteorEndWall, CFG.meteorBurst.durationMin + CFG.meteorBurst.durationRange
    );
    if (meteorRemain > 0) {
      startMeteorBurst(now + meteorRemain);
      if (burst.stats && isFinite(burst.stats.total)) {
        burstStats = { total: burst.stats.total, fire: burst.stats.fire || 0 };
      }
    }
    if (burst.level > 0 && burst.level <= CFG.flyBright.maxLevel) {
      const levelRemain = remainingFromWall(burst.levelEndWall, CFG.flyBright.keepMs);
      if (levelRemain > 0) {
        flyLevel = burst.level;
        flyLevelUntil = now + levelRemain;
      }
    }
  }

  function restoreFlies() {
    try {
      if (!sessionStorage) return false;
      const raw = sessionStorage.getItem(FLY_STORE_KEY);
      if (!raw) return false;
      const snap = JSON.parse(raw);
      if (!snap || !Array.isArray(snap.flies) || !snap.flies.length) return false;
      if (!snap.t || Date.now() - snap.t > FLY_STORE_MAX_AGE_MS) return false;
      if (!snap.w || !snap.h) return false;
      // 视口宽高比变化过大（换设备/旋转屏幕）时放弃恢复，重新随机出生
      const ratioNow = w / h;
      const ratioSnap = snap.w / snap.h;
      if (!ratioSnap || Math.abs(ratioNow - ratioSnap) / ratioSnap > 0.35) return false;
      flies.length = 0;
      const count = Math.min(snap.flies.length, targetFlyCount());
      for (let i = 0; i < count; i++) {
        const s = snap.flies[i];
        if (!s || !isFinite(s.nx) || !isFinite(s.ny)) continue;
        const vx0 = isFinite(s.vx0) ? s.vx0 : (s.vx || 0);
        const vy0 = isFinite(s.vy0) ? s.vy0 : (s.vy || 0);
        flies.push({
          x: Math.min(Math.max(s.nx, 0), 1) * w,
          y: Math.min(Math.max(s.ny, 0), 1) * h,
          r: isFinite(s.r) && s.r > 0 ? s.r : 1 + Math.random() * 1.6,
          vx: isFinite(s.vx) ? s.vx : vx0,
          vy: isFinite(s.vy) ? s.vy : vy0,
          vx0: vx0, vy0: vy0,
          phase: isFinite(s.phase) ? s.phase : Math.random() * Math.PI * 2,
          breathOffset: isFinite(s.breathOffset) ? s.breathOffset : Math.random(),
          breathPeriod: isFinite(s.breathPeriod) && s.breathPeriod > 0
            ? s.breathPeriod
            : CFG.flies.breathPeriodMin + Math.random() * CFG.flies.breathPeriodRange,
          meetCd: 0,
          mouseGlowUntil: 0
        });
      }
      // 恢复后不足公式数量时补种到目标数（跨页视口可能变大）
      while (flies.length < targetFlyCount()) flies.push(spawnFly(true));
      // 爆发状态不在这里恢复：init 尾部还有一轮瞬态归零，
      // 必须等归零全部完成后由 init 调用 applyBurstSnapshot。
      return snap;
    } catch (e) {
      return false;
    }
  }

  function hashInt(n) {
    /* 简单整数哈希：同一个周期号永远得到同一个随机数（全球统一的关键） */
    let x = (n ^ 0x9e3779b9) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    return (x ^ (x >>> 16)) >>> 0;
  }

  function meteorWindow(now) {
    /* 全球统一的流星雨窗口：所有人同一时刻看到同一场流星雨 */
    const cycle = CFG.meteorBurst.globalCycle;
    const n = Math.floor(now / cycle);
    const seed = hashInt(n);
    const start = n * cycle + (seed % (cycle - 65000));
    const dur = CFG.meteorBurst.durationMin + ((seed >>> 8) % CFG.meteorBurst.durationRange);
    return { start: start, end: start + dur, active: now >= start && now < start + dur };
  }

  function flyWindow(now) {
    /* 全球统一的萤火爆发窗口：31 分钟一个周期，位置随机（与流星雨互不相关） */
    const cycle = CFG.flyBurst.globalCycle;
    const n = Math.floor(now / cycle);
    const seed = hashInt(n ^ 0x51ab);
    const start = n * cycle + (seed % (cycle - 60000));
    const dur = CFG.flyBurst.durationMin + ((seed >>> 8) % CFG.flyBurst.durationRange);
    return { start: start, end: start + dur, active: now >= start && now < start + dur };
  }

  function targetFlyCount() {
    /* 通用密度公式：视觉密度全设备一致——面积大就多、面积小就少，
       2K 竖屏与 2K 横屏数量相同（面积相同）。 */
    return Math.min(
      CFG.flies.maxCount,
      Math.round(Math.sqrt(w * h) / CFG.flies.areaDivisor)
    );
  }

  function settleFlies() {
    /* 数量结算（防抖后执行一次）：
       · 只补不删可见萤火虫：不足公式数量时补种（散布在视口内）；
       · 稳态超员（非爆发期间）时，只移除"当前最暗"的多余个体——
         它们正处于呼吸暗相位，在深色背景上本就几乎不可见，减员无声；
       · 爆发期间绝不减员（爆发人口是临时事件，不受公式约束）。
       不触碰流星雨、萤火爆发等进行中的状态。 */
    const count = targetFlyCount();
    const bursting = performance.now() < flyBurstUntil;
    if (!bursting && flies.length > count) {
      const now = performance.now();
      const scored = flies
        .map(function (f) {
          return { f: f, b: breathPulse(now, f.breathPeriod, f.breathOffset) };
        })
        .sort(function (a, b) { return b.b - a.b; });
      const keep = new Set(scored.slice(0, count).map(function (s) { return s.f; }));
      for (let i = flies.length - 1; i >= 0; i--) {
        if (!keep.has(flies[i])) flies.splice(i, 1);
      }
    }
    while (flies.length < count) flies.push(spawnFly(true));
  }

  function init() {
    resize();
    flies.length = 0;
    // 跨页保持：同标签页导航时优先恢复上一页的萤火虫状态。
    // 注意这里只恢复萤火虫本体——爆发/亮度档位在 init 尾部
    // （全部瞬态归零完成之后）由 applyBurstSnapshot 恢复。
    const restoredSnapshot = restoreFlies();
    if (!restoredSnapshot) {
      const count = targetFlyCount();
      for (let i = 0; i < count; i++) flies.push(spawnFly(true));
    }
    meteors.length = 0;
    flashes.length = 0;
    nextMeteor = performance.now() + 2500 + Math.random() * 4000;
    burstUntil = 0;
    forcedBurstUntil = 0;
    burstStats = { total: 0, fire: 0 };
    const gw0 = meteorWindow(performance.now() + PERF_TO_WALL);
    nextBurst = meteorWindow(gw0.start + CFG.meteorBurst.globalCycle).start - PERF_TO_WALL;
    refW = window.innerWidth;
    refH = window.innerHeight;
    flyBurstUntil = 0;
    forcedFlyUntil = 0;
    const fw0 = flyWindow(performance.now() + PERF_TO_WALL);
    nextFlyBurst = flyWindow(fw0.start + CFG.flyBurst.globalCycle).start - PERF_TO_WALL;
    flyBurstMax = 0;
    flyMeetCount = 0;
    flyFade = 0;
    flyLevel = 0;
    flyLevelUntil = 0;
    flyFlashT0 = -99999;
    lastFlySpawn = 0;
    // 所有瞬态归零完成后，最后一步恢复跨页爆发状态
    if (restoredSnapshot) applyBurstSnapshot(restoredSnapshot.burst);
    line1 = document.getElementById("burst-line-1");
    line2 = document.getElementById("burst-line-2");
  }

  function startMeteorBurst(now) {
    const dur = CFG.meteorBurst.durationMin + Math.random() * CFG.meteorBurst.durationRange;
    burstUntil = now + dur;
    forcedBurstUntil = now + dur;
    burstStats = { total: 0, fire: 0 };
  }

  function beginFlyBurst(until) {
    flyBurstUntil = until;
    forcedFlyUntil = until;
    flyBurstMax = Math.min(CFG.flyBurst.maxFlies, flies.length * 2);
    flyMeetCount = 0;
    flyFade = 1;
    for (let i = 0; i < CFG.flyBurst.popCount && flies.length < flyBurstMax; i++) flies.push(spawnFly(false));
  }

  function segDist(px, py, ax, ay, bx, by) {
    /* 点到线段的最短距离（平方），用于“撞到流星整条线”的判定 */
    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;
    const len2 = abx * abx + aby * aby || 1;
    let t = (apx * abx + apy * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + abx * t;
    const cy = ay + aby * t;
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy;
  }

  function spawnMeteor(now) {
    const bursting = now < burstUntil;
    if (bursting) burstStats.total++;
    const fire = Math.random() < (bursting ? CFG.meteor.burstFireChance : CFG.meteor.fireChance);
    if (fire && bursting) burstStats.fire++;
    const blue = !fire && Math.random() < CFG.meteor.blueChance;
    const bright = fire ? 0.85 + Math.random() * 0.3 : 0.45 + Math.random() * 0.75;
    const speed = (fire ? 7 + Math.random() * 6 : 3 + Math.random() * 4) * CFG.meteor.speedMul;
    const side = Math.random() < 0.25;
    let x, vx;
    if (side) {
      x = Math.random() < 0.5 ? -40 : w + 40;
      vx = (x < 0 ? 1 : -1) * speed * (0.6 + Math.random() * 0.5);
    } else {
      x = Math.random() * w;
      vx = (Math.random() < 0.5 ? -1 : 1) * speed * (0.3 + Math.random() * 0.9);
    }
    const vy = speed * (0.8 + Math.random() * 0.7);
    const y = side ? h * (0.2 + Math.random() * 0.6) : -30 - Math.random() * 120;

    let flashX = 0, flashY = 0;
    if (fire) {
      const exits = [];
      if (vx > 0) exits.push((w - x) / vx);
      if (vx < 0) exits.push((0 - x) / vx);
      exits.push((h - y) / vy);
      let tExit = Math.min.apply(null, exits.filter(function (t) { return t > 0; }));
      if (!isFinite(tExit) || tExit <= 0) tExit = (h - y) / vy;
      const tFlash = tExit * (0.3 + Math.random() * 0.55);
      flashX = x + vx * tFlash;
      flashY = y + vy * tFlash;
    }

    meteors.push({
      x: x,
      y: y,
      vx: vx,
      vy: vy,
      len: fire
        ? CFG.meteor.fireLenMin + Math.random() * CFG.meteor.fireLenRange
        : CFG.meteor.lenMin + Math.random() * CFG.meteor.lenRange,
      fire: fire,
      blue: blue,
      bright: bright,
      flickerPhase: Math.random() * Math.PI * 2,
      flashed: false,
      flashT0: 0,
      flashX: flashX,
      flashY: flashY,
      fade: 1,
      hitCd: 0
    });
    const base = bursting
      ? CFG.meteor.burstSpawnMin + Math.random() * CFG.meteor.burstSpawnRange
      : CFG.meteor.spawnMin + Math.random() * CFG.meteor.spawnRange;
    nextMeteor = now + base;
  }

  function drawMeteor(m, t) {
    const dist = Math.hypot(m.vx, m.vy) || 1;
    const tailX = m.x - (m.vx / dist) * m.len;
    const tailY = m.y - (m.vy / dist) * m.len;
    const b = m.bright;
    const fade = m.fade;
    let fl = 1;
    if (m.fire) {
      fl = 0.72 + 0.28 * Math.sin(t * 0.022 + m.flickerPhase) * Math.sin(t * 0.075 + m.flickerPhase * 2.3);
      fl = Math.max(0.55, Math.min(1, fl));
    }

    const g = ctx.createLinearGradient(m.x, m.y, tailX, tailY);
    if (m.fire) {
      g.addColorStop(0, "rgba(255, 226, 180, " + (0.9 * b * fade * fl).toFixed(3) + ")");
      g.addColorStop(0.75, "rgba(255, 190, 120, " + (0.85 * b * fade * fl).toFixed(3) + ")");
      g.addColorStop(1, "rgba(255, 150, 80, " + (0.35 * b * fade * fl).toFixed(3) + ")");
    } else if (m.blue) {
      g.addColorStop(0, "rgba(180, 220, 255, " + (0.9 * b).toFixed(3) + ")");
      g.addColorStop(0.75, "rgba(150, 205, 255, " + (0.85 * b).toFixed(3) + ")");
      g.addColorStop(1, "rgba(120, 185, 255, " + (0.35 * b).toFixed(3) + ")");
    } else {
      g.addColorStop(0, "rgba(236, 245, 255, " + (0.85 * b).toFixed(3) + ")");
      g.addColorStop(0.75, "rgba(226, 238, 255, " + (0.8 * b).toFixed(3) + ")");
      g.addColorStop(1, "rgba(210, 226, 255, " + (0.3 * b).toFixed(3) + ")");
    }
    ctx.strokeStyle = g;
    ctx.lineWidth = m.fire ? 3.2 : 1.6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(m.x, m.y);
    ctx.lineTo(tailX, tailY);
    ctx.stroke();

    const dotR = m.fire ? 2.6 : 1.8;
    if (m.fire) {
      ctx.fillStyle = "rgba(255, 242, 214, " + (0.7 * b * fade * fl).toFixed(3) + ")";
    } else if (m.blue) {
      ctx.fillStyle = "rgba(205, 232, 255, " + (0.65 * b).toFixed(3) + ")";
    } else {
      ctx.fillStyle = "rgba(240, 248, 255, " + (0.6 * b).toFixed(3) + ")";
    }
    ctx.beginPath();
    ctx.arc(m.x, m.y, dotR, 0, Math.PI * 2);
    ctx.fill();
  }

  function addFlash(x, y, t, small) {
    if (flashes.length >= CFG.flash.max) return;
    const embers = [];
    if (!small) {
      for (let i = 0; i < CFG.flash.emberCount; i++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = 1.1 + Math.random() * 2.1;
        embers.push({
          x: x,
          y: y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp - 0.4,
          size: 1 + Math.random() * 1.1,
          dur: 380 + Math.random() * 220
        });
      }
    }
    flashes.push({ x: x, y: y, t0: t, small: !!small, embers: embers });
  }

  function easeOut(p) {
    return 1 - (1 - p) * (1 - p);
  }

  function breathPulse(t, period, offset) {
    /* 一轮约 6~7.5 秒：吸气般亮起 40%，呼气般暗下 60%。余弦缓动避免机械闪烁。
       最暗不低于 0.3：mini-LED 等深黑面板上，12% 亮度的萤火虫会完全隐形，
       导致"数量看起来变少、发光出现在没预料的位置、没法瞄准躲闪"。 */
    const p = (t / period + offset) % 1;
    const inhale = CFG.flies.inhaleRatio;
    let eased;
    if (p < inhale) {
      eased = (1 - Math.cos(Math.PI * p / inhale)) / 2;
      return 0.3 + 0.7 * eased;
    }
    eased = (1 - Math.cos(Math.PI * (p - inhale) / (1 - inhale))) / 2;
    return 1 - 0.7 * eased;
  }

  function updatePreview(now) {
    if (!line1 && !line2) return;
    if (now - lastPreviewUpdate < 1000) return;
    lastPreviewUpdate = now;
    if (line1) {
      if (now < burstUntil) {
        line1.textContent = "流星雨进行中 · 已划过 " + burstStats.total + " 颗 · 火流星 " + burstStats.fire + " 颗";
      } else {
        const mMin = Math.max(1, Math.round((nextBurst - now) / 60000));
        line1.textContent = "下一次流星雨 约 " + mMin + " 分钟后";
      }
    }
    if (line2) {
      if (now < flyBurstUntil) {
        line2.textContent = "萤火爆发中 · 已相遇 " + flyMeetCount + " 次";
      } else {
        const fMin = Math.max(1, Math.round((nextFlyBurst - now) / 60000));
        line2.textContent = "萤火爆发 约 " + fMin + " 分钟后";
      }
    }
  }

  function tick(t) {
    /* 后台节流交给平台：浏览器会自动降频/暂停隐藏标签页的 RAF。
       我们的职责只有"恢复时无缝"——真实世界时钟重算时间表
       （隐藏期间错过的爆发正确跳过），dt 钳制防止瞬移。 */
    try {
      ctx.clearRect(0, 0, w, h);
      /* 帧间隔归一化：所有按帧积分的位置/推力都乘 dt，
         让 60Hz 与 120/165Hz 高刷屏上的飞行、躲避速度完全一致
         （dt=1 表示 60fps 基准帧；切标签页后的长间隔被钳制，避免瞬移）。 */
      const dt = lastT ? Math.min(3, Math.max(0.25, (t - lastT) / 16.67)) : 1;
      lastDt = dt;

    const gw = meteorWindow(t + PERF_TO_WALL);
    if (gw.active) {
      if (t >= burstUntil && t >= forcedBurstUntil) {
        burstUntil = gw.end - PERF_TO_WALL;
        forcedBurstUntil = 0;
        burstStats = { total: 0, fire: 0 };
      }
      nextBurst = meteorWindow(gw.start + CFG.meteorBurst.globalCycle).start - PERF_TO_WALL;
    } else {
      if (t >= forcedBurstUntil) {
        burstUntil = 0;
      }
      nextBurst = meteorWindow(gw.start + CFG.meteorBurst.globalCycle).start - PERF_TO_WALL;
    }
    const fgw = flyWindow(t + PERF_TO_WALL);
    if (fgw.active) {
      if (t >= flyBurstUntil && t >= forcedFlyUntil) {
        beginFlyBurst(fgw.end - PERF_TO_WALL);
        forcedFlyUntil = 0;
      }
      nextFlyBurst = flyWindow(fgw.start + CFG.flyBurst.globalCycle).start - PERF_TO_WALL;
    } else {
      if (t >= forcedFlyUntil) {
        flyBurstUntil = 0;
      }
      nextFlyBurst = flyWindow(fgw.start + CFG.flyBurst.globalCycle).start - PERF_TO_WALL;
    }
    if (t < flyBurstUntil && flies.length < flyBurstMax && t - lastFlySpawn > CFG.flyBurst.spawnEvery) {
      flies.push(spawnFly(false));
      lastFlySpawn = t;
    }
    if (t >= nextMeteor) spawnMeteor(t);

    for (let mi = meteors.length - 1; mi >= 0; mi--) {
      const m = meteors[mi];
      const leaving = m.y > h || (m.vx > 0 && m.x > w) || (m.vx < 0 && m.x < 0);
      if (leaving) {
        if (m.fire && !m.flashed) {
          addFlash(Math.max(0, Math.min(w, m.x)), Math.min(h, m.y), t, false);
        }
        meteors.splice(mi, 1);
      }
    }
    for (const m of meteors) {
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      const ptr = window.__pointerFx;
      if (ptr && ptr.active && t > m.hitCd) {
        const spd = Math.hypot(m.vx, m.vy) || 1;
        const tx = m.x - (m.vx / spd) * m.len;
        const ty = m.y - (m.vy / spd) * m.len;
        if (segDist(ptr.x, ptr.y, m.x, m.y, tx, ty) < 2025) {
          m.hitCd = t + 700;
          addFlash(m.x, m.y, t, true);
          if (window.__cursorFx && window.__cursorFx.burstAt) {
            window.__cursorFx.burstAt(m.x, m.y, ["#ff5a5a", "#ffd9a0", "#f5b84b"], 12);
          }
        }
      }
      if (m.fire && !m.flashed) {
        const dx = m.x - m.flashX;
        const dy = m.y - m.flashY;
        if (dx * dx + dy * dy < CFG.meteor.flashReach) {
          m.flashed = true;
          m.flashT0 = t;
          addFlash(m.x, m.y, t, false);
        }
      }
      if (m.fire && m.flashed) {
        m.fade = Math.max(0.2, 1 - (t - m.flashT0) / CFG.meteor.fireFadeMs);
      }
      drawMeteor(m, t);
    }

    if (t < flyBurstUntil) {
      flyFade = 1;
    } else if (lastT > 0) {
      flyFade = Math.max(0, flyFade - (t - lastT) / CFG.flyBurst.fadeMs);
    }
    lastT = t;
    const burstingNow = t < flyBurstUntil;
    if (flyLevel > 0 && !burstingNow && t > flyLevelUntil) flyLevel = 0;

    for (const f of flies) {
      f.x += (f.vx + Math.sin(t / 3000 + f.phase) * 0.05) * dt;
      f.y += (f.vy + Math.cos(t / 2400 + f.phase) * 0.04) * dt;
      if (f.y < -12 || f.x < -12 || f.x > w + 12) {
        Object.assign(f, spawnFly(false));
      }
      const ptr = window.__pointerFx;
      if (ptr && ptr.active) {
        const pdx = f.x - ptr.x;
        const pdy = f.y - ptr.y;
        const pd2 = pdx * pdx + pdy * pdy;
        if (pd2 < CFG.pointer.glowReach2) {
          f.mouseGlowUntil = t + 700;
        }
        if (pd2 < CFG.pointer.repelReach2) {
          const pd = Math.sqrt(pd2) || 1;
          const nx = pd2 > 0 ? pdx / pd : Math.cos(f.phase);
          const ny = pd2 > 0 ? pdy / pd : Math.sin(f.phase);
          f.vx += nx * CFG.pointer.repelImpulse * dt;
          f.vy += ny * CFG.pointer.repelImpulse * dt;
          const sp = Math.hypot(f.vx, f.vy);
          const maxSp = CFG.pointer.cruiseMaxSpeed;
          if (sp > maxSp) {
            f.vx *= maxSp / sp;
            f.vy *= maxSp / sp;
          }
        }
      }
      f.vx += (f.vx0 - f.vx) * CFG.pointer.relax * dt;
      f.vy += (f.vy0 - f.vy) * CFG.pointer.relax * dt;
    }

    for (const m of meteors) {
      for (const f of flies) {
        const dx = m.x - f.x;
        const dy = m.y - f.y;
        const reach = CFG.meet.meteorReach + f.r;
        if (dx * dx + dy * dy < reach * reach && t > f.meetCd) {
          f.meetCd = t + CFG.meet.cooldown;
          addFlash((m.x + f.x) / 2, (m.y + f.y) / 2, t, true);
          if (burstingNow) flyMeetCount++;
        }
      }
    }
    for (let i = 0; i < flies.length; i++) {
      for (let j = i + 1; j < flies.length; j++) {
        const a = flies[i], b = flies[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if (dx * dx + dy * dy < CFG.meet.dist2 && t > a.meetCd && t > b.meetCd) {
          a.meetCd = t + CFG.meet.cooldown;
          b.meetCd = t + CFG.meet.cooldown;
          addFlash((a.x + b.x) / 2, (a.y + b.y) / 2, t, true);
          if (burstingNow) flyMeetCount++;
        }
      }
    }

    flashes = flashes.filter(function (f) {
      return t - f.t0 < (f.small ? CFG.flash.smallDur : CFG.flash.bigDur);
    });
    ctx.globalCompositeOperation = "lighter";
    for (const f of flashes) {
      const e = t - f.t0;
      if (f.small) {
        const p = Math.min(1, e / CFG.flash.smallDur);
        const r = 7 + 8 * easeOut(p);
        const alpha = (1 - p) * 0.22;
        const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
        g.addColorStop(0, "rgba(255, 236, 205, " + alpha.toFixed(3) + ")");
        g.addColorStop(1, "rgba(255, 170, 100, 0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      const p = Math.min(1, e / CFG.flash.bigDur);
      const haloR = 12 + 30 * easeOut(p);
      const haloA = Math.pow(1 - p, 1.5) * 0.32;
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, haloR);
      g.addColorStop(0, "rgba(255, 238, 205, " + haloA.toFixed(3) + ")");
      g.addColorStop(0.55, "rgba(255, 190, 120, " + (haloA * 0.5).toFixed(3) + ")");
      g.addColorStop(1, "rgba(255, 140, 80, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(f.x, f.y, haloR, 0, Math.PI * 2);
      ctx.fill();

      const coreR = Math.max(0.8, 4.2 * (1 - p));
      ctx.fillStyle = "rgba(255, 250, 235, " + (Math.pow(1 - p, 2) * 0.9).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(f.x, f.y, coreR, 0, Math.PI * 2);
      ctx.fill();

      const ringR = 10 + 24 * easeOut(p);
      ctx.strokeStyle = "rgba(255, 225, 180, " + ((1 - p) * 0.22).toFixed(3) + ")";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(f.x, f.y, ringR, 0, Math.PI * 2);
      ctx.stroke();

      for (const em of f.embers) {
        em.x += em.vx * dt;
        em.y += em.vy * dt;
        em.vx *= Math.pow(0.97, dt);
        em.vy *= Math.pow(0.97, dt);
        const ep = Math.min(1, e / em.dur);
        if (ep >= 1) continue;
        ctx.fillStyle = "rgba(255, 218, 168, " + ((1 - ep) * 0.75).toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc(em.x, em.y, em.size * (1 - ep * 0.6), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = "source-over";

    const flashing = t - flyFlashT0 < CFG.fireflyFlashMs;
    const sizeMul = 1 + (burstingNow ? (CFG.flyBurst.sizeMul - 1) : flyFade) + flyLevel * CFG.flyBright.sizeStep;
    const brightBoost = flashing ? 1.9 : (1 + CFG.flyBurst.brightAdd * (burstingNow ? 1 : flyFade) + flyLevel * CFG.flyBright.brightStep);
    for (const f of flies) {
      const mouseBoost = f.mouseGlowUntil > t ? 1 : 0;
      const flicker = breathPulse(t, f.breathPeriod, f.breathOffset);
      const alpha = Math.min(1, (0.10 + 0.7 * flicker) * brightBoost + mouseBoost * CFG.pointer.startleAlpha);
      const glowR = f.r * 5 * sizeMul * (flashing ? 1.8 : 1) * (0.8 + 0.3 * flicker) * (1 + mouseBoost * 0.35);
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, glowR);
      g.addColorStop(0, "rgba(255, 217, 160, " + alpha.toFixed(3) + ")");
      g.addColorStop(1, "rgba(245, 184, 75, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(f.x, f.y, glowR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 235, 200, " + Math.min(1, (0.12 + 0.75 * flicker) * brightBoost + mouseBoost * CFG.pointer.startleCoreAlpha).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r * 0.7 * sizeMul, 0, Math.PI * 2);
      ctx.fill();
    }

      updatePreview(t);
    } catch (e) {
      try { console.error("flitfancy tick:", e); } catch (e2) { /* ignore */ }
    }
    requestAnimationFrame(tick);
  }

  window.flitfancy = {
    meteor: function () { spawnMeteor(performance.now()); },
    meteorBurst: function () { startMeteorBurst(performance.now()); },
    fireflyFlash: function () { flyFlashT0 = performance.now(); },
    fireflyBright: function () {
      if (flyLevel < CFG.flyBright.maxLevel) flyLevel++;
      flyLevelUntil = performance.now() + CFG.flyBright.keepMs;
    },
    fireflyBurst: function () {
      flyLevel = 0;
      beginFlyBurst(performance.now() + CFG.flyBurst.durationMin + Math.random() * CFG.flyBurst.durationRange);
    }
  };

  /* 只读调试句柄：debug-firefly.html 用它把内部状态可视化。
     不影响正常渲染，正常运行永远不读它。 */
  window.__ffDebug = {
    get count() { return flies.length; },
    get flies() {
      return flies.map(function (f) {
        return { x: f.x, y: f.y, r: f.r, vx: f.vx, vy: f.vy, glow: f.mouseGlowUntil };
      });
    },
    get env() {
      return { w: w, h: h, dpr: dpr, dt: lastDt, refW: refW, refH: refH };
    },
    get pointer() { return window.__pointerFx || null; },
  };

  window.addEventListener("resize", function () {
    /* 天空-视口模型（弹性版）：
       · 画布即时跟随窗口（CSS 尺寸锁定 + DPR 后备存储）；
       · 所有萤火虫位置立即按新旧视口比例重排，重排后【立即更新参考值】——
         连续 resize 事件不会累积失真（每步只乘"当前→新"的比值），
         收缩再放大可精确还原；由此分布恒均匀，不可能偏左/右侧空/缩成一团；
       · 数量结算防抖 200ms 执行一次（settleFlies：只补不删可见萤火虫，
         稳态超员只移除当前最暗的个体，爆发期间绝不减员）；
       · 流星雨/萤火爆发/相遇统计全程保留。 */
    resize();
    if (Math.abs(window.innerWidth - refW) <= 40) return;
    const sx = window.innerWidth / Math.max(1, refW);
    const sy = window.innerHeight / Math.max(1, refH);
    for (const f of flies) {
      f.x *= sx;
      f.y *= sy;
    }
    refW = window.innerWidth;
    refH = window.innerHeight;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(settleFlies, 200);
  });
  init();
  requestAnimationFrame(tick);
  /* 跨页保持：离开页面或转入后台时保存萤火虫状态，下次同标签页加载恢复 */
  window.addEventListener("pagehide", saveFlies);
  if (document.addEventListener) {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") saveFlies();
    });
  }
  /* 预览面板每帧节流更新由 tick 内的 updatePreview(t) 负责，此处不再重复定时 */
})();
