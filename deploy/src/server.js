// KindBot Face Engine — single-container Node.js Express server.
// Serves the kiosk frontend AND the control API on one port.
//
// ENV:
//   PORT                  (default 8080)
//   KINDBOT_API_TOKEN     REQUIRED. Bearer token for /mode/* and /say writes.
//   CORS_ORIGINS          (default *) comma-separated list of allowed origins
//   OPENAI_API_KEY        OPTIONAL. Enables /api/say (TTS lip-sync).
//   KINDBOT_TTS_MODEL     (default tts-1)  -- tts-1 | tts-1-hd
//   KINDBOT_TTS_VOICE     (default nova)   -- alloy|ash|coral|echo|fable|nova|onyx|sage|shimmer
//
// Endpoints:
//   GET  /                static kiosk page
//   GET  /assets/...      static assets (mp4s, etc.)
//   GET  /api/health
//   GET  /api/state
//   GET  /api/stream      Server-Sent Events stream (state + say events)
//   POST /api/mode/*      (auth)
//   POST /api/say         (auth) -- TTS lip-sync
//   GET  /api/say/:id.mp3 -- serves cached generated audio

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const OpenAI = require('openai');
const mm = require('music-metadata');
const { FaceState } = require('./state');

const PORT = parseInt(process.env.PORT || '8080', 10);
const TOKEN = process.env.KINDBOT_API_TOKEN || '';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim());
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const TTS_MODEL = (process.env.KINDBOT_TTS_MODEL || 'tts-1').toLowerCase();
const TTS_VOICE = (process.env.KINDBOT_TTS_VOICE || 'nova').toLowerCase();

if (!TOKEN) {
  console.warn('[kindbot] WARNING: KINDBOT_API_TOKEN is not set.');
  console.warn('[kindbot]   Read-only endpoints (/api/health, /api/state, /api/stream)');
  console.warn('[kindbot]   and the kiosk frontend will work normally, but');
  console.warn('[kindbot]   /api/mode/* and /api/say will return 503 until a token');
  console.warn('[kindbot]   is configured. Set KINDBOT_API_TOKEN in .env and restart.');
}

const app = express();
const state = new FaceState();
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const VALID_VOICES = new Set([
  'alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer',
]);
const VALID_TTS_MODELS = new Set(['tts-1', 'tts-1-hd']);

// In-memory MP3 cache for /api/say results
const SAY_CACHE = new Map();   // id -> { audio: Buffer, ts: number }
const SAY_CACHE_MAX = 32;
const SAY_CACHE_TTL_MS = 10 * 60 * 1000;

function cacheSay(buf) {
  const id = crypto.randomBytes(8).toString('hex');
  SAY_CACHE.set(id, { audio: buf, ts: Date.now() });
  // TTL eviction
  const now = Date.now();
  for (const [k, v] of SAY_CACHE) {
    if (now - v.ts > SAY_CACHE_TTL_MS) SAY_CACHE.delete(k);
  }
  // Cap size
  while (SAY_CACHE.size > SAY_CACHE_MAX) {
    const oldest = [...SAY_CACHE.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) SAY_CACHE.delete(oldest[0]); else break;
  }
  return id;
}

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// ----- CORS ------------------------------------------------------------------
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  const allowed = CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin);
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGINS.includes('*') ? '*' : origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

// ----- Auth middleware ------------------------------------------------------
function requireToken(req, res, next) {
  if (!TOKEN) {
    return res.status(503).json({
      error: 'KINDBOT_API_TOKEN not configured. Set it in .env and restart the container.',
    });
  }
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m || m[1] !== TOKEN) {
    return res.status(401).json({ error: 'invalid or missing bearer token' });
  }
  return next();
}

// ----- API ------------------------------------------------------------------
const api = express.Router();

api.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'kindbot-face-engine',
    token_configured: !!TOKEN,
    tts_enabled: !!openai,
  });
});

api.get('/state', (_req, res) => {
  res.json(state.snapshot());
});

api.get('/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Initial state
  send('state', state.snapshot());

  const unsub = state.subscribe((env) => send(env.event, env.data));
  const ka = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(ka);
    unsub();
  });
});

