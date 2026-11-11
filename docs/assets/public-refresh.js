/* Public content refreshes share one scheduler per page. */
(function (global) {
  "use strict";
  if (!global.FlitFancyRefresh) return;
  const scheduler = global.FlitFancyRefresh.create({ concurrency: 2 });
  function reconcile(runNow) {
    scheduler.reconcile({
      hidden: !!document.hidden,
      online: !global.navigator || global.navigator.onLine !== false,
      runNow: runNow === true,
    });
  }
  global.FlitFancyPublicRefresh = {
    register: function (spec) { return scheduler.register(Object.assign({ hidden: "pause" }, spec)); },
  };
  document.addEventListener("visibilitychange", function () { reconcile(); });
  global.addEventListener("online", function () { reconcile(true); });
  global.addEventListener("offline", function () { reconcile(); });
  global.addEventListener("pagehide", function (event) {
    if (event.persisted) scheduler.reconcile({ hidden: true, online: false });
    else scheduler.dispose();
  });
  global.addEventListener("pageshow", function (event) { if (event.persisted) reconcile(true); });
  reconcile();
  scheduler.start();
})(window);
