(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var canvas = $("canvas");
  var cursor = $("cursor");
  var hint = $("hint");
  var gate = $("gate");
  var sizeGroup = $("sizeGroup");
  var opacityGroup = $("opacityGroup");
  var sizeInput = $("sizeInput");
  var opacityInput = $("opacityInput");
  var sizeOut = $("sizeOut");
  var opacityOut = $("opacityOut");
  var colorInput = $("colorInput");
  var customSwatch = colorInput.parentElement;
  var meterFill = $("meterFill");
  var meterTick = $("meterTick");
  var undoBtn = $("undoBtn");
  var clearBtn = $("clearBtn");
  var saveBtn = $("saveBtn");

  var STORAGE_KEY = "trackpad-draw.settings";
  var THRESHOLD = 0.12;

  var settings = load({
    mode: "size",
    color: "#1a1a1a",
    size: 24,
    opacity: 1,
  });

  var engine = TouchDrawEngine.create(canvas, {
    mode: settings.mode,
    color: settings.color,
    size: settings.size,
    opacity: settings.opacity,
    threshold: THRESHOLD,
    background: getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() || "#f7f4ee",
  });

  // ---- Safari gate ---------------------------------------------------------
  var hasForce = TouchDrawEngine.supportsForce();
  if (!hasForce && location.search.indexOf("nogate") === -1) {
    gate.hidden = false;
    document.body.classList.add("is-fallback");
    $("copyLinkBtn").addEventListener("click", function () {
      var status = $("copyStatus");
      var url = location.href;
      var done = function () { status.textContent = "Copied. Paste it into Safari."; };
      var fail = function () { status.textContent = url; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, fail);
      } else {
        fail();
      }
    });
    $("continueBtn").addEventListener("click", function () {
      gate.hidden = true;
      hint.textContent = "Click and drag to draw. Pressure is fixed in this browser.";
    });
  }

  // ---- Mode ----------------------------------------------------------------
  var segs = document.querySelectorAll(".seg");
  function setMode(mode) {
    settings.mode = mode;
    engine.set({ mode: mode });
    for (var i = 0; i < segs.length; i++) {
      segs[i].setAttribute("aria-checked", segs[i].dataset.mode === mode ? "true" : "false");
    }
    sizeGroup.classList.toggle("is-pressure", mode === "size");
    opacityGroup.classList.toggle("is-pressure", mode === "opacity");
    updateCursorSize();
    save();
  }
  for (var i = 0; i < segs.length; i++) {
    segs[i].addEventListener("click", function (e) { setMode(e.currentTarget.dataset.mode); });
  }

  // ---- Color ---------------------------------------------------------------
  var swatches = document.querySelectorAll(".swatch[data-color]");
  function setColor(color, fromCustom) {
    settings.color = color;
    engine.set({ color: color });
    cursor.style.borderColor = color;
    var matched = false;
    for (var i = 0; i < swatches.length; i++) {
      var on = !fromCustom && swatches[i].dataset.color.toLowerCase() === color.toLowerCase();
      swatches[i].classList.toggle("is-active", on);
      swatches[i].setAttribute("aria-checked", on ? "true" : "false");
      if (on) matched = true;
    }
    customSwatch.classList.toggle("is-active", !matched);
    customSwatch.classList.toggle("has-custom", !matched);
    if (!matched) customSwatch.style.setProperty("--c", color);
    colorInput.value = color;
    save();
  }
  for (var j = 0; j < swatches.length; j++) {
    swatches[j].addEventListener("click", function (e) { setColor(e.currentTarget.dataset.color, false); });
  }
  colorInput.addEventListener("input", function () { setColor(colorInput.value, true); });

  // ---- Sliders -------------------------------------------------------------
  function setSize(px) {
    settings.size = px;
    engine.set({ size: px });
    sizeInput.value = px;
    sizeOut.value = px;
    updateCursorSize();
    save();
  }
  function setOpacity(pct) {
    settings.opacity = pct / 100;
    engine.set({ opacity: pct / 100 });
    opacityInput.value = pct;
    opacityOut.value = pct;
    save();
  }
  sizeInput.addEventListener("input", function () { setSize(Number(sizeInput.value)); });
  opacityInput.addEventListener("input", function () { setOpacity(Number(opacityInput.value)); });

  // ---- Cursor ring ---------------------------------------------------------
  var lastPressure = 0;
  function updateCursorSize() {
    var base = settings.size;
    var d = settings.mode === "size" ? Math.max(3, base * Math.max(lastPressure, 0.15)) : base;
    if (!document.body.classList.contains("is-drawing") && settings.mode === "size") d = base;
    cursor.style.width = d + "px";
    cursor.style.height = d + "px";
  }
  canvas.addEventListener("mousemove", function (e) {
    cursor.style.transform = "translate(" + (e.clientX - 0) + "px, " + (e.clientY - 0) + "px) translate(-50%, -50%)";
    cursor.classList.add("is-visible");
  });
  canvas.addEventListener("mouseleave", function () { cursor.classList.remove("is-visible"); });
  canvas.addEventListener("mouseenter", function () { cursor.classList.add("is-visible"); });

  // ---- Engine events -------------------------------------------------------
  engine.on("pressure", function (p) {
    lastPressure = p;
    meterFill.style.transform = "scaleX(" + p.toFixed(3) + ")";
    cursor.classList.toggle("is-pressing", p >= THRESHOLD);
    if (document.body.classList.contains("is-drawing")) updateCursorSize();
  });
  engine.on("strokestart", function () {
    document.body.classList.add("is-drawing");
    hint.classList.add("is-hidden");
  });
  engine.on("strokeend", function () {
    document.body.classList.remove("is-drawing");
    updateCursorSize();
  });
  engine.on("change", refreshButtons);

  function refreshButtons() {
    undoBtn.disabled = !engine.canUndo();
  }

  // ---- Actions -------------------------------------------------------------
  undoBtn.addEventListener("click", function () { engine.undo(); refreshButtons(); });
  clearBtn.addEventListener("click", function () { engine.clear(); refreshButtons(); });
  saveBtn.addEventListener("click", savePNG);

  function savePNG() {
    engine.toBlob(function (blob) {
      if (!blob) return;
      var a = document.createElement("a");
      var d = new Date();
      var pad = function (n) { return (n < 10 ? "0" : "") + n; };
      a.download = "trackpad-draw-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + ".png";
      a.href = URL.createObjectURL(blob);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
  }

  // ---- Keyboard ------------------------------------------------------------
  document.addEventListener("keydown", function (e) {
    var meta = e.metaKey || e.ctrlKey;
    var tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" && e.target.type !== "range") return;
    if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); engine.undo(); refreshButtons(); return; }
    if (meta && e.key.toLowerCase() === "s") { e.preventDefault(); savePNG(); return; }
    if (meta) return;
    switch (e.key) {
      case "1": setMode("size"); break;
      case "2": setMode("opacity"); break;
      case "[": setSize(Math.max(2, settings.size - (settings.size > 20 ? 4 : 1))); break;
      case "]": setSize(Math.min(120, settings.size + (settings.size >= 20 ? 4 : 1))); break;
      case "-": setOpacity(Math.max(5, Math.round(settings.opacity * 100) - 5)); break;
      case "=": case "+": setOpacity(Math.min(100, Math.round(settings.opacity * 100) + 5)); break;
      default: return;
    }
    e.preventDefault();
  });

  // ---- Resize --------------------------------------------------------------
  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { engine.resize(); }, 60);
  });

  // ---- Persistence ---------------------------------------------------------
  function load(defaults) {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaults;
      var parsed = JSON.parse(raw);
      var out = {};
      for (var k in defaults) out[k] = parsed[k] != null ? parsed[k] : defaults[k];
      return out;
    } catch (err) { return defaults; }
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (err) { /* ignore */ }
  }

  // ---- Init ----------------------------------------------------------------
  meterTick.style.left = Math.round(THRESHOLD * 100) + "%";
  setMode(settings.mode);
  setColor(settings.color, false);
  setSize(settings.size);
  setOpacity(Math.round(settings.opacity * 100));
  refreshButtons();
})();
