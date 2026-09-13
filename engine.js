/* Canvas 2D pressure drawing. Samples in CSS pixels are the document;
   backing stores and coverage masks are disposable rendering caches. */
(function () {
  "use strict";

  function supportsForce() {
    return typeof window.MouseEvent !== "undefined" &&
      "webkitForce" in window.MouseEvent.prototype;
  }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function mix(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
      p: a.p + (b.p - a.p) * t };
  }
  function distance(a, b) {
    var x = b.x - a.x, y = b.y - a.y;
    return Math.sqrt(x * x + y * y);
  }
  function copy(o) {
    var result = {}, k;
    for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) result[k] = o[k];
    return result;
  }

  // Flatten midpoint quadratics, then resample by arc length. Pressure follows
  // the same quadratic and interpolation as position, including stationary input.
  function smooth(samples, spacing) {
    if (samples.length < 2) return samples.slice();
    var flat = [samples[0]], start = samples[0], i;
    function curve(a, c, b, depth) {
      var ac = mix(a, c, 0.5), cb = mix(c, b, 0.5), mid = mix(ac, cb, 0.5);
      if (depth < 12 && (distance(a, b) > spacing * 4 ||
          distance(mid, mix(a, b, 0.5)) > 0.15)) {
        curve(a, ac, mid, depth + 1);
        curve(mid, cb, b, depth + 1);
      } else { flat.push(b); }
    }
    for (i = 1; i < samples.length; i++) {
      var end = i === samples.length - 1 ? samples[i] : mix(samples[i], samples[i + 1], 0.5);
      curve(start, samples[i], end, 0);
      start = end;
    }
    var out = [flat[0]], remaining = spacing;
    for (i = 1; i < flat.length; i++) {
      var a = flat[i - 1], b = flat[i], len = distance(a, b);
      if (len < 0.0001) { out.push(b); continue; }
      while (len >= remaining) {
        a = mix(a, b, remaining / len);
        out.push(a);
        len = distance(a, b);
        remaining = spacing;
      }
      remaining -= len;
    }
    out.push(flat[flat.length - 1]);
    return out;
  }

  function create(canvas, options) {
    var opts = { mode: "size", color: "#1a1a1a", size: 24, opacity: 1,
      threshold: 0.12, background: "#f7f4ee" };
    function set(partial) {
      if (!partial) return;
      if (partial.mode === "size" || partial.mode === "opacity") opts.mode = partial.mode;
      if (typeof partial.color === "string") opts.color = partial.color;
      var keys = ["size", "opacity", "threshold"];
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i], v = partial[k];
        if (typeof v === "number" && isFinite(v)) {
          opts[k] = k === "size" ? Math.max(0.1, v) : clamp(v, 0, 1);
        }
      }
    }
    set(options);
    if (options && typeof options.background === "string") opts.background = options.background;
    var ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable");
    var base = document.createElement("canvas"), baseCtx = base.getContext("2d");
    var live = document.createElement("canvas"), liveCtx = live.getContext("2d");
    var strokes = [], history = [], listeners = {}, bindings = [];
    var gesture = null, path = null, ema = null, lastTime = 0;
    var dpr = 1, frame = null, destroyed = false, baseDirty = true;
    var hasForce = supportsForce(), renderedCount = 0;

    function emit(name, value) {
      var callbacks = (listeners[name] || []).slice();
      for (var i = 0; i < callbacks.length; i++) callbacks[i](value);
    }
    function bind(target, name, fn) {
      target.addEventListener(name, fn, false);
      bindings.push([target, name, fn]);
    }
    function schedule() {
      if (!destroyed && frame === null) frame = window.requestAnimationFrame(function () {
        frame = null;
        render();
      });
    }

    // Each tapered segment is the envelope of interpolated circles. Coverage
    // is MAX, never source-over: crossings and repeated samples cannot darken
    // either mode. Pixel-edge coverage supplies antialiasing at the current DPR.
    function renderStroke(target, stroke) {
      var style = stroke.style, paths = [], minX = Infinity, minY = Infinity;
      var maxX = -Infinity, maxY = -Infinity, i, j;
      var spacing = Math.max(0.25, Math.min(1, style.size / 8));
      for (i = 0; i < stroke.paths.length; i++) {
        var points = smooth(stroke.paths[i], spacing);
        paths.push(points);
        for (j = 0; j < points.length; j++) {
          var pt = points[j] = copy(points[j]);
          pt.r = Math.max(0.35, style.size * (style.mode === "size" ? pt.p : 1) / 2) * dpr;
          pt.x *= dpr; pt.y *= dpr;
          minX = Math.min(minX, pt.x - pt.r - 1); minY = Math.min(minY, pt.y - pt.r - 1);
          maxX = Math.max(maxX, pt.x + pt.r + 1); maxY = Math.max(maxY, pt.y + pt.r + 1);
        }
      }
      if (minX === Infinity) return;
      var left = Math.max(0, Math.floor(minX)), top = Math.max(0, Math.floor(minY));
      var right = Math.min(canvas.width, Math.ceil(maxX)), bottom = Math.min(canvas.height, Math.ceil(maxY));
      var w = right - left, h = bottom - top;
      if (w <= 0 || h <= 0) return;
      var coverage = new Uint8ClampedArray(w * h);
      function envelope(a, b) {
        var dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
        var len = Math.sqrt(len2), dr = b.r - a.r;
        var x0 = Math.max(left, Math.floor(Math.min(a.x - a.r, b.x - b.r) - 1));
        var y0 = Math.max(top, Math.floor(Math.min(a.y - a.r, b.y - b.r) - 1));
        var x1 = Math.min(right, Math.ceil(Math.max(a.x + a.r, b.x + b.r) + 1));
        var y1 = Math.min(bottom, Math.ceil(Math.max(a.y + a.r, b.y + b.r) + 1));
        for (var y = y0; y < y1; y++) {
          for (var x = x0; x < x1; x++) {
            var index = (y - top) * w + x - left;
            var ceiling = style.mode === "opacity" ? Math.round(255 * Math.max(a.p, b.p)) : 255;
            if (coverage[index] >= ceiling) continue;
            var px = x + 0.5 - a.x, py = y + 0.5 - a.y;
            var t = 0;
            if (len > 0.0001) {
              var along = (px * dx + py * dy) / len;
              var across = Math.abs(px * dy - py * dx) / len;
              // Minimize distance to the center minus interpolated radius.
              t = Math.abs(dr) < len ? clamp((along + dr * across /
                Math.sqrt(len2 - dr * dr)) / len, 0, 1) : (dr > 0 ? 1 : 0);
            } else if (b.r > a.r || b.p > a.p) { t = 1; }
            var ex = px - dx * t, ey = py - dy * t;
            var edge = clamp(a.r + dr * t + 0.5 - Math.sqrt(ex * ex + ey * ey), 0, 1);
            var alpha = style.mode === "opacity" ? a.p + (b.p - a.p) * t : 1;
            var value = Math.round(255 * edge * alpha);
            if (value > coverage[index]) coverage[index] = value;
          }
        }
      }
      for (i = 0; i < paths.length; i++) {
        var line = paths[i];
        for (j = 0; j < line.length; j++) {
          // Endpoint circles also preserve the maximum at stationary presses.
          envelope(line[j], line[j]);
          if (j) envelope(line[j - 1], line[j]);
        }
      }
      live.width = w; live.height = h;
      var pixels = liveCtx.createImageData(w, h);
      for (i = 0; i < coverage.length; i++) pixels.data[i * 4 + 3] = coverage[i];
      liveCtx.putImageData(pixels, 0, 0);
      liveCtx.globalCompositeOperation = "source-in";
      liveCtx.fillStyle = style.color;
      liveCtx.fillRect(0, 0, w, h);
      liveCtx.globalCompositeOperation = "source-over";
      target.save();
      target.globalAlpha = style.opacity;
      target.drawImage(live, left, top);
      target.restore();
    }
    function render() {
      if (destroyed) return;
      if (baseDirty) {
        baseCtx.clearRect(0, 0, base.width, base.height);
        baseCtx.fillStyle = opts.background;
        baseCtx.fillRect(0, 0, base.width, base.height);
        renderedCount = 0;
        baseDirty = false;
      }
      for (; renderedCount < strokes.length; renderedCount++) {
        renderStroke(baseCtx, strokes[renderedCount]);
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(base, 0, 0);
      if (gesture) renderStroke(ctx, gesture);
    }
    function flush() {
      if (frame !== null) { window.cancelAnimationFrame(frame); frame = null; }
      render();
    }
    function resize() {
      if (destroyed) return;
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
      canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
      base.width = canvas.width; base.height = canvas.height;
      baseDirty = true;
      schedule();
    }
    function pressureOf(e) {
      if (!hasForce) return gesture || (e.buttons & 1) ||
        (e.type === "mousedown" && e.button === 0) ? 0.5 : 0;
      var force = e.webkitForce;
      return typeof force === "number" && isFinite(force) ? clamp(force / 3, 0, 1) : 0;
    }
    function sample(e, p) {
      if (!gesture) return;
      var threshold = gesture.style.threshold;
      if (path && p <= threshold * 0.6) { path = null; ema = null; return; }
      if (!path) {
        if (p <= 0 || p < threshold) return;
        path = [];
        gesture.paths.push(path);
        ema = null;
      }
      var time = window.performance && window.performance.now ? window.performance.now() : Date.now();
      ema = ema === null ? p : ema + (p - ema) * (1 - Math.exp(-Math.max(0, time - lastTime) / 30));
      lastTime = time;
      var rect = canvas.getBoundingClientRect();
      var point = { x: e.clientX - rect.left, y: e.clientY - rect.top, p: ema };
      var previous = path[path.length - 1];
      if (!previous || previous.x !== point.x || previous.y !== point.y || previous.p !== point.p) {
        path.push(point);
        schedule();
      }
    }
    function finish() {
      emit("pressure", 0);
      if (!gesture) return;
      var ended = gesture;
      gesture = null; path = null; ema = null;
      if (ended.paths.length) {
        strokes.push(ended);
        history.push({ type: "stroke" });
      }
      schedule();
      emit("strokeend");
      emit("change");
    }
    function onDown(e) {
      emit("pressure", pressureOf(e));
      if (e.button !== 0 || destroyed) return;
      e.preventDefault();
      if (gesture) finish();
      gesture = { style: copy(opts), paths: [] };
      emit("strokestart");
      sample(e, pressureOf(e));
    }
    function onInput(e) {
      var lost = gesture && typeof e.buttons === "number" && !(e.buttons & 1);
      var p = lost && !hasForce ? 0 : pressureOf(e);
      emit("pressure", p);
      if (lost) { finish(); return; }
      if (gesture) { e.preventDefault(); sample(e, p); }
    }
    function outsideInput(e) {
      if (e.target !== canvas && gesture) onInput(e);
    }
    function onUp(e) {
      if (e.button === 0 || (gesture && !(e.buttons & 1))) finish();
    }
    function outsideUp(e) { if (e.target !== canvas) onUp(e); }
    function prevent(e) { e.preventDefault(); }
    bind(canvas, "mousedown", onDown);
    bind(canvas, "mousemove", onInput);
    bind(canvas, "mouseup", onUp);
    bind(canvas, "webkitmouseforcechanged", onInput);
    bind(canvas, "webkitmouseforcewillbegin", prevent);
    bind(canvas, "contextmenu", prevent);
    bind(window, "mousemove", outsideInput);
    bind(window, "webkitmouseforcechanged", outsideInput);
    bind(window, "mouseup", outsideUp);
    bind(window, "blur", finish);
    resize();

    return {
      set: function (partial) { if (!destroyed) set(partial); },
      get: function () { return copy(opts); },
      clear: function () {
        if (destroyed) return;
        if (gesture) finish();
        history.push({ type: "clear", strokes: strokes });
        strokes = [];
        baseDirty = true; schedule(); emit("change");
      },
      undo: function () {
        if (destroyed) return false;
        if (gesture) finish();
        var entry = history.pop();
        if (!entry) return false;
        if (entry.type === "clear") strokes = entry.strokes;
        else strokes.pop();
        baseDirty = true; schedule(); emit("change");
        return true;
      },
      canUndo: function () { return history.length > 0; },
      isEmpty: function () { return strokes.length === 0 && (!gesture || gesture.paths.length === 0); },
      toBlob: function (cb) { flush(); canvas.toBlob(cb, "image/png"); },
      resize: resize,
      on: function (event, cb) {
        if (destroyed) return function () {};
        (listeners[event] = listeners[event] || []).push(cb);
        return function () {
          var list = listeners[event] || [], index = list.indexOf(cb);
          if (index !== -1) list.splice(index, 1);
        };
      },
      destroy: function () {
        if (destroyed) return;
        if (gesture) finish();
        flush();
        destroyed = true;
        for (var i = 0; i < bindings.length; i++) {
          bindings[i][0].removeEventListener(bindings[i][1], bindings[i][2], false);
        }
        bindings = []; listeners = {}; strokes = []; history = [];
        base.width = base.height = live.width = live.height = 1;
      }
    };
  }
  window.TouchDrawEngine = { create: create, supportsForce: supportsForce };
})();
