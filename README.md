# Touch Draw

Draw with your MacBook's Force Touch trackpad in Safari. Press lightly to start, press harder for more.

- **Pressure → Size**: harder press, thicker line. Opacity is fixed by the slider.
- **Pressure → Opacity**: harder press, darker line. Size is fixed by the slider.
- Color swatches plus a custom picker, undo (⌘Z), clear, save PNG (⌘S).
- Keys: `1` / `2` switch mode, `[` `]` size, `-` `=` opacity.

## Why Safari only

Trackpad pressure reaches the web only through Safari's proprietary Force Touch events
(`event.webkitForce`, `webkitmouseforcechanged`). Chrome, Firefox and Edge report a flat
`PointerEvent.pressure` of 0.5 for any click. Other browsers see a notice with a "continue
without pressure" fallback.

## Run

No build step. Open `index.html` in Safari, or serve the folder statically (GitHub Pages works).

## Files

- `index.html`, `style.css`, `ui.js` — UI shell, toolbar, Safari gate, keyboard shortcuts.
- `engine.js` — canvas drawing engine (input, pressure, stroke rendering, undo, export). API in `ENGINE_API.md`.
