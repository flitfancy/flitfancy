/* 在原有模型选择中配置接口；密钥只写不读。 */
(function (global) {
  "use strict";

  const SELECT_TO_PROVIDER = {"__legacy__": "legacy", "deepseek-chat": "deepseek", "mimo-v2.5": "mimo", "__openai__": "openai", "__custom__": "custom", "__custom2__": "custom2", "__custom3__": "custom3"};
  const PROVIDER_TO_SELECT = {legacy: "__legacy__", deepseek: "deepseek-chat", mimo: "mimo-v2.5", openai: "__openai__", custom: "__custom__", custom2: "__custom2__", custom3: "__custom3__"};

  function create(options) {
    const opts = options || {};
    const query = opts.query || function (selector) { return document.querySelector(selector); };
    const select = query('[data-role="cfg-model"]');
    const state = query('[data-role="gpt-admin-state"]');
    const message = query('[data-role="gpt-admin-message"]');
    const key = query('[data-role="gpt-admin-key"]');
    const model = query('[data-role="gpt-admin-model"]');
    const modelOptions = query('[data-role="gpt-model-options"]');
    const defaultEffort = query('[data-role="gpt-default-effort"]');
    const base = query('[data-role="gpt-admin-base"]');
    const access = query('[data-role="gpt-admin-access"]');
    const daily = query('[data-role="gpt-admin-daily"]');
    const saveButton = query('[data-role="cfg-save"]');
    const cfToken = query('[data-role="gpt-cloudflare-token"]');
    const cfSave = query('[data-role="gpt-cloudflare-save"]');
    const cfMessage = query('[data-role="gpt-cloudflare-message"]');
    const editButton = query('[data-role="gpt-edit"]');
    const editPanel = query('[data-role="gpt-edit-panel"]');
    const changeKey = query('[data-role="gpt-change-key"]');
    const keyWrap = query('[data-role="gpt-key-wrap"]');
    const keyStatus = query('[data-role="gpt-key-status"]');
    const modelSummary = query('[data-role="gpt-model-summary"]');
    const cfStatus = query('[data-role="gpt-cf-status"]');
    const defaultService = query('[data-role="gpt-default"]');
    const publicProvider = query('[data-role="gpt-public-provider"]');
    const cfSummary = query('[data-role="gpt-cloudflare-summary"]');
    const usageRefresh = query('[data-role="gpt-usage-refresh"]');
    const usageStatus = query('[data-role="gpt-usage-status"]');
    const usageSummary = query('[data-role="gpt-usage-summary"]');
    const publicBase = opts.publicBase || "https://api.flitfancy.com";
    let signedIn = false, started = false, loaded = false, saving = false, cfSaving = false, epoch = 0, revision = 0;

    function gate() {
      saveButton.disabled = !signedIn || !loaded || saving;
      const fieldsDisabled = !signedIn || !loaded || saving;
      key.disabled = fieldsDisabled || select.value === "__legacy__";
      model.disabled = fieldsDisabled; modelOptions.disabled = fieldsDisabled; defaultEffort.disabled = fieldsDisabled; base.disabled = key.disabled; access.disabled = fieldsDisabled; daily.disabled = fieldsDisabled;
      select.disabled = !signedIn || saving;
      editButton.disabled = !signedIn || !loaded || saving;
      changeKey.disabled = fieldsDisabled || select.value === "__legacy__";
      defaultService.disabled = fieldsDisabled;
      publicProvider.disabled = fieldsDisabled;
      usageRefresh.disabled = !signedIn;
      cfToken.disabled = !signedIn || !loaded || cfSaving || saving;
      cfSave.disabled = cfToken.disabled;
    }

    function describe(data) {
      const configured = data.configured ? "接口已配置" : "接口尚未配置完整";
      const scope = data.access === "all" ? "所有访客" : data.access === "off" ? "已关闭" : "仅管理员";
      state.textContent = (data.provider_label || "模型") + " · " + configured + " · " + scope;
      cfMessage.textContent = data.manager_ready ? "Cloudflare 管理授权已配置。" : "如需在网页保存新密钥，请先配置管理授权。";
      cfSummary.textContent = data.manager_ready ? "Cloudflare 管理授权 · 已配置" : "首次配置 Cloudflare 管理授权";
      cfStatus.textContent = data.manager_ready ? "已配置" : "尚未配置";
      modelSummary.textContent = "模型：" + (data.model || "未配置") + (data.provider && data.provider === data.selected_provider ? " · 默认服务" : "");
      const saved = data.key_saved === undefined ? data.configured === true : data.key_saved === true;
      keyStatus.textContent = saved ? "已保存" : "尚未保存";
      changeKey.textContent = saved ? "更换密钥" : "输入密钥";
      keyWrap.hidden = saved;
      defaultService.checked = !data.selected_provider || data.selected_provider === data.provider;
      publicProvider.checked = data.public_enabled === undefined ? defaultService.checked : data.public_enabled === true;
      if (!data.configured) { editPanel.hidden = false; editButton.textContent = "收起配置"; }
    }

    async function refresh(provider) {
      if (!signedIn) return;
      const current = epoch, currentRevision = ++revision;
      loaded = false; gate();
      try {
        const suffix = provider ? "?provider=" + encodeURIComponent(provider) : "";
        const data = await opts.request("/api/model-gateway/status" + suffix, {timeoutMs: 15000});
        if (current !== epoch || currentRevision !== revision) return;
        if (data.storage !== "cloudflare" || data.local_model_ui_version !== 2 || data.model_ui_version !== 2) {
          key.value = ""; loaded = false;
          state.textContent = "新版模型设置尚未完全启用，请更新云端组件并重启本机后端；已保存的密钥会保留。";
          gate(); return;
        }
        select.value = PROVIDER_TO_SELECT[data.provider || data.selected_provider] || "__custom__";
        model.value = data.model || ""; base.value = data.base_url || "";
        modelOptions.value = (Array.isArray(data.models) ? data.models : []).filter(function (value) { return value !== data.model; }).join(", ");
        const labels = {auto: "自动", none: "关闭思考", low: "快速", medium: "平衡", high: "深入", xhigh: "更深入", max: "最高"};
        const efforts = Array.isArray(data.efforts) && data.efforts.length ? data.efforts : ["auto"];
        defaultEffort.replaceChildren();
        efforts.forEach(function (value) { const item = document.createElement("option"); item.value = value; item.textContent = labels[value] || value; defaultEffort.appendChild(item); });
        defaultEffort.value = efforts.includes(data.default_effort) ? data.default_effort : "auto";
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
      const payload = {provider: provider, model: selectedModel, base_url: endpoint, access: access.value, public_daily_limit: limit,
        models: [selectedModel].concat(modelOptions.value.split(/[,，\n]/).map(function (value) { return value.trim(); }).filter(Boolean)), default_effort: defaultEffort.value || "auto",
        set_default: Boolean(defaultService.checked), public_enabled: Boolean(publicProvider.checked)};
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
          keyStatus.textContent = "已提交，等待云端生效"; keyWrap.hidden = true; editPanel.hidden = true; editButton.textContent = "管理配置";
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
          if (data.configured) { editPanel.hidden = true; editButton.textContent = "管理配置"; }
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
        cfStatus.textContent = "已提交，等待云端生效";
      } catch (error) {
        if (current !== epoch) return;
        cfMessage.textContent = error.message || "授权保存失败，请检查令牌权限。";
      } finally {
        if (current === epoch) { cfSaving = false; gate(); }
      }
    }

    async function refreshUsage() {
      if (!signedIn) return;
      const current = epoch;
      usageStatus.textContent = "正在读取本站用量…";
      try {
        const data = await opts.request("/api/model-gateway/usage", {timeoutMs: 15000});
        if (current !== epoch) return;
        usageSummary.replaceChildren();
        if (!data.from_ms) { usageStatus.textContent = "暂无记录，新调用会自动计入。"; return; }
        usageStatus.textContent = "本站调用统计 · 北京时间";
        [["今天", data.today], ["本月", data.month]].forEach(function (entry) {
          const row = entry[1] || {}, line = document.createElement("p");
          const count = Number(row.requests || 0), unknown = Number(row.unknown_cost || 0);
          const missing = Number(row.unknown_usage || 0);
          const estimate = Number(row.estimated_usd || 0).toFixed(4);
          const tokens = count && missing === count ? "用量未知" : "输入 " + Number(row.input_tokens || 0) + " · 输出 " + Number(row.output_tokens || 0) + (missing ? "（另 " + missing + " 次未知）" : "");
          const cost = !count ? "暂无计费记录" : unknown === count ? "费用暂无法估算" : "估算 $" + estimate + (unknown ? "（另 " + unknown + " 次无法估算）" : "");
          line.textContent = entry[0] + " " + count + " 次 · " + tokens + " · " + cost;
          usageSummary.appendChild(line);
        });
        const labels = {chat: "模型直聊", consult: "小流萤咨询", public: "访客直聊"};
        if (Array.isArray(data.breakdown) && data.breakdown.length) {
          const details = document.createElement("details"), heading = document.createElement("summary");
          heading.textContent = "本月按来源与模型"; details.appendChild(heading);
          data.breakdown.forEach(function (row) { const line = document.createElement("p"); line.className = "hint";
            const missing = Number(row.unknown_usage || 0);
            const tokens = missing === Number(row.requests) ? "用量未知" : "输入 " + row.input_tokens + " / 输出 " + row.output_tokens + (missing ? "（" + missing + " 次未知）" : "");
            line.textContent = (labels[row.purpose] || "模型调用") + " · " + (row.model || row.provider || "模型") + " · " + row.requests + " 次 · " + tokens;
            details.appendChild(line); });
          usageSummary.appendChild(details);
        }
        (Array.isArray(data.recent) ? data.recent.slice(0, 5) : []).forEach(function (row) {
          const line = document.createElement("p"); line.className = "hint";
          const when = row.at_ms ? new Date(row.at_ms).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"}) : "";
          line.textContent = when + " " + (labels[row.purpose] || "模型调用") + " · " + (row.model || row.provider || "模型") + " · " +
            (row.outcome === "complete" ? "完成" : "未完成") + " · " + (row.input_tokens == null || row.output_tokens == null ? "用量未知" : "输入 " + row.input_tokens + " / 输出 " + row.output_tokens);
          usageSummary.appendChild(line);
        });
      } catch (error) { if (current === epoch) { usageSummary.replaceChildren(); usageStatus.textContent = error.message || "用量暂时不可用。"; } }
    }

    function clearPrivate() {
      epoch++; revision++; signedIn = false; loaded = false; saving = false; cfSaving = false;
      key.value = ""; model.value = ""; modelOptions.value = ""; defaultEffort.replaceChildren(); base.value = ""; access.value = "admin"; daily.value = "20";
      cfToken.value = ""; cfMessage.textContent = "";
      keyStatus.textContent = "等待登录"; modelSummary.textContent = "模型：等待登录"; cfStatus.textContent = "等待登录"; cfSummary.textContent = "Cloudflare 管理授权";
      editPanel.hidden = true; editButton.textContent = "管理配置"; keyWrap.hidden = true; usageSummary.replaceChildren(); usageStatus.textContent = "登录后读取本站用量。";
      state.textContent = "登录后读取设置。"; message.textContent = ""; gate();
    }

    function setAuthenticated(value) {
      if (!value) { if (signedIn) clearPrivate(); return; }
      if (!signedIn) { signedIn = true; void refresh(); void refreshUsage(); }
      gate();
    }

    function start() {
      if (started) return;
      started = true;
      saveButton.addEventListener("click", save);
      editButton.addEventListener("click", function () { editPanel.hidden = !editPanel.hidden; editButton.textContent = editPanel.hidden ? "管理配置" : "收起配置"; });
      changeKey.addEventListener("click", function () { keyWrap.hidden = !keyWrap.hidden; if (keyWrap.hidden) key.value = "";
        changeKey.textContent = keyWrap.hidden ? (keyStatus.textContent === "已保存" ? "更换密钥" : "输入密钥") : "取消输入"; });
      model.addEventListener("input", function () { defaultEffort.value = "auto"; });
      usageRefresh.addEventListener("click", function () { void refreshUsage(); });
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
