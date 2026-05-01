"""KindBot Face Engine - FastAPI backend (preview environment).

Mirrors the production Node.js spec:
  - In-memory state machine (mode + listening overlay)
  - POST /api/mode/* endpoints (Bearer token auth)
  - GET /api/state         (current state, no auth)
  - GET /api/stream        (Server-Sent Events stream of state changes)
  - POST /api/say          (Bearer auth) -- TTS lip-sync via OpenAI
  - GET /api/say/<id>.mp3  (no auth, scoped) -- serves generated audio
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import AsyncGenerator, Dict, Set

from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

API_TOKEN = os.environ.get("KINDBOT_API_TOKEN", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
TTS_MODEL = os.environ.get("KINDBOT_TTS_MODEL", "tts-1")
TTS_VOICE = os.environ.get("KINDBOT_TTS_VOICE", "nova")
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*").split(",")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kindbot")

# ----- State -----------------------------------------------------------------

VALID_MODES = {"idle", "music", "cleaning", "talking"}


class FaceState:
    """In-memory state singleton with async fan-out to SSE subscribers."""

    def __init__(self) -> None:
        self.mode: str = "idle"
        self.prev_mode: str = "idle"
        self.listening: bool = False
        self._subscribers: Set[asyncio.Queue] = set()
        self._lock = asyncio.Lock()
        self._talking_token: int = 0  # increments to invalidate stale auto-stop tasks

    def snapshot(self) -> dict:
        return {"mode": self.mode, "listening": self.listening}

    async def set_mode(self, mode: str) -> dict:
        async with self._lock:
            if mode not in VALID_MODES:
                raise ValueError(f"invalid mode: {mode}")
            if mode != "talking":
                self.prev_mode = mode
            self.mode = mode
            self._talking_token += 1
        await self._broadcast({"event": "state", "data": self.snapshot()})
        return self.snapshot()

    async def start_talking(self) -> tuple[dict, int]:
        async with self._lock:
            if self.mode != "talking":
                self.prev_mode = self.mode
            self.mode = "talking"
            self._talking_token += 1
            tok = self._talking_token
        await self._broadcast({"event": "state", "data": self.snapshot()})
        return self.snapshot(), tok

    async def stop_talking_if_token(self, tok: int) -> None:
        """Stop talking only if no other transition has happened since `tok`."""
        async with self._lock:
            if self._talking_token != tok or self.mode != "talking":
                return
            self.mode = self.prev_mode if self.prev_mode in VALID_MODES else "idle"
            self._talking_token += 1
        await self._broadcast({"event": "state", "data": self.snapshot()})

    async def stop_talking(self) -> dict:
        async with self._lock:
            if self.mode == "talking":
                self.mode = self.prev_mode if self.prev_mode in VALID_MODES else "idle"
            self._talking_token += 1
        await self._broadcast({"event": "state", "data": self.snapshot()})
        return self.snapshot()

    async def set_listening(self, on: bool) -> dict:
        async with self._lock:
            self.listening = bool(on)
        await self._broadcast({"event": "state", "data": self.snapshot()})
        return self.snapshot()

    # ---- pub/sub ----
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=64)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    async def _broadcast(self, msg: dict) -> None:
        """Broadcast {event, data} to all SSE subscribers."""
        for q in list(self._subscribers):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                try:
                    q.get_nowait()
                    q.put_nowait(msg)
                except Exception:
                    pass

    async def broadcast_say(self, payload: dict) -> None:
        await self._broadcast({"event": "say", "data": payload})


state = FaceState()

# ----- Audio cache (in-memory, TTL-evicted) ---------------------------------

# {id: (bytes, created_ts)}; size-capped at 32 entries.
SAY_CACHE: Dict[str, tuple[bytes, float]] = {}
SAY_CACHE_MAX = 32
SAY_CACHE_TTL_SECONDS = 600  # 10 min


def cache_say(audio: bytes) -> str:
    say_id = uuid.uuid4().hex[:16]
    SAY_CACHE[say_id] = (audio, time.time())
    # Evict old entries
    now = time.time()
    expired = [k for k, (_, ts) in SAY_CACHE.items() if now - ts > SAY_CACHE_TTL_SECONDS]
    for k in expired:
        SAY_CACHE.pop(k, None)
    # Cap size
    while len(SAY_CACHE) > SAY_CACHE_MAX:
        oldest = min(SAY_CACHE.items(), key=lambda kv: kv[1][1])[0]
        SAY_CACHE.pop(oldest, None)
    return say_id


def mp3_duration_ms(audio: bytes) -> int:
    """Best-effort MP3 duration in ms using mutagen. Falls back to 0 on failure."""
    try:
        from mutagen.mp3 import MP3
        info = MP3(io.BytesIO(audio))
        return int(round(info.info.length * 1000))
    except Exception:
        return 0


# ----- Auth ------------------------------------------------------------------

security = HTTPBearer(auto_error=False)


def require_token(creds: HTTPAuthorizationCredentials | None = Depends(security)) -> None:
    if not API_TOKEN:
        raise HTTPException(status_code=500, detail="server token not configured")
    if creds is None or creds.scheme.lower() != "bearer" or creds.credentials != API_TOKEN:
        raise HTTPException(status_code=401, detail="invalid or missing bearer token")


# ----- App -------------------------------------------------------------------

app = FastAPI(title="KindBot Face Engine")
api = APIRouter(prefix="/api")


@api.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "service": "kindbot-face-engine",
        "tts_enabled": bool(OPENAI_API_KEY),
    }


@api.get("/state")
async def get_state() -> dict:
    return state.snapshot()


@api.get("/stream")
async def stream(request: Request) -> EventSourceResponse:
    q = state.subscribe()

    async def event_gen() -> AsyncGenerator[dict, None]:
        try:
            yield {"event": "state", "data": json.dumps(state.snapshot())}
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield {"event": msg["event"], "data": json.dumps(msg["data"])}
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": "1"}
        finally:
            state.unsubscribe(q)

    return EventSourceResponse(event_gen())


# ---- Mode endpoints (auth required) ----

@api.post("/mode/idle", dependencies=[Depends(require_token)])
async def mode_idle() -> dict:
    return await state.set_mode("idle")


@api.post("/mode/music", dependencies=[Depends(require_token)])
async def mode_music() -> dict:
    return await state.set_mode("music")


@api.post("/mode/cleaning", dependencies=[Depends(require_token)])
async def mode_cleaning() -> dict:
    return await state.set_mode("cleaning")


@api.post("/mode/talking/start", dependencies=[Depends(require_token)])
async def talking_start() -> dict:
    snap, _ = await state.start_talking()
    return snap


@api.post("/mode/talking/stop", dependencies=[Depends(require_token)])
async def talking_stop() -> dict:
    return await state.stop_talking()


@api.post("/mode/listening/start", dependencies=[Depends(require_token)])
async def listening_start() -> dict:
    return await state.set_listening(True)


@api.post("/mode/listening/stop", dependencies=[Depends(require_token)])
async def listening_stop() -> dict:
    return await state.set_listening(False)


# ---- TTS lip-sync (/api/say) -----------------------------------------------

VALID_VOICES = {"alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"}
VALID_TTS_MODELS = {"tts-1", "tts-1-hd"}


class SayRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    voice: str | None = None
    model: str | None = None
    speed: float | None = Field(None, ge=0.25, le=4.0)


@api.post("/say", dependencies=[Depends(require_token)])
async def say(req: SayRequest) -> dict:
    """Generate TTS audio, broadcast a 'say' event for kiosks to play, and
    auto-toggle talking_mode for the duration of the clip."""
    if not OPENAI_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="OPENAI_API_KEY not configured. Set it in /app/backend/.env to enable /api/say.",
        )

    voice = (req.voice or TTS_VOICE).lower()
    model = (req.model or TTS_MODEL).lower()
    if voice not in VALID_VOICES:
        raise HTTPException(status_code=400, detail=f"invalid voice; choose from {sorted(VALID_VOICES)}")
    if model not in VALID_TTS_MODELS:
        raise HTTPException(status_code=400, detail=f"invalid model; choose from {sorted(VALID_TTS_MODELS)}")

    # Generate via emergentintegrations (uses OpenAI under the hood)
    try:
        from emergentintegrations.llm.openai import OpenAITextToSpeech
        tts = OpenAITextToSpeech(api_key=OPENAI_API_KEY)
        kwargs = {"text": req.text, "model": model, "voice": voice, "response_format": "mp3"}
        if req.speed is not None:
            kwargs["speed"] = req.speed
        audio = await tts.generate_speech(**kwargs)
    except Exception as exc:
        log.exception("tts generation failed")
        raise HTTPException(status_code=502, detail=f"tts provider error: {exc}") from exc

    if not isinstance(audio, (bytes, bytearray)) or len(audio) == 0:
        raise HTTPException(status_code=502, detail="tts returned empty audio")

    say_id = cache_say(bytes(audio))
    duration_ms = mp3_duration_ms(audio)
    url = f"/api/say/{say_id}.mp3"

    # Flip into talking mode immediately and capture token for auto-stop
    _, tok = await state.start_talking()

    # Broadcast say event so kiosks can play with amplitude-driven lip sync
    await state.broadcast_say({
        "id": say_id,
        "url": url,
        "durationMs": duration_ms,
        "voice": voice,
        "model": model,
    })

    # Schedule auto-stop just after audio ends (+250ms grace)
    if duration_ms > 0:
        async def _auto_stop() -> None:
            try:
                await asyncio.sleep((duration_ms + 250) / 1000.0)
                await state.stop_talking_if_token(tok)
            except Exception:
                log.exception("auto-stop failed")
        asyncio.create_task(_auto_stop())

    return {"id": say_id, "url": url, "durationMs": duration_ms, "voice": voice, "model": model}


@api.get("/say/{say_id}.mp3")
async def say_audio(say_id: str) -> Response:
    """Serve a previously-generated MP3 by id. No auth: id is unguessable."""
    entry = SAY_CACHE.get(say_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="audio not found or expired")
    audio, _ts = entry
    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "public, max-age=600",
            "Content-Length": str(len(audio)),
        },
    )


app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup() -> None:
    log.info(
        "KindBot Face Engine ready  mode=%s  tts=%s  voice=%s  model=%s",
        state.mode, "on" if OPENAI_API_KEY else "off", TTS_VOICE, TTS_MODEL,
    )
