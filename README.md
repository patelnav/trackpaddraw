# Trackpad Draw

**https://trackpaddraw.com**

Draw on your MacBook trackpad, online, no install. Press lightly to start, press harder for more. Uses the trackpad's pressure sensitivity (Force Touch) in Safari.

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

No build step. Open `public/index.html` in Safari, or serve the folder statically.

## Deploy

Hosted as a Cloudflare Worker with static assets (`wrangler.jsonc`). Cloudflare builds and deploys every push to `main` from GitHub. Manual deploy:

```bash
CLOUDFLARE_ACCOUNT_ID=bd46952636ca619876c464e8389c274b npx wrangler deploy
```

## Files

- `public/index.html`, `public/style.css`, `public/ui.js` — UI shell, toolbar, Safari gate, keyboard shortcuts.
- `public/engine.js` — canvas drawing engine (input, pressure, stroke rendering, undo, export). API in `ENGINE_API.md`.
