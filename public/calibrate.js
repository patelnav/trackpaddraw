/* Automatic force calibration. Learns each person's full-pressure point from
   the hardest press of their recent strokes, so nobody has to calibrate. */
(function () {
  "use strict";

  var DEFAULT_MAX = 3;     // webkitForce: click = 1, force click = 2, deep press ~3
  var FLOOR = 1.6;         // never demand less than a firm click for full size
  var CEILING = 3.5;
  var HISTORY = 30;        // stroke peaks remembered
  var MIN_STROKES = 5;     // before shrinking toward a learned target
  var SHRINK_RATE = 0.2;   // fraction of the gap closed per stroke when lowering

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function percentile(values, q) {
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  }

  // state: { forceMax: number, peaks: number[] }. Returns the next state.
  function afterStroke(state, strokePeak) {
    var forceMax = typeof state.forceMax === "number" ? state.forceMax : DEFAULT_MAX;
    var peaks = (state.peaks || []).slice();
    // Ignore strokes that never got past a plain click; they say nothing about range.
    if (!(strokePeak > 1.05)) return { forceMax: forceMax, peaks: peaks };
    peaks.push(strokePeak);
    if (peaks.length > HISTORY) peaks = peaks.slice(peaks.length - HISTORY);

    if (strokePeak > forceMax) {
      // Pressing past full must always do something: expand right away.
      forceMax = strokePeak;
    } else if (peaks.length >= MIN_STROKES) {
      // Full size sits just above this person's hard presses.
      var target = percentile(peaks, 0.9) * 1.08;
      if (target < forceMax) forceMax += (target - forceMax) * SHRINK_RATE;
    }
    return { forceMax: +clamp(forceMax, FLOOR, CEILING).toFixed(3), peaks: peaks };
  }

  window.TouchDrawCalibration = { afterStroke: afterStroke, DEFAULT_MAX: DEFAULT_MAX };
})();
