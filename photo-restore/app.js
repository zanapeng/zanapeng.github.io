/* 老照片修复 —— 纯前端本地图像处理（含前后对比） */
(function () {
  "use strict";

  var MAX_DIM = 2000; // 处理长边上限，超出自动缩放，保证流畅

  var state = {
    loaded: false,
    width: 0,
    height: 0,
    original: null,     // 原始 ImageData
    origCanvas: null,   // 离屏画布：原图
    resultCanvas: null, // 离屏画布：处理结果
    medianCache: null,  // 去噪缓存（3x3 中值）
    blurCache: null,    // 锐化缓存（3x3 高斯）
    blur5Cache: null,   // 清晰度缓存（5x5 高斯）
    levelsLUT: null,    // 自动色阶 LUT（3 x 256）
    intensity: 100,     // 效果强度 %
    params: {
      temperature: 0,
      brightness: 0,
      contrast: 0,
      saturation: 0,
      clarity: 0,
      denoise: 0,
      sharpen: 0,
      levels: 0
    },
    compareMode: false,
    showOriginal: false,
    divX: 0.5,
    dragging: false
  };

  // ---------- DOM ----------
  function $(id) { return document.getElementById(id); }
  var dropzone = $("dropzone");
  var fileInput = $("fileInput");
  var workspace = $("workspace");
  var canvas = $("stage");
  var ctx = canvas.getContext("2d");
  var busyEl = $("busy");

  var KEYS = ["temperature", "brightness", "contrast", "saturation", "clarity", "denoise", "sharpen"];
  var ctl = {};
  KEYS.forEach(function (k) {
    ctl[k] = $(k);
    ctl[k + "Val"] = $(k + "Val");
  });
  var levelsCtl = $("levelsCtl");
  var intensityCtl = $("intensity");
  var intensityVal = $("intensityVal");
  var compareBtn = $("compareBtn");
  var holdBtn = $("holdBtn");

  function setBusy(on) { busyEl.classList.toggle("hidden", !on); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // ---------- 图像算子 ----------

  // 3x3 中值滤波（逐通道插入排序）
  function medianFilter(img) {
    var w = img.width, h = img.height, data = img.data;
    var out = new Uint8ClampedArray(data.length);
    var rv = new Float64Array(9), gv = new Float64Array(9), bv = new Float64Array(9);

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var n = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            var j = (ny * w + nx) * 4;
            rv[n] = data[j]; gv[n] = data[j + 1]; bv[n] = data[j + 2];
            n++;
          }
        }
        for (var a = 1; a < n; a++) {
          var tv = rv[a], p = a - 1;
          while (p >= 0 && rv[p] > tv) { rv[p + 1] = rv[p]; p--; }
          rv[p + 1] = tv;
        }
        for (var a2 = 1; a2 < n; a2++) {
          var tv2 = gv[a2], p2 = a2 - 1;
          while (p2 >= 0 && gv[p2] > tv2) { gv[p2 + 1] = gv[p2]; p2--; }
          gv[p2 + 1] = tv2;
        }
        for (var a3 = 1; a3 < n; a3++) {
          var tv3 = bv[a3], p3 = a3 - 1;
          while (p3 >= 0 && bv[p3] > tv3) { bv[p3 + 1] = bv[p3]; p3--; }
          bv[p3 + 1] = tv3;
        }
        var m = n >> 1;
        var o = (y * w + x) * 4;
        out[o] = rv[m]; out[o + 1] = gv[m]; out[o + 2] = bv[m]; out[o + 3] = 255;
      }
    }
    return new ImageData(out, w, h);
  }

  // 3x3 高斯模糊（unsharp 锐化用）
  function gaussianBlur3(img) {
    var w = img.width, h = img.height, data = img.data;
    var out = new Uint8ClampedArray(data.length);
    var K = [1, 2, 1, 2, 4, 2, 1, 2, 1];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var r = 0, g = 0, b = 0, ws = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            var wt = K[(dy + 1) * 3 + (dx + 1)];
            var j = (ny * w + nx) * 4;
            r += data[j] * wt; g += data[j + 1] * wt; b += data[j + 2] * wt;
            ws += wt;
          }
        }
        var o = (y * w + x) * 4;
        out[o] = r / ws; out[o + 1] = g / ws; out[o + 2] = b / ws; out[o + 3] = 255;
      }
    }
    return new ImageData(out, w, h);
  }

  // 5x5 高斯模糊（可分离实现，清晰度用）sigma≈1.6
  function gaussianBlur5(img) {
    var w = img.width, h = img.height, data = img.data;
    var W = [1, 4, 7, 4, 1];
    var WS = 17;
    var tmp = new Float64Array(data.length);
    var out = new Uint8ClampedArray(data.length);

    // 水平
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var r = 0, g = 0, b = 0;
        for (var dx = -2; dx <= 2; dx++) {
          var nx = x + dx;
          if (nx < 0 || nx >= w) nx = x;
          var wt = W[dx + 2];
          var j = (y * w + nx) * 4;
          r += data[j] * wt; g += data[j + 1] * wt; b += data[j + 2] * wt;
        }
        var o = (y * w + x) * 4;
        tmp[o] = r / WS; tmp[o + 1] = g / WS; tmp[o + 2] = b / WS;
      }
    }
    // 垂直
    for (var x2 = 0; x2 < w; x2++) {
      for (var y2 = 0; y2 < h; y2++) {
        var r2 = 0, g2 = 0, b2 = 0;
        for (var dy = -2; dy <= 2; dy++) {
          var ny2 = y2 + dy;
          if (ny2 < 0 || ny2 >= h) ny2 = y2;
          var wt2 = W[dy + 2];
          var j2 = (ny2 * w + x2) * 4;
          r2 += tmp[j2] * wt2; g2 += tmp[j2 + 1] * wt2; b2 += tmp[j2 + 2] * wt2;
        }
        var o2 = (y2 * w + x2) * 4;
        out[o2] = r2 / WS; out[o2 + 1] = g2 / WS; out[o2 + 2] = b2 / WS; out[o2 + 3] = 255;
      }
    }
    return new ImageData(out, w, h);
  }

  // 直方图百分位拉伸 LUT（0.5% ~ 99.5%）
  function computeLevelsLUT(img) {
    var w = img.width, h = img.height, data = img.data, n = w * h;
    var hist = [new Float64Array(256), new Float64Array(256), new Float64Array(256)];
    for (var i = 0; i < n; i++) {
      var j = i * 4;
      hist[0][data[j]]++;
      hist[1][data[j + 1]]++;
      hist[2][data[j + 2]]++;
    }
    var luts = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
    var loCut = n * 0.005, hiCut = n * 0.995;
    for (var c = 0; c < 3; c++) {
      var acc = 0, lo = 0;
      while (lo < 255 && acc + hist[c][lo] <= loCut) { acc += hist[c][lo]; lo++; }
      acc = 0; var hi = 255;
      while (hi > 0 && acc + hist[c][hi] <= n - hiCut) { acc += hist[c][hi]; hi--; }
      if (hi <= lo) hi = lo + 1;
      for (var v = 0; v < 256; v++) {
        luts[c][v] = clamp(Math.round(((v - lo) / (hi - lo)) * 255), 0, 255);
      }
    }
    return luts;
  }

  function getMedian() {
    if (!state.medianCache) state.medianCache = medianFilter(state.original);
    return state.medianCache;
  }
  function getBlur3() {
    if (!state.blurCache) state.blurCache = gaussianBlur3(state.original);
    return state.blurCache;
  }
  function getBlur5() {
    if (!state.blur5Cache) state.blur5Cache = gaussianBlur5(state.original);
    return state.blur5Cache;
  }

  // ---------- 渲染 ----------
  function render() {
    if (!state.loaded) return;
    var w = state.width, h = state.height;
    var rctx = state.resultCanvas.getContext("2d");
    var src = state.original.data;
    var out = rctx.createImageData(w, h);
    var d = out.data;

    var p = state.params;
    var k = state.intensity / 100;            // 效果强度
    var t = (p.temperature / 100) * k;
    var bri = (p.brightness / 100) * 127 * k;
    var cf = 1 + (p.contrast / 100) * k;
    var sat = 1 + (p.saturation / 100) * k;
    var clA = (p.clarity / 100) * 1.4 * k;
    var hasMedian = p.denoise > 0;
    var median = hasMedian ? getMedian() : null;
    var denA = (p.denoise / 100) * k;
    var hasBlur = p.sharpen > 0;
    var blur = hasBlur ? getBlur3() : null;
    var shA = (p.sharpen / 100) * 1.6 * k;
    var LUT = p.levels ? state.levelsLUT : null;
    var blur5 = clA !== 0 ? getBlur5() : null;

    var n = w * h;
    for (var i = 0; i < n; i++) {
      var j = i * 4;
      var r = src[j], g = src[j + 1], b = src[j + 2];

      // 0) 自动色阶
      if (LUT) { r = LUT[0][r]; g = LUT[1][g]; b = LUT[2][b]; }
      // 1) 去黄/色温
      if (t !== 0) { r += -t * 60; b += t * 60; }
      // 2) 亮度
      if (bri !== 0) { r += bri; g += bri; b += bri; }
      // 3) 对比度
      if (cf !== 1) {
        r = (r - 128) * cf + 128;
        g = (g - 128) * cf + 128;
        b = (b - 128) * cf + 128;
      }
      // 4) 饱和度
      if (sat !== 1) {
        var lum = 0.299 * r + 0.587 * g + 0.114 * b;
        r = lum + (r - lum) * sat;
        g = lum + (g - lum) * sat;
        b = lum + (b - lum) * sat;
      }
      // 5) 清晰度（局部对比度）
      if (blur5) {
        r = r + (r - blur5.data[j]) * clA;
        g = g + (g - blur5.data[j + 1]) * clA;
        b = b + (b - blur5.data[j + 2]) * clA;
      }
      // 6) 去噪
      if (hasMedian) {
        r = r + (median.data[j] - r) * denA;
        g = g + (median.data[j + 1] - g) * denA;
        b = b + (median.data[j + 2] - b) * denA;
      }
      // 7) 锐化（unsharp mask）
      if (hasBlur) {
        r = r + (r - blur.data[j]) * shA;
        g = g + (g - blur.data[j + 1]) * shA;
        b = b + (b - blur.data[j + 2]) * shA;
      }

      d[j] = clamp(r, 0, 255);
      d[j + 1] = clamp(g, 0, 255);
      d[j + 2] = clamp(b, 0, 255);
      d[j + 3] = 255;
    }

    rctx.putImageData(out, 0, 0);
    paint();
  }

  // 呈现：原图 / 结果 / 前后对比分屏
  function paint() {
    if (!state.loaded) return;
    var w = state.width, h = state.height;
    ctx.clearRect(0, 0, w, h);

    if (state.showOriginal) {
      ctx.drawImage(state.origCanvas, 0, 0);
      return;
    }

    if (state.compareMode) {
      ctx.drawImage(state.origCanvas, 0, 0);
      var dx = Math.round(state.divX * w);
      ctx.save();
      ctx.beginPath();
      ctx.rect(dx, 0, w - dx, h);
      ctx.clip();
      ctx.drawImage(state.resultCanvas, 0, 0);
      ctx.restore();

      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(dx, 0);
      ctx.lineTo(dx, h);
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#6c5ce7";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(dx, h / 2, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.font = "bold 13px -apple-system, 'PingFang SC', sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(30,36,48,0.65)";
      roundRect(ctx, 8, 8, 52, 24, 6);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText("原图", 16, 20);
      ctx.fillStyle = "rgba(30,36,48,0.65)";
      var tw = ctx.measureText("修复后").width;
      roundRect(ctx, w - tw - 24, 8, tw + 16, 24, 6);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText("修复后", w - tw - 16, 20);
    } else {
      ctx.drawImage(state.resultCanvas, 0, 0);
    }
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  var rafId = 0;
  function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      render();
    });
  }

  // ---------- 参数同步 ----------
  function syncControls() {
    KEYS.forEach(function (k) {
      ctl[k].value = state.params[k];
      ctl[k + "Val"].textContent = state.params[k];
    });
    levelsCtl.checked = state.params.levels === 1;
    intensityCtl.value = state.intensity;
    intensityVal.textContent = state.intensity + "%";
  }

  function resetParams() {
    KEYS.forEach(function (k) { state.params[k] = 0; });
    state.params.levels = 0;
    syncControls();
  }

  function setParams(obj) {
    KEYS.forEach(function (k) { state.params[k] = obj[k] !== undefined ? obj[k] : 0; });
    state.params.levels = obj.levels !== undefined ? obj.levels : 0;
    syncControls();
  }

  // ---------- 图片加载 ----------
  function loadFromCanvas(srcCanvas) {
    var w = srcCanvas.width, h = srcCanvas.height;

    state.origCanvas = srcCanvas;
    state.original = srcCanvas.getContext("2d").getImageData(0, 0, w, h);

    state.resultCanvas = document.createElement("canvas");
    state.resultCanvas.width = w;
    state.resultCanvas.height = h;

    canvas.width = w;
    canvas.height = h;

    state.width = w;
    state.height = h;
    state.medianCache = null;
    state.blurCache = null;
    state.blur5Cache = null;
    state.levelsLUT = computeLevelsLUT(state.original);
    state.compareMode = false;
    state.showOriginal = false;
    state.divX = 0.5;
    state.loaded = true;

    resetParams();
    workspace.classList.remove("hidden");
    dropzone.classList.add("hidden");
    compareBtn.classList.remove("active");
    workspace.classList.remove("comparing");

    // 加载后自动跑一次修复，立刻看到效果
    autoRestore();
  }

  function loadImage(file) {
    if (!file || !/^image\//.test(file.type)) {
      alert("请选择图片文件。");
      return;
    }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth, h = img.naturalHeight;
      var scale = Math.min(1, MAX_DIM / Math.max(w, h));
      w = Math.round(w * scale);
      h = Math.round(h * scale);
      var c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      loadFromCanvas(c);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      alert("图片加载失败，请换一张试试。");
    };
    img.src = url;
  }

  function showUpload() {
    state.loaded = false;
    canvas.width = 0;
    canvas.height = 0;
    fileInput.value = "";
    workspace.classList.add("hidden");
    dropzone.classList.remove("hidden");
  }

  // ---------- 示例老照片（程序生成：泛黄 + 噪点 + 暗角 + 划痕） ----------
  function generateDemo() {
    var w = 800, h = 600;
    var c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    var x = c.getContext("2d");

    // 天空
    var g = x.createLinearGradient(0, 0, 0, 420);
    g.addColorStop(0, "#9db8d8");
    g.addColorStop(1, "#efe6cf");
    x.fillStyle = g;
    x.fillRect(0, 0, w, 420);

    // 太阳
    x.fillStyle = "#f5ecc2";
    x.beginPath();
    x.arc(620, 130, 46, 0, Math.PI * 2);
    x.fill();

    // 云
    x.fillStyle = "rgba(255,255,255,0.85)";
    x.beginPath();
    x.arc(150, 120, 26, 0, Math.PI * 2);
    x.arc(190, 105, 32, 0, Math.PI * 2);
    x.arc(230, 120, 24, 0, Math.PI * 2);
    x.fill();

    // 远山
    x.fillStyle = "#96a7a0";
    x.beginPath();
    x.moveTo(0, 420);
    x.lineTo(140, 300);
    x.lineTo(300, 420);
    x.closePath();
    x.fill();
    x.beginPath();
    x.moveTo(220, 420);
    x.lineTo(430, 280);
    x.lineTo(640, 420);
    x.closePath();
    x.fill();

    // 地面
    x.fillStyle = "#c9b98a";
    x.fillRect(0, 420, w, 180);

    // 小路
    x.fillStyle = "#b3a074";
    x.beginPath();
    x.moveTo(300, 600);
    x.lineTo(360, 420);
    x.lineTo(440, 420);
    x.lineTo(500, 600);
    x.closePath();
    x.fill();

    // 房子
    x.fillStyle = "#d8c4a2";
    x.fillRect(360, 430, 130, 90);
    x.fillStyle = "#a0522d";
    x.beginPath();
    x.moveTo(345, 430);
    x.lineTo(425, 385);
    x.lineTo(505, 430);
    x.closePath();
    x.fill();
    x.fillStyle = "#7a5230";
    x.fillRect(410, 470, 30, 50);
    x.fillStyle = "#8aa6c8";
    x.fillRect(375, 450, 26, 26);
    x.fillRect(450, 450, 26, 26);

    // 树
    x.fillStyle = "#8a6a48";
    x.fillRect(240, 470, 18, 60);
    x.fillStyle = "#6e8a5e";
    x.beginPath();
    x.arc(249, 440, 42, 0, Math.PI * 2);
    x.fill();

    // 旧化处理：降饱和 + 泛黄 + 噪点 + 暗角
    var img = x.getImageData(0, 0, w, h);
    var d = img.data;
    var n = w * h;
    for (var i = 0; i < n; i++) {
      var j = i * 4;
      var r = d[j], gg = d[j + 1], b = d[j + 2];
      var lum = 0.299 * r + 0.587 * gg + 0.114 * b;
      var sat = 0.55;
      r = lum + (r - lum) * sat;
      gg = lum + (gg - lum) * sat;
      b = lum + (b - lum) * sat;
      r = r * 1.08 + 14;
      gg = gg * 1.02 + 6;
      b = b * 0.72 + 4;
      var no = (Math.random() - 0.5) * 34;
      r += no; gg += no; b += no;
      var px = (i % w - w / 2) / (w / 2);
      var py = (((i / w) | 0) - h / 2) / (h / 2);
      var vig = 1 - 0.5 * Math.min(1, px * px + py * py);
      r *= vig; gg *= vig; b *= vig;
      d[j] = clamp(r, 0, 255);
      d[j + 1] = clamp(gg, 0, 255);
      d[j + 2] = clamp(b, 0, 255);
      d[j + 3] = 255;
    }
    x.putImageData(img, 0, 0);

    // 划痕
    x.strokeStyle = "rgba(255,255,255,0.22)";
    x.lineWidth = 1.2;
    for (var k = 0; k < 9; k++) {
      x.beginPath();
      x.moveTo(Math.random() * w, Math.random() * h);
      x.lineTo(Math.random() * w, Math.random() * h);
      x.stroke();
    }

    loadFromCanvas(c);
  }

  // ---------- 自动修复 ----------
  function autoRestore() {
    if (!state.loaded) return;
    setBusy(true);
    setTimeout(function () {
      // 灰世界白平衡：按通道均值估色偏
      var src = state.original.data;
      var n = state.width * state.height;
      var sr = 0, sg = 0, sb = 0;
      for (var i = 0; i < n; i++) {
        var j = i * 4;
        sr += src[j]; sg += src[j + 1]; sb += src[j + 2];
      }
      var mr = sr / n, mg = sg / n, mb = sb / n;
      var t = clamp(Math.round((mg - mb) / 1.5), -60, 60);

      state.params = {
        temperature: t,
        brightness: 3,
        contrast: 35,
        saturation: 25,
        clarity: 40,
        denoise: 30,
        sharpen: 60,
        levels: 1
      };
      syncControls();
      render();
      setBusy(false);
    }, 30);
  }

  // ---------- 预设 ----------
  var PRESETS = {
    bw:    { temperature: 0,   brightness: 0,  contrast: 20, saturation: -100, clarity: 35, denoise: 25, sharpen: 50, levels: 1 },
    vivid: { temperature: 0,   brightness: 0,  contrast: 25, saturation: 45,  clarity: 45, denoise: 15, sharpen: 45, levels: 1 },
    retro: { temperature: -50, brightness: -5, contrast: 15, saturation: -15, clarity: 20, denoise: 20, sharpen: 35, levels: 0 }
  };

  // ---------- 事件绑定 ----------
  dropzone.addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files[0]) loadImage(fileInput.files[0]);
  });

  ["dragover", "dragenter"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    });
  });
  dropzone.addEventListener("drop", function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
      loadImage(e.dataTransfer.files[0]);
    }
  });

  $("demoBtn").addEventListener("click", function (e) {
    e.stopPropagation();
    generateDemo();
  });

  KEYS.forEach(function (k) {
    ctl[k].addEventListener("input", function () {
      state.params[k] = Number(ctl[k].value);
      ctl[k + "Val"].textContent = ctl[k].value;
      scheduleRender();
    });
  });

  intensityCtl.addEventListener("input", function () {
    state.intensity = Number(intensityCtl.value);
    intensityVal.textContent = state.intensity + "%";
    scheduleRender();
  });

  levelsCtl.addEventListener("change", function () {
    state.params.levels = levelsCtl.checked ? 1 : 0;
    render();
  });

  $("autoBtn").addEventListener("click", autoRestore);
  $("resetBtn").addEventListener("click", function () {
    resetParams();
    render();
  });
  $("changeBtn").addEventListener("click", showUpload);

  $("presetBwBtn").addEventListener("click", function () { setParams(PRESETS.bw); render(); });
  $("presetVividBtn").addEventListener("click", function () { setParams(PRESETS.vivid); render(); });
  $("presetRetroBtn").addEventListener("click", function () { setParams(PRESETS.retro); render(); });

  // 前后对比开关
  compareBtn.addEventListener("click", function () {
    state.compareMode = !state.compareMode;
    compareBtn.classList.toggle("active", state.compareMode);
    workspace.classList.toggle("comparing", state.compareMode);
    paint();
  });

  // 按住看原图
  holdBtn.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    state.showOriginal = true;
    paint();
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach(function (ev) {
    holdBtn.addEventListener(ev, function () {
      state.showOriginal = false;
      paint();
    });
  });

  // 对比分隔线拖动
  function canvasPosX(e) {
    var rect = canvas.getBoundingClientRect();
    return clamp((e.clientX - rect.left) / rect.width, 0, 1);
  }
  canvas.addEventListener("pointerdown", function (e) {
    if (!state.loaded || !state.compareMode) return;
    state.dragging = true;
    state.divX = canvasPosX(e);
    canvas.setPointerCapture(e.pointerId);
    paint();
  });
  canvas.addEventListener("pointermove", function (e) {
    if (!state.dragging) return;
    state.divX = canvasPosX(e);
    paint();
  });
  ["pointerup", "pointercancel"].forEach(function (ev) {
    canvas.addEventListener(ev, function () { state.dragging = false; });
  });

  $("downloadBtn").addEventListener("click", function () {
    if (!state.loaded) return;
    var a = document.createElement("a");
    var ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.download = "restored-" + ts + ".png";
    a.href = state.resultCanvas.toDataURL("image/png");
    a.click();
  });

  // 页脚年份
  document.getElementById("year").textContent = new Date().getFullYear();
})();
