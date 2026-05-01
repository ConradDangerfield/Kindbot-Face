"""KindBot Face Engine - FastAPI backend (preview environment).

Mirrors the production Node.js spec:
  - In-memory state machine (mode + listening overlay)
  - POST /api/mode/* endpoints (Bearer token auth)
  - GET /api/state         (current state, no auth)
  - GET /api/stream        (Server-Sent Events stream of state changes)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import AsyncGenerator, Set

from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sse_starlette.sse import EventSourceResponse
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

API_TOKEN = os.environ.get("KINDBOT_API_TOKEN", "")
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*").split(",")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kindbot")

# ----- State -----------------------------------------------------------------

VALID_MODES = {"idle", "music", "cleaning", "talking"}


class FaceState:
    """In-memory state singleton with async fan-out to SSE subscribers."""

    def __init__(self) -> None:
        self.mode: str = "idle"           # idle | music | cleaning | talking
        self.prev_mode: str = "idle"      # mode to restore after talking ends
        self.listening: bool = False
        self._subscribers: Set[asyncio.Queue] = set()
        self._lock = asyncio.Lock()

    def snapshot(self) -> dict:
        return {"mode": self.mode, "listening": self.listening}

    async def set_mode(self, mode: str) -> dict:
        async with self._lock:
            if mode not in VALID_MODES:
                raise ValueError(f"invalid mode: {mode}")
            if mode != "talking":
                self.prev_mode = mode
            self.mode = mode
        await self._broadcast()
        return self.snapshot()

    async def start_talking(self) -> dict:
        async with self._lock:
            if self.mode != "talking":
                self.prev_mode = self.mode
            self.mode = "talking"
        await self._broadcast()
        return self.snapshot()

    async def stop_talking(self) -> dict:
        async with self._lock:
            if self.mode == "talking":
                self.mode = self.prev_mode if self.prev_mode in VALID_MODES else "idle"
        await self._broadcast()
        return self.snapshot()

    async def set_listening(self, on: bool) -> dict:
        async with self._lock:
            self.listening = bool(on)
        await self._broadcast()
        return self.snapshot()

    # ---- pub/sub ----
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=32)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    async def _broadcast(self) -> None:
        payload = self.snapshot()
        for q in list(self._subscribers):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                # drop slow consumers' oldest message
                try:
                    q.get_nowait()
                    q.put_nowait(payload)
                except Exception:
                    pass


state = FaceState()

# ----- Auth ------------------------------------------------------------------

security = HTTPBearer(auto_error=False)


def require_token(creds: HTTPAuthorizationCredentials | None = Depends(security)) -> None:
    if not API_TOKEN:
        # Fail closed if token isn't configured
        raise HTTPException(status_code=500, detail="server token not configured")
    if creds is None or creds.scheme.lower() != "bearer" or creds.credentials != API_TOKEN:
        raise HTTPException(status_code=401, detail="invalid or missing bearer token")


# ----- App -------------------------------------------------------------------

app = FastAPI(title="KindBot Face Engine")
api = APIRouter(prefix="/api")


@api.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "kindbot-face-engine"}


@api.get("/state")
async def get_state() -> dict:
    return state.snapshot()


@api.get("/stream")
async def stream(request: Request) -> EventSourceResponse:
    """SSE stream. Kiosk subscribes here; no auth (read-only state)."""
    q = state.subscribe()

    async def event_gen() -> AsyncGenerator[dict, None]:
        try:
            # Send initial snapshot immediately
            yield {"event": "state", "data": json.dumps(state.snapshot())}
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield {"event": "state", "data": json.dumps(payload)}
                except asyncio.TimeoutError:
                    # keepalive comment
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
    return await state.start_talking()


@api.post("/mode/talking/stop", dependencies=[Depends(require_token)])
async def talking_stop() -> dict:
    return await state.stop_talking()


@api.post("/mode/listening/start", dependencies=[Depends(require_token)])
async def listening_start() -> dict:
    return await state.set_listening(True)


@api.post("/mode/listening/stop", dependencies=[Depends(require_token)])
async def listening_stop() -> dict:
    return await state.set_listening(False)


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
    log.info("KindBot Face Engine ready  mode=%s", state.mode)
