# KindBot Face Engine

A lightweight, production-ready SVG face engine for a **KindBot** kiosk
running on a Raspberry Pi 5" screen in Chromium kiosk mode.

The engine displays an inline-SVG character (the exact rig from the spec)
that reacts in real time to commands from Home Assistant, OpenClaw, or any
other HTTP client. It can also play fullscreen MP4 loops for `music_mode`
and `cleaning_mode`, and seamlessly fade back to the face when speaking
or going idle.

> **Core promise:** the provided SVG is rendered verbatim. Animation is done
> only with CSS transforms and `requestAnimationFrame` — never by mutating
> SVG geometry, swapping images, or rebuilding the face.

## Deployment topology

```
        ┌──────────────────────────────────────┐                ┌──────────────────────────────┐
        │  Hostinger VPS                       │                │  Raspberry Pi (display only) │
        │                                      │                │                              │
        │  ┌────────────────────┐              │                │  Chromium kiosk              │
        │  │  Traefik           │  HTTPS / SSE │   HTTPS / SSE  │  (5" screen, 800x480)        │
        │  │  (TLS termination) │ ◄────────────┼──────────────► │                              │
        │  └─────────┬──────────┘              │                │  Pointing at:                │
        │            │ docker net              │                │  https://kindbot.<your-      │
        │            ▼                         │                │             domain>.tld/     │
        │  ┌────────────────────┐              │                │                              │
        │  │  kindbot-face:8080 │              │                │                              │
        │  │  Express + SSE     │              │                │                              │
        │  └────────────────────┘              │                │                              │
        └──────────────┬───────────────────────┘                └──────────────────────────────┘
                       │
                       │ HTTPS POST /api/mode/* and /api/say
                       │ Authorization: Bearer <token>
                       │
        ┌──────────────┴───────────────────────┐
        │  Home Assistant / OpenClaw           │
        └──────────────────────────────────────┘
```

The Pi runs **only Chromium** in kiosk mode. All state, rendering, TTS, and
APIs live inside one Docker container on the Hostinger VPS, fronted by your
existing Traefik instance for HTTPS/TLS.

---

## Table of contents

