/* 控制台 FIREFLY VOICE 模块：本机状态、双麦录音、STT 与文件播放。 */
(function (global) {
  "use strict";

  const ALLOWED_EXTENSIONS = ["ncm", "flac", "mp3", "wav", "aac", "m4a", "ogg", "opus"];
  const MAX_FILE_BYTES = 500 * 1024 * 1024;
  const MIC_STEPS = ["left", "both", "right"];
  const MIC_LABELS = ["左麦", "双麦", "右麦"];
  const GAIN_STEPS = [1, 2, 4, 8];

  function spectrumFrame(snapshot, elapsed) {
    if (!snapshot || !snapshot.active || !Array.isArray(snapshot.frames) ||
        snapshot.step_ms !== 50 || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 800) return null;
    const frame = snapshot.frames[Math.floor(elapsed / 50)];
    if (!Array.isArray(frame) || frame.length !== 16) return null;
    return frame.map(function (value) {
      return Number.isFinite(value) ? Math.max(0, Math.min(1, value / 100)) : 0;
    });
  }

  function levelPercent(db) {
    const value = Number(db);
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, value + 100));
  }

  function displayError(value) {
    const lines = String(value || "").trim().split(/\r?\n/).filter(Boolean);
    return (lines[lines.length - 1] || "").replace(/^\w+(Error|Exception):\s*/, "").slice(0, 240);
  }

  function transportText(state) {
    if (!state || !state.playing) return "";
    const rate = Number(state.play_rate) || 48000;
    const buffered = Math.max(0, Number(state.buffered_frames) || 0) / rate;
    return " · 缓冲 " + buffered.toFixed(1) + " 秒 · 重传 " +
      (Number(state.retry_count) || 0) + " · 重缓存 " + (Number(state.rebuffer_events) || 0);
  }

  function currentLyric(lyrics, position) {
    if (!Array.isArray(lyrics) || !lyrics.length) return "";
    const seconds = Math.max(0, Number(position) || 0);
    let current = "";
    for (let index = 0; index < lyrics.length; index += 1) {
      if (Number(lyrics[index].time) > seconds) break;
      current = String(lyrics[index].text || "").trim();
    }
    return current;
  }

  function vadPresentation(state) {
    const vad = state && state.vad;
    const aec = state && state.aec;
    const notes = {
      active: "正在消除播放回声 · 检测与识别使用处理后的声音",
      aligning: "正在对齐播放参考 · 开头可能仍有播放人声",
      standby: "回声消除已开启 · 等待扬声器播放",
      disabled: "回声消除已关闭 · 检测与识别使用原始收音",
      "waiting-reference": "播放参考暂时中断 · 回声消除效果暂不可保证",
      error: "回声消除异常 · 已回退原始收音",
      waiting: "回声消除：等待麦克风音频",
      loading: "回声消除正在准备…",
    };
    const note = aec ? (notes[aec.status] || "正在读取回声消除状态…") : vad && vad.playback_overlap
      ? "扬声器正在播放：检测结果可能包含播放人声，回声消除尚未启用。"
      : "观察模式：只显示检测结果，连续收音；尚未启用回声消除。";
    if (!state || !state.board_connected) return { status: "语音检测：等待板子连接", metrics: "", note: note };
    if (!vad) return { status: "语音检测：请更新并重启本机音频服务", metrics: "", note: note };
    if (vad.status === "error") return { status: "语音检测暂不可用", metrics: displayError(vad.error), note: note };
    if (vad.status !== "ready") return { status: "语音检测：等待音频", metrics: "", note: note };
    const percent = function (value) { return Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100); };
    return {
      status: vad.speech ? "检测到语音" : "未检测到语音",
      metrics: "语音概率 · 左麦 " + percent(vad.left_probability) + "% · 右麦 " + percent(vad.right_probability) +
        "% · 已检测 " + (Number(vad.segments) || 0) + " 段",
      detail: "检测耗时 " + (Number(vad.processing_ms_per_32ms) || 0).toFixed(2) + " ms / 32 ms 双麦音频",
      note: note,
    };
  }

  function wakePresentation(state) {
    const wake = state && state.wakeword;
    if (!wake) return "语音唤醒：请更新本机音频服务";
    const keyword = String(wake.keyword || "小萤小萤");
    const turn = state.voice_turn;
    if (wake.status === "error") return "语音唤醒暂不可用：" + displayError(wake.error);
    if (state.recording && turn) {
      if (turn.phase === "cue") return "已唤醒 · 提示音后请说指令";
      if (turn.phase === "waiting-speech") return "我在听，请说指令 · 等待 " + (Number(turn.wait_remaining) || 0) + " 秒";
      return "正在听取指令 · 说完稍停，自动提交识别";
    }
    if (state.recording) return "正在语音识别 · 可点击停止或双击板上按键结束";
    if (!wake.enabled) return "语音唤醒已关闭 · 仍可手动开始识别";
    if (!state.board_connected) return "语音唤醒：等待板子连接";
    if (state.model !== "ready") return "语音唤醒：正在准备识别服务";
    const labels = {
      loading: "正在加载本地唤醒模型…",
      "waiting-audio": "语音唤醒：等待麦克风音频",
      cooldown: "稍候即可再次唤醒…",
      detected: "已听到“" + keyword + "” · 正在开始语音识别",
      armed: "等待“" + keyword + "” · 唤醒后稍停一下再说指令",
    };
    if (turn && turn.phase === "processing") return "正在识别刚才的指令…";
    const last = turn ? {
      complete: "指令已识别 · ", timeout: "未听到指令，已退出 · ",
      unrecognized: "没有识别出清楚的指令 · ", error: "本次识别失败 · ",
    }[turn.phase] || "" : "";
    return last + (labels[wake.status] || "正在读取语音唤醒状态…");
  }

  function create(options) {
    const opts = options || {};
    const query = opts.query || function (selector) { return document.querySelector(selector); };
    const request = opts.request;
    const isServerOnline = opts.isServerOnline || function () { return false; };
    const isAdmin = opts.isAdmin || function () { return false; };
    const history = global.FlitFancyAudioHistory ? global.FlitFancyAudioHistory.create({
      query: query, request: request, isServerOnline: function () { return isServerOnline() && isAdmin(); },
    }) : null;
    const elements = {
      panel: query('[data-role="audio-panel"]'),
      spectrum: query('[data-role="audio-spectrum"]'),
      mic: query('[data-role="audio-mic"]'),
      gain: query('[data-role="audio-gain"]'),
      micText: query('[data-role="audio-mic-text"]'),
      gainText: query('[data-role="audio-gain-text"]'),
      recognitionToggle: query('[data-role="audio-recognition-toggle"]'),
      aecToggle: query('[data-role="audio-aec-toggle"]'),
      wakeToggle: query('[data-role="audio-wake-toggle"]'),
      rawRecording: query('[data-role="audio-raw-recording"]'),
      leftTrack: query('[data-role="audio-level-left"]'),
      rightTrack: query('[data-role="audio-level-right"]'),
      leftDb: query('[data-role="audio-db-left"]'),
      rightDb: query('[data-role="audio-db-right"]'),
      leftProbability: query('[data-role="audio-probability-left"]'),
      rightProbability: query('[data-role="audio-probability-right"]'),
      leftProbabilityValue: query('[data-role="audio-probability-value-left"]'),
      rightProbabilityValue: query('[data-role="audio-probability-value-right"]'),
      stats: query('[data-role="audio-stats"]'),
      vadState: query('[data-role="audio-vad-state"]'),
      vadMetrics: query('[data-role="audio-vad-metrics"]'),
      modelStatus: query('[data-role="audio-model-status"]'),
      transcript: query('[data-role="audio-transcript"]'),
      recording: query('[data-role="audio-recording"]'),
      file: query('[data-role="audio-file"]'),
      drop: query('[data-role="audio-drop"]'),
      source: query('[data-role="audio-source"]'),
      volume: query('[data-role="audio-volume"]'),
      volumeText: query('[data-role="audio-volume-text"]'),
      progress: query('[data-role="audio-progress"]'),
      lyrics: query('[data-role="audio-lyrics"]'),
      playStatus: query('[data-role="audio-play-status"]'),
      playName: query('[data-role="audio-play-name"]'),
      playPercent: query('[data-role="audio-play-percent"]'),
      playFormat: query('[data-role="audio-play-format"]'),
      playTransport: query('[data-role="audio-play-transport"]'),
      playPanel: query('[data-role="audio-play-panel"]'),
      playPause: query('[data-role="audio-play-pause"]'),
      playStop: query('[data-role="audio-play-stop"]'),
      playRetry: query('[data-role="audio-play-retry"]'),
      wifiStatus: query('[data-role="audio-wifi-status"]'),
      deviceReboot: query('[data-role="audio-device-reboot"]'),
      otaToggle: query('[data-role="audio-ota-toggle"]'),
      otaPanel: query('[data-role="audio-ota-panel"]'),
      otaFile: query('[data-role="audio-ota-file"]'),
      otaSelect: query('[data-role="audio-ota-select"]'),
      otaStart: query('[data-role="audio-ota-start"]'),
      otaName: query('[data-role="audio-ota-name"]'),
      otaStatus: query('[data-role="audio-ota-status"]'),
      otaVersion: query('[data-role="audio-ota-version"]'),
      error: query('[data-role="audio-error"]'),
    };
    let timer = null;
    let privacyRevision = 0, recordingRevision = 0, recordingUrl = null;
    const mediaUrls = new Set();
    let firmwareFile = null;
    let firmwareUploading = false;
    let firmwareError = "";
    let lastState = null;
    let volumeTimer = null;
    let uploading = false;
    let uploadPercent = 0;
    let uploadError = "";
    let uploadName = "";
    let lastRecording = "";
    let stopped = false;
    let nextPollMs = 2500;
    let recognitionActive = false;
    let recognitionPending = false;
    let aecEnabled = true;
    let aecPending = false;
    let wakeEnabled = true;
    let wakePending = false;
    let spectrumTimer = null;
    const spectrumBars = [];

    function showSpectrum(snapshot) {
      clearTimeout(spectrumTimer);
      const received = performance.now();
      function tick() {
        const frame = document.hidden || stopped ? null : spectrumFrame(snapshot, performance.now() - received);
        elements.spectrum.dataset.active = String(Boolean(frame));
        spectrumBars.forEach(function (bar, index) {
          bar.style.transform = 'scaleY(' + Math.max(0.04, frame ? frame[index] : 0) + ')';
        });
        if (frame) spectrumTimer = setTimeout(tick, 50);
      }
      tick();
    }

    function allControls() {
      return [elements.mic, elements.gain, elements.recognitionToggle, elements.aecToggle, elements.wakeToggle,
        elements.file, elements.drop, elements.volume, elements.playPause, elements.playStop,
        elements.deviceReboot, elements.playRetry, elements.otaSelect, elements.otaStart];
    }

    function setDisabled(disabled) {
      allControls().forEach(function (element) {
        if (!element) return;
        if (element === elements.drop) {
          element.classList.toggle("disabled", disabled);
          element.setAttribute("aria-disabled", disabled ? "true" : "false");
          element.tabIndex = disabled ? -1 : 0;
        } else {
          element.disabled = disabled;
        }
      });
    }

    function setError(message) {
      const text = displayError(message);
      elements.error.textContent = text;
      elements.error.hidden = !text;
    }

    function renderUnavailable(message) {
      showPlaybackPanel(false);
      showSpectrum(null);
      if (opts.onState) opts.onState(null);
      elements.modelStatus.textContent = "SenseVoice 未连接";
      elements.modelStatus.dataset.state = "offline";
      if (elements.vadState) elements.vadState.textContent = "语音检测：等待音频服务";
      if (elements.vadMetrics) elements.vadMetrics.textContent = "等待语音检测";
      setProbability(elements.leftProbability, elements.leftProbabilityValue, null);
      setProbability(elements.rightProbability, elements.rightProbabilityValue, null);
      elements.vadMetrics.classList.remove("active");
      elements.stats.hidden = true;
      elements.stats.textContent = "";
      elements.wifiStatus.textContent = "WiFi未连接";
      elements.wifiStatus.title = message || "本机音频服务未连接";
      setDisabled(true);
    }

    function setProbability(track, text, value) {
      const ready = value != null && Number.isFinite(Number(value));
      const percent = ready ? Math.round(Math.max(0, Math.min(1, Number(value))) * 100) : 0;
      track.style.width = percent + "%";
      const label = ready ? percent + "%" : "等待检测";
      text.textContent = ready ? label : "—";
      track.parentNode.setAttribute("aria-valuetext", label);
      if (ready) track.parentNode.setAttribute("aria-valuenow", String(percent));
      else track.parentNode.removeAttribute("aria-valuenow");
    }

    function setMeter(track, text, value) {
      const numeric = Number(value);
      const db = Number.isFinite(numeric) ? Math.max(-100, Math.min(0, numeric)) : -100;
      track.style.width = levelPercent(db) + "%";
      track.parentNode.setAttribute("aria-valuenow", String(db));
      text.textContent = (db <= -100 ? "−100" : db.toFixed(1)) + " dBFS";
    }

    function render(state) {
      if (!isAdmin()) { clearPrivate(); return; }
      lastState = state;
      if (opts.onState) opts.onState(state);
      if (!state || !state.available) {
        nextPollMs = 4000;
        renderUnavailable(state && state.error);
        return;
      }
      const connected = Boolean(state.board_connected);
      const ready = state.model === "ready";
      elements.modelStatus.textContent = "SenseVoice " + ({ ready: "就绪", loading: "加载中", error: "异常" }[state.model] || "未就绪");
      elements.modelStatus.dataset.state = state.model || "offline";
      const playing = Boolean(state.playing);
      const recording = Boolean(state.recording);
      const failed = !playing && !uploading && Boolean(uploadError || state.play_error);
      showPlaybackPanel(playing || uploading || failed);
      showSpectrum(playing && !state.play_paused && connected ? state.playback_spectrum : null);
      const busy = playing || recording || uploading;
      nextPollMs = busy || (connected && state.vad && state.vad.status === "ready") ? 600 : 2500;
      elements.mic.disabled = !connected || recording;
      elements.gain.disabled = !connected || recording;
      recognitionActive = recording;
      elements.recognitionToggle.disabled = recognitionPending || (!recording && (!connected || !ready || uploading));
      elements.recognitionToggle.textContent = recording ? "停止语音识别" : "开始语音识别";
      elements.recognitionToggle.setAttribute("aria-pressed", String(recording));
      aecEnabled = Boolean(state.aec && state.aec.enabled);
      elements.aecToggle.disabled = !connected || !state.aec || aecPending;
      elements.aecToggle.textContent = state.aec ? "回声消除：" + (aecEnabled ? "开" : "关") : "回声消除：服务待更新";
      elements.aecToggle.setAttribute("aria-pressed", String(aecEnabled));
      wakeEnabled = Boolean(state.wakeword && state.wakeword.enabled);
      elements.wakeToggle.disabled = !state.wakeword || wakePending;
      elements.wakeToggle.textContent = "语音唤醒：" + (wakeEnabled ? "开" : "关");
      elements.wakeToggle.setAttribute("aria-pressed", String(wakeEnabled));
      elements.file.disabled = !connected || playing || uploading;
      elements.drop.classList.toggle("disabled", !connected || playing || uploading);
      elements.drop.setAttribute("aria-disabled", (!connected || playing || uploading) ? "true" : "false");
      elements.drop.tabIndex = (!connected || playing || uploading) ? -1 : 0;
      elements.volume.disabled = !connected;
      elements.playPause.disabled = !playing || !state.metadata;
      elements.playStop.disabled = !playing;
      elements.playPause.hidden = failed;
      elements.playStop.hidden = failed;
      elements.playRetry.hidden = !failed;
      elements.playRetry.disabled = !connected;
      elements.deviceReboot.disabled = !connected;
      elements.playPause.textContent = state.play_paused ? "继续播放" : "暂停播放";
      elements.wifiStatus.textContent = connected && state.wifi_connected && state.wifi_ip
        ? state.wifi_ip + (state.wifi_rssi != null && Number.isFinite(Number(state.wifi_rssi))
          ? " · " + Math.round(Number(state.wifi_rssi)) + " dBm" : "") : "WiFi未连接";
      elements.wifiStatus.title = "";

      if (document.activeElement !== elements.mic) {
        const index = MIC_STEPS.indexOf(state.mic_mode);
        elements.mic.value = String(index < 0 ? 1 : index);
      }
      if (document.activeElement !== elements.gain) {
        const index = GAIN_STEPS.indexOf(Number(state.gain));
        elements.gain.value = String(index < 0 ? 2 : index);
      }
      updateInputLabels();
      if (document.activeElement !== elements.volume) {
        elements.volume.value = String(Number(state.play_volume) || 0);
        elements.volumeText.textContent = elements.volume.value + "%";
      }
      setMeter(elements.leftTrack, elements.leftDb, state.rms_db_left);
      setMeter(elements.rightTrack, elements.rightDb, state.rms_db_right);
      const vad = vadPresentation(state);
      const vadReady = connected && state.vad && state.vad.status === "ready";
      setProbability(elements.leftProbability, elements.leftProbabilityValue, vadReady ? state.vad.left_probability : null);
      setProbability(elements.rightProbability, elements.rightProbabilityValue, vadReady ? state.vad.right_probability : null);
      if (elements.vadState) elements.vadState.textContent = vad.status;
      if (elements.vadMetrics) {
        elements.vadMetrics.textContent = vadReady ? "已检测 " + (Number(state.vad.segments) || 0) + " 段" : "等待语音检测";
        elements.vadMetrics.title = vad.detail || "";
      }
      elements.stats.hidden = !recording;
      elements.stats.textContent = recording ? "正在识别 · 已录音 " + (Number(state.seconds) || 0) + " 秒" : "";
      elements.stats.title = recording ? "音频包 " + (Number(state.frames) || 0) +
        " · CRC " + (Number(state.crc_errors) || 0) + " · 跳包 " + (Number(state.gaps) || 0) +
        " · 溢出 " + (Number(state.overruns) || 0) : "";

      const texts = Array.isArray(state.texts) ? state.texts : [];
      elements.transcript.textContent = texts.map(function (item) {
        const source = item.source === "left" ? "左麦" : item.source === "right" ? "右麦" : "双麦";
        return "[" + source + "] " + String(item.text || "").trim();
      }).filter(function (line) { return line.trim(); }).join("\n") || "等待语音";

      if (state.wav && state.wav !== lastRecording) {
        lastRecording = state.wav;
        loadRecording(state.wav);
      }
      elements.rawRecording.hidden = !state.wav_raw;
      if (state.wav_raw) elements.rawRecording.href = '#';

      const receiving = state.upload_active || (failed && state.play_error && !state.metadata);
      const progress = uploading ? uploadPercent : receiving
        ? Math.min(100, 100 * (Number(state.upload_received) || 0) / (Number(state.upload_total) || 1))
        : Math.max(0, Math.min(100, Number(state.play_progress) || 0));
      elements.progress.style.width = progress + "%";
      const lyric = currentLyric(state.lyrics, state.play_position);
      elements.lyrics.textContent = lyric || (state.lyrics_source
        ? "前奏 / 间奏"
        : "未找到同名 LRC 歌词");
      elements.lyrics.classList.toggle("active", Boolean(lyric));
      elements.vadMetrics.classList.toggle("active", Boolean(lyric));
      if (!uploading) {
        elements.playName.textContent = (uploadError ? uploadName : state.play_name) || "音频播放";
        elements.playStatus.textContent = failed ? "未能开始播放" : state.play_status || "等待拖入音频";
        elements.playPercent.textContent = failed && !receiving ? "失败" : progress.toFixed(1) + "%";
        elements.playFormat.textContent = state.metadata
          ? "实际输出 · " + (Number(state.metadata.decoded_rate) / 1000) + " kHz / 16-bit / 单声道" : "";
        elements.playFormat.hidden = !state.metadata;
        elements.playTransport.textContent = receiving
          ? "已接收 " + ((Number(state.upload_received) || 0) / 1048576).toFixed(1) +
            " / " + ((Number(state.upload_total) || 0) / 1048576).toFixed(1) + " MB"
          : state.metadata ? transportText(state).replace(/^ · /, "") : "";
        elements.playTransport.hidden = !elements.playTransport.textContent;
      }
      setError(uploadError || state.error || state.play_error || "");
      renderFirmware(state);
    }

    function renderFirmware(state) {
      if (!elements.otaStatus) return;
      const ota = state.ota || {};
      const info = ota.firmware;
      const busy = Boolean(ota.busy || firmwareUploading);
      const percent = Math.min(100, 100 * (Number(ota.received) || 0) / (Number(ota.total) || 1));
      const phases = { uploading: "接收固件", queued: "准备升级", writing: "写入固件",
        rebooting: "等待板子重启", verifying: "验证 Wi-Fi 与音频", complete: "升级完成", error: "升级未完成" };
      const current = info ? "当前 v" + info.version : "当前固件不支持 OTA 或板子未连接";
      if (elements.otaVersion) elements.otaVersion.textContent = info ? current : "版本未获取";
      elements.otaStatus.textContent = firmwareError || ota.error ||
        (firmwareUploading ? "正在上传固件…" : phases[ota.phase]
          ? phases[ota.phase] + (ota.phase === "writing" || ota.phase === "uploading" ? " · " + percent.toFixed(1) + "%" : "")
          : !state.board_connected ? "请先连接板子" : !info ? current
            : info.pending_verify ? "等待当前固件启动验证" : state.playing || state.recording ? "请先停止播放和语音识别"
            : firmwareFile ? "固件已就绪，可以开始升级" : "选择固件后即可升级");
      if (busy) { setDisabled(true); nextPollMs = 600; }
      elements.otaSelect.disabled = busy;
      elements.otaStart.disabled = busy || !firmwareFile || !state.board_connected || !info ||
        info.pending_verify || state.playing || state.recording;
    }

    async function uploadFirmware() {
      if (!isAdmin()) { clearPrivate(); return; }
      if (!firmwareFile || firmwareUploading || elements.otaStart.disabled) return;
      const epoch = privacyRevision;
      firmwareUploading = true; firmwareError = "";
      if (lastState) renderFirmware(lastState);
      try {
        await defaultUpload(firmwareFile, function () {}, "/api/audio/firmware");
        if (epoch !== privacyRevision) return;
        firmwareFile = null; elements.otaFile.value = "";
        elements.otaName.textContent = "固件已提交，正在等待板子验证";
      } catch (error) { if (epoch === privacyRevision) firmwareError = error.message; }
      finally { if (epoch === privacyRevision) { firmwareUploading = false; await refresh(); } }
    }

    async function control(action, value) {
      if (!isAdmin()) { clearPrivate(); return; }
      const epoch = privacyRevision;
      setError("");
      try {
        await request("/api/audio/control", {
          method: "POST",
          body: JSON.stringify({ action: action, value: value }),
        });
        if (epoch === privacyRevision) await refresh();
      } catch (error) {
        if (epoch === privacyRevision) setError(error.message);
      }
    }

    function defaultUpload(file, onProgress, target) {
      return new Promise(function (resolve, reject) {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", target || "/api/audio/play-file?filename=" + encodeURIComponent(file.name));
        xhr.timeout = 600000;
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        const token = global.FlitFancyAdmin.token();
        if (token) xhr.setRequestHeader("Authorization", "Bearer " + token);
        xhr.upload.onprogress = function (event) {
          if (event.lengthComputable) onProgress(100 * event.loaded / event.total);
        };
        xhr.onload = function () {
          let data = {};
          try { data = JSON.parse(xhr.responseText || "{}"); } catch (error) { /* ignore */ }
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data.error || ("HTTP " + xhr.status)));
        };
        xhr.onerror = function () { reject(new Error("文件上传连接中断")); };
        xhr.ontimeout = function () { reject(new Error("文件上传超时")); };
        xhr.send(file);
      });
    }

    function showPlaybackPanel(active) {
      elements.drop.hidden = active;
      elements.playPanel.hidden = !active;
    }

    async function playFile(file) {
      if (!isAdmin()) { clearPrivate(); return; }
      if (!file || uploading) return;
      const extension = String(file.name || "").split(".").pop().toLowerCase();
      if (ALLOWED_EXTENSIONS.indexOf(extension) === -1) {
        setError("不支持的音频格式");
        return;
      }
      if (!file.size || file.size > MAX_FILE_BYTES) {
        setError("音频文件必须小于 500 MB");
        return;
      }
      uploading = true;
      const epoch = privacyRevision;
      uploadError = "";
      uploadName = file.name;
      setError("");
      uploadPercent = 0;
      showPlaybackPanel(true);
      elements.playPause.disabled = true;
      elements.playStop.disabled = true;
      elements.playPause.hidden = false;
      elements.playStop.hidden = false;
      elements.playRetry.hidden = true;
      elements.playName.textContent = file.name;
      elements.playStatus.textContent = "正在传给本机音频服务";
      elements.playPercent.textContent = "0%";
      elements.playFormat.hidden = true;
      elements.playTransport.hidden = true;
      try {
        const uploader = opts.upload || defaultUpload;
        await uploader(file, function (percent) {
          if (epoch !== privacyRevision || !isAdmin()) return;
          uploadPercent = Math.max(0, Math.min(100, percent));
          elements.playPercent.textContent = uploadPercent.toFixed(1) + "%";
          elements.progress.style.width = uploadPercent + "%";
          elements.playStatus.textContent = uploadPercent >= 100
            ? "上传完成，等待本机接收" : "正在上传文件";
        });
      } catch (error) {
        if (epoch !== privacyRevision) return;
        uploadError = error.message;
        setError(error.message);
        elements.playStatus.textContent = "播放未开始";
      } finally {
        if (epoch === privacyRevision) {
          uploading = false;
          elements.file.value = "";
          await refresh();
        }
      }
    }

    async function refresh() {
      if (stopped || !isServerOnline()) return;
      if (!isAdmin()) { clearPrivate(); return; }
      const current = privacyRevision;
      try {
        const state = await request("/api/audio/status");
        if (current !== privacyRevision || !isAdmin()) return;
        render(state);
      } catch (error) {
        if (current !== privacyRevision) return;
        if (error.status === 401) { clearPrivate(); if (opts.onLoginRequired) opts.onLoginRequired(); return; }
        renderUnavailable("本机音频服务未连接");
      }
    }

    function revokeMedia(url) {
      if (!url || !mediaUrls.delete(url)) return;
      global.URL.revokeObjectURL(url);
    }

    async function recordingBlob(name) {
      const current = privacyRevision;
      if (!isAdmin() || !opts.fetchRaw) return null;
      const response = await opts.fetchRaw('/api/audio/recording?name=' + encodeURIComponent(name));
      if (!response.ok) { const error = new Error('录音读取失败，请检查登录和音频服务'); error.status = response.status; throw error; }
      const blob = await response.blob();
      if (stopped || current !== privacyRevision || !isAdmin()) return null;
      const url = global.URL.createObjectURL(blob);
      mediaUrls.add(url);
      return url;
    }

    async function loadRecording(name) {
      const current = ++recordingRevision;
      const epoch = privacyRevision;
      try {
        const url = await recordingBlob(name);
        if (!url) return;
        if (current !== recordingRevision || !isAdmin()) { revokeMedia(url); return; }
        revokeMedia(recordingUrl); recordingUrl = url;
        elements.recording.src = url;
        elements.recording.hidden = false;
      } catch (error) {
        if (epoch !== privacyRevision || current !== recordingRevision) return;
        lastRecording = '';
        setError(error.message);
        if (error.status === 401) { clearPrivate(); if (opts.onLoginRequired) opts.onLoginRequired(); }
      }
    }

    function clearPrivate() {
      privacyRevision++; recordingRevision++; lastState = null; lastRecording = '';
      firmwareFile = null; uploadName = ''; uploadError = ''; firmwareError = '';
      uploading = false; firmwareUploading = false;
      clearTimeout(volumeTimer);
      if (history && history.clearPrivate) history.clearPrivate();
      if (elements.recording.pause) elements.recording.pause();
      elements.recording.removeAttribute('src'); elements.recording.hidden = true;
      if (elements.recording.load) elements.recording.load();
      elements.rawRecording.removeAttribute('href'); elements.rawRecording.hidden = true;
      mediaUrls.forEach(revokeMedia); recordingUrl = null;
      for (const name of ['transcript', 'lyrics', 'playName', 'playFormat', 'playTransport', 'otaName', 'error']) elements[name].textContent = '';
      elements.file.value = ''; elements.otaFile.value = '';
      renderUnavailable('请先登录后使用音频和对话');
      elements.modelStatus.textContent = '请先登录';
      elements.wifiStatus.textContent = '登录后连接音频服务';
    }

    function schedule() {
      if (stopped || !isServerOnline()) return;
      refresh().finally(function () {
        timer = setTimeout(schedule, nextPollMs);
      });
    }

    function updateInputLabels() {
      const mic = MIC_LABELS[Number(elements.mic.value)];
      const gain = GAIN_STEPS[Number(elements.gain.value)];
      elements.micText.textContent = mic;
      elements.gainText.textContent = gain + "×";
      elements.mic.setAttribute("aria-valuetext", mic);
      elements.gain.setAttribute("aria-valuetext", gain + "倍");
    }

    function bind() {
      elements.rawRecording.addEventListener('click', async function (event) {
        event.preventDefault();
        if (!isAdmin() || !lastState || !lastState.wav_raw) return;
        const name = lastState.wav_raw, epoch = privacyRevision;
        try {
          const url = await recordingBlob(name);
          if (!url) return;
          if (epoch !== privacyRevision || !isAdmin()) { revokeMedia(url); return; }
          const link = document.createElement('a'); link.href = url; link.download = name; link.click();
          setTimeout(function () { revokeMedia(url); }, 30000);
        } catch (error) { if (epoch === privacyRevision) setError(error.message); }
      });
      elements.mic.addEventListener("input", updateInputLabels);
      elements.gain.addEventListener("input", updateInputLabels);
      elements.mic.addEventListener("change", function () { control("mic", MIC_STEPS[Number(elements.mic.value)]); });
      elements.gain.addEventListener("change", function () { control("gain", GAIN_STEPS[Number(elements.gain.value)]); });
      elements.recognitionToggle.addEventListener("click", async function () {
        if (recognitionPending) return;
        recognitionPending = true;
        elements.recognitionToggle.disabled = true;
        try {
          await control(recognitionActive ? "record-stop" : "record-start", recognitionActive ? undefined : 600);
        } finally {
          recognitionPending = false;
          await refresh();
        }
      });
      elements.aecToggle.addEventListener("click", async function () {
        if (aecPending) return;
        aecPending = true; elements.aecToggle.disabled = true;
        try { await control("aec", !aecEnabled); }
        finally { aecPending = false; await refresh(); }
      });
      elements.wakeToggle.addEventListener("click", async function () {
        if (wakePending) return;
        wakePending = true; elements.wakeToggle.disabled = true;
        try { await control("wakeword", !wakeEnabled); }
        finally { wakePending = false; await refresh(); }
      });
      elements.playPause.addEventListener("click", function () {
        control(elements.playPause.textContent === "继续播放" ? "play-resume" : "play-pause");
      });
      elements.playStop.addEventListener("click", function () { control("play-stop"); });
      elements.playRetry.addEventListener("click", function () { elements.file.click(); });
      elements.deviceReboot.addEventListener("click", function () { control("device-reboot"); });
      if (elements.otaToggle) {
        elements.otaToggle.addEventListener("click", function () {
          elements.otaPanel.hidden = !elements.otaPanel.hidden;
          elements.otaToggle.setAttribute("aria-expanded", String(!elements.otaPanel.hidden));
        });
        elements.otaSelect.addEventListener("click", function () { elements.otaFile.click(); });
        elements.otaFile.addEventListener("change", function () {
          const file = elements.otaFile.files[0]; firmwareError = "";
          firmwareFile = file && /\.bin$/i.test(file.name) && file.size >= 288 && file.size <= 0x640000 ? file : null;
          if (file && !firmwareFile) firmwareError = "请选择不超过 6.25 MiB 的应用固件 .bin";
          elements.otaName.textContent = firmwareFile ? file.name + " · " + (file.size / 1048576).toFixed(2) + " MiB" : "选择 FIREFLY VOICE 应用固件";
          if (lastState) renderFirmware(lastState);
        });
        elements.otaStart.addEventListener("click", uploadFirmware);
      }
      elements.volume.addEventListener("input", function () {
        elements.volumeText.textContent = elements.volume.value + "%";
        clearTimeout(volumeTimer);
        volumeTimer = setTimeout(function () { control("volume", Number(elements.volume.value)); }, 80);
      });
      elements.drop.addEventListener("click", function () {
        if (!elements.drop.classList.contains("disabled")) elements.file.click();
      });
      elements.drop.addEventListener("keydown", function (event) {
        if ((event.key === "Enter" || event.key === " ") &&
            !elements.drop.classList.contains("disabled")) {
          event.preventDefault();
          elements.file.click();
        }
      });
      ["dragenter", "dragover"].forEach(function (name) {
        elements.source.addEventListener(name, function (event) {
          event.preventDefault();
          if (!elements.file.disabled) elements.source.classList.add("active");
        });
      });
      ["dragleave", "drop"].forEach(function (name) {
        elements.source.addEventListener(name, function (event) {
          event.preventDefault();
          elements.source.classList.remove("active");
        });
      });
      elements.source.addEventListener("drop", function (event) {
        if (!elements.file.disabled && event.dataTransfer && event.dataTransfer.files) {
          return playFile(event.dataTransfer.files[0]);
        }
      });
      elements.file.addEventListener("change", function () { playFile(elements.file.files[0]); });
    }

    function start() {
      if (history) history.start();
      for (let index = 0; index < 16; index += 1) {
        const bar = document.createElement('span');
        elements.spectrum.appendChild(bar);
        spectrumBars.push(bar);
      }
      bind();
      if (!isServerOnline()) {
        renderUnavailable("请从本机控制台或登录后的控制台使用音频功能");
        return;
      }
      schedule();
    }

    function dispose() {
      stopped = true;
      clearPrivate();
      if (history) history.dispose();
      clearTimeout(timer);
      clearTimeout(volumeTimer);
      showSpectrum(null);
    }

    return { start: start, refresh: refresh, render: render, playFile: playFile, clearPrivate: clearPrivate, dispose: dispose };
  }

  global.FlitFancyConsoleAudio = {
    create: create,
    spectrumFrame: spectrumFrame,
    levelPercent: levelPercent,
    transportText: transportText,
    currentLyric: currentLyric,
    displayError: displayError,
    vadPresentation: vadPresentation,
    wakePresentation: wakePresentation,
  };
})(window);
