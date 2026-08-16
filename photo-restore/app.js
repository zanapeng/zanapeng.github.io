/* 老照片修复 —— 纯前端本地图像处理 */
(function () {
  "use strict";

  var MAX_DIM = 2000; // 处理长边上限，超出自动缩放，保证流畅

  var state = {
    loaded: false,
    width: 0,
    height: 0,
    original: null,   // 原始 ImageData
    medianCache: null,// 去噪缓存（3x3 中值）
    blurCache: null,  // 锐化缓存（3x3 高斯模糊）
    params: {
      temperature: 0,
      brightness: 0,
      contrast: 0,
      saturation: 0,
      denoise: 0,
      sharpen: 0
    }
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

  function setBusy(on) {
    busyEl.classList.toggle("hidden", !on);
  }

  // ---------- 工具函数 ----------
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

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
        // 插入排序求中值
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

  function getMedian() {
    if (!state.medianCache) state.medianCache = medianFilter(state.original);
    return state.medianCache;
  }

  function getBlur() {
    if (!state.blurCache) state.blurCache = gaussianBlur(state.original);
    return state.blurCache;
  }

  // ---------- 主渲染管线 ----------
  function render() {
    if (!state.loaded) return;
    var w = state.width, h = state.height;
    var src = state.original.data;
    var out = ctx.createImageData(w, h);
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

    var n = w * h;
    for (var i = 0; i < n; i++) {
      var j = i * 4;
      var r = src[j], g = src[j + 1], b = src[j + 2];

      // 1) 去黄/色温
      if (t !== 0) {
        r += -t * 25;
        b += t * 25;
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
      // 5) 去噪（与原图按强度混合）
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

    ctx.putImageData(out, 0, 0);
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
  }

  function resetParams() {
    KEYS.forEach(function (k) { state.params[k] = 0; });
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
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(img, 0, 0, w, h);
      state.original = ctx.getImageData(0, 0, w, h);
      state.width = w;
      state.height = h;
      state.medianCache = null;
      state.blurCache = null;
      state.loaded = true;
      URL.revokeObjectURL(url);

      resetParams();
      dropzone.classList.add("hidden");
      workspace.classList.remove("hidden");
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
      // 黄旧照片：红绿高、蓝低 → 提高蓝、降低红（t>0 = 去黄）
      var t = clamp(Math.round((mg - mb) / 2.5), -100, 100);

      state.params = {
        temperature: t,
        brightness: 0,
        contrast: 18,
        saturation: 14,
        denoise: 22,
        sharpen: 35
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

  $("autoBtn").addEventListener("click", autoRestore);
  $("resetBtn").addEventListener("click", function () {
    resetParams();
    render();
  });
  $("changeBtn").addEventListener("click", showUpload);

  var compareBtn = $("compareBtn");
  ["pointerdown", "touchstart"].forEach(function (ev) {
    compareBtn.addEventListener(ev, function (e) {
      e.preventDefault();
      if (state.loaded) ctx.putImageData(state.original, 0, 0);
    });
  });
  ["pointerup", "pointerleave", "pointercancel", "touchend"].forEach(function (ev) {
    compareBtn.addEventListener(ev, function () {
      if (state.loaded) render();
    });
  });

  $("downloadBtn").addEventListener("click", function () {
    if (!state.loaded) return;
    var a = document.createElement("a");
    var ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.download = "restored-" + ts + ".png";
    a.href = canvas.toDataURL("image/png");
    a.click();
  });

  // 页脚年份
  document.getElementById("year").textContent = new Date().getFullYear();
})();
