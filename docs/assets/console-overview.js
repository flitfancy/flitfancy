/* 传感器 24 小时总览：历史数据读取、系列开关、光谱模式与 canvas 绘图。 */
(function (global) {
  "use strict";

  const SPECTRAL_BANDS = [
    { key: "f1_415", label: "415" },
    { key: "f2_445", label: "445" },
    { key: "f3_480", label: "480" },
    { key: "f4_515", label: "515" },
    { key: "f5_555", label: "555" },
    { key: "f6_590", label: "590" },
    { key: "f7_630", label: "630" },
    { key: "f8_680", label: "680" },
  ];
  const SPECTRAL_COLORS = ["#8b5cf6", "#6366f1", "#3b82f6", "#22d3ee",
    "#34d399", "#a3e635", "#fbbf24", "#fb7185"];

  function pressureTrendText(buckets) {
    if (!buckets || buckets.length < 7) return "";
    const average = function (rows) {
      if (!rows.length) return null;
      let sum = 0;
      let count = 0;
      rows.forEach(function (bucket) {
        const value = Number(bucket.pressure_pa);
        if (isFinite(value)) {
          sum += value;
          count += 1;
        }
      });
      return count ? sum / count : null;
    };
    const recent = average(buckets.slice(-3));
    const earlier = average(buckets.slice(-21, -18));
    if (recent == null || earlier == null) return "";
    const delta = recent - earlier;
    if (Math.abs(delta) < 30) return "气压 3h 趋势：平稳";
    return "气压 3h 趋势：" + (delta > 0 ? "↑ +" : "↓ ") +
      (delta / 100).toFixed(1) + " hPa（" +
      (delta > 0 ? "天气趋向稳定/转晴" : "天气可能转差") + "）";
  }

  function create(options) {
    const opts = options || {};
    const query = opts.query || function (selector) { return document.querySelector(selector); };
    const request = opts.request;
    const publicBase = opts.publicBase || "https://api.flitfancy.com";
    const refreshMs = opts.refreshMs || 60000;
    const sensorMeta = opts.sensorMeta || {};
    const format = opts.format;
    const math = opts.math || {};
    const getRows = opts.getRows || function () { return []; };
    const renderRows = opts.renderRows || function () {};
    let channelOpen = null;
    let refreshTimer = null;
    let spectralMode = false;
    const bandsOn = {};
    const seriesOn = {};
    const chartState = { canvas: null, buckets: null, padL: 0, plotW: 0, draw: null };
    let hoverIndex = null;

    const series = {
      CH0: [
        { key: "temp_c", label: "温度", unit: "°C", digits: 1, color: "#f5b84b" },
        { key: "rh_pct", label: "湿度", unit: "%RH", digits: 0, color: "#38bdf8" },
        { key: "dew", label: "露点", unit: "°C", digits: 1, color: "#34d399",
          get: function (bucket) {
            return math.dewPointC(Number(bucket.temp_c), Number(bucket.rh_pct));
          } },
        { key: "heat", label: "体感", unit: "°C", digits: 1, color: "#fb7185",
          get: function (bucket) {
            return math.heatIndexC(Number(bucket.temp_c), Number(bucket.rh_pct));
          } },
      ],
      CH1: [
        { key: "pressure_pa", label: "气压", unit: "hPa", digits: 1,
          scale: 0.01, color: "#f5b84b" },
        { key: "temp_c", label: "温度", unit: "°C", digits: 1, color: "#38bdf8" },
      ],
      CH2: [
        { key: "clear_raw", label: "全光谱", unit: "counts", digits: 0, color: "#f5b84b" },
        { key: "nir_raw", label: "近红外", unit: "counts", digits: 0, color: "#a78bfa" },
      ],
      CH3: [
        { key: "als_raw", label: "环境光", unit: "counts", digits: 0, color: "#f5b84b" },
        { key: "uv_raw", label: "紫外", unit: "counts", digits: 0, color: "#a78bfa" },
        { key: "lux", label: "照度", unit: "lux", digits: 0, color: "#fbbf24",
          get: function (bucket) { return math.luxEstimate(Number(bucket.als_raw)); } },
        { key: "uvi", label: "UVI", unit: "", digits: 1, color: "#fb7185",
          get: function (bucket) { return math.uviEstimate(Number(bucket.uv_raw)); } },
      ],
      CH4: [
        { key: "voc_index", label: "VOC", unit: "index", digits: 0, color: "#f5b84b" },
        { key: "nox_index", label: "NOx", unit: "index", digits: 0, color: "#38bdf8" },
        { key: "sraw_voc", label: "sraw VOC", unit: "raw", digits: 0, color: "#a78bfa" },
        { key: "sraw_nox", label: "sraw NOx", unit: "raw", digits: 0, color: "#34d399" },
      ],
      CH5: [
        { key: "co2_ppm", label: "CO₂", unit: "ppm", digits: 0, color: "#f5b84b" },
        { key: "temp_c", label: "温度", unit: "°C", digits: 1, color: "#38bdf8" },
      ],
    };

    function isOpen() {
      return channelOpen !== null;
    }

    function toggle(channel) {
      if (channelOpen === channel) close();
      else open(channel);
    }

    function makeSeriesButtons(channel) {
      const row = document.createElement("div");
      row.className = "overview-modes series-row";
      (series[channel] || []).forEach(function (item) {
        const button = document.createElement("button");
        button.className = "btn btn-ghost series-btn";
        button.dataset.key = item.key;
        button.textContent = item.label;
        button.style.color = item.color;
        button.style.borderColor = item.color + "66";
        button.addEventListener("click", function () {
          seriesOn[channel] = seriesOn[channel] || {};
          seriesOn[channel][item.key] = seriesOn[channel][item.key] === false;
          button.classList.toggle("off", seriesOn[channel][item.key] === false);
          load(channel);
        });
        row.appendChild(button);
      });
      return row;
    }

    function appendSpectralControls(head, channel) {
      const modes = document.createElement("div");
      modes.className = "overview-modes";
      const syncModes = function () {
        const main = query('[data-role="ov-mode-main"]');
        const spectral = query('[data-role="ov-mode-spectral"]');
        if (main) main.classList.toggle("active", !spectralMode);
        if (spectral) spectral.classList.toggle("active", spectralMode);
        modes.querySelectorAll(".band-btn").forEach(function (button) {
          button.disabled = !spectralMode;
          button.classList.toggle("off",
            !spectralMode || bandsOn[button.dataset.key] === false);
        });
        modes.querySelectorAll(".series-btn").forEach(function (button) {
          button.disabled = spectralMode;
          const active = seriesOn.CH2 || {};
          button.classList.toggle("off",
            spectralMode || active[button.dataset.key] === false);
        });
      };
      const makeModeButton = function (label, mode) {
        const button = document.createElement("button");
        button.className = "btn btn-ghost";
        button.dataset.role = mode === "spectral" ? "ov-mode-spectral" : "ov-mode-main";
        button.textContent = label;
        button.addEventListener("click", function () {
          spectralMode = mode === "spectral";
          syncModes();
          load(channel);
        });
        return button;
      };
      modes.appendChild(makeModeButton("主通道", "main"));
      modes.appendChild(makeModeButton("8 波段", "spectral"));
      (series.CH2 || []).forEach(function (item) {
        const button = document.createElement("button");
        button.className = "btn btn-ghost series-btn";
        button.dataset.key = item.key;
        button.textContent = item.label;
        button.style.color = item.color;
        button.style.borderColor = item.color + "66";
        button.addEventListener("click", function () {
          seriesOn.CH2 = seriesOn.CH2 || {};
          seriesOn.CH2[item.key] = seriesOn.CH2[item.key] === false;
          button.classList.toggle("off", seriesOn.CH2[item.key] === false);
          load(channel);
        });
        modes.appendChild(button);
      });
      SPECTRAL_BANDS.forEach(function (band, index) {
        const button = document.createElement("button");
        button.className = "btn btn-ghost band-btn";
        button.dataset.key = band.key;
        button.textContent = band.label;
        button.style.color = SPECTRAL_COLORS[index];
        button.style.borderColor = SPECTRAL_COLORS[index] + "66";
        button.disabled = !spectralMode;
        button.classList.toggle("off", bandsOn[band.key] === false);
        button.addEventListener("click", function () {
          bandsOn[band.key] = bandsOn[band.key] === false;
          button.classList.toggle("off", bandsOn[band.key] === false);
          load(channel);
        });
        modes.appendChild(button);
      });
      head.appendChild(modes);
      syncModes();
    }

    function open(channel) {
      channelOpen = channel;
      const grid = query('[data-role="sensor-grid"]');
      const meta = sensorMeta[channel];
      grid.textContent = "";
      const wrapper = document.createElement("div");
      wrapper.className = "sensor-overview";
      const head = document.createElement("div");
      head.className = "overview-head";
      const title = document.createElement("span");
      title.textContent = channel + " · " + meta.name + " · 24 小时总览";
      const back = document.createElement("button");
      back.className = "btn btn-ghost";
      back.setAttribute("data-role", "overview-back");
      back.textContent = "返回";
      back.addEventListener("click", close);
      head.appendChild(title);
      if (channel === "CH2") appendSpectralControls(head, channel);
      else head.appendChild(makeSeriesButtons(channel));
      head.appendChild(back);

      const canvas = document.createElement("canvas");
      canvas.setAttribute("data-role", "overview-chart");
      hoverIndex = null;
      canvas.addEventListener("mousemove", function (event) {
        if (chartState.canvas !== canvas || !chartState.buckets || !chartState.buckets.length) return;
        const rect = canvas.getBoundingClientRect();
        const pixel = event.clientX - rect.left;
        const count = chartState.buckets.length;
        const index = Math.max(0, Math.min(count - 1,
          Math.round((pixel - chartState.padL) / chartState.plotW * (count - 1))));
        if (index !== hoverIndex) {
          hoverIndex = index;
          chartState.draw();
        }
      });
      canvas.addEventListener("mouseleave", function () {
        if (chartState.canvas !== canvas) return;
        hoverIndex = null;
        chartState.draw();
      });
      const status = document.createElement("p");
      status.className = "hint";
      status.setAttribute("data-role", "overview-status");
      status.textContent = "正在读取 24 小时数据…";
      wrapper.appendChild(head);
      wrapper.appendChild(canvas);
      wrapper.appendChild(status);
      grid.appendChild(wrapper);
      load(channel);
      global.clearInterval(refreshTimer);
      refreshTimer = global.setInterval(function () { load(channelOpen); }, refreshMs);
    }

    function close() {
      channelOpen = null;
      global.clearInterval(refreshTimer);
      const grid = query('[data-role="sensor-grid"]');
      grid.textContent = "";
      renderRows(getRows());
    }

    async function load(channel) {
      if (!channel) return;
      const status = query('[data-role="overview-status"]');
      const params = "channel=" + encodeURIComponent(channel) + "&hours=24";
      const urls = ["/api/sensors/history?" + params,
        publicBase + "/sensors/history?" + params];
      for (const url of urls) {
        try {
          const data = await request(url);
          if (!data.ok) throw new Error(data.error || "HTTP");
          if (channelOpen !== channel) return;
          const currentSeries = channel === "CH2" && spectralMode
            ? buildSpectralSeries(data.buckets || [])
            : buildSeriesList(channel, data.buckets || []);
          drawSeriesChart(query('[data-role="overview-chart"]'),
            data.buckets || [], currentSeries);
          const trend = channel === "CH1"
            ? " · " + pressureTrendText(data.buckets || [])
            : "";
          status.textContent = "24 小时总览 · " + (data.buckets || []).length +
            " 个采样点（10 分钟聚合）" + trend;
          return;
        } catch (e) { /* 尝试下一个数据源 */ }
      }
      status.textContent = "暂时拿不到 24 小时数据（需要本地服务或登录后的云端历史）";
    }

    function buildSeriesList(channel, buckets) {
      const active = seriesOn[channel] || {};
      return (series[channel] || []).filter(function (item) {
        return active[item.key] !== false;
      }).map(function (item) {
        const values = buckets.map(function (bucket) {
          const value = item.get ? item.get(bucket) : Number(bucket[item.key]);
          return isFinite(value) ? value * (item.scale || 1) : null;
        });
        return {
          label: item.label,
          unit: item.unit,
          digits: item.digits,
          color: item.color,
          values: values,
        };
      });
    }

    function buildSpectralSeries(buckets) {
      const output = [];
      SPECTRAL_BANDS.forEach(function (band, index) {
        if (bandsOn[band.key] === false) return;
        output.push({
          label: band.label + " nm",
          unit: "counts",
          digits: 0,
          color: SPECTRAL_COLORS[index],
          values: buckets.map(function (bucket) {
            const value = Number(bucket[band.key]);
            return isFinite(value) ? value : null;
          }),
        });
      });
      return output;
    }

    function drawSeriesChart(canvas, buckets, seriesList) {
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      const width = canvas.clientWidth || 600;
      const height = canvas.clientHeight || 170;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      const context = canvas.getContext("2d");
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      const empty = function (text) {
        context.fillStyle = "rgba(139, 148, 168, 0.8)";
        context.font = "13px system-ui, sans-serif";
        context.textAlign = "center";
        context.fillText(text, width / 2, height / 2);
      };
      if (!buckets || !buckets.length) {
        empty("该通道暂无 24 小时数据");
        return;
      }
      const plotted = seriesList.map(function (item) {
        const valid = item.values.filter(function (value) { return value != null; });
        let min = Infinity;
        let max = -Infinity;
        valid.forEach(function (value) {
          if (value < min) min = value;
          if (value > max) max = value;
        });
        if (valid.length && max - min < 1e-6) {
          min -= 1;
          max += 1;
        }
        return Object.assign({}, item, { valid: valid, min: min, max: max });
      }).filter(function (item) { return item.valid.length; });
      if (!plotted.length) {
        empty("请打开至少一条曲线");
        return;
      }
      const padLeft = 48;
      const padRight = 12;
      const padBottom = 26;
      const padTop = 14 + plotted.length * 14;
      const plotWidth = width - padLeft - padRight;
      const plotHeight = height - padTop - padBottom;
      const x = function (index) {
        if (buckets.length === 1) return padLeft + plotWidth / 2;
        return padLeft + index / (buckets.length - 1) * plotWidth;
      };

      const first = plotted[0];
      context.font = "10px Consolas, monospace";
      context.textAlign = "right";
      for (let level = 0; level <= 4; level++) {
        const value = first.min + (first.max - first.min) * level / 4;
        const y = padTop + (1 - level / 4) * plotHeight;
        context.fillStyle = "rgba(139, 148, 168, 0.85)";
        context.fillText(format(value, first.digits), padLeft - 6, y + 3);
        if (level > 0 && level < 4) {
          context.strokeStyle = "rgba(148, 163, 184, 0.10)";
          context.lineWidth = 1;
          context.beginPath();
          context.moveTo(padLeft, y);
          context.lineTo(width - padRight, y);
          context.stroke();
        }
      }

      plotted.forEach(function (item) {
        const y = function (value) {
          return padTop + (1 - (value - item.min) / (item.max - item.min)) * plotHeight;
        };
        context.beginPath();
        let started = false;
        for (let index = 0; index < buckets.length; index++) {
          const value = item.values[index];
          if (value == null) {
            started = false;
            continue;
          }
          const px = x(index);
          const py = y(value);
          if (started) context.lineTo(px, py);
          else context.moveTo(px, py);
          started = true;
        }
        context.strokeStyle = item.color;
        context.lineWidth = 1.6;
        context.stroke();
      });

      context.font = "11px Consolas, monospace";
      context.textAlign = "left";
      plotted.forEach(function (item, index) {
        const average = item.valid.reduce(function (sum, value) {
          return sum + value;
        }, 0) / item.valid.length;
        context.fillStyle = item.color;
        context.fillText(item.label + " 平均 " + format(average, item.digits) + " " +
          item.unit + " · 最低 " + format(item.min, item.digits) + " · 最高 " +
          format(item.max, item.digits), 4, 15 + index * 14);
      });

      if (hoverIndex != null) {
        const index = Math.max(0, Math.min(buckets.length - 1, hoverIndex));
        context.strokeStyle = "rgba(255, 255, 255, 0.35)";
        context.lineWidth = 1;
        context.setLineDash([4, 4]);
        context.beginPath();
        context.moveTo(x(index), padTop);
        context.lineTo(x(index), padTop + plotHeight);
        context.stroke();
        context.setLineDash([]);
        context.font = "11px Consolas, monospace";
        const lines = plotted.map(function (item) {
          const value = item.values[index];
          return {
            text: item.label + "  " +
              (value == null ? "—" : format(value, item.digits) + " " + item.unit),
            color: item.color,
          };
        });
        const time = String(buckets[index].bucket || "").slice(11, 16);
        let boxWidth = context.measureText(time).width;
        lines.forEach(function (line) {
          boxWidth = Math.max(boxWidth, context.measureText(line.text).width);
        });
        boxWidth += 20;
        const boxHeight = lines.length * 14 + 30;
        const boxX = width - padRight - boxWidth;
        const boxY = padTop + 2;
        context.fillStyle = "rgba(15, 23, 42, 0.88)";
        context.strokeStyle = "rgba(245, 184, 75, 0.35)";
        context.beginPath();
        if (context.roundRect) context.roundRect(boxX, boxY, boxWidth, boxHeight, 6);
        else context.rect(boxX, boxY, boxWidth, boxHeight);
        context.fill();
        context.stroke();
        context.textAlign = "left";
        lines.forEach(function (line, lineIndex) {
          context.fillStyle = line.color;
          context.fillText(line.text, boxX + 10, boxY + 18 + lineIndex * 14);
        });
        context.fillStyle = "rgba(139, 148, 168, 0.9)";
        context.fillText(time, boxX + 10, boxY + 18 + lines.length * 14);
      }

      context.fillStyle = "rgba(139, 148, 168, 0.9)";
      context.font = "11px Consolas, monospace";
      [0, 0.25, 0.5, 0.75, 1].forEach(function (point, pointIndex) {
        const index = Math.round(point * (buckets.length - 1));
        const time = String(buckets[index].bucket || "").slice(11, 16);
        if (pointIndex === 0) context.textAlign = "left";
        else if (pointIndex === 4) context.textAlign = "right";
        else context.textAlign = "center";
        context.fillText(time, x(index), height - 8);
      });

      chartState.canvas = canvas;
      chartState.buckets = buckets;
      chartState.padL = padLeft;
      chartState.plotW = plotWidth;
      chartState.draw = function () { drawSeriesChart(canvas, buckets, seriesList); };
    }

    return {
      isOpen: isOpen,
      toggle: toggle,
      open: open,
      close: close,
      refresh: load,
    };
  }

  global.FlitFancyConsoleOverview = {
    create: create,
    pressureTrendText: pressureTrendText,
  };
})(window);
