// KindBot Face Engine — single-container Node.js Express server.
// Serves the kiosk frontend AND the control API on one port.
//
// ENV:
//   PORT                 (default 8080)
//   KINDBOT_API_TOKEN    REQUIRED. Bearer token for /mode/* writes.
//   CORS_ORIGINS         (default *) comma-separated list of allowed origins
//
// Endpoints:
//   GET  /                static kiosk page
//   GET  /assets/...      static assets (mp4s, etc.)
//   GET  /api/health
//   GET  /api/state
//   GET  /api/stream      Server-Sent Events stream
//   POST /api/mode/idle             (auth)
//   POST /api/mode/music            (auth)
//   POST /api/mode/cleaning         (auth)
//   POST /api/mode/talking/start    (auth)
//   POST /api/mode/talking/stop     (auth)
//   POST /api/mode/listening/start  (auth)
//   POST /api/mode/listening/stop   (auth)

const path = require('path');
const express = require('express');
const { FaceState } = require('./state');

const PORT = parseInt(process.env.PORT || '8080', 10);
const TOKEN = process.env.KINDBOT_API_TOKEN || '';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim());

if (!TOKEN) {
  console.error('[kindbot] FATAL: KINDBOT_API_TOKEN env var is required');
  process.exit(1);
}

const app = express();
const state = new FaceState();

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// ----- CORS (lightweight, only what we need) --------------------------------
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

// ----- Bearer auth middleware ----------------------------------------------
function requireToken(req, res, next) {
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
  res.json({ status: 'ok', service: 'kindbot-face-engine' });
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

  const unsub = state.subscribe((snap) => send('state', snap));
  const ka = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(ka);
    unsub();
  });
});

api.post('/mode/idle', requireToken, (_req, res) => {
  res.json(state.setMode('idle'));
});
api.post('/mode/music', requireToken, (_req, res) => {
  res.json(state.setMode('music'));
});
api.post('/mode/cleaning', requireToken, (_req, res) => {
  res.json(state.setMode('cleaning'));
});
api.post('/mode/talking/start', requireToken, (_req, res) => {
  res.json(state.startTalking());
});
api.post('/mode/talking/stop', requireToken, (_req, res) => {
  res.json(state.stopTalking());
});
api.post('/mode/listening/start', requireToken, (_req, res) => {
  res.json(state.setListening(true));
});
api.post('/mode/listening/stop', requireToken, (_req, res) => {
  res.json(state.setListening(false));
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
  console.log(`[kindbot] mode=${state.mode}  cors=${CORS_ORIGINS.join('|')}`);
});
