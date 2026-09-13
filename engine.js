/* PLACEHOLDER engine — minimal implementation of ENGINE_API.md so the UI can be
   exercised. To be replaced by the Codex-authored engine. */
(function () {
  "use strict";

  function supportsForce() {
    return typeof MouseEvent !== "undefined" && "webkitForce" in MouseEvent.prototype;
  }

  function create(canvas, options) {
    var opts = {
      mode: "size", color: "#1a1a1a", size: 24, opacity: 1, threshold: 0.12, background: "#f7f4ee",
    };
    for (var k in options) if (options[k] != null) opts[k] = options[k];

    var ctx = canvas.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    var listeners = {};
    var undoStack = [];
    var drawing = false;
    var last = null;
    var hasForce = supportsForce();
    var strokes = 0;

    function emit(ev, arg) {
      var l = listeners[ev] || [];
      for (var i = 0; i < l.length; i++) l[i](arg);
    }

    function fill() {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = opts.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }

    function resize() {
      var snap = canvas.width ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
      fill();
      if (snap) ctx.putImageData(snap, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function pressureOf(e) {
      if (!hasForce) return e.buttons ? 0.5 : 0;
      return Math.max(0, Math.min(1, (e.webkitForce || 0) / 3));
    }

    function pushUndo() {
      undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
      if (undoStack.length > 20) undoStack.shift();
    }

    function segment(a, b, p) {
      var w = opts.mode === "size" ? Math.max(1, opts.size * p) : opts.size;
      var alpha = opts.mode === "opacity" ? opts.opacity * p : opts.opacity;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = opts.color;
      ctx.lineWidth = w;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    function onDown(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      last = { x: e.clientX, y: e.clientY };
      var p = pressureOf(e);
      emit("pressure", p);
      if (p >= opts.threshold) start(e);
    }
    function start(e) {
      drawing = true;
      pushUndo();
      strokes++;
      emit("strokestart");
      segment(last, last, pressureOf(e));
    }
    function onMove(e) {
      if (!(e.buttons & 1)) return;
      var p = pressureOf(e);
      emit("pressure", p);
      var pt = { x: e.clientX, y: e.clientY };
      if (!drawing && p >= opts.threshold) { last = pt; start(e); return; }
      if (drawing) { segment(last, pt, p); }
      last = pt;
    }
    function onForce(e) {
      var p = pressureOf(e);
      emit("pressure", p);
      if (!drawing && p >= opts.threshold && last) start(e);
    }
    function onUp() {
      emit("pressure", 0);
      if (drawing) { drawing = false; emit("strokeend"); emit("change"); }
      last = null;
    }

    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("webkitmouseforcewillbegin", function (e) { e.preventDefault(); });
    canvas.addEventListener("webkitmouseforcechanged", onForce);
    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    resize();

    return {
      set: function (partial) { for (var k in partial) if (partial[k] != null) opts[k] = partial[k]; },
      get: function () { var o = {}; for (var k in opts) o[k] = opts[k]; return o; },
      clear: function () { pushUndo(); fill(); strokes = 0; emit("change"); },
      undo: function () {
        var snap = undoStack.pop();
        if (!snap) return false;
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.putImageData(snap, 0, 0); ctx.restore();
        emit("change");
        return true;
      },
      canUndo: function () { return undoStack.length > 0; },
      isEmpty: function () { return strokes === 0; },
      toBlob: function (cb) { canvas.toBlob(cb, "image/png"); },
      resize: resize,
      on: function (ev, cb) {
        (listeners[ev] = listeners[ev] || []).push(cb);
        return function () { listeners[ev] = listeners[ev].filter(function (f) { return f !== cb; }); };
      },
      destroy: function () {
        canvas.removeEventListener("mousedown", onDown);
        canvas.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      },
    };
  }

  window.TouchDrawEngine = { create: create, supportsForce: supportsForce };
})();