// ---- Mode endpoints --------------------------------------------------------
api.post('/mode/idle',     requireToken, (_req, res) => res.json(state.setMode('idle')));
api.post('/mode/music',    requireToken, (_req, res) => res.json(state.setMode('music')));
api.post('/mode/cleaning', requireToken, (_req, res) => res.json(state.setMode('cleaning')));
api.post('/mode/talking/start', requireToken, (_req, res) => res.json(state.startTalking().snapshot));
api.post('/mode/talking/stop',  requireToken, (_req, res) => res.json(state.stopTalking()));
api.post('/mode/listening/start', requireToken, (_req, res) => res.json(state.setListening(true)));
api.post('/mode/listening/stop',  requireToken, (_req, res) => res.json(state.setListening(false)));

// ---- TTS lip-sync (/api/say) ----------------------------------------------
api.post('/say', requireToken, async (req, res) => {
  if (!openai) {
    return res.status(503).json({
      error: 'OPENAI_API_KEY not configured. Set it to enable /api/say.',
    });
  }
  const text = (req.body && typeof req.body.text === 'string') ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'text is required' });
  if (text.length > 4000) return res.status(400).json({ error: 'text must be <= 4000 chars' });

  const voice = ((req.body.voice || TTS_VOICE) + '').toLowerCase();
  const model = ((req.body.model || TTS_MODEL) + '').toLowerCase();
  const speed = req.body.speed != null ? Number(req.body.speed) : undefined;

  if (!VALID_VOICES.has(voice)) return res.status(400).json({ error: `invalid voice; choose from ${[...VALID_VOICES].sort().join(', ')}` });
  if (!VALID_TTS_MODELS.has(model)) return res.status(400).json({ error: `invalid model; choose from ${[...VALID_TTS_MODELS].sort().join(', ')}` });
  if (speed !== undefined && (Number.isNaN(speed) || speed < 0.25 || speed > 4.0)) {
    return res.status(400).json({ error: 'speed must be a number in [0.25, 4.0]' });
  }

  let audioBuf;
  try {
    const params = { model, voice, input: text, response_format: 'mp3' };
    if (speed !== undefined) params.speed = speed;
    const result = await openai.audio.speech.create(params);
    audioBuf = Buffer.from(await result.arrayBuffer());
  } catch (err) {
    console.error('[kindbot] tts error:', err && err.message ? err.message : err);
    return res.status(502).json({ error: `tts provider error: ${err && err.message ? err.message : 'unknown'}` });
  }
  if (!audioBuf || audioBuf.length === 0) {
    return res.status(502).json({ error: 'tts returned empty audio' });
  }

  // Probe duration
  let durationMs = 0;
  try {
    const meta = await mm.parseBuffer(audioBuf, 'audio/mpeg', { duration: true });
    if (meta && meta.format && meta.format.duration) {
      durationMs = Math.round(meta.format.duration * 1000);
    }
  } catch (_) { /* best-effort */ }

  const id = cacheSay(audioBuf);
  const url = `/api/say/${id}.mp3`;

  // Flip into talking mode and capture token for auto-stop
  const { token } = state.startTalking();
  state.emitSay({ id, url, durationMs, voice, model });

  if (durationMs > 0) {
    setTimeout(() => {
      try { state.stopTalkingIfToken(token); } catch (_) {}
    }, durationMs + 250);
  }

  return res.json({ id, url, durationMs, voice, model });
});

api.get('/say/:fname', (req, res) => {
  // fname expected as "<id>.mp3"
  const m = /^([0-9a-f]+)\.mp3$/i.exec(req.params.fname || '');
  if (!m) return res.status(404).json({ error: 'not found' });
  const entry = SAY_CACHE.get(m[1]);
  if (!entry) return res.status(404).json({ error: 'audio not found or expired' });
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'public, max-age=600');
  res.setHeader('Content-Length', entry.audio.length);
  res.end(entry.audio);
});

app.use('/api', api);

// ----- Static frontend ------------------------------------------------------
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, {
  fallthrough: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  },
}));

// SPA fallback (kiosk single page)
app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[kindbot] listening on 0.0.0.0:${PORT}`);
  console.log(`[kindbot] mode=${state.mode}  cors=${CORS_ORIGINS.join('|')}  tts=${openai ? 'on' : 'off'}  voice=${TTS_VOICE}  model=${TTS_MODEL}`);
});
