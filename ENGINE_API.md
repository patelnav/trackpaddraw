# engine.js contract

Classic script (no ES modules, must work from `file://`). Exposes one global:

```js
window.TouchDrawEngine.create(canvas, options) -> engine
```

`options` (all optional, defaults shown):
```js
{
  mode: 'size',          // 'size' | 'opacity'  — which property pressure drives
  color: '#1a1a1a',    // hex, or the string 'rainbow': hue advances 0.6° per CSS px of travel, hsl(h 85% 55%), continuing across strokes
  size: 24,              // px at DPR 1. In 'size' mode = max width; in 'opacity' mode = fixed width
  opacity: 1,            // 0..1. In 'opacity' mode = max alpha; in 'size' mode = fixed alpha
  threshold: 0.12,       // normalized pressure (0..1) needed to start a stroke (UI passes 0.08)
  background: '#f7f4ee', // paper color, baked into export
  forceMax: 3,           // raw webkitForce treated as full pressure (1.2..4); ui.js adapts it per person via calibrate.js
}
```

`engine` methods:
```js
engine.set({ mode, color, size, opacity, threshold })   // partial update, any subset
engine.get()                    // current options
engine.clear()                  // wipes to background, pushes undo entry
engine.undo()                   // returns true if something was undone
engine.canUndo()                // boolean
engine.isEmpty()                // no strokes since last clear
engine.toBlob(cb)               // PNG blob with background, at canvas DPR resolution
engine.resize()                 // call on window resize; must preserve drawing
engine.on(event, cb)            // returns unsubscribe fn
engine.destroy()
```

Events (`engine.on`):
- `'pressure'` → `(p)` normalized 0..1 pressure (webkitForce 0.85..3 mapped onto 0..1 with a 0.8 exponent, so a plain click ≈ 0.12, a force click ≈ 0.6, and the deepest press = 1), fired on every force change (also 0 on release). UI uses this for the live meter.
- `'force'` → `(raw)` raw `webkitForce` on every mousedown/mousemove/forcechanged (Safari only). ui.js uses it to learn each person's pressure range (calibrate.js) and for the ?debug readout.
- `'strokestart'` → `()`
- `'strokeend'` → `()`
- `'change'` → `()` after clear/undo/strokeend so UI can refresh button states.

Input:
- Engine attaches its own listeners to `canvas` (mousedown/move/up, webkitmouseforcewillbegin/changed, contextmenu). It calls `preventDefault` on `webkitmouseforcewillbegin` to suppress Look Up.
- `TouchDrawEngine.supportsForce()` → boolean: true when `'webkitForce' in MouseEvent.prototype` (Safari on macOS).
- When force is unsupported, engine still works with a constant pressure of 0.5 while the button is down (so a fallback "continue anyway" works).
