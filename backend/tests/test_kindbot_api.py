"""KindBot Face Engine — backend API tests (pytest).

Covers:
- Health & state
- Bearer auth on all /api/mode/* endpoints
- Mode transitions (idle / music / cleaning)
- Talking start/stop with prev_mode restoration
- Listening start/stop independent of mode
- SSE: initial snapshot + state events on mutation
"""
from __future__ import annotations

import json
import os
import threading
import time

import pytest
import requests
from dotenv import load_dotenv

# Load backend .env to pick up KINDBOT_API_TOKEN even if shell doesn't have it
load_dotenv("/app/backend/.env")

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL")
if not BASE_URL:
    # Fall back to frontend .env for the public preview URL
    from pathlib import Path

    fe_env = Path("/app/frontend/.env")
    if fe_env.exists():
        for line in fe_env.read_text().splitlines():
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip().strip('"')
                break
BASE_URL = (BASE_URL or "").rstrip("/")
TOKEN = os.environ.get("KINDBOT_API_TOKEN", "")

assert BASE_URL, "REACT_APP_BACKEND_URL must be set"
assert TOKEN, "KINDBOT_API_TOKEN must be set in /app/backend/.env"

AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    yield s
    # Reset to idle after the module
    try:
        s.post(f"{BASE_URL}/api/mode/idle", headers=AUTH, timeout=5)
        s.post(f"{BASE_URL}/api/mode/listening/stop", headers=AUTH, timeout=5)
    except Exception:
        pass
    s.close()


# ---------------- Health & state ----------------------------------------------

def test_health_ok(session):
    r = session.get(f"{BASE_URL}/api/health", timeout=10)
    assert r.status_code == 200
    body = r.json()
    assert body.get("status") == "ok"


def test_state_initial_shape(session):
    # Ensure clean state
    session.post(f"{BASE_URL}/api/mode/idle", headers=AUTH, timeout=5)
    session.post(f"{BASE_URL}/api/mode/listening/stop", headers=AUTH, timeout=5)

    r = session.get(f"{BASE_URL}/api/state", timeout=10)
    assert r.status_code == 200
    body = r.json()
    assert body == {"mode": "idle", "listening": False}


# ---------------- Auth --------------------------------------------------------

def test_mode_music_without_token_401(session):
    r = session.post(f"{BASE_URL}/api/mode/music", timeout=10)
    assert r.status_code == 401


def test_mode_music_with_wrong_token_401(session):
    r = session.post(
        f"{BASE_URL}/api/mode/music",
        headers={"Authorization": "Bearer wrong"},
        timeout=10,
    )
    assert r.status_code == 401


# ---------------- Mode transitions -------------------------------------------

def test_mode_music_with_token(session):
    r = session.post(f"{BASE_URL}/api/mode/music", headers=AUTH, timeout=10)
    assert r.status_code == 200
    assert r.json() == {"mode": "music", "listening": False}

    # Verify via GET /state
    g = session.get(f"{BASE_URL}/api/state", timeout=10).json()
    assert g["mode"] == "music"


def test_mode_cleaning_with_token(session):
    r = session.post(f"{BASE_URL}/api/mode/cleaning", headers=AUTH, timeout=10)
    assert r.status_code == 200
    assert r.json()["mode"] == "cleaning"


def test_mode_idle_with_token(session):
    r = session.post(f"{BASE_URL}/api/mode/idle", headers=AUTH, timeout=10)
    assert r.status_code == 200
    assert r.json()["mode"] == "idle"


# ---------------- Talking + prev_mode restoration ----------------------------

def test_talking_restores_cleaning(session):
    # Set cleaning
    session.post(f"{BASE_URL}/api/mode/cleaning", headers=AUTH, timeout=10)

    r1 = session.post(f"{BASE_URL}/api/mode/talking/start", headers=AUTH, timeout=10)
    assert r1.status_code == 200
    assert r1.json()["mode"] == "talking"

    r2 = session.post(f"{BASE_URL}/api/mode/talking/stop", headers=AUTH, timeout=10)
    assert r2.status_code == 200
    assert r2.json()["mode"] == "cleaning"