1. [What's in the box](#whats-in-the-box)
2. [Architecture](#architecture)
3. [State machine](#state-machine)
4. [HTTP API](#http-api)
5. [Repository layout & file walkthrough](#repository-layout--file-walkthrough)
6. [Setup — production single-container (the Hostinger VPS)](#setup--production-single-container-the-hostinger-vps)
7. [Setup — Raspberry Pi kiosk client](#setup--raspberry-pi-kiosk-client)
8. [Setup — Home Assistant integration](#setup--home-assistant-integration)
9. [Setup — OpenClaw / generic clients](#setup--openclaw--generic-clients)
10. [Setup — preview environment (this repo, no Docker)](#setup--preview-environment-this-repo-no-docker)
11. [How the animations work](#how-the-animations-work)
12. [Troubleshooting](#troubleshooting)
13. [Suggested feature enhancements](#suggested-feature-enhancements)

---

## What's in the box

| Path | Purpose |
|---|---|
| `/app/pi-deploy/src/server.js`         | Production Node.js Express server (single container target) |
| `/app/pi-deploy/src/state.js`          | In-memory state machine (mirrors backend Python) |
| `/app/pi-deploy/public/index.html`     | Kiosk page with the inline SVG rig |
| `/app/pi-deploy/public/styles.css`     | Animations + layout |
| `/app/pi-deploy/public/app.js`         | Frontend logic — SSE subscription + transform-driven animations |
| `/app/pi-deploy/public/assets/mp4/`    | **You drop `music.mp4` and `cleaning.mp4` here** |
| `/app/pi-deploy/Dockerfile`            | Multi-stage Alpine image, non-root, healthchecked |
| `/app/pi-deploy/docker-compose.yml`    | One-command deployment |
| `/app/pi-deploy/package.json`          | Production deps (express, openai, music-metadata) |
| `/app/backend/server.py`               | Preview-environment FastAPI mirror (used in this repo's preview only) |
| `/app/frontend/`                       | Preview-environment React mirror (used in this repo's preview only) |
| `/app/memory/test_credentials.md`      | Bearer token for testing |

---

## Architecture

There are **two equivalent implementations** of the same engine:

### A. Production target (the Raspberry Pi VPS) — single Node.js container
```
┌──────────────────────────── one Docker container ───────────────────────────┐
│                                                                              │
│  Express :8080                                                               │
│   ├── GET  /                  → public/index.html                            │
│   ├── GET  /styles.css, /app.js, /assets/mp4/...                             │
│   ├── GET  /api/health        (open)                                         │
│   ├── GET  /api/state         (open) — JSON snapshot                         │
│   ├── GET  /api/stream        (open) — Server-Sent Events                    │
│   └── POST /api/mode/*        (Bearer token) — state mutations               │
│                                                                              │
│  In-memory FaceState  ←──────── publishes to all SSE subscribers ─────────┐  │
│  { mode, listening, prevMode }                                            │  │
└───────────────────────────────────────────────────────────────────────────┼──┘
                                                                            │
              ┌─────────────────────────────────────────────────────────────┘
              ▼
   Chromium kiosk on the Pi  ──── EventSource('/api/stream')
   renders public/index.html and animates the SVG via transforms

   Home Assistant / OpenClaw  ──── POST with `Authorization: Bearer …`
                                   to /api/mode/{music,cleaning,idle,
                                                  talking/start, talking/stop,
                                                  listening/start, listening/stop}
```

### B. Preview environment (this repo, supervisor-managed)
The repo ships with an **identical-behaviour FastAPI + React mirror** so the
engine can be exercised here without Docker. Both implementations share the
same state semantics, endpoint shapes, SSE protocol, and bearer-token auth.

Use whichever you prefer:
- **Docker / Pi:** the Node.js implementation in `/app/src` + `/app/public`
- **This preview URL:** the FastAPI + React implementation in `/app/backend`
  + `/app/frontend`

---

## State machine

```
                        ┌────────────┐
                        │   idle     │ ◄──────────────────┐
                        └─────┬──────┘                    │
              POST music ▲    │ ▲                         │
                         │    │ │ POST idle               │
                         │    ▼ │                         │
                  ┌────────────┐    POST cleaning   ┌─────┴─────┐
                  │   music    │ ◄────────────────► │  cleaning │
                  └─────┬──────┘                    └─────┬─────┘
                        │                                 │
                        │  talking/start                  │  talking/start
                        │  (saves prev_mode)              │  (saves prev_mode)
                        ▼                                 ▼
                  ┌─────────────────────────────────────────────┐
                  │                  talking                    │
                  │  (overlay; interrupts MP4 immediately)      │
                  └────────────────────┬────────────────────────┘
                                       │
                                       │  talking/stop
                                       │  → restores prev_mode (or idle if invalid)
                                       ▼
                              (back to whatever was running)

  listening (boolean overlay) is independent of mode — it tweaks the face
  on top of any mode (slower bob, larger eyes, reduced blinking).
```

**Invariants enforced by `state.js` / `server.py`:**
- `mode` is always one of `idle | music | cleaning | talking`.
- `prev_mode` is updated only on **non-talking** transitions, so consecutive
  `talking/start` calls never poison the restoration target.
- `listening` is a boolean — orthogonal to `mode`.

---

## HTTP API

All endpoints are mounted under `/api`. The path is the same in both the
production Node.js server and the preview FastAPI server.

### Open endpoints (no auth)

| Method | Path                | Purpose                                            |
|--------|---------------------|----------------------------------------------------|
| GET    | `/api/health`       | Liveness — `{status:"ok", tts_enabled:bool}`        |
| GET    | `/api/state`        | Snapshot — `{mode, listening}`                      |
| GET    | `/api/stream`       | **Server-Sent Events** stream (state + say events)  |
| GET    | `/api/say/<id>.mp3` | Serves a generated TTS clip (id is unguessable)     |

`/api/stream` events:
```
event: state
data: {"mode":"idle","listening":false}

event: state
data: {"mode":"music","listening":false}

event: say
data: {"id":"…","url":"/api/say/….mp3","durationMs":1840,"voice":"nova","model":"tts-1"}
```

The kiosk subscribes to this stream, applies every state snapshot, and on
`say` events plays the audio clip with **Web Audio API amplitude analysis**
driving the mouth's `scaleY` for real lip-sync. The stream auto-reconnects
on disconnect (1.5s backoff).

### Mutating endpoints (require `Authorization: Bearer <KINDBOT_API_TOKEN>`)

| Method | Path                            | Effect                                        |
|--------|----------------------------------|-----------------------------------------------|
| POST   | `/api/mode/idle`                 | `mode = idle`                                 |
| POST   | `/api/mode/music`                | `mode = music`, plays `music.mp4` fullscreen  |
| POST   | `/api/mode/cleaning`             | `mode = cleaning`, plays `cleaning.mp4`       |
| POST   | `/api/mode/talking/start`        | `mode = talking` (saves prev_mode)            |
| POST   | `/api/mode/talking/stop`         | restores prev_mode                            |
| POST   | `/api/mode/listening/start`      | `listening = true`                            |
| POST   | `/api/mode/listening/stop`       | `listening = false`                           |
| POST   | `/api/say`                       | TTS lip-sync — see below                      |

#### `POST /api/say` — TTS lip-sync (requires `OPENAI_API_KEY`)

Request body:
```json
{
  "text": "Hello! I'm KindBot.",
  "voice": "nova",      // optional. one of: alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer
  "model": "tts-1",     // optional. tts-1 (fast) or tts-1-hd (higher quality)
  "speed": 1.0          // optional. 0.25 .. 4.0
}
```

Response:
```json
{
  "id": "a1b2c3d4e5f6g7h8",
  "url": "/api/say/a1b2c3d4e5f6g7h8.mp3",
  "durationMs": 1840,
  "voice": "nova",
  "model": "tts-1"
}
```

Side-effects:
1. The server immediately flips the engine into `talking` mode (saving the
   previous mode for restoration).
2. It broadcasts a `say` SSE event so every connected kiosk can play the
   clip and lip-sync in real time.
3. After `durationMs + 250ms` the server auto-restores the previous mode —
   unless another transition has happened since (we use a token to avoid
   stale auto-stops). You don't need to call `talking/stop` yourself.

Errors:
- `503` — `OPENAI_API_KEY not configured`. Add it to env and restart.
- `400` — invalid `voice`, `model`, `speed`, or empty/oversized `text`
  (4096-character cap from OpenAI).
- `502` — TTS provider returned an error (passed through in the message).
- `401` — bearer token missing or wrong.

All mutations return the **new** state snapshot as JSON.

### Authentication

```
Authorization: Bearer <KINDBOT_API_TOKEN>
```

- `KINDBOT_API_TOKEN` is required at server start. The Node.js server exits
  fast if the env var is missing.
- Recommended generation:
  ```bash
  openssl rand -base64 32
  ```
- **Always run this behind HTTPS** in production. The token is a long-lived
  bearer credential. A reverse proxy (Caddy / nginx / Traefik) with auto-TLS
  in front of port 8080 is the recommended deployment pattern.

---

## Repository layout & file walkthrough

```
/app
├── deploy/                    # ── Hostinger VPS Docker target ──
│   ├── src/                   # Node.js server
│   │   ├── server.js          # Express + SSE + bearer auth + static
│   │   └── state.js           # FaceState class (in-memory, pub/sub)
│   ├── public/                # Static kiosk assets served by Express
│   │   ├── index.html         # Kiosk page (inline SVG rig)
│   │   ├── styles.css         # All animations & layout (transforms only)
│   │   ├── app.js             # SSE subscription + animation loops
│   │   └── assets/mp4/        # YOUR music.mp4 and cleaning.mp4 go here
│   ├── Dockerfile             # Multi-stage Alpine, non-root, healthchecked
│   ├── docker-compose.yml     # One-command deployment, env-driven
│   └── package.json           # express, openai, music-metadata
│
├── backend/                   # ── Preview-only FastAPI mirror ──
│   ├── server.py              # Identical behaviour to deploy/src/server.js
│   ├── requirements.txt
│   └── .env                   # KINDBOT_API_TOKEN, OPENAI_API_KEY, …
│
├── frontend/                  # ── Preview-only React mirror ──
│   ├── src/
│   │   ├── App.js             # Same kiosk component as deploy/public/index.html
│   │   ├── App.css            # Same animations as deploy/public/styles.css
│   │   └── index.css
│   └── public/assets/mp4/     # Mirror of deploy/public/assets/mp4 for preview
│
└── memory/
    ├── PRD.md                 # Product brief
    └── test_credentials.md    # Bearer token + endpoint cheatsheet
```

> **Why `deploy/` is its own folder?** The Pi-VPS Docker artifacts live in
> their own subfolder so they're never picked up by the Emergent platform's
> deployment build (which expects the FastAPI + React layout at the repo
> root). Build / deploy your Hostinger container from inside `deploy/`.

### File-by-file annotations

**`src/state.js`**
- `FaceState` class with `mode`, `prevMode`, `listening`.
- `setMode(m)` updates `prevMode` only when `m !== 'talking'` so successive
  `talking/start` calls don't lose the original mode.
- `subscribe(fn)` returns an unsubscribe function. `_broadcast()` iterates
  and ignores subscriber exceptions.

**`src/server.js`**
- Single Express app on `PORT` (default 8080).
- Fails closed if `KINDBOT_API_TOKEN` is missing.
- Tiny CORS middleware (no extra dep).
- `requireToken` middleware checks `Authorization: Bearer …` constant-time-ish.
- `GET /api/stream` writes SSE headers, sends initial snapshot, subscribes to
  the state and pushes every change. Sends a `: ping` keepalive every 15s.
  Cleanup happens on `req.close`.
- `express.static('public')` serves the kiosk and MP4 assets.
- `app.get('*')` SPA fallback returns `index.html`.

**`public/index.html`**
- Tiny page with the **exact** SVG from the spec inline.
- All elements that the JS needs to find are addressed by `id` (which is what
  the spec defines) — no extra wrapping. Test IDs (`data-testid`) are added
  alongside, never replacing structure.

**`public/styles.css`**
- All animations are CSS keyframes operating on `transform`.
- The crucial detail: every keyframe **preserves** the original `translate(x,y)`
  from the SVG (e.g. `translate(260px, 220px)` for `#left_eye`) and only
  composes a `scale()` on top. This is why blinking and listening work without
  ever changing the rig's position.
- `.video-on .face-layer { opacity: 0 }` and `.video-on .video-layer { opacity: 1 }`
  give us the 280ms cross-fade between MP4 and face.
- `.mode-talking .video-layer { opacity: 0 !important }` enforces "talking
  always interrupts MP4".

**`public/app.js`**
- `applyState({mode, listening})` is the single source of truth — it sets the
  stage class, updates the HUD, and toggles the `<video>` source/playback.
- The blink loop runs forever, but `once()` only fires when the face is
  actually visible (`mode === 'idle' || 'talking'`).
- The mouth talking loop is a `requestAnimationFrame` smoother that picks a
  new `(scaleX, scaleY)` target every 50–120ms and eases the mouth toward it
  at 35% per frame. It only runs while `mode === 'talking'`.
- The SSE consumer reconnects automatically on error after 1.5s. The HUD's
  green dot reflects connection state for at-a-glance kiosk debugging.

**`backend/server.py`** (preview only)
- FastAPI port of `src/server.js`. Same endpoints, same shapes, same auth.
- Uses `sse-starlette` for the SSE stream. State is `asyncio.Lock`-guarded.
- Convenient for running this engine without Docker, e.g. inside this preview
  environment where supervisor manages a Python backend.

**`frontend/src/App.js`** (preview only)
- React port of `public/app.js`. Mounts the same SVG rig (same IDs and test
  IDs), runs the same animation logic, subscribes to the same SSE endpoint
  via `process.env.REACT_APP_BACKEND_URL`.

---

## Install-then-configure flow

The container is designed so you can **install first and configure later**.

| Stage | Without `.env` | With `.env` filled in |
|---|---|---|
| `docker compose build` / image pull | ✓ works | ✓ works |
| `docker compose up -d` | ✓ container starts in **configuration-pending mode** | ✓ container starts fully |
| Kiosk page (`GET /`) | ✓ renders the SVG face | ✓ renders the SVG face |
| `GET /api/health` | ✓ 200, reports `token_configured:false` | ✓ 200, reports `token_configured:true` |
| `GET /api/state`, `GET /api/stream` | ✓ work (read-only) | ✓ work |
| `POST /api/mode/*`, `POST /api/say` | ⚠ **503** "KINDBOT_API_TOKEN not configured" | ✓ work with bearer auth |

So the typical workflow is:

```bash
# 1. Pull the repo on the VPS, build & start with no env yet:
git clone https://github.com/<you>/kindbot.git
cd kindbot/deploy
docker compose up -d --build
docker compose logs kindbot                  # → "WARNING: KINDBOT_API_TOKEN is not set"
curl https://kindbot.unconfigured.local/api/health  # not yet routable

# 2. Configure:
cp .env.example .env
sed -i "s|^KINDBOT_API_TOKEN=.*|KINDBOT_API_TOKEN=$(openssl rand -base64 32)|" .env
sed -i "s|^KINDBOT_DOMAIN=.*|KINDBOT_DOMAIN=kindbot.your.tld|" .env
nano .env                                    # add OPENAI_API_KEY etc. as desired

# 3. Apply (no rebuild needed — env-only change):
docker compose up -d
curl -fsSL https://kindbot.your.tld/api/health   # → token_configured:true
```

> Why two `docker compose up` calls?  Compose recreates the container when
> environment variables change, which picks up your new `.env` values.
> No image rebuild happens — it's a fast restart.



## Setup — production single-container (the Hostinger VPS)

> Time required: ~3 minutes if Docker is already installed on the VPS.
>
> SSH into your Hostinger VPS and clone this repo there. The Pi never runs
> any of this — the Pi only points Chromium at the VPS URL.

### 1. Drop your MP4 assets in
```bash
cd /path/to/this/repo/deploy              # ← all Docker artifacts live here
ls public/assets/mp4/                     # should contain music.mp4 + cleaning.mp4
```
Encoding hints:
- Container/codec: H.264 + AAC (or no audio at all) in MP4
- Resolution: 800×480 minimum (we `object-fit: cover` to fill the screen)
- Keep file size small for the Pi's SD card

### 2. Choose / generate a bearer token
```bash
export KINDBOT_API_TOKEN="$(openssl rand -base64 32)"
echo "KINDBOT_API_TOKEN=$KINDBOT_API_TOKEN" >> .env   # for docker-compose
```

### 2b. (Optional) Enable `/api/say` TTS lip-sync
Get an OpenAI key at https://platform.openai.com/api-keys, then:
```bash
echo 'OPENAI_API_KEY=sk-…your-key…' >> .env
# Optional defaults:
echo 'KINDBOT_TTS_MODEL=tts-1' >> .env       # or tts-1-hd
echo 'KINDBOT_TTS_VOICE=nova'  >> .env       # alloy|ash|coral|echo|fable|nova|onyx|sage|shimmer
```
The server boots fine without this key — `/api/say` simply returns 503 until
the key is added. Cost is roughly `$0.015 / 1k characters` for `tts-1` and
`$0.030 / 1k characters` for `tts-1-hd` (verify on OpenAI's pricing page).

### 3. Bring it up
```bash
cd deploy/                                   # all Docker artifacts live here
echo "KINDBOT_API_TOKEN=$KINDBOT_API_TOKEN"  >> .env   # if not already
echo "KINDBOT_DOMAIN=kindbot.your.tld"       >> .env   # required for Traefik routing
docker compose up -d --build
docker compose logs -f kindbot               # watch startup
```
Health check (through Traefik, once DNS for `KINDBOT_DOMAIN` points at the VPS):
```bash
curl -fsSL https://kindbot.your.tld/api/health   # → {"status":"ok",...}
```

The compose file:
- Reads `KINDBOT_API_TOKEN` from your shell or a local `.env`.
- Bind-mounts `./public/assets/mp4` so you can swap MP4s without rebuilding.
- Restarts on failure (`restart: unless-stopped`).
- Exposes a healthcheck (`/api/health`) that Docker uses to keep the
  container marked healthy.

### 4. Wire it into your existing Traefik (recommended)

This compose file is built for an existing Traefik instance running in
another container — e.g. `traefik-ypta`. The KindBot container does NOT
publish a host port; Traefik reaches it on the shared Docker network.

**Required env (in `./deploy/.env` or shell):**
```bash
KINDBOT_API_TOKEN=…                 # generated above
KINDBOT_DOMAIN=kindbot.your.tld     # public hostname Traefik routes to
```

**Optional env (with sensible defaults — only override if your Traefik
setup uses different names):**
```bash
TRAEFIK_NETWORK=traefik-ypta        # external Docker network Traefik is on
TRAEFIK_ENTRYPOINT=websecure        # Traefik HTTPS entrypoint
TRAEFIK_CERT_RESOLVER=letsencrypt   # Traefik cert resolver
```

**Bring it up:**
```bash
cd deploy/
docker compose up -d --build
docker compose logs -f kindbot
```

The compose file declares the Traefik network as `external: true` and
attaches `kindbot-face` to it. Traefik picks up the labels and automatically:
- routes `https://${KINDBOT_DOMAIN}/` → `kindbot-face:8080`
- terminates TLS via your cert resolver
- adds `X-Accel-Buffering: no` so the SSE stream isn't buffered

Verify routing:
```bash
curl -fsSL https://${KINDBOT_DOMAIN}/api/health
# {"status":"ok","service":"kindbot-face-engine","tts_enabled":false}
```

If you ever need to bypass Traefik for local debugging, drop a temporary
`ports: ["8080:8080"]` block under the `kindbot` service.

#### Don't have Traefik?

If you ever need to swap to nginx / Caddy / direct port instead, do
**one** of:

- Comment out the `networks:` block, the `labels:` block, and the
  external `networks:` declaration at the bottom of `docker-compose.yml`,
  then add `ports: ["8080:8080"]`. Open `ufw allow 8080/tcp`.
- Or front it with nginx:
  ```nginx
  server {
      listen 443 ssl http2;
      server_name kindbot.your-domain.tld;
      # ssl_certificate ... ssl_certificate_key ...
      location / {
          proxy_pass http://127.0.0.1:8080;
          proxy_http_version 1.1;
          proxy_set_header Connection "";
          proxy_buffering off;       # critical for SSE
          proxy_cache off;
      }
  }
  ```

> **SSE proxying gotcha:** any reverse proxy MUST disable response buffering
> for `/api/stream` or the kiosk will not receive state events in real time.
> Traefik streams responses by default — no extra config needed beyond what
> the compose file already sets.

---

## Setup — Raspberry Pi kiosk client (display only)

The Pi is **only** a Chromium kiosk — no Docker, no Node.js, no API
runs on it. It connects to the Hostinger VPS over HTTPS.

Assumes Raspberry Pi OS (Bookworm) with Chromium installed.

### 1. Make Chromium boot in kiosk mode pointing at the VPS

Create `/etc/xdg/autostart/kindbot-kiosk.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=KindBot Kiosk
Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars \
     --check-for-update-interval=31536000 \
     --autoplay-policy=no-user-gesture-required \
     https://kindbot.your-domain.tld/
X-GNOME-Autostart-enabled=true
```

Key flags:
- `--kiosk` — fullscreen, no chrome, locks Chromium to one URL.
- `--autoplay-policy=no-user-gesture-required` — required so MP4s autoplay
  without a click. (Our `<video>` is already `muted` to satisfy autoplay
  rules, but this flag is belt-and-braces.)
- `--check-for-update-interval=31536000` — disable update prompts.

### 2. Disable the cursor
```bash
sudo apt install -y unclutter
echo "unclutter -idle 0 -root &" >> ~/.xsessionrc
```

(The CSS already sets `cursor: none`, this is a redundancy for Wayland setups.)

### 3. Auto-reconnect on server reload
The kiosk does this for you — `EventSource` auto-reconnects after 1.5s on
error. There is **nothing** to configure.

---

## Setup — Home Assistant integration

Add to `configuration.yaml`:

```yaml
rest_command:
  kindbot_idle:
    url: "https://kindbot.your-domain.tld/api/mode/idle"
    method: POST
    headers:
      Authorization: !secret kindbot_token
  kindbot_music:
    url: "https://kindbot.your-domain.tld/api/mode/music"
    method: POST
    headers:
      Authorization: !secret kindbot_token
  kindbot_cleaning:
    url: "https://kindbot.your-domain.tld/api/mode/cleaning"
    method: POST
    headers:
      Authorization: !secret kindbot_token
  kindbot_talking_start:
    url: "https://kindbot.your-domain.tld/api/mode/talking/start"
    method: POST
    headers:
      Authorization: !secret kindbot_token
  kindbot_talking_stop:
    url: "https://kindbot.your-domain.tld/api/mode/talking/stop"
    method: POST
    headers:
      Authorization: !secret kindbot_token
  kindbot_listening_start:
    url: "https://kindbot.your-domain.tld/api/mode/listening/start"
    method: POST
    headers:
      Authorization: !secret kindbot_token
  kindbot_listening_stop:
    url: "https://kindbot.your-domain.tld/api/mode/listening/stop"
    method: POST
    headers:
      Authorization: !secret kindbot_token
```

In `secrets.yaml`:
```yaml
kindbot_token: "Bearer YOUR_LONG_RANDOM_TOKEN"
```

Example automation — the robot listens whenever the smart speaker is awake:
```yaml
- alias: "KindBot listens with Alexa wake"
  trigger:
    - platform: state
      entity_id: media_player.echo
      to: "listening"
  action:
    - service: rest_command.kindbot_listening_start
- alias: "KindBot stops listening"
  trigger:
    - platform: state
      entity_id: media_player.echo
      from: "listening"
  action:
    - service: rest_command.kindbot_listening_stop
```

---

## Setup — OpenClaw / generic clients

Any HTTP client works. Examples:

```bash
# Bash
curl -X POST -H "Authorization: Bearer $KINDBOT_API_TOKEN" \
  https://kindbot.your-domain.tld/api/mode/talking/start
```

```python
# Python
import requests, os
H = {"Authorization": f"Bearer {os.environ['KINDBOT_API_TOKEN']}"}
requests.post("https://kindbot.your-domain.tld/api/mode/music", headers=H)
```

```javascript
// Node.js
await fetch("https://kindbot.your-domain.tld/api/mode/cleaning", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.KINDBOT_API_TOKEN}` },
});
```

To watch state changes in any client:
```bash
curl -N -H "Accept: text/event-stream" \
  https://kindbot.your-domain.tld/api/stream
```

---

## Setup — preview environment (this repo, no Docker)

This repo's preview ships a FastAPI+React mirror that runs without Docker:

- Backend: `/app/backend/server.py` (FastAPI, supervisor-managed on :8001)
- Frontend: `/app/frontend` (React, supervisor-managed on :3000)
- Bearer token: `KINDBOT_API_TOKEN` in `/app/backend/.env`

Endpoints are reachable through the public preview URL set in
`frontend/.env` as `REACT_APP_BACKEND_URL`. The kiosk page is the React
root (`/`) and the API lives under `/api`.

Restart after editing `.env`:
```bash
sudo supervisorctl restart backend frontend
```

---

## How the animations work

The spec is uncompromising: **only transforms; never geometry mutations**.
Here's how each behaviour is implemented within that constraint.

| Behaviour       | Mechanism | Where |
|-----------------|-----------|-------|
| Idle bob + tilt | `@keyframes face-bob` translates Y −10px and rotates ±1.2° on `#face` | `styles.css` |
| Blinking        | `@keyframes blink-l/r` `translate(orig) scaleY(1 → 0.1 → 1)` over 130ms; class added/removed by JS | `styles.css` + `app.js` |
| Talking mouth   | `requestAnimationFrame` loop picks new `(scaleX, scaleY)` every 50–120ms and eases toward it; written to `mouth.style.transform` | `app.js` |
| Listening eyes  | `@keyframes eye-attentive-l/r` scale 1 → 1.12 with the original translate preserved | `styles.css` |
| MP4 / face fade | `.video-on .face-layer { opacity:0 }` + `.video-on .video-layer { opacity:1 }` with 280ms transition | `styles.css` |
| Talking overrides MP4 | `.mode-talking .video-layer { opacity:0 !important }` | `styles.css` |
| Pi-friendly perf | `will-change: transform` on `#face`; only a few elements animate; no JS layout thrash | `styles.css` |

The trick to keep the rig untouched while still scaling/translating is to
write keyframes like:
```css
@keyframes blink-l {
  0%   { transform: translate(260px, 220px) scaleY(1); }
  50%  { transform: translate(260px, 220px) scaleY(0.1); }
  100% { transform: translate(260px, 220px) scaleY(1); }
}
```
We're never editing the SVG's own `transform="translate(260, 220)"` — we're
just composing `scaleY` on top of an identical translate, so the eye stays
exactly where the spec put it.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `error while interpolating services.kindbot.environment.[]: required variable KINDBOT_API_TOKEN is missing` during a build on the Emergent platform | The `deploy/` folder is for the Hostinger VPS, NOT for the Emergent platform. Make sure no `Dockerfile` or `docker-compose.yml` exists at the repo root. (Current compose uses `:-` defaults so this error should no longer occur even on Emergent.) |
| Container starts but logs `WARNING: KINDBOT_API_TOKEN is not set` | Expected if you haven't configured `.env` yet. The container is in **configuration-pending mode**. Read-only endpoints work, writes return 503. Set `KINDBOT_API_TOKEN` in `deploy/.env` and run `docker compose up -d`. |
| `KINDBOT_API_TOKEN env var is required` and the container exits | Old behaviour — only seen if you're running an older image. Re-pull / rebuild. |
| Kiosk shows the face but never updates on POST | Reverse proxy is buffering SSE. Add `proxy_buffering off` (nginx) or `flush_interval -1` (Caddy). |
| `401 invalid or missing bearer token` | The header must be exactly `Authorization: Bearer <token>` — note the space and the literal word `Bearer`. |
| MP4 mode shows a black screen | `music.mp4` / `cleaning.mp4` is missing from `public/assets/mp4/` or its codec is unsupported. Use H.264. |
| Autoplay blocked in console | The `<video>` is already muted; ensure Chromium is started with `--autoplay-policy=no-user-gesture-required`. |
| HUD dot stays orange | Backend/server unreachable. Check `docker compose logs -f kindbot` and reverse-proxy logs. |
| Eyes/mouth glitch on slow Pi | Lower the bob frequency (`face-bob` duration) or remove the rotation by editing the keyframes — the rest is essentially free on a Pi 4/5. |

---

## Suggested feature enhancements

Open ideas in priority order. None of these are required for the current
spec — they're upgrades you can ship as small, additive PRs without touching
the existing state machine.

### 1. **`/api/say` — TTS lip-sync in one call** *(✅ shipped in v1.1)*
**Status: implemented.** Single endpoint takes
`{ "text": "...", "voice": "..." }`, generates audio with **OpenAI TTS**
(`tts-1` or `tts-1-hd`), returns it as `/api/say/<id>.mp3`, and the kiosk
plays it back with **Web Audio API amplitude analysis** driving the
mouth's `scaleY` for true lip-sync. The server flips into `talking` mode
on the call and auto-restores the previous mode after the audio ends.

Possible follow-ups in this area:
- ElevenLabs voice provider as an alternative (more expressive voices).
- Audio cache persistence to disk (currently in-memory, 10-minute TTL).
- WebSocket fallback for environments where the SSE `say` event is
  proxied poorly.

### 2. **Additional expressive states** *(low effort)*
Add discrete states the rig already supports without geometry change:
- `sleep` — eyes scaleY → 0.05 (closed), face bob slowed.
- `error` — eyes briefly recolour via CSS variable, slight head tilt.
- `wake` — eyes scaleY → 1.2 + brief brighten.

Each is just a new entry in `VALID_MODES` plus a CSS class.

### 3. **Multi-kiosk fan-out & device targeting** *(medium effort)*
Today every connected kiosk gets every state event. For a multi-room setup,
add an optional `?device=living-room` query string on `/api/stream` and a
`{device}` field on `/api/mode/*`. The state machine becomes a `Map<device, FaceState>`.

### 4. **Local audio output for music_mode** *(small)*
`music.mp4` plays muted today (browser autoplay policy). If the Pi has
speakers wired to it, add an `audio` channel via Web Audio API +
`AudioContext.resume()` on first user interaction (or the `--autoplay-policy`
Chromium flag is already enough — toggle `video.muted = false` when in
`music` mode).

### 5. **Prometheus metrics** *(optional ops)*
`GET /api/metrics` exposing connected SSE clients, mode change counts, and
last mutation timestamp. Useful when you have multiple KindBot units.

### 6. **Reduced-motion / energy-save mode** *(accessibility)*
Honour `prefers-reduced-motion` by disabling the bob and the talking RAF
loop, replacing the talking mouth with a simple two-frame open/close at a
slower pace. Also gives the Pi a thermal break overnight.

### 7. **Real-time face mood from sentiment** *(fun)*
A small classifier (or even a regex) over the text fed to `/api/say`
chooses one of `happy/curious/concerned/sleepy` and adds a CSS class with
subtle eye-shape variations (still transforms only — e.g. scale the eye
non-uniformly to suggest squint).

### 8. **CLI helper** *(quality of life)*
A `bin/kindbot` script that wraps curl with the bearer token from `.env`,
so operators can run `kindbot music` instead of the full curl.

---

## License

Build and modify freely for your KindBot deployment. The SVG rig is the
spec's verbatim asset — it is rendered exactly as provided.
