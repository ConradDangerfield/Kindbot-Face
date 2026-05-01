// State machine for the KindBot Face Engine (production Node.js).
// Generic pub/sub: subscribers receive {event, data} envelopes so we can
// multiplex 'state' updates and 'say' events on a single SSE channel.

const VALID_MODES = new Set(['idle', 'music', 'cleaning', 'talking']);

class FaceState {
  constructor() {
    this.mode = 'idle';
    this.prevMode = 'idle';
    this.listening = false;
    this._talkingToken = 0;        // increments to invalidate stale auto-stops
    this.subscribers = new Set();  // each is fn({event, data}){}
  }

  snapshot() {
    return { mode: this.mode, listening: this.listening };
  }

  _broadcast(event, data) {
    const env = { event, data };
    for (const fn of this.subscribers) {
      try { fn(env); } catch (_) {}
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
    this._talkingToken++;
    this._broadcast('state', this.snapshot());
    return this.snapshot();
  }

  startTalking() {
    if (this.mode !== 'talking') this.prevMode = this.mode;
    this.mode = 'talking';
    this._talkingToken++;
    const token = this._talkingToken;
    this._broadcast('state', this.snapshot());
    return { snapshot: this.snapshot(), token };
  }

  stopTalking() {
    if (this.mode === 'talking') {
      this.mode = VALID_MODES.has(this.prevMode) ? this.prevMode : 'idle';
    }
    this._talkingToken++;
    this._broadcast('state', this.snapshot());
    return this.snapshot();
  }

  // Stop talking only if no other transition has happened since `token`.
  stopTalkingIfToken(token) {
    if (this._talkingToken !== token || this.mode !== 'talking') return false;
    this.mode = VALID_MODES.has(this.prevMode) ? this.prevMode : 'idle';
    this._talkingToken++;
    this._broadcast('state', this.snapshot());
    return true;
  }

  setListening(on) {
    this.listening = !!on;
    this._broadcast('state', this.snapshot());
    return this.snapshot();
  }

  emitSay(payload) {
    this._broadcast('say', payload);
  }
}

module.exports = { FaceState, VALID_MODES };