def test_talking_restores_idle(session):
    session.post(f"{BASE_URL}/api/mode/idle", headers=AUTH, timeout=10)

    r1 = session.post(f"{BASE_URL}/api/mode/talking/start", headers=AUTH, timeout=10)
    assert r1.status_code == 200
    assert r1.json()["mode"] == "talking"

    r2 = session.post(f"{BASE_URL}/api/mode/talking/stop", headers=AUTH, timeout=10)
    assert r2.status_code == 200
    assert r2.json()["mode"] == "idle"


# ---------------- Listening (independent of mode) ----------------------------

def test_listening_toggle(session):
    # Make sure mode is idle so we don't carry side-effects
    session.post(f"{BASE_URL}/api/mode/idle", headers=AUTH, timeout=10)

    r1 = session.post(f"{BASE_URL}/api/mode/listening/start", headers=AUTH, timeout=10)
    assert r1.status_code == 200
    body1 = r1.json()
    assert body1["listening"] is True

    g = session.get(f"{BASE_URL}/api/state", timeout=10).json()
    assert g["listening"] is True

    r2 = session.post(f"{BASE_URL}/api/mode/listening/stop", headers=AUTH, timeout=10)
    assert r2.status_code == 200
    assert r2.json()["listening"] is False


def test_listening_without_token_401(session):
    r = session.post(f"{BASE_URL}/api/mode/listening/start", timeout=10)
    assert r.status_code == 401


# ---------------- SSE stream --------------------------------------------------

def _read_sse_events(url, duration_s, out_list):
    """Read SSE stream for `duration_s` seconds, append parsed events to out_list."""
    try:
        with requests.get(
            url,
            stream=True,
            timeout=duration_s + 5,
            headers={"Accept": "text/event-stream"},
        ) as resp:
            assert resp.status_code == 200
            start = time.time()
            event = None
            data_lines = []
            for raw in resp.iter_lines(decode_unicode=True):
                if time.time() - start > duration_s:
                    break
                if raw is None:
                    continue
                line = raw.strip("\r")
                if line == "":
                    if event and data_lines:
                        try:
                            payload = json.loads("\n".join(data_lines))
                        except Exception:
                            payload = "\n".join(data_lines)
                        out_list.append({"event": event, "data": payload})
                    event, data_lines = None, []
                    continue
                if line.startswith("event:"):
                    event = line.split(":", 1)[1].strip()
                elif line.startswith("data:"):
                    data_lines.append(line.split(":", 1)[1].strip())
    except Exception as e:
        out_list.append({"event": "error", "data": str(e)})


def test_sse_initial_and_updates(session):
    # Reset to a known baseline
    session.post(f"{BASE_URL}/api/mode/idle", headers=AUTH, timeout=10)
    session.post(f"{BASE_URL}/api/mode/listening/stop", headers=AUTH, timeout=10)

    events = []
    t = threading.Thread(
        target=_read_sse_events,
        args=(f"{BASE_URL}/api/stream", 6, events),
        daemon=True,
    )
    t.start()

    # Give the consumer a moment to connect & receive initial snapshot
    time.sleep(1.2)

    # Issue mutations
    session.post(f"{BASE_URL}/api/mode/music", headers=AUTH, timeout=10)
    time.sleep(0.5)
    session.post(f"{BASE_URL}/api/mode/listening/start", headers=AUTH, timeout=10)
    time.sleep(0.5)
    session.post(f"{BASE_URL}/api/mode/idle", headers=AUTH, timeout=10)
    session.post(f"{BASE_URL}/api/mode/listening/stop", headers=AUTH, timeout=10)

    t.join(timeout=8)

    state_events = [e for e in events if e.get("event") == "state"]
    assert len(state_events) >= 3, f"expected >=3 state events, got {events}"

    # Initial snapshot should reflect idle
    first = state_events[0]["data"]
    assert isinstance(first, dict)
    assert first.get("mode") == "idle"
    assert first.get("listening") is False

    # We should observe a music event somewhere
    modes_seen = [e["data"].get("mode") for e in state_events if isinstance(e["data"], dict)]
    listening_seen = [e["data"].get("listening") for e in state_events if isinstance(e["data"], dict)]
    assert "music" in modes_seen
    assert True in listening_seen
