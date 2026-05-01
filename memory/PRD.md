# PRD — KindBot Face Engine

## Original problem statement
Lightweight, production-ready "KindBot Face Engine" for a Raspberry Pi 5" screen
running Chromium kiosk. The exact provided SVG face rig MUST be animated using
transforms only (CSS transforms or `requestAnimationFrame`) — no geometry
mutation, no asset swaps. States: idle, talking, listening, music_mode,
cleaning_mode. MP4 modes (music.mp4, cleaning.mp4) play fullscreen, autoplay,
looped, no controls. Talking interrupts MP4; when talking stops, restore the
previous mode. Fade transitions 200–300ms — no hard cuts. JSON API for Home
Assistant + OpenClaw. Single Docker container.

## User choices (Iteration 1)
- Stack: pure Node.js (Express) + static HTML/CSS/JS in single Docker container
- MP4 assets: user uploads later
- Auth: Bearer token in `Authorization` header (HTTPS only)
- Run inside preview environment in addition to producing Docker artifacts
- Idle motion: subtle vertical bob + tiny rotation
- Background: pure white (Iteration 1.1)

## User personas
- **End user (kiosk)** — passive viewer of the face on the Pi screen
- **Home Assistant / OpenClaw integrator** — POSTs to `/api/mode/*`
- **Operator (you)** — runs `docker compose up`, swaps MP4 assets

## Architecture
- **Production target** (`/app/src` + `/app/public` + `/app/Dockerfile` +
  `/app/docker-compose.yml`): single Node.js Express container serving the
  kiosk and the API on port 8080.
- **Preview environment** (`/app/backend` FastAPI on :8001 +
  `/app/frontend` React on :3000): functional mirror of the spec for testing
  in this Kubernetes-managed environment.
- Shared state semantics: `{mode, listening, prev_mode}` with talking as an
  overlay that restores the previous mode on stop.
- Real-time state push: Server-Sent Events on `/api/stream`.

## Implemented (2026-02-01)
- ✅ FastAPI backend with bearer-token auth, `FaceState` singleton, SSE stream,
  all 7 mode endpoints, `/api/health`, `/api/state`. (`/app/backend/server.py`)
- ✅ React kiosk: inline SVG rig (verbatim), idle bob keyframes, blink loop,
  talking mouth `requestAnimationFrame` loop, listening eye scale, MP4
  fullscreen layer with 280ms fade, SSE auto-reconnect, HUD with mode +
  connection dot. (`/app/frontend/src/App.js`, `App.css`, `index.css`)
- ✅ Production Node.js Express server + state module (`/app/src/server.js`,
  `state.js`)
- ✅ Static kiosk HTML/CSS/JS (`/app/public/index.html`, `styles.css`, `app.js`)
- ✅ Dockerfile (multi-stage, alpine, non-root, healthcheck) +
  docker-compose.yml (env-driven, MP4 bind mount)
- ✅ End-to-end testing passed (12/12 backend, all frontend reactivity checks)

## Implemented (2026-02-01, v1.1)
- ✅ Pure white background (replacing the cream theme)
- ✅ "Made with Emergent" badge removed from preview kiosk
- ✅ **`/api/say` TTS lip-sync** (OpenAI TTS via `emergentintegrations`
  / `openai` SDK in Node). Server flips to `talking`, broadcasts a `say`
  SSE event, auto-restores previous mode after audio ends.
- ✅ **Web Audio API amplitude-driven mouth** — kiosk uses an
  `AnalyserNode` on the playing TTS audio and writes the lower-mid
  frequency energy to `mouth.style.transform = scale(...)` per frame
  (transforms only — rig is still untouched).
- ✅ Cache + serve generated MP3s at `/api/say/<id>.mp3`
  (in-memory, 10-min TTL, 32-entry cap).
- ✅ End-to-end testing passed (19/19 backend, all frontend flows).

## What's remaining / backlog
**P0**
- Provide real `music.mp4` / `cleaning.mp4` assets — *user-supplied; not blocking*

**P1**
- Add a small WebSocket fallback alongside SSE for environments where SSE is
  proxied poorly (most modern reverse proxies handle SSE fine)
- Optional: add an `/api/mode/sleep` or `/api/mode/error` state with a distinct
  visual (e.g. closed eyes / red eyes) for richer kiosk signalling

**P2**
- Multi-kiosk mode-set broadcasting from a central HA instance (already works
  thanks to SSE — multiple browsers get the same state — but could add a
  "device id" tag for selective fan-out)
- Optional metrics endpoint (`/api/metrics`) for Prometheus
- Reduced-motion accessibility variant

## Test credentials
See `/app/memory/test_credentials.md` (Bearer token).
