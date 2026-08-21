(function () {
  /* 全局契约（firefly.js）：本文件定义 window.__pointerFx 与
     window.__cursorFx，供 firefly.js 做指针避让与光标爆发。
     firefly.js 在本文件之前加载，靠 RAF 延迟读取成立——见 firefly.js 头部说明。 */
  /* 悬停预加载：鼠标移到导航链接上时，提前把目标页面缓存下来 */
  document.querySelectorAll('.nav nav a').forEach(function (a) {
    var url = a.getAttribute('href');
    if (!url || url.indexOf('http') === 0) return;
    var timer = null;
    a.addEventListener('mouseenter', function () {
      timer = setTimeout(function () {
        var link = document.createElement('link');
        link.rel = 'prefetch';
        link.href = url;
        document.head.appendChild(link);
      }, 80);
    });
    a.addEventListener('mouseleave', function () {
      clearTimeout(timer);
    });
  });

  /* 光标特效：划过 = 淡金流星尾；左键 = 蓝色迸发；右键 = 红色迸发 */
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var canvas = document.createElement('canvas');
  canvas.className = 'cursor-fx';
  document.body.appendChild(canvas);
  var ctx = canvas.getContext('2d');
  var W = 0, H = 0, dpr = 1;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  var parts = [];
  var trail = [];
  var trailMs = 220;
  var trailStep = 2.5;
  var MAX = 140;
  /* 供夜空引擎调用的火花迸发接口（流星碰撞用） */
  window.__cursorFx = {
    burstAt: function (x, y, colors, n) {
      burst(x, y, colors || ['#f5b84b'], n || 10);
    }
  };

  function add(x, y, vx, vy, life, color, size) {
    if (parts.length >= MAX) parts.shift();
    parts.push({ x: x, y: y, vx: vx, vy: vy, life: life, max: life, color: color, size: size });
  }

  function burst(x, y, colors, n, speed) {
    speed = speed || 230;
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var v = speed * (0.35 + Math.random() * 0.85);
      add(
        x, y,
        Math.cos(a) * v, Math.sin(a) * v,
        0.45 + Math.random() * 0.25,
        colors[(Math.random() * colors.length) | 0],
        1.2 + Math.random() * 1.6
      );
    }
  }

  document.addEventListener('mousemove', function (e) {
    wake();
    window.__pointerFx = { x: e.clientX, y: e.clientY, active: true };
    var now = performance.now();
    var last = trail[trail.length - 1];
    if (last) {
      var dx = e.clientX - last.x;
      var dy = e.clientY - last.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var steps = Math.min(Math.floor(dist / trailStep), 50);
      for (var i = 1; i <= steps; i++) {
        var k = i / (steps + 1);
        trail.push({
          x: last.x + dx * k,
          y: last.y + dy * k,
          t: last.t + (now - last.t) * k
        });
      }
    } else {
      trail.push({ x: e.clientX, y: e.clientY, t: now });
    }
    if (trail.length > 240) trail.splice(0, trail.length - 240);
  });

  document.addEventListener('touchmove', function (e) {
    wake();
    var t = e.touches && e.touches[0];
    if (t) window.__pointerFx = { x: t.clientX, y: t.clientY, active: true };
  }, { passive: true });

  document.addEventListener('touchstart', function (e) {
    wake();
    var t = e.touches && e.touches[0];
    if (t) window.__pointerFx = { x: t.clientX, y: t.clientY, active: true };
  }, { passive: true });

  /* 触点/光标离开后复位：萤火虫不再永久吸附过期触点 */
  function clearPointer() {
    if (window.__pointerFx) window.__pointerFx.active = false;
  }
  document.addEventListener('touchend', clearPointer, { passive: true });
  document.addEventListener('touchcancel', clearPointer, { passive: true });
  document.addEventListener('mouseleave', clearPointer);

  document.addEventListener('mousedown', function (e) {
    if (e.button === 0) {
      wake();
      burst(e.clientX, e.clientY, ['#3fd0e8', '#a8ecff', '#7fd8a4'], 14, 230);
    }
  });

  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    wake();
    burst(e.clientX, e.clientY, ['#ff5a5a', '#ff9a6a', '#f5b84b'], 14, 230);
  });

  var lastFrameT = 0;
  var running = true;

  function wake() {
    if (!running) {
      running = true;
      requestAnimationFrame(frame);
    }
  }

  function frame() {
    /* 空闲停帧：没有粒子、没有轨迹、没有活跃触点时不再空转（后台节流交给平台） */
    if (!parts.length && !trail.length &&
        !(window.__pointerFx && window.__pointerFx.active)) {
      running = false;
      return;
    }
    /* 后台节流交给平台（浏览器自动降频隐藏标签页的 RAF） */
    ctx.clearRect(0, 0, W, H);
    var now = performance.now();
    /* 帧间隔归一化：火花粒子的位移与衰减按 dt 缩放，
       让 60Hz 与高刷屏上的迸发速度/寿命一致（dt=1 表示 60fps 基准帧）。 */
    var dt = lastFrameT ? Math.min(3, Math.max(0.25, (now - lastFrameT) / 16.67)) : 1;
    lastFrameT = now;

    /* 流星尾：连续渐隐光带 */
    for (var ti = trail.length - 1; ti >= 0; ti--) {
      if (now - trail[ti].t >= trailMs) trail.splice(ti, 1);
    }
    ctx.lineCap = 'round';
    ctx.globalCompositeOperation = 'lighter';
    for (var t = 1; t < trail.length; t++) {
      var a = trail[t - 1], b = trail[t];
      var ka = Math.max(0, 1 - (now - a.t) / trailMs);
      var kb = Math.max(0, 1 - (now - b.t) / trailMs);
      var k = Math.min(ka, kb);
      k = k * k;
      ctx.globalAlpha = k * 0.6;
      ctx.strokeStyle = '#3fd0e8';
      ctx.lineWidth = 0.7 + k * 2.6;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    if (trail.length) {
      var h = trail[trail.length - 1];
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = '#eafcff';
      ctx.beginPath();
      ctx.arc(h.x, h.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      var k = p.life / p.max;
      p.x += p.vx / 60 * dt;
      p.y += p.vy / 60 * dt;
      p.vx *= Math.pow(0.92, dt);
      p.vy *= Math.pow(0.92, dt);
      p.life -= 1 / 60 * dt;
      if (p.life <= 0) {
        parts.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = k * 0.9;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * k + 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
