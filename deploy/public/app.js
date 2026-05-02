// KindBot Face Engine — kiosk client (production single-container).
// Subscribes to /api/stream (SSE) and animates the inline SVG via transforms.
// Also reacts to `say` events: plays the TTS audio with Web Audio API
// amplitude analysis driving the mouth scaleY for real lip-sync.
(function () {
  'use strict';

  const MP4_SOURCES = (() => {
    const modes = ['music','cleaning','chef','gaming','angry','bandit','karate','love','party','santa','sleeping','hot'];
    return Object.fromEntries(modes.map((m) => [m, `/assets/mp4/${m}.mp4`]));
  })();

  const stage = document.getElementById('stage');
  const dot = document.getElementById('dot');
  const hudMode = document.getElementById('hud-mode');
  const hudListening = document.getElementById('hud-listening');
  const video = document.getElementById('bg-video');
  const leftEye = document.getElementById('left_eye');
  const rightEye = document.getElementById('right_eye');
  const mouth = document.getElementById('mouth');

  let mode = 'idle';
  let listening = false;

  // ----- Synthetic mouth talking loop (used when no /api/say is active) ----
  let mouthRaf = 0;
  let mouthRunning = false;
  function startSyntheticMouth() {
    if (mouthRunning || sayActive) return;
    mouthRunning = true;
    let curSY = 1, curSX = 1;
    let tgtSY = 1, tgtSX = 1;
    let nextSwitchAt = 0;
    function pickTarget() {
      tgtSY = 0.55 + Math.random() * 0.7;
      tgtSX = 0.92 + Math.random() * 0.18;
      nextSwitchAt = performance.now() + 50 + Math.random() * 70;
    }
    pickTarget();
    function tick(t) {
      if (!mouthRunning || sayActive) return;
      if (t >= nextSwitchAt) pickTarget();
      curSY += (tgtSY - curSY) * 0.35;
      curSX += (tgtSX - curSX) * 0.35;
      mouth.style.transform = 'scale(' + curSX.toFixed(3) + ',' + curSY.toFixed(3) + ')';
      mouthRaf = requestAnimationFrame(tick);
    }
    mouthRaf = requestAnimationFrame(tick);
  }
  function stopSyntheticMouth() {
    mouthRunning = false;
    cancelAnimationFrame(mouthRaf);
    if (!sayActive) mouth.style.transform = '';
  }

  // ----- /api/say playback with amplitude-driven mouth ---------------------
  let audioCtx = null;
  let sayAudio = null;
  let sayAnalyser = null;
  let sayRaf = 0;
  let sayActive = false;

  function ensureAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function stopSay() {
    sayActive = false;
    cancelAnimationFrame(sayRaf);
    if (sayAudio) {
      try { sayAudio.pause(); } catch (_) {}
      try { sayAudio.src = ''; } catch (_) {}
      sayAudio = null;
    }
    sayAnalyser = null;
    mouth.style.transform = '';
  }

  function playSay(url) {
    stopSay();
    stopSyntheticMouth();
    const audio = new Audio(url);
    audio.crossOrigin = 'anonymous';
    audio.preload = 'auto';
    sayAudio = audio;

    const ctx = ensureAudioCtx();
    let analyser = null;
    if (ctx) {
      try {
        const src = ctx.createMediaElementSource(audio);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.65;
        src.connect(analyser);
        analyser.connect(ctx.destination);
        sayAnalyser = analyser;
      } catch (_) {
        analyser = null;
      }
    }

    sayActive = true;
    const buf = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    let curSY = 1, curSX = 1;

    function tick() {
      if (!sayActive) return;
      let level = 0;
      if (analyser && buf) {
        analyser.getByteFrequencyData(buf);
        let sum = 0;
        let count = 0;
        for (let i = 2; i < 32; i++) { sum += buf[i]; count++; }
        level = count ? sum / count / 255 : 0;
      } else {
        level = 0.25 + Math.abs(Math.sin(performance.now() / 90)) * 0.5;
      }
      const tgtSY = 0.30 + Math.min(1.0, level * 2.3) * 1.0;
      const tgtSX = 0.96 + Math.min(0.18, level * 0.3);
      curSY += (tgtSY - curSY) * 0.45;
      curSX += (tgtSX - curSX) * 0.45;
      mouth.style.transform = 'scale(' + curSX.toFixed(3) + ',' + curSY.toFixed(3) + ')';
      sayRaf = requestAnimationFrame(tick);
    }

    audio.addEventListener('ended', stopSay, { once: true });
    audio.addEventListener('error', stopSay, { once: true });
    const p = audio.play();
    if (p && typeof p.catch === 'function') p.catch(() => stopSay());
    sayRaf = requestAnimationFrame(tick);
  }

  // ----- State application -------------------------------------------------
  function applyState(next) {
    const prevMode = mode;
    if (typeof next.mode === 'string') mode = next.mode;
    if (typeof next.listening === 'boolean') listening = next.listening;

    const isVideoMode = Object.prototype.hasOwnProperty.call(MP4_SOURCES, mode);
    stage.className = ['stage',
      'mode-' + mode,
      listening ? 'is-listening' : '',
      isVideoMode ? 'video-on' : 'video-off',
    ].filter(Boolean).join(' ');

    hudMode.textContent = mode;
    if (listening) hudListening.removeAttribute('hidden');
    else hudListening.setAttribute('hidden', '');

    if (isVideoMode) {
      const src = MP4_SOURCES[mode];
      if (video.getAttribute('src') !== src) {
        video.setAttribute('src', src);
        video.load();
      }
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else {
      try { video.pause(); } catch (_) {}
    }

    // Mouth animation lifecycle
    if (mode === 'talking' && prevMode !== 'talking') {
      // If a /api/say is already running, let it drive the mouth.
      // Otherwise start the synthetic loop.
      if (!sayActive) startSyntheticMouth();
    }
    if (mode !== 'talking' && prevMode === 'talking') {
      stopSyntheticMouth();
      stopSay();
    }
  }

  // ----- Blink loop --------------------------------------------------------
  (function blinkLoop() {
    function once() {
      [leftEye, rightEye].forEach((g) => g && g.classList.add('blink'));
      setTimeout(() => {
        [leftEye, rightEye].forEach((g) => g && g.classList.remove('blink'));
      }, 130);
    }
    function schedule() {
      const min = listening ? 4000 : 2000;
      const max = listening ? 8000 : 5000;
      const next = min + Math.random() * (max - min);
      setTimeout(() => {
        if (mode === 'idle' || mode === 'talking') once();
        schedule();
      }, next);
    }
    schedule();
  })();

  // ----- SSE subscription --------------------------------------------------
  function connect() {
    const es = new EventSource('/api/stream');
    es.addEventListener('state', (e) => {
      try {
        const data = JSON.parse(e.data);
        applyState(data);
        dot.classList.add('ok');
        dot.classList.remove('down');
      } catch (_) {}
    });
    es.addEventListener('say', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data && data.url) playSay(data.url);
      } catch (_) {}
    });
    es.onerror = () => {
      dot.classList.remove('ok');
      dot.classList.add('down');
      es.close();
      setTimeout(connect, 1500);
    };
  }
  connect();
})();
