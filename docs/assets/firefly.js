/* flitfancy 夜空特效
 * 所有可调参数集中在 CFG，后续可从控制台配置接口覆盖。
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
      countPer90: 90,          // 每 90px 宽一只
      minCount: 10,
      maxCount: 22,
      flickerPeriodMin: 1800,  // 呼吸周期（ms）
      flickerPeriodRange: 1000
    },
    flyBurst: {
      durationMin: 30000,      // 萤火爆发时长（ms）
      durationRange: 15000,
      intervalMin: 1800000,    // 爆发间隔 30~60 分钟
      intervalRange: 1800000,
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
      fireLenRange: 93
    },
    meteorBurst: {
      durationMin: 45000,      // 流星雨时长 45~60 秒
      durationRange: 15000,
      intervalMin: 1800000,    // 间隔 30~60 分钟
      intervalRange: 1800000
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
    fireflyFlashMs: 800        // 全屏闪一下时长
  };

  const ctx = canvas.getContext("2d");
  const MOBILE = window.innerWidth < 640;
  let w, h, dpr;
  let flies = [];
  let meteors = [];
  let flashes = [];
  let nextMeteor = 0;
  let burstUntil = 0;
  let nextBurst = 0;
  let burstStats = { total: 0, fire: 0 };
  let burstWallUntil = 0;
  let flyBurstUntil = 0;
  let nextFlyBurst = 0;
  let flyBurstMax = 0;
  let flyMeetCount = 0;
  let flyWallUntil = 0;
  let flyFade = 0;
  let lastT = 0;
  let flyLevel = 0;
  let flyLevelUntil = 0;
  let flyFlashT0 = -99999;
  let lastFlySpawn = 0;
  let line1 = null;
  let line2 = null;
  let lastPreviewUpdate = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth = window.innerWidth;
    h = canvas.clientHeight = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawnFly(init) {
    return {
      x: Math.random() * w,
      y: init ? Math.random() * h : h + 10,
      r: 1 + Math.random() * 1.6,
      vx: (Math.random() - 0.5) * 0.18,
      vy: -0.15 - Math.random() * 0.35,
      phase: Math.random() * Math.PI * 2,
      flickerPeriod: CFG.flies.flickerPeriodMin + Math.random() * CFG.flies.flickerPeriodRange,
      meetCd: 0
    };
  }

  function storageGet(key) {
    try {
      return JSON.parse(sessionStorage.getItem(key));
    } catch (e) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* 忽略存储失败 */
    }
  }

  function restoreBursts() {
    const m = storageGet("flitfancy.meteorBurst");
    if (m && m.until > Date.now()) {
      burstUntil = performance.now() + (m.until - Date.now());
      burstStats = m.stats || { total: 0, fire: 0 };
      burstWallUntil = m.until;
      nextMeteor = performance.now() + 150;
    }
    const f = storageGet("flitfancy.flyBurst");
    if (f && f.until > Date.now()) {
      flyBurstUntil = performance.now() + (f.until - Date.now());
      flyMeetCount = f.meets || 0;
      flyFade = 1;
      flyWallUntil = f.until;
      flyBurstMax = Math.min(CFG.flyBurst.maxFlies, Math.max(flies.length, 10) * 2);
    }
  }

  function init() {
    resize();
    const count = Math.min(
      CFG.flies.maxCount,
      Math.max(MOBILE ? 16 : CFG.flies.minCount, Math.floor(w / (MOBILE ? 60 : CFG.flies.countPer90)))
    );
    flies = [];
    for (let i = 0; i < count; i++) flies.push(spawnFly(true));
    meteors = [];
    flashes = [];
    nextMeteor = performance.now() + 2500 + Math.random() * 4000;
    burstUntil = 0;
    burstStats = { total: 0, fire: 0 };
    burstWallUntil = 0;
    nextBurst = performance.now() + CFG.meteorBurst.intervalMin + Math.random() * CFG.meteorBurst.intervalRange;
    flyBurstUntil = 0;
    nextFlyBurst = performance.now() + CFG.flyBurst.intervalMin + Math.random() * CFG.flyBurst.intervalRange;
    flyBurstMax = 0;
    flyMeetCount = 0;
    flyWallUntil = 0;
    flyFade = 0;
    flyLevel = 0;
    flyLevelUntil = 0;
    flyFlashT0 = -99999;
    lastFlySpawn = 0;
    line1 = document.getElementById("burst-line-1");
    line2 = document.getElementById("burst-line-2");
    restoreBursts();
  }

  function startMeteorBurst(now) {
    const dur = CFG.meteorBurst.durationMin + Math.random() * CFG.meteorBurst.durationRange;
    burstUntil = now + dur;
    burstStats = { total: 0, fire: 0 };
    burstWallUntil = Date.now() + dur;
    storageSet("flitfancy.meteorBurst", { until: burstWallUntil, stats: burstStats });
  }

  function startFlyBurst(now) {
    const dur = CFG.flyBurst.durationMin + Math.random() * CFG.flyBurst.durationRange;
    flyBurstUntil = now + dur;
    flyBurstMax = Math.min(CFG.flyBurst.maxFlies, flies.length * 2);
    flyMeetCount = 0;
    flyFade = 1;
    flyWallUntil = Date.now() + dur;
    storageSet("flitfancy.flyBurst", { until: flyWallUntil, meets: flyMeetCount });
    for (let i = 0; i < CFG.flyBurst.popCount && flies.length < flyBurstMax; i++) flies.push(spawnFly(false));
  }

  function spawnMeteor(now) {
    const bursting = now < burstUntil;
    if (bursting) burstStats.total++;
    const fire = Math.random() < (bursting ? CFG.meteor.burstFireChance : CFG.meteor.fireChance);
    if (fire && bursting) burstStats.fire++;
    if (bursting) storageSet("flitfancy.meteorBurst", { until: burstWallUntil, stats: burstStats });
    const blue = !fire && Math.random() < CFG.meteor.blueChance;
    const bright = fire ? 0.85 + Math.random() * 0.3 : 0.45 + Math.random() * 0.75;
    const speed = fire ? 7 + Math.random() * 6 : 3 + Math.random() * 4;
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
      fade: 1
    });
    const base = bursting
      ? CFG.meteor.burstSpawnMin + Math.random() * CFG.meteor.burstSpawnRange
      : CFG.meteor.spawnMin + Math.random() * CFG.meteor.spawnRange;
    nextMeteor = now + (MOBILE ? base * 0.6 : base);
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
    ctx.clearRect(0, 0, w, h);

    if (t >= nextBurst && t >= burstUntil) {
      startMeteorBurst(t);
      nextBurst = t + CFG.meteorBurst.intervalMin + Math.random() * CFG.meteorBurst.intervalRange;
    }
    if (t >= nextFlyBurst && t >= flyBurstUntil) {
      startFlyBurst(t);
      nextFlyBurst = t + CFG.flyBurst.intervalMin + Math.random() * CFG.flyBurst.intervalRange;
    }
    if (t < flyBurstUntil && flies.length < flyBurstMax && t - lastFlySpawn > CFG.flyBurst.spawnEvery) {
      flies.push(spawnFly(false));
      lastFlySpawn = t;
    }
    if (t >= nextMeteor) spawnMeteor(t);

    meteors = meteors.filter(function (m) {
      const leaving = m.y > h || (m.vx > 0 && m.x > w) || (m.vx < 0 && m.x < 0);
      if (leaving) {
        if (m.fire && !m.flashed) {
          addFlash(Math.max(0, Math.min(w, m.x)), Math.min(h, m.y), t, false);
        }
        return false;
      }
      return true;
    });
    for (const m of meteors) {
      m.x += m.vx;
      m.y += m.vy;
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
    if (burstWallUntil && Date.now() > burstWallUntil) {
      try { sessionStorage.removeItem("flitfancy.meteorBurst"); } catch (e) {}
      burstWallUntil = 0;
    }
    if (flyWallUntil && Date.now() > flyWallUntil) {
      try { sessionStorage.removeItem("flitfancy.flyBurst"); } catch (e) {}
      flyWallUntil = 0;
    }

    for (const f of flies) {
      f.x += f.vx + Math.sin(t / 3000 + f.phase) * 0.05;
      f.y += f.vy + Math.cos(t / 2400 + f.phase) * 0.04;
      if (f.y < -12 || f.x < -12 || f.x > w + 12) {
        Object.assign(f, spawnFly(false));
      }
    }

    for (const m of meteors) {
      for (const f of flies) {
        const dx = m.x - f.x;
        const dy = m.y - f.y;
        const reach = CFG.meet.meteorReach + f.r;
        if (dx * dx + dy * dy < reach * reach && t > f.meetCd) {
          f.meetCd = t + CFG.meet.cooldown;
          addFlash((m.x + f.x) / 2, (m.y + f.y) / 2, t, true);
          if (burstingNow) {
            flyMeetCount++;
            storageSet("flitfancy.flyBurst", { until: flyWallUntil, meets: flyMeetCount });
          }
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
          if (burstingNow) {
            flyMeetCount++;
            storageSet("flitfancy.flyBurst", { until: flyWallUntil, meets: flyMeetCount });
          }
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
        em.x += em.vx;
        em.y += em.vy;
        em.vx *= 0.97;
        em.vy *= 0.97;
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
    const sizeMul = 1 + (burstingNow ? 1 : flyFade) + flyLevel * CFG.flyBright.sizeStep;
    const brightBoost = flashing ? 1.9 : (1 + 0.3 * (burstingNow ? 1 : flyFade) + flyLevel * CFG.flyBright.brightStep);
    for (const f of flies) {
      const breathe = 0.55 + 0.42 * Math.sin(t / f.flickerPeriod + f.phase) +
                      0.10 * Math.sin(t / (f.flickerPeriod * 0.47) + f.phase * 1.9);
      const flicker = Math.max(0.12, Math.min(1, breathe));
      const alpha = Math.min(1, (0.10 + 0.7 * flicker) * brightBoost);
      const glowR = f.r * 5 * sizeMul * (flashing ? 1.8 : 1) * (0.8 + 0.3 * flicker);
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, glowR);
      g.addColorStop(0, "rgba(255, 217, 160, " + alpha.toFixed(3) + ")");
      g.addColorStop(1, "rgba(245, 184, 75, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(f.x, f.y, glowR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 235, 200, " + Math.min(1, (0.12 + 0.75 * flicker) * brightBoost).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r * 0.7 * sizeMul, 0, Math.PI * 2);
      ctx.fill();
    }

    updatePreview(t);
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
      startFlyBurst(performance.now());
    }
  };

  window.addEventListener("resize", init);
  init();
  requestAnimationFrame(tick);
})();
