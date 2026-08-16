/* 老照片修复 v4 —— 纯前端本地图像处理（含前后对比）
   管线：白平衡 → 亮度色阶 → 色温/亮度/对比度/饱和度（实时）
        → 清晰度/去噪/锐化（基于当前帧，防抖重算缓存） */
(function () {
  "use strict";

  var MAX_DIM = 1800;

  var state = {
    loaded: false,
    width: 0,
    height: 0,
    original: null,      // 原始 ImageData
    stageA: null,        // 白平衡后（缓存）
    lut: null,           // 亮度色阶 LUT（基于 stageA）
    cur: null,           // 颜色调整后（实时缓冲）
    origCanvas: null,
    resultCanvas: null,
    medianCache: null,
    blur3Cache: null,
    blur5Cache: null,
    intensity: 100,
    params: {
      wb: 1, levels: 1, temperature: 0, brightness: 0,
      contrast: 0, saturation: 0, clarity: 0, denoise: 0, sharpen: 0
    },
    compareMode: false,
    showOriginal: false,
    divX: 0.5,
    dragging: false,
    computingPost: false
  };

  function $(id) { return document.getElementById(id); }
  var dropzone = $("dropzone");
  var fileInput = $("fileInput");
  var workspace = $("workspace");
  var canvas = $("stage");
  var ctx = canvas.getContext("2d");
  var busyEl = $("busy");

  var SLIDERS = ["temperature", "brightness", "contrast", "saturation", "clarity", "denoise", "sharpen"];
  var ctl = {};
  SLIDERS.forEach(function (k) {
    ctl[k] = $(k);
    ctl[k + "Val"] = $(k + "Val");
  });
  var wbCtl = $("wbCtl");
  var levelsCtl = $("levelsCtl");
  var intensityCtl = $("intensity");
  var intensityVal = $("intensityVal");
  var compareBtn = $("compareBtn");
  var holdBtn = $("holdBtn");

  function setBusy(on) { busyEl.classList.toggle("hidden", !on); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // ---------- 图像算子 ----------

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

  // 5x5 高斯模糊（可分离，清晰度用）；中间缓冲用 Uint16 省内存
  function gaussianBlur5(img) {
    var w = img.width, h = img.height, data = img.data;
    var Wt = [1, 4, 7, 4, 1], WS = 17;
    var tmp = new Uint16Array(data.length);
    var out = new Uint8ClampedArray(data.length);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var r = 0, g = 0, b = 0;
        for (var dx = -2; dx <= 2; dx++) {
          var nx = x + dx;
          if (nx < 0 || nx >= w) nx = x;
          var wt = Wt[dx + 2];
          var j = (y * w + nx) * 4;
          r += data[j] * wt; g += data[j + 1] * wt; b += data[j + 2] * wt;
        }
        var o = (y * w + x) * 4;
        tmp[o] = r / WS; tmp[o + 1] = g / WS; tmp[o + 2] = b / WS;
      }
    }
    for (var x2 = 0; x2 < w; x2++) {
      for (var y2 = 0; y2 < h; y2++) {
        var r2 = 0, g2 = 0, b2 = 0;
        for (var dy = -2; dy <= 2; dy++) {
          var ny = y2 + dy;
          if (ny < 0 || ny >= h) ny = y2;
          var wt2 = Wt[dy + 2];
          var j2 = (ny * w + x2) * 4;
          r2 += tmp[j2] * wt2; g2 += tmp[j2 + 1] * wt2; b2 += tmp[j2 + 2] * wt2;
        }
        var o2 = (y2 * w + x2) * 4;
        out[o2] = r2 / WS; out[o2 + 1] = g2 / WS; out[o2 + 2] = b2 / WS; out[o2 + 3] = 255;
      }
    }
    return new ImageData(out, w, h);
  }

  // ---------- 管线各阶段 ----------

  // 阶段A：白平衡（灰世界），线性增益；关闭时直接引用原图
  function computeStageA() {
    var src = state.original, w = state.width, h = state.height, n = w * h, d = src.data;
    if (!state.params.wb) { state.stageA = src; return; }
    var sr = 0, sg = 0, sb = 0;
    for (var i = 0; i < n; i++) {
      var j = i * 4;
      sr += d[j]; sg += d[j + 1]; sb += d[j + 2];
    }
    var mr = sr / n, mg = sg / n, mb = sb / n, mavg = (mr + mg + mb) / 3;
    var gR = clamp(mavg / (mr || 1), 0.7, 1.6);
    var gG = clamp(mavg / (mg || 1), 0.7, 1.6);
    var gB = clamp(mavg / (mb || 1), 0.7, 1.6);
    var out = ctx.createImageData(w, h);
    var o = out.data;
    for (var i2 = 0; i2 < n; i2++) {
      var j2 = i2 * 4;
      o[j2] = clamp(d[j2] * gR, 0, 255);
      o[j2 + 1] = clamp(d[j2 + 1] * gG, 0, 255);
      o[j2 + 2] = clamp(d[j2 + 2] * gB, 0, 255);
      o[j2 + 3] = 255;
    }
    state.stageA = out;
  }

  // 阶段B：亮度直方图百分位拉伸 LUT（0.5% ~ 99.5%，不改变颜色）
  function computeLUT() {
    if (!state.params.levels) { state.lut = null; return; }
    var src = state.stageA, w = state.width, h = state.height, n = w * h, d = src.data;
    var hist = new Float64Array(256);
    for (var i = 0; i < n; i++) {
      var lum = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
      hist[Math.min(255, lum | 0)]++;
    }
    var loCut = n * 0.005, hiCut = n * 0.995;
    var acc = 0, lo = 0;
    while (lo < 255 && acc + hist[lo] <= loCut) { acc += hist[lo]; lo++; }
    acc = 0; var hi = 255;
    while (hi > 0 && acc + hist[hi] <= n - hiCut) { acc += hist[hi]; hi--; }
    if (hi <= lo) hi = lo + 1;
    var lut = new Uint8ClampedArray(256);
    for (var v = 0; v < 256; v++) {
      lut[v] = clamp(Math.round((v - lo) / (hi - lo) * 255), 0, 255);
    }
    state.lut = lut;
  }

  // 阶段C：色温/亮度/对比度/饱和度（实时，写入 cur 缓冲）
  function computeCur() {
    var A = state.stageA, w = state.width, h = state.height, n = w * h, d = A.data;
    var p = state.params, k = state.intensity / 100;
    var lut = p.levels ? state.lut : null;
    var t = (p.temperature / 100) * k;
    var bri = (p.brightness / 100) * 127 * k;
    var cf = 1 + (p.contrast / 100) * k;
    var sat = 1 + (p.saturation / 100) * k;
    var o = state.cur.data;
    for (var i = 0; i < n; i++) {
      var j = i * 4;
      var r = d[j], g = d[j + 1], b = d[j + 2];
      if (lut) { r = lut[r]; g = lut[g]; b = lut[b]; }
      if (t !== 0) { r += -t * 30; b += t * 30; }
      if (bri !== 0) { r += bri; g += bri; b += bri; }
      if (cf !== 1) { r = (r - 128) * cf + 128; g = (g - 128) * cf + 128; b = (b - 128) * cf + 128; }
      if (sat !== 1) {
        var l = 0.299 * r + 0.587 * g + 0.114 * b;
        r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
      }
      o[j] = clamp(r, 0, 255);
      o[j + 1] = clamp(g, 0, 255);
      o[j + 2] = clamp(b, 0, 255);
      o[j + 3] = 255;
    }
  }

  // 阶段D：基于当前帧重算 中值/模糊 缓存
  function computePost() {
    var p = state.params;
    if (p.denoise > 0) state.medianCache = medianFilter(state.cur);
    if (p.sharpen > 0) state.blur3Cache = gaussianBlur3(state.cur);
    if (p.clarity > 0) state.blur5Cache = gaussianBlur5(state.cur);
  }

  // 合成最终结果（cur + 细节增强）并呈现
  function applyPostAndPaint() {
    if (!state.loaded) return;
    var w = state.width, h = state.height, n = w * h;
    var rctx = state.resultCanvas.getContext("2d");
    var p = state.params, k = state.intensity / 100;
    var clA = (p.clarity / 100) * 1.4 * k;
    var denA = (p.denoise / 100) * k;
    var shA = (p.sharpen / 100) * 1.6 * k;
    var med = p.denoise > 0 ? state.medianCache : null;
    var b5 = p.clarity > 0 ? state.blur5Cache : null;
    var b3 = p.sharpen > 0 ? state.blur3Cache : null;
    var d = state.cur.data;
    var out = rctx.createImageData(w, h);
    var o = out.data;
    for (var i = 0; i < n; i++) {
      var j = i * 4;
      var r = d[j], g = d[j + 1], b = d[j + 2];
      if (b5) {
        r = r + (r - b5.data[j]) * clA;
        g = g + (g - b5.data[j + 1]) * clA;
        b = b + (b - b5.data[j + 2]) * clA;
      }
      if (med) {
        r = r + (med.data[j] - r) * denA;
        g = g + (med.data[j + 1] - g) * denA;
        b = b + (med.data[j + 2] - b) * denA;
      }
      if (b3) {
        r = r + (r - b3.data[j]) * shA;
        g = g + (g - b3.data[j + 1]) * shA;
        b = b + (b - b3.data[j + 2]) * shA;
      }
      o[j] = clamp(r, 0, 255);
      o[j + 1] = clamp(g, 0, 255);
      o[j + 2] = clamp(b, 0, 255);
      o[j + 3] = 255;
    }
    rctx.putImageData(out, 0, 0);
    paint();
  }

  // 主渲染：实时阶段 + 防抖重算细节缓存
  var postTimer = 0;
  function render() {
    if (!state.loaded) return;
    computeCur();
    applyPostAndPaint();
    clearTimeout(postTimer);
    postTimer = setTimeout(function () {
      if (!state.loaded || state.computingPost) return;
      state.computingPost = true;
      var big = state.width * state.height > 900000;
      if (big) setBusy(true);
      computePost();
      state.computingPost = false;
      if (big) setBusy(false);
      applyPostAndPaint();
    }, 200);
  }

  // 切换白平衡/色阶时重建基底
  function refreshBases() {
    computeStageA();
    computeLUT();
    render();
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
    SLIDERS.forEach(function (k) {
      ctl[k].value = state.params[k];
      ctl[k + "Val"].textContent = state.params[k];
    });
    wbCtl.checked = state.params.wb === 1;
    levelsCtl.checked = state.params.levels === 1;
    intensityCtl.value = state.intensity;
    intensityVal.textContent = state.intensity + "%";
  }

  function resetParams() {
    SLIDERS.forEach(function (k) { state.params[k] = 0; });
    state.params.wb = 0;
    state.params.levels = 0;
    syncControls();
  }

  function setParams(obj) {
    SLIDERS.forEach(function (k) { state.params[k] = obj[k] !== undefined ? obj[k] : 0; });
    state.params.wb = obj.wb !== undefined ? obj.wb : 0;
    state.params.levels = obj.levels !== undefined ? obj.levels : 0;
    syncControls();
    refreshBases();
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
    state.cur = ctx.createImageData(w, h);
    state.medianCache = null;
    state.blur3Cache = null;
    state.blur5Cache = null;
    state.compareMode = false;
    state.showOriginal = false;
    state.divX = 0.5;
    state.loaded = true;

    resetParams();
    workspace.classList.remove("hidden");
    dropzone.classList.add("hidden");
    compareBtn.classList.remove("active");
    workspace.classList.remove("comparing");

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

  // ---------- 示例老照片 ----------
  function generateDemo() {
    var w = 800, h = 600;
    var c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    var x = c.getContext("2d");

    var g = x.createLinearGradient(0, 0, 0, 420);
    g.addColorStop(0, "#9db8d8");
    g.addColorStop(1, "#efe6cf");
    x.fillStyle = g;
    x.fillRect(0, 0, w, 420);

    x.fillStyle = "#f5ecc2";
    x.beginPath();
    x.arc(620, 130, 46, 0, Math.PI * 2);
    x.fill();

    x.fillStyle = "rgba(255,255,255,0.85)";
    x.beginPath();
    x.arc(150, 120, 26, 0, Math.PI * 2);
    x.arc(190, 105, 32, 0, Math.PI * 2);
    x.arc(230, 120, 24, 0, Math.PI * 2);
    x.fill();

    x.fillStyle = "#96a7a0";
    x.beginPath();
    x.moveTo(0, 420); x.lineTo(140, 300); x.lineTo(300, 420); x.closePath(); x.fill();
    x.beginPath();
    x.moveTo(220, 420); x.lineTo(430, 280); x.lineTo(640, 420); x.closePath(); x.fill();

    x.fillStyle = "#c9b98a";
    x.fillRect(0, 420, w, 180);

    x.fillStyle = "#b3a074";
    x.beginPath();
    x.moveTo(300, 600); x.lineTo(360, 420); x.lineTo(440, 420); x.lineTo(500, 600); x.closePath(); x.fill();

    x.fillStyle = "#d8c4a2";
    x.fillRect(360, 430, 130, 90);
    x.fillStyle = "#a0522d";
    x.beginPath();
    x.moveTo(345, 430); x.lineTo(425, 385); x.lineTo(505, 430); x.closePath(); x.fill();
    x.fillStyle = "#7a5230";
    x.fillRect(410, 470, 30, 50);
    x.fillStyle = "#8aa6c8";
    x.fillRect(375, 450, 26, 26);
    x.fillRect(450, 450, 26, 26);

    x.fillStyle = "#8a6a48";
    x.fillRect(240, 470, 18, 60);
    x.fillStyle = "#6e8a5e";
    x.beginPath();
    x.arc(249, 440, 42, 0, Math.PI * 2);
    x.fill();

    // 旧化：降饱和 + 泛黄 + 噪点 + 暗角
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
      state.params = {
        wb: 1, levels: 1, temperature: 0, brightness: 2,
        contrast: 20, saturation: 15, clarity: 30, denoise: 25, sharpen: 45
      };
      syncControls();
      refreshBases();
      setBusy(false);
    }, 30);
  }

  // ---------- 预设 ----------
  var PRESETS = {
    bw:    { wb: 1, levels: 1, temperature: 0,   brightness: 0, contrast: 20, saturation: -100, clarity: 35, denoise: 25, sharpen: 50 },
    vivid: { wb: 1, levels: 1, temperature: 0,   brightness: 0, contrast: 25, saturation: 45,  clarity: 45, denoise: 15, sharpen: 45 },
    retro: { wb: 0, levels: 0, temperature: -50, brightness: -5, contrast: 15, saturation: -15, clarity: 20, denoise: 20, sharpen: 35 }
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

  SLIDERS.forEach(function (k) {
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

  wbCtl.addEventListener("change", function () {
    state.params.wb = wbCtl.checked ? 1 : 0;
    refreshBases();
  });
  levelsCtl.addEventListener("change", function () {
    state.params.levels = levelsCtl.checked ? 1 : 0;
    computeLUT();
    render();
  });

  $("autoBtn").addEventListener("click", autoRestore);
  $("resetBtn").addEventListener("click", function () {
    resetParams();
    refreshBases();
  });
  $("changeBtn").addEventListener("click", showUpload);

  $("presetBwBtn").addEventListener("click", function () { setParams(PRESETS.bw); });
  $("presetVividBtn").addEventListener("click", function () { setParams(PRESETS.vivid); });
  $("presetRetroBtn").addEventListener("click", function () { setParams(PRESETS.retro); });

  compareBtn.addEventListener("click", function () {
    state.compareMode = !state.compareMode;
    compareBtn.classList.toggle("active", state.compareMode);
    workspace.classList.toggle("comparing", state.compareMode);
    paint();
  });

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

  // 页脚年份
  document.getElementById("year").textContent = new Date().getFullYear();
})();
