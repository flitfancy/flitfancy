/* 控制台与存在页共用启动编排；只初始化当前页面拥有的功能模块。 */
(async function () {
  "use strict";

  const PUBLIC_BASE = "https://api.flitfancy.com";
  const SENSOR_REFRESH_MS = 5000;
  const CONFIG_REFRESH_MS = 60000;
  const query = function (selector) { return document.querySelector(selector); };
  const failures = new Set();

  function reportFailure(name) {
    failures.add(name);
    query('[data-role="module-error-text"]').textContent =
      Array.from(failures).join("、") + "暂不可用，可刷新页面重试。";
    query('[data-role="module-error"]').hidden = false;
  }

  query('[data-role="module-reload"]').addEventListener("click", function () {
    window.location.reload();
  });

  // Only retry missing exports; successful scripts and running modules are never reinitialized.
  async function recoverScript(original) {
    const exportName = original.dataset.consoleModule;
    for (let attempt = 1; !window[exportName] && attempt <= 2; attempt++) {
      await new Promise(function (resolve) {
        const script = document.createElement("script");
        let timer;
        function finish() {
          clearTimeout(timer);
          script.onload = script.onerror = null;
          script.remove();
          resolve();
        }
        script.src = original.src + "&console_retry=" + attempt;
        script.onload = script.onerror = finish;
        timer = setTimeout(finish, 3000);
        document.head.appendChild(script);
      });
    }
  }

  await Promise.all(Array.from(document.querySelectorAll("script[data-console-module]")).map(recoverScript));
  if (!window.FlitFancyAdmin) {
    reportFailure("登录组件");
    return; // Never initialize private controls without the authentication core.
  }
  if (!window.FlitFancyRefresh) { reportFailure('刷新调度'); return; }
  const serverOnline = window.FlitFancyAdmin.isAdminHost();
  const pageName = query('[data-role="bridge-panel"]') ? 'console' : 'presence';
  const scheduler = window.FlitFancyRefresh.create({concurrency: 3});
  let authenticated = null, authRevision = 0, backendReady = false, statusChecked = false, loginRequired = null;

  window.FlitFancyAdmin.installErrorHandler('[data-role="js-error"]');

  function createModule(name, factory, options, dependencies) {
    try {
      if (!factory || (dependencies || []).some(function (value) { return !value; })) {
        throw new Error("Module unavailable");
      }
      return { name: name, instance: factory.create(options) };
    } catch (e) {
      reportFailure(name);
      return null;
    }
  }

  // Keep UI failures outside the network/authentication error path.
  function call(module, method, ...args) {
    if (!module || typeof module.instance[method] !== "function") return;
    try {
      const result = module.instance[method](...args);
      if (result && typeof result.catch === "function") {
        return result.catch(function () { reportFailure(module.name); });
      }
      return result;
    } catch (e) {
      reportFailure(module.name);
    }
  }

  function setStatus(ok, message) {
    query('[data-role="status"]').textContent = message || "";
    query('[data-role="dot"]').classList.toggle("offline", !ok);
  }

  async function request(url, options) {
    const epoch = authRevision;
    try { return await window.FlitFancyAdmin.request(url, options); }
    catch (error) {
      if (window.FlitFancyAdmin.isUnauthorized(error) && epoch === authRevision) {
        syncContext();
        if (!call(admin,'token')) {
          updateLoginRequired(true);
          if (serverOnline) setStatus(false,'需要登录');
        }
      }
      throw error;
    }
  }

  function updateLoginRequired(required) {
    if (loginRequired === required) return;
    loginRequired = required;
    call(admin, 'setLoginRequired', required);
  }

  function fetchPublic(url) {
    return window.FlitFancyAdmin.fetchRaw(url, {authMode:'none',cache:'no-store'});
  }

  async function sendRequest(url, body) {
    return request(url, {method:"POST", body:JSON.stringify(body || {})});
  }

  async function readPublicSensors() {
    if (!sensors) return {skipped:true};
    const epoch = authRevision;
    try {
      const response = await fetchPublic(PUBLIC_BASE + "/sensors/latest");
      if (!response.ok) throw Object.assign(new Error("public sensor request failed"), {status:response.status});
      const data = await response.json();
      if (epoch !== authRevision) return {skipped:true};
      call(sensors, "render", data.rows || []);
      return {ok:true};
    } catch (error) { return {ok:false,status:error.status}; }
  }

  const services = query('[data-role="ffs-start"]') ? createModule("服务状态", window.FlitFancyConsoleServices) : null;
  const sensors = query('[data-role="sensor-grid"]') ? createModule("环境数据", window.FlitFancyConsoleSensors, {
    query:query, request:request, publicBase:PUBLIC_BASE, overviewRefreshMs:CONFIG_REFRESH_MS, scheduler:scheduler,
    isAdminReady:function () { return serverOnline && authenticated; },
  }, [window.FlitFancySensorState, window.FlitFancyConsoleOverview]) : null;
  const authOnly = !query('[data-role="admin-panel"]');
  const admin = createModule("管理面板", window.FlitFancyConsoleAdmin, {
    query:query, authOnly:authOnly, isServerOnline:function () { return serverOnline; },
    onAuthenticated:function () { syncContext(true); },
    onSignedOut:function () {
      authenticated = false; authRevision++;
      clearPrivateViews();
      scheduler.reconcile({authenticated:false});
    },
  }, authOnly ? [] : [window.FlitFancyPanelShell, window.FlitFancyVisits]);
  const chat = query('[data-role="chat-log"]') ? createModule("对话", serverOnline ? window.FlitFancyConsoleDialogue : window.FlitFancyConsoleChat, {
    query:query, sendRequest:sendRequest, publicBase:PUBLIC_BASE, fetchPublic:fetchPublic,
    isServerOnline:function () { return serverOnline; },
    isAdmin:function () { return !!call(admin,"token"); },
    setStatus:function (text) { query('[data-role="chat-status"]').textContent = text || ""; },
  }) : null;
  const audio = query('[data-role="audio-panel"]') ? createModule("音频面板", window.FlitFancyConsoleAudio, {
    query:query, request:request, scheduler:scheduler,
    isServerOnline:function () { return serverOnline; },
    isAdmin:function () { return !!call(admin,"token"); },
    fetchRaw:function (url) { return window.FlitFancyAdmin.fetchRaw(url); },
    onLoginRequired:function () { updateLoginRequired(true); },
    onState:function (state) { call(chat,"updateState",state); },
  }) : null;
  const sensorOta = query('[data-role="sensor-ota-toggle"]') ? createModule("感知板固件", window.FlitFancySensorOta, {
    query:query, request:request, scheduler:scheduler,
    isServerOnline:function () { return serverOnline; },
    isAdmin:function () { return !!call(admin,"token"); },
    onLoginRequired:function () { updateLoginRequired(true); },
  }) : null;
  const launcher = query('[data-role="launcher-panel"]') ? createModule("本机启动", window.FlitFancyConsoleLauncher, {
    query:query, request:request, scheduler:scheduler,
    isServerOnline:function () { return serverOnline; },
    isAdmin:function () { return !!call(admin,"token"); },
  }) : null;
  const activity = query('[data-role="activity-panel"]') ? createModule("电脑使用", window.FlitFancyConsoleActivity, {
    query:query, request:request, scheduler:scheduler,
    fetchRaw:function (url) { return window.FlitFancyAdmin.fetchRaw(url); },
    isServerOnline:function () { return serverOnline; },
    isAdmin:function () { return !!call(admin,"token"); },
  }) : null;
  const bridge = query('[data-role="bridge-panel"]') ? createModule("全界之桥", window.FlitFancyConsoleBridge, {
    query:query, request:request, scheduler:scheduler,
    isServerOnline:function () { return serverOnline; },
    isAdmin:function () { return !!call(admin,"token"); },
  }, [window.FlitFancyBridgeHash, window.FlitFancyBridgeFiles]) : null;
  const heartbeats = query('[data-role="heartbeat-panel"]') ? createModule("刷新心跳", window.FlitFancyHeartbeats, {
    query:query, scheduler:scheduler, request:request,
    isAdmin:function () { return !!call(admin,"token"); },
    isServerOnline:function () { return serverOnline; },
  }) : null;

  function clearPrivateViews() {
    call(chat,"updateState",null);
    for (const module of [audio,sensorOta,activity,bridge,launcher,sensors,heartbeats]) call(module,"clearPrivate");
  }
  function syncContext(runNow) {
    const signedIn = !!call(admin,"token");
    const online = !window.navigator || window.navigator.onLine !== false;
    if (authenticated !== signedIn) {
      authenticated = signedIn; authRevision++;
      if (!signedIn) clearPrivateViews();
    }
    if (!online) { setStatus(false,'网络离线'); call(services,'update',null); }
    scheduler.reconcile({authenticated:signedIn,hidden:!!document.hidden,
      online:online,runNow:runNow === true});
    call(heartbeats,"refresh");
  }

  async function refreshStatus() {
    const epoch = authRevision;
    try {
      const status = await request("/api/status");
      if (epoch !== authRevision) return {skipped:true};
      const wasReady = backendReady;
      backendReady = true; statusChecked = true;
      setStatus(true);
      updateLoginRequired(!call(admin,"token"));
      call(chat,"setEnabled",status.dialogue_enabled !== false);
      call(services,"setProtocolName",status.protocol_name);
      call(services,"update",status.services);
      if (!wasReady && sensorJob) void sensorJob.refresh();
      return {ok:true};
    } catch (error) {
      if (epoch !== authRevision) return {skipped:true};
      const first = !statusChecked;
      backendReady = false; statusChecked = true;
      const needsLogin = window.FlitFancyAdmin.isUnauthorized(error);
      setStatus(false,needsLogin ? "需要登录" : "");
      if (needsLogin) updateLoginRequired(true);
      call(services,"update",null);
      if (first && sensorJob) void sensorJob.refresh();
      return {ok:false,status:error.status};
    }
  }
  async function refreshSensors() {
    const epoch = authRevision;
    if (!serverOnline || !backendReady) return readPublicSensors();
    try {
      const latest = await request("/api/sensors/latest");
      if (epoch !== authRevision) return {skipped:true};
      if (authenticated) {
        const privateHeartRate = await request("/api/sensors/heart-rate");
        if (epoch !== authRevision) return {skipped:true};
        latest.rows = (latest.rows || []).concat(privateHeartRate.rows || []);
      }
      (latest.rows || []).forEach(function (row) { call(sensors,"notePressure",row); });
      call(sensors,"render",latest.rows || []);
      return {ok:true};
    } catch (error) { return epoch === authRevision ? readPublicSensors() : {skipped:true}; }
  }

  scheduler.register({id:"site-status",label:"服务状态",page:pageName,interval:SENSOR_REFRESH_MS,
    priority:10,hidden:"pause",enabled:function () { return serverOnline; },
    disabledReason:function () { return "公开页面不请求本机状态"; },run:refreshStatus});
  const sensorJob = sensors ? scheduler.register({id:"sensors-latest",label:"现实感知",page:pageName,
    interval:SENSOR_REFRESH_MS,hidden:"pause",enabled:function () { return !serverOnline || statusChecked; },
    disabledReason:function () { return '等待服务状态'; },run:refreshSensors}) : null;
  if (chat && !serverOnline) scheduler.register({id:"public-config",label:"公开对话配置",page:pageName,
    interval:CONFIG_REFRESH_MS,hidden:"pause",run:function () { return chat.instance.refreshPublicConfig(); }});

  call(sensors,"render",[]);
  call(services,"update",null);
  syncContext();
  for (const module of [admin,chat,audio,sensorOta,launcher,bridge,activity,heartbeats]) call(module,"start");
  if (!serverOnline) setStatus(false,sensors ? "公开感知" : "公开访问");
  scheduler.start();
  document.addEventListener("visibilitychange",function () { syncContext(); });
  if (window.addEventListener) {
    window.addEventListener("online",function () { syncContext(true); });
    window.addEventListener("offline",function () { syncContext(); });
    window.addEventListener("pagehide",function (event) {
      if (event && event.persisted) {
        scheduler.reconcile({hidden:true,online:false});
        call(heartbeats,'clearPrivate');
        return;
      }
      scheduler.dispose();
      for (const module of [audio,sensorOta,activity,sensors,launcher,bridge,heartbeats]) call(module,"dispose");
    });
    window.addEventListener('pageshow',function (event) { if (event.persisted) syncContext(true); });
  }
})();
