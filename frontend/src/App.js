import { useEffect, useRef, useState } from "react";
import "@/App.css";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";
const API = `${BACKEND_URL}/api`;

const VIDEO_MODES = [
  "music", "cleaning", "chef", "gaming", "angry", "bandit",
  "karate", "love", "party", "santa", "sleeping", "hot",
];
const MP4_SOURCES = Object.fromEntries(
  VIDEO_MODES.map((m) => [m, `/assets/mp4/${m}.mp4`])
);

function App() {
  const [mode, setMode] = useState("idle");
  const [listening, setListening] = useState(false);
  const [connected, setConnected] = useState(false);

  const faceRef = useRef(null);
  const leftEyeRef = useRef(null);
  const rightEyeRef = useRef(null);
  const mouthRef = useRef(null);
  const videoRef = useRef(null);

  // amplitude-driven lip-sync infrastructure (Web Audio API)
  const audioCtxRef = useRef(null);
  const sayAudioRef = useRef(null);
  const sayAnalyserRef = useRef(null);
  const sayRafRef = useRef(0);
  const sayActiveRef = useRef(false);

  // ----- SSE subscription ------------------------------------------------
  useEffect(() => {
    let es;
    let stopped = false;
    let retry;

    const connect = () => {
      es = new EventSource(`${API}/stream`);
      es.addEventListener("state", (e) => {
        try {
          const data = JSON.parse(e.data);
          if (typeof data.mode === "string") setMode(data.mode);
          if (typeof data.listening === "boolean") setListening(data.listening);
          setConnected(true);
        } catch (_) {}
      });
      es.addEventListener("say", (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data && data.url) playSay(`${BACKEND_URL}${data.url}`);
        } catch (_) {}
      });
      es.onerror = () => {
        setConnected(false);
        es.close();
        if (!stopped) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      if (es) es.close();
      stopSay();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- Blink loop ------------------------------------------------------
  useEffect(() => {
    let timer;
    let cancelled = false;

    const blinkOnce = () => {
      const eyes = [leftEyeRef.current, rightEyeRef.current];
      eyes.forEach((g) => g && g.classList.add("blink"));
      setTimeout(() => {
        eyes.forEach((g) => g && g.classList.remove("blink"));
      }, 130);
    };

    const schedule = () => {
      if (cancelled) return;
      const min = listening ? 4000 : 2000;
      const max = listening ? 8000 : 5000;
      const next = min + Math.random() * (max - min);
      timer = setTimeout(() => {
        if (mode === "idle" || mode === "talking") blinkOnce();
        schedule();
      }, next);
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mode, listening]);

  // ----- Mouth talking loop (synthetic, used when no /api/say is active) -
  useEffect(() => {
    if (mode !== "talking" || !mouthRef.current || sayActiveRef.current) {
      if (mouthRef.current && !sayActiveRef.current) {
        mouthRef.current.style.transform = "";
      }
      return;
    }
    let raf;
    let cancelled = false;
    let nextSwitchAt = 0;
    let curSY = 1, curSX = 1;
    let tgtSY = 1, tgtSX = 1;

    const pickTarget = () => {
      tgtSY = 0.55 + Math.random() * 0.7;
      tgtSX = 0.92 + Math.random() * 0.18;
      nextSwitchAt = performance.now() + 50 + Math.random() * 70;
    };
    pickTarget();

    const tick = (t) => {
      if (cancelled) return;
      // If amplitude-driven sync took over mid-flight, yield
      if (sayActiveRef.current) { return; }
      if (t >= nextSwitchAt) pickTarget();
      curSY += (tgtSY - curSY) * 0.35;
      curSX += (tgtSX - curSX) * 0.35;
      if (mouthRef.current) {
        mouthRef.current.style.transform = `scale(${curSX.toFixed(3)}, ${curSY.toFixed(3)})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (mouthRef.current && !sayActiveRef.current) {
        mouthRef.current.style.transform = "";
      }
    };
  }, [mode]);

  // ----- /api/say playback with amplitude-driven mouth ------------------
  const ensureAudioCtx = () => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtxRef.current = new Ctx();
    }
    if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume().catch(() => {});
    }
    return audioCtxRef.current;
  };

  const stopSay = () => {
    sayActiveRef.current = false;
    cancelAnimationFrame(sayRafRef.current);
    if (sayAudioRef.current) {
      try { sayAudioRef.current.pause(); } catch (_) {}
      try { sayAudioRef.current.src = ""; } catch (_) {}
      sayAudioRef.current = null;
    }
    sayAnalyserRef.current = null;
    if (mouthRef.current) mouthRef.current.style.transform = "";
  };

  const playSay = (url) => {
    stopSay();
    const audio = new Audio(url);
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    sayAudioRef.current = audio;

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
        sayAnalyserRef.current = analyser;
      } catch (_) {
        // If WebAudio isn't available (some Pis with strict autoplay), audio
        // will still play normally — the synthetic mouth loop will run.
        analyser = null;
      }
    }

    sayActiveRef.current = true;

    const buf = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    let curSY = 1, curSX = 1;
    const tick = () => {
      if (!sayActiveRef.current) return;
      let level = 0;
      if (analyser && buf) {
        analyser.getByteFrequencyData(buf);
        // Use lower-mid range (vowel/consonant energy band)
        let sum = 0, count = 0;
        for (let i = 2; i < 32; i++) { sum += buf[i]; count++; }
        level = count ? sum / count / 255 : 0;     // 0..1
      } else {
        // Fallback — fake a varying level
        level = 0.25 + Math.abs(Math.sin(performance.now() / 90)) * 0.5;
      }
      const tgtSY = 0.30 + Math.min(1.0, level * 2.3) * 1.0;   // 0.30..1.30
      const tgtSX = 0.96 + Math.min(0.18, level * 0.3);
      curSY += (tgtSY - curSY) * 0.45;
      curSX += (tgtSX - curSX) * 0.45;
      if (mouthRef.current) {
        mouthRef.current.style.transform = `scale(${curSX.toFixed(3)}, ${curSY.toFixed(3)})`;
      }
      sayRafRef.current = requestAnimationFrame(tick);
    };

    audio.addEventListener("ended", stopSay, { once: true });
    audio.addEventListener("error", stopSay, { once: true });

    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch(() => stopSay());
    }
    sayRafRef.current = requestAnimationFrame(tick);
  };

  // ----- MP4 playback management ----------------------------------------
  const showVideo = Object.prototype.hasOwnProperty.call(MP4_SOURCES, mode);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (showVideo) {
      v.muted = true;
      v.playsInline = true;
      v.loop = true;
      const p = v.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } else {
      try { v.pause(); } catch (_) {}
    }
  }, [showVideo, mode]);

  // Stop /api/say playback if we leave talking mode for any reason
  useEffect(() => {
    if (mode !== "talking") stopSay();
  }, [mode]);

  const stageClass = [
    "stage",
    `mode-${mode}`,
    listening ? "is-listening" : "",
    showVideo ? "video-on" : "video-off",
  ].filter(Boolean).join(" ");

  return (
    <div className={stageClass} data-testid="kindbot-stage">
      <div className="video-layer" data-testid="video-layer">
        <video
          ref={videoRef}
          className="bg-video"
          src={showVideo ? MP4_SOURCES[mode] : undefined}
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
          data-testid="bg-video"
        />
      </div>

      <div className="face-layer" data-testid="face-layer">
        <svg
          id="kindbot"
          viewBox="0 0 800 480"
          xmlns="http://www.w3.org/2000/svg"
          aria-label="KindBot face"
        >
          <g id="head">
            <rect
              x="40" y="40" width="720" height="400"
              rx="80" ry="80"
              fill="none" stroke="#111" strokeWidth="12"
            />
          </g>

          <g id="face" ref={faceRef} className="face-float">
            <g
              id="left_eye"
              ref={leftEyeRef}
              transform="translate(260, 220)"
              className="eye"
              data-testid="left-eye"
            >
              <ellipse cx="0" cy="0" rx="55" ry="55" fill="#111" />
              <circle cx="-15" cy="-15" r="12" fill="#fff" />
              <circle cx="20" cy="10" r="6" fill="#fff" />
            </g>

            <g
              id="right_eye"
              ref={rightEyeRef}
              transform="translate(540, 220)"
              className="eye"
              data-testid="right-eye"
            >
              <ellipse cx="0" cy="0" rx="55" ry="55" fill="#111" />
              <circle cx="-15" cy="-15" r="12" fill="#fff" />
              <circle cx="20" cy="10" r="6" fill="#fff" />
            </g>

            <g
              id="mouth"
              ref={mouthRef}
              transform="translate(400, 310)"
              className="mouth"
              data-testid="mouth"
            >
              <rect x="-60" y="-18" width="120" height="36" rx="18" fill="#111" />
            </g>
          </g>
        </svg>
      </div>

      <div className="hud" data-testid="hud-status">
        <span className={`dot ${connected ? "ok" : "down"}`} />
        <span className="hud-mode" data-testid="hud-mode">{mode}</span>
        {listening && <span className="hud-tag" data-testid="hud-listening">listening</span>}
      </div>
    </div>
  );
}

export default App;
