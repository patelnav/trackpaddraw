/* Canvas 2D pressure drawing. Samples in CSS pixels are the document;
   backing stores and coverage masks are disposable rendering caches. */
(function () {
  "use strict";

  // Session hue advances only when a rainbow gesture ends, never on replay.
  var rainbowHue = 0, rainbowRGB = [];
  for (var hue = 0; hue < 360; hue++) {
    var chroma = (1 - Math.abs(2 * 0.55 - 1)) * 0.85;
    var secondary = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
    var offset = 0.55 - chroma / 2;
    var rgb = hue < 60 ? [chroma, secondary, 0] :
      hue < 120 ? [secondary, chroma, 0] : hue < 180 ? [0, chroma, secondary] :
      hue < 240 ? [0, secondary, chroma] : hue < 300 ? [secondary, 0, chroma] :
      [chroma, 0, secondary];
    rainbowRGB.push([Math.round((rgb[0] + offset) * 255),
      Math.round((rgb[1] + offset) * 255), Math.round((rgb[2] + offset) * 255)]);
  }

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

  function flattenCurve(a, c, b, spacing, emitPoint, depth) {
    var ac = mix(a, c, 0.5), cb = mix(c, b, 0.5), mid = mix(ac, cb, 0.5);
    if (depth < 12 && (distance(a, b) > spacing * 4 ||
        distance(mid, mix(a, b, 0.5)) > 0.15)) {
      flattenCurve(a, ac, mid, spacing, emitPoint, depth + 1);
      flattenCurve(mid, cb, b, spacing, emitPoint, depth + 1);
    } else { emitPoint(b); }
  }

  // Flatten midpoint quadratics, then resample by arc length. Pressure follows
  // the same quadratic and interpolation as position, including stationary input.
  function smooth(samples, spacing) {
    if (samples.length < 2) return samples.slice();
    var flat = [samples[0]], start = samples[0], i;

    for (i = 1; i < samples.length; i++) {
      var end = i === samples.length - 1 ? samples[i] : mix(samples[i], samples[i + 1], 0.5);
      flattenCurve(start, samples[i], end, spacing, function (point) { flat.push(point); }, 0);
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
    // Scratch canvas for replayed strokes (undo fallback, resize).
    var live = document.createElement("canvas"), liveCtx = live.getContext("2d");
    // Persistent full-size layer holding the colored pixels of the live gesture.
    // Only the rectangle touched each frame is uploaded to it and redrawn on screen.
    var layer = document.createElement("canvas"), layerCtx = layer.getContext("2d");
    var strokes = [], history = [], listeners = {}, bindings = [];
    var gesture = null, path = null, ema = null, lastTime = 0;
    var dpr = 1, frame = null, destroyed = false, baseDirty = true;
    var hasForce = supportsForce(), renderedCount = 0;
    var gestureMask = null, pendingMasks = [];
    // Coverage and hue buffers are allocated once per canvas size and zeroed by
    // rectangle after each gesture, instead of per pen-down.
    var coverageBuffer = null, hueBuffer = null;
    // Screen rectangles to repaint from base + layer on the next frame.
    var screenRects = [], fullBlit = true;
    // Undo patches: pixels of base under each committed stroke. Bumping the
    // generation (resize) invalidates all of them.
    var patchGeneration = 0, patchPixels = 0;

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
    function envelope(mask, style, a, b) {
      var left = mask.left, top = mask.top, w = mask.width;
      var right = left + w, bottom = top + mask.height, coverage = mask.coverage;
      var dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      var len = Math.sqrt(len2), dr = b.r - a.r;
      var x0 = Math.max(left, Math.floor(Math.min(a.x - a.r, b.x - b.r) - 1));
      var y0 = Math.max(top, Math.floor(Math.min(a.y - a.r, b.y - b.r) - 1));
      var x1 = Math.min(right, Math.ceil(Math.max(a.x + a.r, b.x + b.r) + 1));
      var y1 = Math.min(bottom, Math.ceil(Math.max(a.y + a.r, b.y + b.r) + 1));
      if (x1 <= x0 || y1 <= y0) return;
      if (mask.dirty) growRect(mask.dirty, x0, y0, x1, y1);
      var opacityMode = style.mode === "opacity";
      var ceiling = opacityMode ? Math.round(255 * Math.max(a.p, b.p)) : 255;
      for (var y = y0; y < y1; y++) {
        for (var x = x0; x < x1; x++) {
          var index = (y - top) * w + x - left;
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
          var alpha = opacityMode ? a.p + (b.p - a.p) * t : 1;
          var value = Math.round(255 * edge * alpha);
          if (value > coverage[index]) {
            coverage[index] = value;
            // Point hues stay unwrapped so interpolation crosses 360 correctly.
            if (mask.hues) mask.hues[index] = Math.round((a.hue + (b.hue - a.hue) * t) % 360) % 360;
          }
        }
      }
    }

    function emptyRect() { return { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }; }
    function growRect(r, x0, y0, x1, y1) {
      if (x0 < r.left) r.left = x0;
      if (y0 < r.top) r.top = y0;
      if (x1 > r.right) r.right = x1;
      if (y1 > r.bottom) r.bottom = y1;
    }
    // Integer rectangle clipped to the canvas, or null when empty.
    function clipRect(r) {
      if (!r) return null;
      var left = Math.max(0, Math.floor(r.left)), top = Math.max(0, Math.floor(r.top));
      var right = Math.min(canvas.width, Math.ceil(r.right)), bottom = Math.min(canvas.height, Math.ceil(r.bottom));
      return right > left && bottom > top ? { left: left, top: top, right: right, bottom: bottom } : null;
    }
    function boxRect(box) {
      return clipRect({ left: box.left, top: box.top, right: box.right, bottom: box.bottom });
    }
    var colorProbe = null;
    function solidRGB(color) {
      if (!colorProbe) colorProbe = document.createElement("canvas").getContext("2d");
      colorProbe.fillStyle = "#000000";
      colorProbe.fillStyle = color;
      var hex = colorProbe.fillStyle;
      if (typeof hex === "string" && hex.charAt(0) === "#" && hex.length === 7) {
        return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
      }
      return [0, 0, 0];
    }
    // Copy the colored coverage of one rectangle from the gesture buffers into
    // the persistent layer canvas. Alpha is coverage; color is the hue LUT or
    // the solid color, matching the old putImageData + source-in fill result.
    function uploadRect(mask, r) {
      var w = r.right - r.left, h = r.bottom - r.top;
      var pixels = layerCtx.createImageData(w, h), data = pixels.data;
      var coverage = mask.coverage, hues = mask.hues, rgb = mask.rgb, width = mask.width;
      for (var y = 0; y < h; y++) {
        var source = (r.top + y) * width + r.left, dest = y * w * 4;
        for (var x = 0; x < w; x++, dest += 4) {
          var value = coverage[source + x];
          if (!value) continue;
          if (hues) {
            var c = rainbowRGB[hues[source + x]];
            data[dest] = c[0]; data[dest + 1] = c[1]; data[dest + 2] = c[2];
          } else {
            data[dest] = rgb[0]; data[dest + 1] = rgb[1]; data[dest + 2] = rgb[2];
          }
          data[dest + 3] = value;
        }
      }
      layerCtx.putImageData(pixels, r.left, r.top);
    }
    function flushMaskToLayer(mask) {
      var r = clipRect(mask.dirty);
      mask.dirty = emptyRect();
      if (r) uploadRect(mask, r);
      return r;
    }
    // Forget a gesture that will not be committed: clear its layer pixels and
    // zero its buffer rows so the shared buffers stay clean for the next one.
    function releaseMask(mask) {
      var r = boxRect(mask.box);
      if (!r) return;
      layerCtx.clearRect(r.left, r.top, r.right - r.left, r.bottom - r.top);
      if (mask.coverage === coverageBuffer) {
        for (var y = r.top; y < r.bottom; y++) {
          coverageBuffer.fill(0, y * mask.width + r.left, y * mask.width + r.right);
        }
      }
      screenRects.push(r);
    }
    function discardPending() {
      for (var i = 0; i < pendingMasks.length; i++) releaseMask(pendingMasks[i].mask);
      pendingMasks = [];
    }

    function renderStroke(target, stroke) {
      var style = stroke.style, paths = [], minX = Infinity, minY = Infinity;
      var maxX = -Infinity, maxY = -Infinity, i, j, travelled = 0;
      var spacing = Math.max(0.25, Math.min(1, style.size / 8));
      for (i = 0; i < stroke.paths.length; i++) {
        var points = smooth(stroke.paths[i], spacing);
        paths.push(points);
        var previous = null;
        for (j = 0; j < points.length; j++) {
          var pt = points[j] = copy(points[j]);
          if (style.color === "rainbow") {
            if (previous) travelled += distance(previous, pt);
            previous = copy(pt);
            pt.distance = travelled;
            pt.hue = style.hueStart + travelled * 0.6;
          }
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
      var mask = { left: left, top: top, width: w, height: h,
        box: { left: left, top: top, right: right, bottom: bottom },
        coverage: new Uint8ClampedArray(w * h),
        hues: style.color === "rainbow" ? new Uint16Array(w * h) : null };

      for (i = 0; i < paths.length; i++) {
        var line = paths[i];
        for (j = 0; j < line.length; j++) {
          // Endpoint circles also preserve the maximum at stationary presses.
          envelope(mask, style, line[j], line[j]);
          if (j) envelope(mask, style, line[j - 1], line[j]);
        }
      }
      composite(target, mask, style);
    }
    function composite(target, mask, style) {
      var box = mask.box, left = box.left, top = box.top;
      var w = box.right - left, h = box.bottom - top;
      if (w <= 0 || h <= 0) return;
      live.width = w; live.height = h;
      var pixels = liveCtx.createImageData(w, h), data = pixels.data;
      for (var y = 0; y < h; y++) {
        var source = (top + y - mask.top) * mask.width + left - mask.left;
        var dest = y * w * 4 + 3;
        for (var x = 0; x < w; x++, dest += 4) {
          data[dest] = mask.coverage[source + x];
          if (mask.hues) {
            var rgb = rainbowRGB[mask.hues[source + x]];
            data[dest - 3] = rgb[0]; data[dest - 2] = rgb[1]; data[dest - 1] = rgb[2];
          }
        }
      }
      liveCtx.putImageData(pixels, 0, 0);
      if (style.color !== "rainbow") {
        liveCtx.globalCompositeOperation = "source-in";
        liveCtx.fillStyle = style.color;
        liveCtx.fillRect(0, 0, w, h);
        liveCtx.globalCompositeOperation = "source-over";
      }
      target.save();
      target.globalAlpha = style.opacity;
      target.drawImage(live, left, top);
      target.restore();
    }

    function newGestureMask() {
      var size = canvas.width * canvas.height;
      if (!coverageBuffer || coverageBuffer.length !== size) coverageBuffer = new Uint8ClampedArray(size);
      var rainbow = gesture.style.color === "rainbow";
      // Hues are only read where coverage is non-zero, and every coverage write
      // also writes the hue, so stale hues from earlier strokes are harmless.
      if (rainbow && (!hueBuffer || hueBuffer.length !== size)) hueBuffer = new Uint16Array(size);
      return { left: 0, top: 0, width: canvas.width, height: canvas.height,
        coverage: coverageBuffer, hues: rainbow ? hueBuffer : null,
        rgb: rainbow ? null : solidRGB(gesture.style.color),
        distance: 0,
        box: { left: canvas.width, top: canvas.height, right: 0, bottom: 0 },
        dirty: emptyRect(),
        pathIndex: 0, state: null, tail: null };
    }
    function devicePoint(point, style) {
      return { x: point.x * dpr, y: point.y * dpr, p: point.p,
        r: Math.max(0.35, style.size * (style.mode === "size" ? point.p : 1) / 2) * dpr };
    }
    function expand(box, point) {
      box.left = Math.max(0, Math.min(box.left, Math.floor(point.x - point.r - 1)));
      box.top = Math.max(0, Math.min(box.top, Math.floor(point.y - point.r - 1)));
      box.right = Math.min(canvas.width, Math.max(box.right, Math.ceil(point.x + point.r + 1)));
      box.bottom = Math.min(canvas.height, Math.max(box.bottom, Math.ceil(point.y + point.r + 1)));
    }
    function rasterPoint(mask, style, state, point) {
      var next = devicePoint(point, style);
      if (mask.hues) {
        if (state.point) state.distance += distance(state.point, point);
        state.point = point;
        next.distance = state.distance;
        next.hue = style.hueStart + state.distance * 0.6;
      }
      expand(mask.box, next);
      envelope(mask, style, next, next);
      if (state.last) envelope(mask, style, state.last, next);
      state.last = next;
    }
    // This is smooth()'s resampler with its arc-length remainder retained across
    // frames. next is the first raw control point not yet finalized; last is the
    // last rasterized resampled point. Neither stored samples nor prefixes move.
    function resampleFlat(state, b, spacing, emitPoint) {
      var a = state.flat, len = distance(a, b);
      if (len < 0.0001) {
        emitPoint(b);
      } else {
        while (len >= state.remaining) {
          a = mix(a, b, state.remaining / len);
          emitPoint(a);
          len = distance(a, b);
          state.remaining = spacing;
        }
        state.remaining -= len;
      }
      state.flat = b;
    }
    function restoreTail(mask) {
      var tail = mask.tail;
      if (!tail) return;
      if (mask.dirty) growRect(mask.dirty, tail.left, tail.top, tail.left + tail.width, tail.top + tail.height);
      for (var y = 0; y < tail.height; y++) {
        mask.coverage.set(tail.pixels.subarray(y * tail.width, (y + 1) * tail.width),
          (tail.top + y) * mask.width + tail.left);
        if (mask.hues) mask.hues.set(tail.hues.subarray(y * tail.width, (y + 1) * tail.width),
          (tail.top + y) * mask.width + tail.left);
      }
      mask.tail = null;
    }
    function saveTail(mask, points, last, style) {
      var box = { left: canvas.width, top: canvas.height, right: 0, bottom: 0 };
      if (last) expand(box, last);
      for (var i = 0; i < points.length; i++) expand(box, devicePoint(points[i], style));
      var w = box.right - box.left, h = box.bottom - box.top;
      if (w <= 0 || h <= 0) return;
      var pixels = new Uint8ClampedArray(w * h);
      var hues = mask.hues ? new Uint16Array(w * h) : null;
      for (var y = 0; y < h; y++) {
        var offset = (box.top + y) * mask.width + box.left;
        pixels.set(mask.coverage.subarray(offset, offset + w), y * w);
        if (hues) hues.set(mask.hues.subarray(offset, offset + w), y * w);
      }
      mask.tail = { left: box.left, top: box.top, width: w, height: h, pixels: pixels, hues: hues };
    }
    function updateGestureMask(mask, stroke) {
      var style = stroke.style, spacing = Math.max(0.25, Math.min(1, style.size / 8));
      restoreTail(mask);
      while (mask.pathIndex < stroke.paths.length) {
        var samples = stroke.paths[mask.pathIndex], n = samples.length;
        if (!n) { mask.pathIndex++; continue; }
        var state = mask.state;
        if (!state) {
          state = mask.state = { next: 1, flat: samples[0], remaining: spacing, last: null,
            point: null, distance: mask.distance };
          rasterPoint(mask, style, state, samples[0]);
        }
        var emitStable = function (point) { rasterPoint(mask, style, state, point); };
        var feedStable = function (point) { resampleFlat(state, point, spacing, emitStable); };
        var limit = samples.closed ? n : n - 1;
        for (; state.next < limit; state.next++) {
          var i = state.next;
          var start = i === 1 ? samples[0] : mix(samples[i - 1], samples[i], 0.5);
          var end = i === n - 1 ? samples[i] : mix(samples[i], samples[i + 1], 0.5);
          flattenCurve(start, samples[i], end, spacing, feedStable, 0);
        }
        if (samples.closed) {
          if (n > 1) emitStable(samples[n - 1]);
          mask.distance = state.distance;
          mask.pathIndex++;
          mask.state = null;
          continue;
        }
        if (n > 1) {
          // The last quadratic changes when another sample arrives. Temporarily
          // rasterize it over a saved rectangle, then restore before appending
          // stable coverage next frame. This avoids permanent tail artifacts.
          var preview = { flat: state.flat, remaining: state.remaining, last: state.last,
            point: state.point, distance: state.distance };
          var points = [];
          var emitPreview = function (point) { points.push(point); };
          var feedPreview = function (point) { resampleFlat(preview, point, spacing, emitPreview); };
          var tailStart = n === 2 ? samples[0] : mix(samples[n - 2], samples[n - 1], 0.5);
          flattenCurve(tailStart, samples[n - 1], samples[n - 1], spacing, feedPreview, 0);
          points.push(samples[n - 1]);
          saveTail(mask, points, state.last, style);
          for (var j = 0; j < points.length; j++) rasterPoint(mask, style, preview, points[j]);
        }
        break;
      }
    }

    // Save the base pixels under a stroke so undo can paste them back.
    function savePatch(stroke, r) {
      var w = r.right - r.left, h = r.bottom - r.top;
      var patch = document.createElement("canvas");
      patch.width = w; patch.height = h;
      patch.getContext("2d").drawImage(base, r.left, r.top, w, h, 0, 0, w, h);
      stroke.patch = { canvas: patch, left: r.left, top: r.top, generation: patchGeneration };
      patchPixels += w * h;
      // Bound memory to a few canvases' worth; drop the oldest patches first.
      var limit = canvas.width * canvas.height * 4;
      for (var i = 0; patchPixels > limit && i < strokes.length; i++) dropPatch(strokes[i]);
    }
    function dropPatch(stroke) {
      if (!stroke || !stroke.patch) return;
      patchPixels -= stroke.patch.canvas.width * stroke.patch.canvas.height;
      stroke.patch.canvas.width = stroke.patch.canvas.height = 0;
      stroke.patch = null;
    }
    function commitMask(mask, stroke) {
      updateGestureMask(mask, stroke);
      flushMaskToLayer(mask);
      var r = boxRect(mask.box);
      if (!r) return;
      var w = r.right - r.left, h = r.bottom - r.top;
      savePatch(stroke, r);
      baseCtx.save();
      baseCtx.globalAlpha = stroke.style.opacity;
      baseCtx.drawImage(layer, r.left, r.top, w, h, r.left, r.top, w, h);
      baseCtx.restore();
      releaseMask(mask);
    }
    function blit(r) {
      var w = r.right - r.left, h = r.bottom - r.top;
      ctx.drawImage(base, r.left, r.top, w, h, r.left, r.top, w, h);
      if (gesture && gestureMask) {
        ctx.save();
        ctx.globalAlpha = gesture.style.opacity;
        ctx.drawImage(layer, r.left, r.top, w, h, r.left, r.top, w, h);
        ctx.restore();
      }
    }
    function render() {
      if (destroyed) return;
      if (baseDirty) {
        baseCtx.clearRect(0, 0, base.width, base.height);
        baseCtx.fillStyle = opts.background;
        baseCtx.fillRect(0, 0, base.width, base.height);
        renderedCount = 0;
        baseDirty = false;
        fullBlit = true;
      }
      for (; renderedCount < strokes.length; renderedCount++) {
        var stroke = strokes[renderedCount], cached = null;
        for (var i = 0; i < pendingMasks.length; i++) {
          if (pendingMasks[i].stroke === stroke) {
            cached = pendingMasks.splice(i, 1)[0].mask;
            break;
          }
        }
        if (cached) commitMask(cached, stroke);
        else { dropPatch(stroke); renderStroke(baseCtx, stroke); fullBlit = true; }
      }
      if (gesture && gestureMask) {
        updateGestureMask(gestureMask, gesture);
        var dirty = flushMaskToLayer(gestureMask);
        if (dirty) screenRects.push(dirty);
      }
      if (fullBlit) {
        ctx.drawImage(base, 0, 0);
        var box = gesture && gestureMask ? boxRect(gestureMask.box) : null;
        if (box) {
          ctx.save();
          ctx.globalAlpha = gesture.style.opacity;
          ctx.drawImage(layer, box.left, box.top, box.right - box.left, box.bottom - box.top,
            box.left, box.top, box.right - box.left, box.bottom - box.top);
          ctx.restore();
        }
        fullBlit = false;
      } else {
        for (var k = 0; k < screenRects.length; k++) blit(screenRects[k]);
      }
      screenRects = [];
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
      layer.width = canvas.width; layer.height = canvas.height;
      coverageBuffer = null; hueBuffer = null;
      pendingMasks = []; screenRects = [];
      patchGeneration++;
      for (var i = 0; i < strokes.length; i++) dropPatch(strokes[i]);
      if (gesture) gestureMask = newGestureMask();
      baseDirty = true;
      schedule();
    }
    function pressureOf(e) {
      if (!hasForce) return gesture || (e.buttons & 1) ||
        (e.type === "mousedown" && e.button === 0) ? 0.5 : 0;
      var force = e.webkitForce;
      // Safari: plain click = 1 (WEBKIT_FORCE_AT_MOUSE_DOWN), force click = 2.
      // Most presses stay between 1 and 2, so that span is the whole range:
      // plain click ~0.15, force click = 1. The 0.6 exponent makes light
      // extra pressure respond quickly instead of needing a hard push.
      if (typeof force !== "number" || !isFinite(force)) return 0;
      var linear = clamp((force - 0.85) / 1.15, 0, 1);
      return Math.pow(linear, 0.6);
    }
    function sample(e, p) {
      if (!gesture) return;
      var threshold = gesture.style.threshold;
      if (path && p <= threshold * 0.6) {
        path.closed = true; path = null; ema = null; schedule(); return;
      }
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
      if (path) path.closed = true;
      if (ended.style.color === "rainbow") {
        // Account for input not yet rendered, without forcing raster work here.
        var travelled = 0, spacing = Math.max(0.25, Math.min(1, ended.style.size / 8));
        for (var i = 0; i < ended.paths.length; i++) {
          var points = smooth(ended.paths[i], spacing);
          for (var j = 1; j < points.length; j++) travelled += distance(points[j - 1], points[j]);
        }
        rainbowHue = (ended.style.hueStart + travelled * 0.6) % 360;
      }
      if (ended.paths.length) pendingMasks.push({ stroke: ended, mask: gestureMask });
      gestureMask = null;
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
      if (pendingMasks.length) flush();
      gesture = { style: copy(opts), paths: [] };
      if (gesture.style.color === "rainbow") gesture.style.hueStart = rainbowHue;
      gestureMask = newGestureMask();
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
        discardPending();
        flush();
        // Keep a copy of the whole drawing so undoing a clear is one paste.
        var snapshot = document.createElement("canvas");
        snapshot.width = base.width; snapshot.height = base.height;
        snapshot.getContext("2d").drawImage(base, 0, 0);
        for (var i = 0; i < history.length; i++) {
          if (history[i].snapshot) { history[i].snapshot.width = history[i].snapshot.height = 0; history[i].snapshot = null; }
        }
        history.push({ type: "clear", strokes: strokes, snapshot: snapshot, generation: patchGeneration });
        strokes = [];
        baseDirty = true; schedule(); emit("change");
      },
      undo: function () {
        if (destroyed) return false;
        if (gesture) finish();
        var entry = history.pop();
        if (!entry) return false;
        if (entry.type === "clear") {
          strokes = entry.strokes;
          if (entry.snapshot && entry.generation === patchGeneration && !baseDirty) {
            baseCtx.drawImage(entry.snapshot, 0, 0);
            renderedCount = strokes.length;
            fullBlit = true;
          } else { baseDirty = true; }
          if (entry.snapshot) { entry.snapshot.width = entry.snapshot.height = 0; entry.snapshot = null; }
        } else {
          var stroke = strokes.pop();
          if (strokes.length >= renderedCount) {
            // Never reached base: just forget its pending layer pixels.
            for (var i = 0; i < pendingMasks.length; i++) {
              if (pendingMasks[i].stroke === stroke) { releaseMask(pendingMasks[i].mask); pendingMasks.splice(i, 1); break; }
            }
            renderedCount = Math.min(renderedCount, strokes.length);
          } else if (stroke.patch && stroke.patch.generation === patchGeneration && !baseDirty) {
            var patch = stroke.patch;
            baseCtx.drawImage(patch.canvas, patch.left, patch.top);
            screenRects.push({ left: patch.left, top: patch.top,
              right: patch.left + patch.canvas.width, bottom: patch.top + patch.canvas.height });
            renderedCount = strokes.length;
          } else {
            discardPending();
            baseDirty = true;
          }
          dropPatch(stroke);
        }
        schedule(); emit("change");
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
        gestureMask = null; pendingMasks = [];
        base.width = base.height = live.width = live.height = layer.width = layer.height = 1;
        coverageBuffer = hueBuffer = null;
      }
    };
  }
  window.TouchDrawEngine = { create: create, supportsForce: supportsForce };
})();
