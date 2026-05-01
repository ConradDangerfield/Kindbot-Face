import { useEffect, useRef, useState } from "react";
import "@/App.css";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";
const API = `${BACKEND_URL}/api`;

// MP4 source map. In preview, files live in /assets/mp4/. In production
// (Node.js single-container), the same path is served by Express static.
const MP4_SOURCES = {
  music: "/assets/mp4/music.mp4",
  cleaning: "/assets/mp4/cleaning.mp4",
};

function App() {
  const [mode, setMode] = useState("idle");          // idle | music | cleaning | talking
  const [listening, setListening] = useState(false);
  const [connected, setConnected] = useState(false);

  // Refs to SVG groups - we animate these via transforms only.
  const faceRef = useRef(null);
  const leftEyeRef = useRef(null);
  const rightEyeRef = useRef(null);
  const mouthRef = useRef(null);
  const videoRef = useRef(null);

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
    };
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
      // Reduced rate when listening, normal otherwise
      const min = listening ? 4000 : 2000;
      const max = listening ? 8000 : 5000;
      const next = min + Math.random() * (max - min);
      timer = setTimeout(() => {
        // Don't blink during MP4 modes (face is hidden)
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

  // ----- Mouth talking loop ---------------------------------------------
  useEffect(() => {
    if (mode !== "talking" || !mouthRef.current) {
      // reset mouth transform when not talking
      if (mouthRef.current) {
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
      // Random scaleY between 0.55 and 1.25, slight scaleX variation
      tgtSY = 0.55 + Math.random() * 0.7;
      tgtSX = 0.92 + Math.random() * 0.18;
      nextSwitchAt = performance.now() + 50 + Math.random() * 70;
    };
    pickTarget();

    const tick = (t) => {
      if (cancelled) return;
      if (t >= nextSwitchAt) pickTarget();
      // Smooth ease toward target
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
      if (mouthRef.current) mouthRef.current.style.transform = "";
    };
  }, [mode]);

  // ----- MP4 playback management ----------------------------------------
  const showVideo = mode === "music" || mode === "cleaning";

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (showVideo) {
      v.muted = true;       // browsers require muted for autoplay
      v.playsInline = true;
      v.loop = true;
      const p = v.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } else {
      try { v.pause(); } catch (_) {}
    }
  }, [showVideo, mode]);

  // ----- Class composition ----------------------------------------------
  const stageClass = [
    "stage",
    `mode-${mode}`,
    listening ? "is-listening" : "",
    showVideo ? "video-on" : "video-off",
  ].filter(Boolean).join(" ");

  return (
    <div className={stageClass} data-testid="kindbot-stage">
      {/* Fullscreen MP4 layer (music / cleaning) */}
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

      {/* SVG face layer */}
      <div className="face-layer" data-testid="face-layer">
        <svg
          id="kindbot"
          viewBox="0 0 800 480"
          xmlns="http://www.w3.org/2000/svg"
          aria-label="KindBot face"
        >
          {/* HEAD */}
          <g id="head">
            <rect
              x="40" y="40" width="720" height="400"
              rx="80" ry="80"
              fill="none" stroke="#111" strokeWidth="12"
            />
          </g>

          {/* FACE GROUP - floating */}
          <g id="face" ref={faceRef} className="face-float">
            {/* LEFT EYE */}
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

            {/* RIGHT EYE */}
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

            {/* MOUTH */}
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

      {/* HUD: minimal status indicator (top-left), useful for debugging on the Pi */}
      <div className="hud" data-testid="hud-status">
        <span className={`dot ${connected ? "ok" : "down"}`} />
        <span className="hud-mode" data-testid="hud-mode">{mode}</span>
        {listening && <span className="hud-tag" data-testid="hud-listening">listening</span>}
      </div>
    </div>
  );
}

export default App;
