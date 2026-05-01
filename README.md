# KindBot Face Engine

A lightweight, production-ready SVG face engine for a KindBot kiosk
running on a Raspberry Pi 5" screen in Chromium kiosk mode.

* Inline SVG rig (the exact one in the spec) animated **only** via CSS
  transforms and `requestAnimationFrame` — never geometry swaps.
* Tiny Node.js / Express server that serves the kiosk + a small JSON
  control API for Home Assistant / OpenClaw.
* Server-Sent Events stream (`/api/stream`) keeps every connected
  kiosk in sync with sub-second latency.
* States: `idle`, `talking`, `listening`, `music_mode`, `cleaning_mode`.
* Talking always overrides MP4. When it stops, we restore the previous mode.

## States and overrides

```
idle ←→ music ←→ cleaning   (mutually exclusive)
   talking      → overlay; interrupts MP4. on stop → previous mode
   listening    → boolean overlay; tweaks the face on top of any mode
```

## Single-container deployment (the Pi VPS)

```bash
# 1. Drop your MP4s into ./public/assets/mp4/ (music.mp4, cleaning.mp4)
# 2. Choose / generate a token
export KINDBOT_API_TOKEN="$(openssl rand -base64 32)"

# 3. Bring it up
docker compose up -d --build

# 4. Open the kiosk on the Pi (Chromium kiosk mode)
chromium-browser --kiosk --noerrdialogs --disable-infobars \
  http://YOUR_VPS:8080/
```

The container exposes:

| Path                          | Auth   | Purpose                          |
| ----------------------------- | ------ | -------------------------------- |
| `GET  /`                      | -      | Kiosk frontend                   |
| `GET  /api/health`            | -      | Liveness probe                   |
| `GET  /api/state`             | -      | Current state snapshot           |
| `GET  /api/stream`            | -      | SSE stream of state changes      |
| `POST /api/mode/idle`         | Bearer | Set mode to `idle`               |
| `POST /api/mode/music`        | Bearer | Play `music.mp4` fullscreen      |
| `POST /api/mode/cleaning`     | Bearer | Play `cleaning.mp4` fullscreen   |
| `POST /api/mode/talking/start`| Bearer | Override into talking            |
| `POST /api/mode/talking/stop` | Bearer | Restore previous mode            |
| `POST /api/mode/listening/start` | Bearer | Listening overlay ON          |
| `POST /api/mode/listening/stop`  | Bearer | Listening overlay OFF         |

### Example: Home Assistant REST commands

```yaml
rest_command:
  kindbot_talking_start:
    url: "http://YOUR_VPS:8080/api/mode/talking/start"
    method: POST
    headers:
      Authorization: !secret kindbot_token
  kindbot_talking_stop:
    url: "http://YOUR_VPS:8080/api/mode/talking/stop"
    method: POST
    headers:
      Authorization: !secret kindbot_token
```

In `secrets.yaml`:

```yaml
kindbot_token: "Bearer YOUR_TOKEN_FROM_KINDBOT_API_TOKEN"
```

## Repository layout

```
/app
  /public                 # served by Node.js Express
    /assets/mp4/          # music.mp4, cleaning.mp4 (you provide)
    index.html            # inline SVG kiosk
    styles.css
    app.js
  /src
    server.js             # Express server (single container)
    state.js              # in-memory state machine
  Dockerfile
  docker-compose.yml
  package.json
```

## Preview environment (this repo)

A FastAPI + React mirror lives in `/app/backend` + `/app/frontend` so the
behaviour can be exercised without Docker. Both implementations share the
identical state semantics. The Bearer token in preview is set in
`/app/backend/.env` as `KINDBOT_API_TOKEN`.

## Constraints honoured

* The exact provided SVG is used — no geometry mutation, no asset swapping.
* Animation is transforms only (CSS keyframes + `requestAnimationFrame`).
* Fullscreen 800x480, no scrollbars, no cursor.
* Auto-reconnect SSE — kiosk recovers automatically if the server reloads.
* Fade transitions (250–280ms) between MP4 and face — no hard cuts.
