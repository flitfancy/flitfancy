(function () {
  const canvas = document.getElementById("sky");
  if (!canvas) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    canvas.style.display = "none";
    return;
  }

  const ctx = canvas.getContext("2d");
  let w, h, dpr;
  let flies = [];

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth = window.innerWidth;
    h = canvas.clientHeight = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn(init) {
    return {
      x: Math.random() * w,
      y: init ? Math.random() * h : h + 10,
      r: 1 + Math.random() * 1.6,
      vx: (Math.random() - 0.5) * 0.18,
      vy: -0.15 - Math.random() * 0.35,
      phase: Math.random() * Math.PI * 2,
      speed: 0.4 + Math.random() * 1.2,
      drift: 12 + Math.random() * 30
    };
  }

  function init() {
    resize();
    const count = Math.min(22, Math.max(10, Math.floor(w / 90)));
    flies = [];
    for (let i = 0; i < count; i++) flies.push(spawn(true));
  }

  function tick(t) {
    ctx.clearRect(0, 0, w, h);
    for (const f of flies) {
      f.x += f.vx + Math.sin(t / 3000 + f.phase) * 0.05;
      f.y += f.vy + Math.cos(t / 2400 + f.phase) * 0.04;
      if (f.y < -12 || f.x < -12 || f.x > w + 12) {
        Object.assign(f, spawn(false));
      }
      const flicker = 0.55 + 0.45 * Math.sin(t / 900 + f.phase * 3);
      const alpha = 0.18 + 0.5 * flicker;
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r * 5);
      g.addColorStop(0, "rgba(255, 217, 160, " + alpha.toFixed(3) + ")");
      g.addColorStop(1, "rgba(245, 184, 75, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r * 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 235, 200, " + (0.25 + 0.5 * flicker).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(tick);
  }

  window.addEventListener("resize", init);
  init();
  requestAnimationFrame(tick);
})();
