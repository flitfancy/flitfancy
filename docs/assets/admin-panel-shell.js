/* 右侧管理面板外壳（旅途整理 / 控制台管理共用，单一实现）：
   - 页脚高度实测写 --footer-h：面板底边始终贴页脚上沿
   - 左缘拖拽调宽（min~max）：写回 --editor-panel-w，正文让位边距自动联动
   - 宽度记忆在 localStorage（每页独立 key，互不干扰）
   - 收起/展开：面板隐藏后右侧浮出"展开"细条；hide() 保留细条，
     clearCollapsed() 用于登出等彻底关闭场景
   用法：window.FlitFancyPanelShell.init({...})，返回 { show, hide, clearCollapsed }。 */
(function (global) {
  "use strict";

  function init(options) {
    const opts = options || {};
    const panel = opts.panel;
    const grab = opts.grab;
    const collapseBtn = opts.collapseBtn;
    const expandTab = opts.expandTab;
    const storageKey = opts.storageKey || "flitfancy.panel.panelW";
    const openClass = opts.openClass || "panel-open";
    const MIN = opts.min || 280;
    const MAX = opts.max || 640;

    function syncFooter() {
      const footer = document.querySelector("footer");
      if (footer) {
        document.documentElement.style.setProperty(
          "--footer-h", footer.getBoundingClientRect().height + "px"
        );
      }
    }
    syncFooter();
    if (global.ResizeObserver && document.querySelector("footer")) {
      new ResizeObserver(syncFooter).observe(document.querySelector("footer"));
    }

    try {
      const saved = parseInt(localStorage.getItem(storageKey) || "", 10);
      if (saved >= MIN && saved <= MAX) {
        document.documentElement.style.setProperty("--editor-panel-w", saved + "px");
      }
    } catch (e) { /* ignore */ }

    if (grab && global.PointerEvent) {
      grab.addEventListener("pointerdown", function (event) {
        event.preventDefault();
        grab.setPointerCapture(event.pointerId);
        document.body.style.userSelect = "none";
        document.body.style.cursor = "ew-resize";
        const clampWidth = function (x) {
          return Math.min(
            Math.max(global.innerWidth - x, MIN),
            Math.min(MAX, Math.floor(global.innerWidth / 2))
          );
        };
        const move = function (ev) {
          document.documentElement.style.setProperty(
            "--editor-panel-w", clampWidth(ev.clientX) + "px"
          );
        };
        const up = function (ev) {
          const width = clampWidth(ev.clientX);
          document.body.style.userSelect = "";
          document.body.style.cursor = "";
          try { localStorage.setItem(storageKey, String(width)); } catch (e) { /* ignore */ }
          grab.removeEventListener("pointermove", move);
          grab.removeEventListener("pointerup", up);
          grab.removeEventListener("pointercancel", up);
        };
        grab.addEventListener("pointermove", move);
        grab.addEventListener("pointerup", up);
        grab.addEventListener("pointercancel", up);
      });
    }

    function show() {
      panel.hidden = false;
      document.body.classList.add(openClass);
      document.body.classList.remove("panel-collapsed");
      if (expandTab) expandTab.hidden = true;
      if (opts.onExpand) opts.onExpand();
    }

    function hide() {
      panel.hidden = true;
      document.body.classList.remove(openClass);
      document.body.classList.add("panel-collapsed");
      if (expandTab) expandTab.hidden = false;
    }

    function clearCollapsed() {
      document.body.classList.remove("panel-collapsed");
      if (expandTab) expandTab.hidden = true;
    }

    if (collapseBtn) collapseBtn.addEventListener("click", hide);
    if (expandTab) expandTab.addEventListener("click", show);

    return { show: show, hide: hide, clearCollapsed: clearCollapsed };
  }

  global.FlitFancyPanelShell = { init: init };
})(window);
