/* 随笔随机展示：关于页与日记页底部共用。保存新随笔后立即刷新。 */
(function () {
  const line = document.querySelector('[data-role="reflection-line"]');
  const text = document.querySelector('[data-role="reflection-text"]');
  const brand = document.querySelector('[data-role="footer-brand"]');
  if (!line || !text) return;

  const endpoint = "https://api.flitfancy.com/config";
  let displayed = null;
  /* 关于页不加载 admin-core，故这里本地声明超时；
     数值与 admin-core.js 的 TIMEOUT_MS 保持一致。 */
  const TIMEOUT_MS = 8000;

  /* 页尾标题：有随笔时随笔随机替换收束句（同一字号/字体/渐变），
     没有随笔或取不到时回退为固定收束句。 */
  function showBrandOnly() {
    line.hidden = true;
    if (brand) brand.hidden = false;
  }

  function load() {
    const ctrl = new AbortController();
    const timer = setTimeout(function () {
      ctrl.abort();
    }, TIMEOUT_MS);
    return fetch(endpoint, { headers: { "Accept": "application/json" }, cache: "no-store", signal: ctrl.signal })
      .then(function (response) {
        clearTimeout(timer);
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        const rows = Array.isArray(data.reflections)
          ? data.reflections.filter(function (item) {
            return typeof item === "string" && item.trim();
          })
          : [];
        const signature = JSON.stringify(rows);
        if (signature === displayed) return { ok: true };
        displayed = signature;
        if (!rows.length) {
          showBrandOnly();
          return { ok: true };
        }
        text.textContent = rows[Math.floor(Math.random() * rows.length)].trim();
        line.hidden = false;
        if (brand) brand.hidden = true;
        return { ok: true };
      })
      .catch(function () { if (displayed === null) showBrandOnly(); return { ok: false }; })
      .finally(function () { clearTimeout(timer); });
  }

  const job = typeof window !== "undefined" && window.FlitFancyPublicRefresh && window.FlitFancyPublicRefresh.register({
    id: "reflections", label: "随笔", page: "journal", interval: 30000, run: load,
  });
  document.addEventListener("flitfancy:reflection-saved", function () {
    return job ? job.refresh({ rerun: true }) : load();
  });
  if (!job) void load();
})();
