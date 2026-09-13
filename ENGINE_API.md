# engine.js contract

Classic script (no ES modules, must work from `file://`). Exposes one global:

```js
window.TouchDrawEngine.create(canvas, options) -> engine
```

`options` (all optional, defaults shown):
```js
{
  mode: 'size',          // 'size' | 'opacity'  — which property pressure drives
  color: '#1a1a1a',
  size: 24,              // px at DPR 1. In 'size' mode = max width; in 'opacity' mode = fixed width
  opacity: 1,            // 0..1. In 'opacity' mode = max alpha; in 'size' mode = fixed alpha
  threshold: 0.12,       // normalized pressure (0..1) needed to start a stroke
  background: '#f7f4ee', // paper color, baked into export
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
- `'pressure'` → `(p)` normalized 0..1 pressure (webkitForce 0.85..2 mapped onto 0..1 with a 0.6 exponent, so a plain click ≈ 0.3 and a force click = 1), fired on every force change (also 0 on release). UI uses this for the live meter.
- `'strokestart'` → `()`
- `'strokeend'` → `()`
- `'change'` → `()` after clear/undo/strokeend so UI can refresh button states.

Input:
- Engine attaches its own listeners to `canvas` (mousedown/move/up, webkitmouseforcewillbegin/changed, contextmenu). It calls `preventDefault` on `webkitmouseforcewillbegin` to suppress Look Up.
- `TouchDrawEngine.supportsForce()` → boolean: true when `'webkitForce' in MouseEvent.prototype` (Safari on macOS).
- When force is unsupported, engine still works with a constant pressure of 0.5 while the button is down (so a fallback "continue anyway" works).
