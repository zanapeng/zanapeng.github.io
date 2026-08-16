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
    blurCache: null,    // 锐化缓存（3x3 高斯模糊）
    levelsLUT: null,    // 自动色阶 LUT（3 x 256）
    params: {
      temperature: 0,
      brightness: 0,
      contrast: 0,
      saturation: 0,
      denoise: 0,
      sharpen: 0,
      levels: 0
    },
    compareMode: false,
    showOriginal: false,
    divX: 0.5,          // 对比分隔线位置（0..1）
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

  var KEYS = ["temperature", "brightness", "contrast", "saturation", "denoise", "sharpen"];
  var ctl = {};
  KEYS.forEach(function (k) {
    ctl[k] = $(k);
    ctl[k + "Val"] = $(k + "Val");
  });
  var levelsCtl = $("levelsCtl");
  var compareBtn = $("compareBtn");
  var holdBtn = $("holdBtn");

  function setBusy(on) { busyEl.classList.toggle("hidden", !on); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // ---------- 图像算子 ----------

  // 3x3 中值滤波（逐通道插入排序，速度优先）
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

  // 3x3 高斯模糊（用于 unsharp 锐化）
  function gaussianBlur(img) {
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

  // 直方图百分位拉伸，生成每通道 LUT（0.5% ~ 99.5%）
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
  function getBlur() {
    if (!state.blurCache) state.blurCache = gaussianBlur(state.original);
    return state.blurCache;
  }

  // ---------- 渲染：结果画到离屏，再统一呈现 ----------
  function render() {
    if (!state.loaded) return;
    var w = state.width, h = state.height;
    var rctx = state.resultCanvas.getContext("2d");
    var src = state.original.data;
    var out = rctx.createImageData(w, h);
    var d = out.data;

    var p = state.params;
    var t = p.temperature / 100;          // -1..1，>0 去黄（降红升蓝）
    var bri = (p.brightness / 100) * 127;
    var cf = (100 + p.contrast) / 100;    // 0..2
    var sat = 1 + p.saturation / 100;     // 0..2
    var hasMedian = p.denoise > 0;
    var median = hasMedian ? getMedian() : null;
    var denA = p.denoise / 100;
    var hasBlur = p.sharpen > 0;
    var blur = hasBlur ? getBlur() : null;
    var shA = (p.sharpen / 100) * 1.6;
    var LUT = p.levels ? state.levelsLUT : null;

    var n = w * h;
    for (var i = 0; i < n; i++) {
      var j = i * 4;
      var r = src[j], g = src[j + 1], b = src[j + 2];

      // 0) 自动色阶（直方图拉伸）
      if (LUT) { r = LUT[0][r]; g = LUT[1][g]; b = LUT[2][b]; }
      // 1) 去黄/色温
      if (t !== 0) {
        r += -t * 60;
        b += t * 60;
      }
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
      // 5) 去噪
      if (hasMedian) {
        r = r + (median.data[j] - r) * denA;
        g = g + (median.data[j + 1] - g) * denA;
        b = b + (median.data[j + 2] - b) * denA;
      }
      // 6) 锐化（unsharp mask）
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

      // 分隔线 + 把手
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

      // 标签
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
  }

  function resetParams() {
    KEYS.forEach(function (k) { state.params[k] = 0; });
    state.params.levels = 0;
    syncControls();
  }

  // ---------- 图片加载 ----------
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

      state.origCanvas = document.createElement("canvas");
      state.origCanvas.width = w;
      state.origCanvas.height = h;
      var octx = state.origCanvas.getContext("2d");
      octx.drawImage(img, 0, 0, w, h);
      state.original = octx.getImageData(0, 0, w, h);

      state.resultCanvas = document.createElement("canvas");
      state.resultCanvas.width = w;
      state.resultCanvas.height = h;

      canvas.width = w;
      canvas.height = h;

      state.width = w;
      state.height = h;
      state.medianCache = null;
      state.blurCache = null;
      state.levelsLUT = computeLevelsLUT(state.original);
      state.compareMode = false;
      state.showOriginal = false;
      state.divX = 0.5;
      state.loaded = true;
      URL.revokeObjectURL(url);

      resetParams();
      workspace.classList.remove("hidden");
      dropzone.classList.add("hidden");
      compareBtn.classList.remove("active");
      workspace.classList.remove("comparing");
      render();
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
      // 旧照片偏黄：红绿高、蓝低 → 降红升蓝（t>0 = 去黄）
      var t = clamp(Math.round((mg - mb) / 1.5), -60, 60);

      state.params = {
        temperature: t,
        brightness: 0,
        contrast: 25,
        saturation: 18,
        denoise: 35,
        sharpen: 50,
        levels: 1
      };
      syncControls();
      render();
      setBusy(false);
    }, 30);
  }

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

  KEYS.forEach(function (k) {
    ctl[k].addEventListener("input", function () {
      state.params[k] = Number(ctl[k].value);
      ctl[k + "Val"].textContent = ctl[k].value;
      scheduleRender();
    });
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

  // 前后对比开关
  compareBtn.addEventListener("click", function () {
    state.compareMode = !state.compareMode;
    compareBtn.classList.toggle("active", state.compareMode);
    workspace.classList.toggle("comparing", state.compareMode);
    paint();
  });

  // 按住看原图
  ["pointerdown"].forEach(function (ev) {
    holdBtn.addEventListener(ev, function (e) {
      e.preventDefault();
      state.showOriginal = true;
      paint();
    });
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
