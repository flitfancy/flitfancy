/* 在原有模型选择中配置接口；密钥只写不读。 */
(function (global) {
  "use strict";

  const SELECT_TO_PROVIDER = {"__legacy__": "legacy", "deepseek-chat": "deepseek", "mimo-v2.5": "mimo", "__openai__": "openai", "__custom__": "custom"};
  const PROVIDER_TO_SELECT = {legacy: "__legacy__", deepseek: "deepseek-chat", mimo: "mimo-v2.5", openai: "__openai__", custom: "__custom__"};

  function create(options) {
    const opts = options || {};
    const query = opts.query || function (selector) { return document.querySelector(selector); };
    const select = query('[data-role="cfg-model"]');
    const state = query('[data-role="gpt-admin-state"]');
    const message = query('[data-role="gpt-admin-message"]');
    const key = query('[data-role="gpt-admin-key"]');
    const model = query('[data-role="gpt-admin-model"]');
    const base = query('[data-role="gpt-admin-base"]');
    const access = query('[data-role="gpt-admin-access"]');
    const daily = query('[data-role="gpt-admin-daily"]');
    const saveButton = query('[data-role="cfg-save"]');
    const cfToken = query('[data-role="gpt-cloudflare-token"]');
    const cfSave = query('[data-role="gpt-cloudflare-save"]');
    const cfMessage = query('[data-role="gpt-cloudflare-message"]');
    const publicBase = opts.publicBase || "https://api.flitfancy.com";
    let signedIn = false, started = false, loaded = false, saving = false, cfSaving = false, epoch = 0, revision = 0;

    function gate() {
      saveButton.disabled = !signedIn || !loaded || saving;
      const fieldsDisabled = !signedIn || !loaded || saving;
      key.disabled = fieldsDisabled || select.value === "__legacy__";
      model.disabled = fieldsDisabled; base.disabled = key.disabled; access.disabled = fieldsDisabled; daily.disabled = fieldsDisabled;
      select.disabled = !signedIn || saving;
      cfToken.disabled = !signedIn || !loaded || cfSaving || saving;
      cfSave.disabled = cfToken.disabled;
    }

    function describe(data) {
      const configured = data.configured ? "接口已配置" : "接口尚未配置完整";
      const scope = data.access === "all" ? "所有访客" : data.access === "off" ? "已关闭" : "仅管理员";
      state.textContent = (data.provider_label || "模型") + " · " + configured + " · 网页直聊：" + scope + " · 密钥位于 Cloudflare";
      cfMessage.textContent = data.manager_ready ? "Cloudflare 管理授权已配置。" : "如需在网页保存新密钥，请先配置管理授权。";
    }

    async function refresh(provider) {
      if (!signedIn) return;
      const current = epoch, currentRevision = ++revision;
      loaded = false; gate();
      try {
        const suffix = provider ? "?provider=" + encodeURIComponent(provider) : "";
        const data = await opts.request("/api/model-gateway/status" + suffix, {timeoutMs: 15000});
        if (current !== epoch || currentRevision !== revision) return;
        if (data.storage !== "cloudflare") {
          key.value = ""; loaded = false;
          state.textContent = "模型网关尚未更新，请发布云端组件并重启本机后端后再保存密钥。";
          gate(); return;
        }
        select.value = PROVIDER_TO_SELECT[data.provider || data.selected_provider] || "__custom__";
        model.value = data.model || ""; base.value = data.base_url || "";
        access.value = data.access || "admin"; daily.value = String(data.public_daily_limit || 20);
        key.value = ""; loaded = true; describe(data); gate();
      } catch (error) {
        if (current !== epoch || currentRevision !== revision) return;
        loaded = false; state.textContent = error.status === 404
          ? "模型网关尚未更新，请发布云端组件并重启本机后端后再保存密钥。"
          : error.message || "暂时无法读取模型设置。"; gate();
      }
    }

    async function save() {
      if (!signedIn || !loaded || saving) return;
      const provider = SELECT_TO_PROVIDER[select.value];
      const secret = key.value.trim(), selectedModel = model.value.trim(), endpoint = base.value.trim();
      const limit = Number(daily.value);
      if (!provider || !selectedModel || !endpoint || !Number.isInteger(limit) || limit < 1 || limit > 200) {
        message.textContent = "请输入模型、接口地址和 1–200 之间的每日次数。"; return;
      }
      const payload = {provider: provider, model: selectedModel, base_url: endpoint, access: access.value, public_daily_limit: limit};
      if (secret) payload.api_key = secret;
      key.value = "";
      const current = epoch;
      saving = true; message.textContent = "正在保存…"; gate();
      try {
        const data = await opts.request("/api/model-gateway/config", {method: "POST", body: JSON.stringify(payload), timeoutMs: 45000});
        if (current !== epoch) return;
        describe(data);
        if (data.pending) {
          message.textContent = "密钥已交给 Cloudflare 保存，云端更新可能需要一点时间；请稍后刷新状态。";
        } else if (data.access === "all") {
          message.textContent = "设置已保存，正在检查公网…";
          try {
            const publicState = await opts.request(publicBase + "/gpt/status", {authMode: "none"});
            if (current !== epoch) return;
            message.textContent = publicState.enabled === true
              ? "访客对话已开放。"
              : "设置已保存，公网组件尚未就绪，请稍后再检查。";
          } catch (error) {
            if (current !== epoch) return;
            message.textContent = "设置已保存，公网组件尚未就绪，请稍后再检查。";
          }
        } else {
          message.textContent = data.configured ? "模型设置已保存。" : "设置已保存，请补全该服务的密钥。";
        }
      } catch (error) {
        if (current !== epoch) return;
        message.textContent = error.message || "保存失败，请重试。";
      } finally {
        if (current === epoch) { saving = false; gate(); }
      }
    }

    async function saveCloudflareToken() {
      if (!signedIn || !loaded || cfSaving) return;
      const token = cfToken.value.trim();
      if (!token) { cfMessage.textContent = "请输入 Cloudflare 管理令牌。"; return; }
      cfToken.value = "";
      const current = epoch;
      cfSaving = true; cfMessage.textContent = "正在保存授权…"; gate();
      try {
        await opts.request("/api/model-gateway/cloudflare-token", {method: "POST", body: JSON.stringify({token: token}), timeoutMs: 35000});
        if (current !== epoch) return;
        cfMessage.textContent = "授权已交给 Cloudflare 保存；云端更新后即可保存模型密钥。";
      } catch (error) {
        if (current !== epoch) return;
        cfMessage.textContent = error.message || "授权保存失败，请检查令牌权限。";
      } finally {
        if (current === epoch) { cfSaving = false; gate(); }
      }
    }

    function clearPrivate() {
      epoch++; revision++; signedIn = false; loaded = false; saving = false; cfSaving = false;
      key.value = ""; model.value = ""; base.value = ""; access.value = "admin"; daily.value = "20";
      cfToken.value = ""; cfMessage.textContent = "";
      state.textContent = "登录后读取设置。"; message.textContent = ""; gate();
    }

    function setAuthenticated(value) {
      if (!value) { if (signedIn) clearPrivate(); return; }
      if (!signedIn) { signedIn = true; void refresh(); }
      gate();
    }

    function start() {
      if (started) return;
      started = true;
      saveButton.addEventListener("click", save);
      cfSave.addEventListener("click", saveCloudflareToken);
      select.addEventListener("change", function () {
        key.value = ""; message.textContent = "";
        void refresh(SELECT_TO_PROVIDER[select.value]);
      });
      gate();
    }

    return {start: start, setAuthenticated: setAuthenticated, clearPrivate: clearPrivate,
      dispose: clearPrivate, refresh: refresh, save: save};
  }

  global.FlitFancyGPTSettings = {create: create};
})(window);
