/* Permanent microphone level history, through the existing authenticated proxy. */
(function (global) {
  "use strict";

  function seriesSegments(rows, channel, step) {
    const segments = [];
    let current = [];
    let previous = null;
    rows.forEach(function (row) {
      const gap = previous && (row.time - previous.time > step * 1.5 ||
        row.first - previous.last > Math.max(2, step) ||
        String(row.gains) !== String(previous.gains));
      if (gap || row[channel] == null) {
        if (current.length) segments.push(current);
        current = [];
      }
      if (row[channel] != null) current.push(row);
      previous = row;
    });
    if (current.length) segments.push(current);
    return segments;
  }

  function create(opts) {
    const query = opts.query || function (selector) { return document.querySelector(selector); };
    const panel = query('[data-role="audio-history"]');
    if (!panel) return { start() {}, dispose() {} };
    const front = query('[data-role="audio-history-front"]');
    const flip = query('[data-role="audio-history-flip"]');
    const backButton = panel.querySelector('[data-role="audio-history-back"]');
    const canvas = panel.querySelector('canvas');
    const modeButton = panel.querySelector('[data-role="audio-history-mode"]');
    const range = panel.querySelector('select');
    const date = panel.querySelector('input');
    const note = panel.querySelector('[data-role="audio-history-note"]');
    const detail = panel.querySelector('[data-role="audio-history-detail"]');
    let mode = 0, data = null, stopped = false, timer = null, revision = 0;
    let message = '正在读取历史…';
    const modes = [['left', 'right'], ['left'], ['right']];
    const labels = ['双麦', '左麦', '右麦'];
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(draw);

    function timeLabel(ts) {
      return new Date(ts * 1000).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      });
    }

    function draw() {
      if (panel.hidden) return;
      const width = canvas.clientWidth || 440, height = canvas.clientHeight || 90;
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      canvas.width = width * dpr; canvas.height = height * dpr;
      const context = canvas.getContext('2d');
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const style = getComputedStyle(panel);
      const muted = style.getPropertyValue('--muted').trim() || '#8b94a8';
      const colors = {
        left: style.getPropertyValue('--amber-soft').trim() || '#d4bc8c',
        right: style.getPropertyValue('--cyan').trim() || '#70b8b3',
      };
      context.clearRect(0, 0, width, height);
      context.font = '11px system-ui';
      const left = 34, right = width - 10, top = 8, bottom = height - 20;
      const minDb = -80, maxDb = -20;
      const y = function (value) { return bottom - (Math.max(minDb, Math.min(maxDb, value)) - minDb) / (maxDb - minDb) * (bottom - top); };
      [-80, -60, -40, -20].forEach(function (value) {
        context.fillStyle = muted; context.fillText(String(value), 0, y(value) + 3);
        context.globalAlpha = .12; context.strokeStyle = muted;
        context.beginPath(); context.moveTo(left, y(value)); context.lineTo(right, y(value)); context.stroke();
        context.globalAlpha = 1;
      });
      if (!data || !data.rows.length) {
        context.textAlign = 'center'; context.fillStyle = muted;
        context.fillText(message, width / 2, height / 2);
        return;
      }
      const x = function (ts) { return left + (ts - data.start) / Math.max(60, data.end - data.start) * (right - left); };
      modes[mode].forEach(function (channel) {
        context.strokeStyle = colors[channel]; context.fillStyle = colors[channel]; context.lineWidth = 1.5;
        seriesSegments(data.rows, channel, data.step).forEach(function (segment) {
          context.beginPath();
          segment.forEach(function (row, index) {
            const xx = x((row.first + row.last) / 2), yy = y(row[channel]);
            if (index) context.lineTo(xx, yy); else context.moveTo(xx, yy);
          });
          context.stroke();
          if (segment.length === 1) {
            const row = segment[0];
            context.beginPath(); context.arc(x((row.first + row.last) / 2), y(row[channel]), 2, 0, Math.PI * 2); context.fill();
          }
        });
      });
      context.fillStyle = muted; context.textAlign = 'left'; context.fillText(timeLabel(data.start), left, height - 3);
      context.textAlign = 'right'; context.fillText(timeLabel(data.end), right, height - 3);
    }

    function changeMode() {
      mode = (mode + 1) % modes.length;
      modeButton.textContent = labels[mode];
      canvas.setAttribute('aria-label', labels[mode] + '历史电平，单位 dBFS');
      draw();
    }

    function showHistory() {
      flip.classList.add('show-history');
      front.inert = true;
      front.setAttribute('aria-hidden', 'true');
      front.setAttribute('aria-expanded', 'true');
      panel.hidden = false;
      backButton.focus();
      draw();
      refresh();
    }

    function showLevels() {
      panel.hidden = true;
      flip.classList.remove('show-history');
      front.inert = false;
      front.removeAttribute('aria-hidden');
      front.setAttribute('aria-expanded', 'false');
      revision += 1;
      clearTimeout(timer);
      front.focus();
    }

    function frontKey(event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); showHistory();
      }
    }

    function backClick(event) {
      if (!event.target.closest('button, select, input, a')) showLevels();
    }

    function backKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); showLevels(); }
    }

    async function refresh() {
      const current = ++revision;
      clearTimeout(timer);
      if (stopped || panel.hidden) return;
      if (!opts.isServerOnline()) {
        data = null; detail.hidden = true; message = '请登录后查看音频历史';
        note.textContent = message; draw();
      } else {
        try {
          let url = '/api/audio/history?span=' + encodeURIComponent(range.value);
          if (date.value) {
            const until = new Date(date.value + 'T00:00:00');
            until.setDate(until.getDate() + 1);
            url += '&end=' + Math.min(Date.now() / 1000, until.getTime() / 1000);
          }
          const result = await opts.request(url);
          if (stopped || current !== revision || !opts.isServerOnline()) return;
          if (!Array.isArray(result.rows)) throw new Error(result.error || '历史服务尚未就绪');
          data = result;
          note.textContent = result.error ? '历史写入异常：' + result.error : result.first_recorded
            ? '始于 ' + timeLabel(result.first_recorded) + ' · 本机长期保存'
            : '等待首条记录 · 本机长期保存';
          detail.hidden = true;
          message = result.error ? '历史写入异常，请检查音频服务' : '这个时段暂无记录';
          draw();
        } catch (error) {
          if (current === revision) {
            message = /unknown api/i.test(error.message)
              ? '网站后台需要重启以加载历史' : '暂时无法读取历史';
            note.textContent = message;
            data = null;
            draw();
          }
        }
      }
      if (!stopped && current === revision) timer = setTimeout(refresh, 15000);
    }

    function inspect(event) {
      if (!data || !data.rows.length) return;
      detail.hidden = false;
      const rect = canvas.getBoundingClientRect();
      const ts = data.start + (event.clientX - rect.left - 34) / Math.max(1, rect.width - 44) * (data.end - data.start);
      const row = data.rows.find(function (item) { return ts >= item.time && ts < item.time + data.step; });
      if (!row) { detail.textContent = timeLabel(ts) + ' · 没有采集记录'; return; }
      detail.textContent = timeLabel(row.time) + ' · 左 ' + row.left + ' / 右 ' + row.right +
        ' dBFS · 最高 ' + row.left_max + ' / ' + row.right_max +
        ' · 增益 ' + row.gains.map(function (gain) { return gain + '×'; }).join('/') +
        ' · 有效收音 ' + Math.round(row.seconds) + ' 秒';
    }

    function clearDetail() { detail.hidden = true; }

    return {
      clearPrivate() {
        revision++; clearTimeout(timer); data = null; detail.hidden = true;
        message = '请登录后查看音频历史'; note.textContent = message; draw();
        if (!stopped && !panel.hidden) timer = setTimeout(refresh, 15000);
      },
      start() {
        front.addEventListener('click', showHistory);
        front.addEventListener('keydown', frontKey);
        backButton.addEventListener('click', showLevels);
        panel.addEventListener('click', backClick);
        panel.addEventListener('keydown', backKey);
        modeButton.addEventListener('click', changeMode);
        canvas.addEventListener('mousemove', inspect);
        canvas.addEventListener('mouseleave', clearDetail);
        range.addEventListener('change', refresh);
        date.addEventListener('change', refresh);
        if (observer) observer.observe(canvas);
        draw(); refresh();
      },
      dispose() {
        stopped = true; revision += 1; clearTimeout(timer);
        if (observer) observer.disconnect();
        front.removeEventListener('click', showHistory);
        front.removeEventListener('keydown', frontKey);
        backButton.removeEventListener('click', showLevels);
        panel.removeEventListener('click', backClick);
        panel.removeEventListener('keydown', backKey);
        modeButton.removeEventListener('click', changeMode);
        canvas.removeEventListener('mousemove', inspect);
        canvas.removeEventListener('mouseleave', clearDetail);
        range.removeEventListener('change', refresh);
        date.removeEventListener('change', refresh);
      },
    };
  }
  global.FlitFancyAudioHistory = { create: create, seriesSegments: seriesSegments };
})(window);
