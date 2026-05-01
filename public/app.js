// KindBot Face Engine — kiosk client (production single-container).
// Subscribes to /api/stream (SSE) and animates the inline SVG via transforms.
(function () {
  'use strict';

  const MP4_SOURCES = {
    music:    '/assets/mp4/music.mp4',
    cleaning: '/assets/mp4/cleaning.mp4',
  };

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

  // ----- State application --------------------------------------------------
  function applyState(next) {
    const prevMode = mode;
    if (typeof next.mode === 'string') mode = next.mode;
    if (typeof next.listening === 'boolean') listening = next.listening;

    // Stage class
    stage.className = ['stage',
      'mode-' + mode,
      listening ? 'is-listening' : '',
      (mode === 'music' || mode === 'cleaning') ? 'video-on' : 'video-off',
    ].filter(Boolean).join(' ');

    hudMode.textContent = mode;
    if (listening) hudListening.removeAttribute('hidden');
    else hudListening.setAttribute('hidden', '');

    // Video source / playback
    if (mode === 'music' || mode === 'cleaning') {
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
    if (mode === 'talking' && prevMode !== 'talking') startMouth();
    if (mode !== 'talking' && prevMode === 'talking') stopMouth();
  }

  // ----- Blink loop ---------------------------------------------------------
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

  // ----- Mouth talking loop -------------------------------------------------
  let mouthRaf = 0;
  let mouthRunning = false;

  function startMouth() {
    if (mouthRunning) return;
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
      if (!mouthRunning) return;
      if (t >= nextSwitchAt) pickTarget();
      curSY += (tgtSY - curSY) * 0.35;
      curSX += (tgtSX - curSX) * 0.35;
      mouth.style.transform = 'scale(' + curSX.toFixed(3) + ',' + curSY.toFixed(3) + ')';
      mouthRaf = requestAnimationFrame(tick);
    }
    mouthRaf = requestAnimationFrame(tick);
  }

  function stopMouth() {
    mouthRunning = false;
    cancelAnimationFrame(mouthRaf);
    mouth.style.transform = '';
  }

  // ----- SSE subscription ---------------------------------------------------
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
    es.onerror = () => {
      dot.classList.remove('ok');
      dot.classList.add('down');
      es.close();
      setTimeout(connect, 1500);
    };
  }
  connect();
})();
