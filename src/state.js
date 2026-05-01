// State machine for the KindBot Face Engine.
// Mirrors backend/server.py (FastAPI) so behaviour is identical in
// preview and production single-container deployments.

const VALID_MODES = new Set(['idle', 'music', 'cleaning', 'talking']);

class FaceState {
  constructor() {
    this.mode = 'idle';
    this.prevMode = 'idle';
    this.listening = false;
    this.subscribers = new Set();   // each is a function(state){}
  }

  snapshot() {
    return { mode: this.mode, listening: this.listening };
  }

  _broadcast() {
    const snap = this.snapshot();
    for (const fn of this.subscribers) {
      try { fn(snap); } catch (_) {}
    }
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  setMode(mode) {
    if (!VALID_MODES.has(mode)) throw new Error(`invalid mode: ${mode}`);
    if (mode !== 'talking') this.prevMode = mode;
    this.mode = mode;
    this._broadcast();
    return this.snapshot();
  }

  startTalking() {
    if (this.mode !== 'talking') this.prevMode = this.mode;
    this.mode = 'talking';
    this._broadcast();
    return this.snapshot();
  }

  stopTalking() {
    if (this.mode === 'talking') {
      this.mode = VALID_MODES.has(this.prevMode) ? this.prevMode : 'idle';
    }
    this._broadcast();
    return this.snapshot();
  }

  setListening(on) {
    this.listening = !!on;
    this._broadcast();
    return this.snapshot();
  }
}

module.exports = { FaceState, VALID_MODES };
