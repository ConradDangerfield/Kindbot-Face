# MP4 assets

The KindBot Face Engine expects the following files in this folder. Each
filename matches the API mode that triggers it
(`POST /api/mode/<name>` plays `<name>.mp4` fullscreen).

| File           | Triggered by                      |
|----------------|------------------------------------|
| `music.mp4`    | `POST /api/mode/music`             |
| `cleaning.mp4` | `POST /api/mode/cleaning`          |
| `chef.mp4`     | `POST /api/mode/chef`              |
| `gaming.mp4`   | `POST /api/mode/gaming`            |
| `angry.mp4`    | `POST /api/mode/angry`             |
| `bandit.mp4`   | `POST /api/mode/bandit`            |
| `karate.mp4`   | `POST /api/mode/karate`            |
| `love.mp4`     | `POST /api/mode/love`              |
| `party.mp4`    | `POST /api/mode/party`             |
| `santa.mp4`    | `POST /api/mode/santa`             |
| `sleeping.mp4` | `POST /api/mode/sleeping`          |
| `hot.mp4`      | `POST /api/mode/hot`               |

Missing files don't crash the server — the kiosk just shows a black layer
for that mode until the file is provided. Add a missing file by dropping
it into this folder; no container restart is needed (this folder is
bind-mounted into the running container via `docker-compose.yml`).

## Encoding recommendations

* H.264 video + AAC audio (or no audio) in MP4 container.
* 800x480 minimum (we `object-fit: cover` to fill the screen).
* Add `-movflags +faststart` so playback can begin before the file is
  fully buffered.

```bash
ffmpeg -i source.ext \
  -c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p \
  -vf "scale='min(800,iw)':'-2'" \
  -c:a aac -b:a 96k \
  -movflags +faststart \
  out.mp4
```
