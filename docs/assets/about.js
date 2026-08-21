/* 随笔随机展示：关于页与日记页底部共用。保存新随笔后立即刷新。 */
(function () {
  const line = document.querySelector('[data-role="reflection-line"]');
  const text = document.querySelector('[data-role="reflection-text"]');
  const brand = document.querySelector('[data-role="footer-brand"]');
  if (!line || !text) return;

  const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const endpoint = local
    ? "/api/reflections"
    : "https://api.flitfancy.com/config";
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
    fetch(endpoint, { headers: { "Accept": "application/json" }, signal: ctrl.signal })
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
        if (!rows.length) {
          showBrandOnly();
          return;
        }
        text.textContent = rows[Math.floor(Math.random() * rows.length)].trim();
        line.hidden = false;
        if (brand) brand.hidden = true;
      })
      .catch(showBrandOnly);
  }

  document.addEventListener("flitfancy:reflection-saved", load);
  load();
})();
