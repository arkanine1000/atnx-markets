"use client";

import { useEffect, useRef, useState } from "react";

// Three-step explainer. Each step is an inline SVG "screen" animated with CSS
// keyframes (see the .hiw-* rules in globals.css) on a shared 6s loop, so a
// scene reads as a short looping clip. The illustrations are always drawn on
// a dark panel, device-mock style, whatever the page theme.

const STEPS = [
  {
    n: 1,
    title: "Capture anything",
    body: "Scrolling and something's blowing up? Hit Ctrl+Shift+X, drag a box around it, and it's captured. Claude works out what it is and opens a market for it.",
    tone: "cyan" as const,
  },
  {
    n: 2,
    title: "Long or Short",
    body: "Every market has a Virality Index. Think attention is about to climb? Go long. Think it's peaked? Go short. Pick a size and you're in.",
    tone: "magenta" as const,
  },
  {
    n: 3,
    title: "Profit for being right",
    body: "As the index moves, so does your position. Call it before the crowd and the difference is yours.",
    tone: "yellow" as const,
  },
];

const TONE = {
  cyan: "bg-atnx-cyan/10 text-atnx-cyan light:text-atnx-cyan-light border-atnx-cyan/25",
  magenta:
    "bg-atnx-magenta/10 text-atnx-magenta light:text-atnx-magenta-light border-atnx-magenta/25",
  yellow:
    "bg-atnx-yellow/10 text-atnx-yellow light:text-atnx-yellow-light border-atnx-yellow/25",
};

// Mounted only while open (the parent conditionally renders it), so every
// opening starts fresh at step 1.
export function HowItWorksModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight")
        setStep((s) => Math.min(STEPS.length - 1, s + 1));
      if (e.key === "ArrowLeft") setStep((s) => Math.max(0, s - 1));
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const s = STEPS[step];
  const last = step === STEPS.length - 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      style={{
        backgroundColor: "rgba(0,0,0,0.7)",
        backdropFilter: "blur(6px)",
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hiw-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-xl bg-surface border border-surface rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden animate-slide-up"
      >
        {/* header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <div className="text-[10px] uppercase tracking-[0.2em] text-tertiary">
            How ATNX works
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-8 w-8 -mr-2 rounded-full inline-flex items-center justify-center text-secondary hover:text-primary hover:bg-elevated cursor-pointer transition-colors"
          >
            {"✕"}
          </button>
        </div>

        {/* scene */}
        <div className="px-5">
          <div className="rounded-xl overflow-hidden border border-surface bg-[#0f0f0f]">
            {step === 0 && <SceneCapture />}
            {step === 1 && <SceneTrade />}
            {step === 2 && <SceneProfit />}
          </div>
        </div>

        {/* copy */}
        <div className="px-5 pt-4 pb-2 min-h-[118px]">
          <div className="flex items-center gap-2.5">
            <span
              className={`h-7 w-7 shrink-0 rounded-lg inline-flex items-center justify-center text-xs font-bold font-mono border ${TONE[s.tone]}`}
            >
              {s.n}
            </span>
            <h2 id="hiw-title" className="text-lg font-bold text-primary">
              {s.title}
            </h2>
          </div>
          <p className="mt-2 text-sm text-secondary leading-relaxed font-sans">
            {s.body}
          </p>
        </div>

        {/* footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-surface">
          <div
            role="tablist"
            aria-label="Steps"
            className="flex items-center gap-2"
          >
            {STEPS.map((st, i) => (
              <button
                key={st.n}
                role="tab"
                type="button"
                aria-selected={i === step}
                aria-label={`Step ${st.n}: ${st.title}`}
                onClick={() => setStep(i)}
                className={`h-1.5 rounded-full transition-all duration-300 cursor-pointer ${
                  i === step
                    ? "w-6 bg-atnx-cyan"
                    : "w-1.5 bg-elevated hover:bg-secondary/40"
                }`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep(step - 1)}
                className="px-3.5 py-2 rounded-full border border-surface text-xs font-bold text-secondary hover:text-primary hover:border-atnx-cyan/50 cursor-pointer transition-colors"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={() => (last ? onClose() : setStep(step + 1))}
              className="px-4 py-2 rounded-full bg-atnx-magenta text-white text-xs font-bold hover:bg-atnx-magenta-dim hover:shadow-[0_0_20px_rgba(255,0,229,0.3)] cursor-pointer transition-all"
            >
              {last ? "Got it" : "Next →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scenes. Shared palette: surface #161616, raised #1e1e1e, line #2a2a2a.
// Every animated element is wrapped so the CSS transform never fights an SVG
// transform attribute on the same node.

const CURSOR = "M0 0 L0 15 L4.2 11.4 L7.2 17.6 L9.8 16.5 L6.8 10.3 L11.6 9.8 Z";

function SceneCapture() {
  return (
    <svg
      viewBox="0 0 360 220"
      className="hiw-scene w-full h-auto block"
      aria-hidden="true"
    >
      <defs>
        <clipPath id="hiw-feed-clip">
          <rect x="0" y="22" width="240" height="154" />
        </clipPath>
        <linearGradient id="hiw-media" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FF00E5" />
          <stop offset="1" stopColor="#00D4FF" />
        </linearGradient>
      </defs>

      {/* shortcut hint, under the desktop window */}
      <g transform="translate(16,186)">
        <rect width="86" height="18" rx="4" fill="#1e1e1e" stroke="#2a2a2a" />
        <text x="43" y="12.5" textAnchor="middle" fontSize="8.5" fill="#999">
          Ctrl+Shift+X
        </text>
      </g>

      {/* phone: same feed, then the screenshot gesture (side button, flash,
          screen shrinks into a thumbnail) */}
      <g transform="translate(246,12)">
        <rect x="-3" y="50" width="3" height="14" rx="1.5" fill="#3a3a3a" />
        <rect x="-3" y="70" width="3" height="14" rx="1.5" fill="#3a3a3a" />
        <g className="hiw-pbtn">
          <rect x="92" y="58" width="3" height="26" rx="1.5" fill="#3a3a3a" />
        </g>
        <rect width="92" height="196" rx="16" fill="#1e1e1e" stroke="#2f2f2f" />
        <rect x="5" y="5" width="82" height="186" rx="12" fill="#0f0f0f" />
        <clipPath id="hiw-phone-clip">
          <rect x="5" y="5" width="82" height="186" rx="12" />
        </clipPath>
        <g clipPath="url(#hiw-phone-clip)">
          <g className="hiw-pshot">
            <rect x="5" y="5" width="82" height="186" fill="#0f0f0f" />
            {/* clipped again inside the scaled group so off-screen feed never
                shows in the shrunken thumbnail */}
            <g clipPath="url(#hiw-phone-clip)">
              <g className="hiw-pfeed">
                {[0, 1, 2, 3, 4].map((i) => (
                  <g key={i} transform={`translate(11, ${30 + i * 70})`}>
                    <rect
                      width="70"
                      height="60"
                      rx="6"
                      fill="#1c1c1c"
                      stroke="#2a2a2a"
                    />
                    <circle cx="9" cy="10" r="5" fill="#333" />
                    <rect
                      x="17"
                      y="7"
                      width="30"
                      height="4"
                      rx="2"
                      fill="#3a3a3a"
                    />
                    <rect
                      x="17"
                      y="13"
                      width="20"
                      height="3"
                      rx="1.5"
                      fill="#2c2c2c"
                    />
                    <rect
                      x="6"
                      y="22"
                      width="58"
                      height="30"
                      rx="4"
                      fill={i === 1 ? "url(#hiw-media)" : "#242424"}
                    />
                  </g>
                ))}
              </g>
            </g>
            <rect
              className="hiw-pshot-frame"
              x="5"
              y="5"
              width="82"
              height="186"
              rx="12"
              fill="none"
              stroke="#fff"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        </g>
        <rect x="32" y="10" width="28" height="7" rx="3.5" fill="#000" />
        <rect x="31" y="184" width="30" height="3" rx="1.5" fill="#444" />
        <rect
          className="hiw-pflash"
          opacity="0"
          x="5"
          y="5"
          width="82"
          height="186"
          rx="12"
          fill="#fff"
        />
      </g>

      {/* browser, scaled to leave room for the phone */}
      <g transform="translate(16,26) scale(0.86)">
        <rect
          width="240"
          height="176"
          rx="10"
          fill="#161616"
          stroke="#2a2a2a"
        />
        <path
          d="M0 10 a10 10 0 0 1 10 -10 h220 a10 10 0 0 1 10 10 v12 h-240 z"
          fill="#1e1e1e"
        />
        <circle cx="13" cy="11" r="3" fill="#ff5f57" />
        <circle cx="23" cy="11" r="3" fill="#febc2e" />
        <circle cx="33" cy="11" r="3" fill="#28c840" />
        <rect x="70" y="6" width="120" height="10" rx="5" fill="#262626" />

        <g clipPath="url(#hiw-feed-clip)">
          <g className="hiw-feed">
            {[0, 1, 2, 3].map((i) => (
              <g key={i} transform={`translate(20, ${34 + i * 72})`}>
                <rect
                  width="200"
                  height="62"
                  rx="8"
                  fill="#1c1c1c"
                  stroke="#2a2a2a"
                />
                <circle cx="16" cy="15" r="7" fill="#333" />
                <rect
                  x="28"
                  y="9"
                  width="54"
                  height="5"
                  rx="2.5"
                  fill="#3a3a3a"
                />
                <rect
                  x="28"
                  y="18"
                  width="34"
                  height="4"
                  rx="2"
                  fill="#2c2c2c"
                />
                <rect
                  x="10"
                  y="30"
                  width="180"
                  height="24"
                  rx="5"
                  fill={i === 1 ? "url(#hiw-media)" : "#242424"}
                />
              </g>
            ))}
          </g>
        </g>

        {/* selection box, flash, cursor */}
        <g transform="translate(14,28)">
          <rect
            className="hiw-sel"
            width="212"
            height="74"
            rx="6"
            fill="rgba(0,212,255,0.12)"
            stroke="#00D4FF"
            strokeWidth="1.5"
            strokeDasharray="6 4"
          />
        </g>
        <rect
          className="hiw-flash"
          opacity="0"
          y="22"
          width="240"
          height="154"
          fill="#fff"
        />
        <g className="hiw-cursor">
          <path
            d={CURSOR}
            fill="#fff"
            stroke="#000"
            strokeWidth="1"
            strokeLinejoin="round"
          />
        </g>
      </g>

      {/* captured badge */}
      <g transform="translate(180,186)">
        <g className="hiw-badge">
          <rect
            x="-46"
            y="-11"
            width="92"
            height="22"
            rx="11"
            fill="#0b2a31"
            stroke="#00D4FF"
          />
          <path
            d="M-32 0 l4 4 l8 -8"
            fill="none"
            stroke="#00D4FF"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <text
            x="6"
            y="3.5"
            textAnchor="middle"
            fontSize="10"
            fontWeight="700"
            fill="#00D4FF"
          >
            Captured
          </text>
        </g>
      </g>
    </svg>
  );
}

function SceneTrade() {
  return (
    <svg
      viewBox="0 0 360 220"
      className="hiw-scene w-full h-auto block"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="hiw-thumb" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FF00E5" />
          <stop offset="1" stopColor="#00D4FF" />
        </linearGradient>
      </defs>

      {/* ticket */}
      <g transform="translate(40,20)">
        <rect
          width="280"
          height="180"
          rx="12"
          fill="#161616"
          stroke="#2a2a2a"
        />

        {/* header */}
        <rect
          x="14"
          y="14"
          width="44"
          height="32"
          rx="6"
          fill="url(#hiw-thumb)"
        />
        <text x="66" y="27" fontSize="11" fontWeight="700" fill="#f0f0f0">
          Sad Cat Meme
        </text>
        <text x="66" y="40" fontSize="8.5" fill="#888">
          relationship humor
        </text>
        <text
          x="266"
          y="24"
          textAnchor="end"
          fontSize="7.5"
          fill="#777"
          letterSpacing="1"
        >
          VI
        </text>
        <text
          x="266"
          y="43"
          textAnchor="end"
          fontSize="18"
          fontWeight="700"
          fill="#FFE500"
        >
          312
        </text>

        {/* side buttons */}
        <g transform="translate(14,60)">
          <rect
            className="hiw-long"
            width="122"
            height="30"
            rx="8"
            fill="#1e1e1e"
            stroke="#2a2a2a"
          />
          <text
            className="hiw-long-text"
            x="61"
            y="19"
            textAnchor="middle"
            fontSize="10.5"
            fontWeight="700"
            fill="#999"
          >
            {"↗"} Long
          </text>
        </g>
        <g transform="translate(144,60)">
          <rect
            width="122"
            height="30"
            rx="8"
            fill="#1e1e1e"
            stroke="#2a2a2a"
          />
          <text
            x="61"
            y="19"
            textAnchor="middle"
            fontSize="10.5"
            fontWeight="700"
            fill="#999"
          >
            {"↘"} Short
          </text>
        </g>

        {/* amount */}
        <g transform="translate(14,100)">
          <rect
            width="252"
            height="34"
            rx="8"
            fill="#1e1e1e"
            stroke="#2a2a2a"
          />
          <text x="12" y="23" fontSize="16" fontWeight="700" fill="#666">
            $
          </text>
          <text x="26" y="23" fontSize="16" fontWeight="700" fill="#f0f0f0">
            <tspan className="hiw-amt hiw-amt-1">1</tspan>
            <tspan className="hiw-amt hiw-amt-2">0</tspan>
            <tspan className="hiw-amt hiw-amt-3">0</tspan>
          </text>
          <text x="240" y="22" textAnchor="end" fontSize="8" fill="#777">
            USDC
          </text>
        </g>

        {/* submit */}
        <g transform="translate(14,144)">
          <g className="hiw-submit">
            <rect width="252" height="26" rx="8" fill="#00D4FF" />
            <text
              x="126"
              y="17"
              textAnchor="middle"
              fontSize="10"
              fontWeight="700"
              fill="#000"
            >
              Open Long {"·"} $100
            </text>
          </g>
        </g>

        {/* cursor */}
        <g className="hiw-cursor2">
          <path
            d={CURSOR}
            fill="#fff"
            stroke="#000"
            strokeWidth="1"
            strokeLinejoin="round"
          />
        </g>
      </g>

      {/* toast */}
      <g transform="translate(180,0)">
        <g className="hiw-toast">
          <rect
            x="-58"
            y="6"
            width="116"
            height="24"
            rx="12"
            fill="#0b2a31"
            stroke="#00D4FF"
          />
          <path
            d="M-44 18 l4 4 l8 -8"
            fill="none"
            stroke="#00D4FF"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <text
            x="8"
            y="21.5"
            textAnchor="middle"
            fontSize="10"
            fontWeight="700"
            fill="#00D4FF"
          >
            Long opened
          </text>
        </g>
      </g>
    </svg>
  );
}

function SceneProfit() {
  // Chart geometry inside the card (card origin 40,20). Line starts low-left,
  // dips, then rips upward.
  const line =
    "M14 132 C 40 130, 56 128, 76 126 S 110 122, 128 116 S 160 104, 178 88 S 214 54, 236 48 S 258 44, 266 44";
  return (
    <svg
      viewBox="0 0 360 220"
      className="hiw-scene w-full h-auto block"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="hiw-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#00D4FF" stopOpacity="0.35" />
          <stop offset="1" stopColor="#00D4FF" stopOpacity="0" />
        </linearGradient>
        <clipPath id="hiw-reveal-clip">
          <rect className="hiw-reveal" x="0" y="0" width="280" height="180" />
        </clipPath>
      </defs>

      <g transform="translate(40,20)">
        <rect
          width="280"
          height="180"
          rx="12"
          fill="#161616"
          stroke="#2a2a2a"
        />

        {/* header */}
        <text x="14" y="24" fontSize="11" fontWeight="700" fill="#f0f0f0">
          Sad Cat Meme
        </text>
        <g transform="translate(112,12)">
          <g className="hiw-viral">
            <rect
              width="52"
              height="16"
              rx="8"
              fill="#2a0b26"
              stroke="#FF00E5"
            />
            <text
              x="26"
              y="11.5"
              textAnchor="middle"
              fontSize="8"
              fontWeight="700"
              fill="#FF00E5"
            >
              VIRAL
            </text>
          </g>
        </g>
        <text
          x="246"
          y="16"
          textAnchor="end"
          fontSize="7.5"
          fill="#777"
          letterSpacing="1"
        >
          VI
        </text>
        <g>
          <text
            className="hiw-vi-old"
            x="246"
            y="36"
            textAnchor="end"
            fontSize="18"
            fontWeight="700"
            fill="#FFE500"
          >
            312
          </text>
          <text
            className="hiw-vi-new"
            x="246"
            y="36"
            textAnchor="end"
            fontSize="18"
            fontWeight="700"
            fill="#FFE500"
          >
            998
          </text>
        </g>

        {/* grid */}
        {[60, 90, 120].map((y) => (
          <line key={y} x1="14" x2="266" y1={y} y2={y} stroke="#232323" />
        ))}

        {/* area + line, revealed left to right */}
        <g clipPath="url(#hiw-reveal-clip)">
          <path d={`${line} L 266 150 L 14 150 Z`} fill="url(#hiw-area)" />
          <path
            d={line}
            fill="none"
            stroke="#00D4FF"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>

        {/* entry marker */}
        <g transform="translate(76,126)">
          <g className="hiw-entry">
            <circle r="4" fill="#FFE500" stroke="#161616" strokeWidth="2" />
            <rect
              x="-30"
              y="10"
              width="60"
              height="14"
              rx="7"
              fill="#1e1e1e"
              stroke="#2a2a2a"
            />
            <text x="0" y="20" textAnchor="middle" fontSize="8" fill="#ccc">
              entry 312
            </text>
          </g>
        </g>

        {/* end marker */}
        <g transform="translate(266,44)">
          <circle
            className="hiw-ring"
            r="4"
            fill="none"
            stroke="#00D4FF"
            strokeWidth="1.5"
          />
          <circle
            className="hiw-end"
            r="4"
            fill="#00D4FF"
            stroke="#161616"
            strokeWidth="2"
          />
        </g>

        {/* pnl */}
        <g transform="translate(140,160)">
          <g className="hiw-pnl">
            <rect
              x="-48"
              y="-12"
              width="96"
              height="24"
              rx="12"
              fill="#0b2a31"
              stroke="#00D4FF"
            />
            <text
              x="0"
              y="4"
              textAnchor="middle"
              fontSize="11"
              fontWeight="700"
              fill="#00D4FF"
            >
              +$212.40
            </text>
          </g>
          <circle
            className="hiw-conf hiw-conf-1"
            cx="-40"
            cy="-16"
            r="3"
            fill="#00D4FF"
          />
          <circle
            className="hiw-conf hiw-conf-2"
            cx="0"
            cy="-20"
            r="3"
            fill="#FF00E5"
          />
          <circle
            className="hiw-conf hiw-conf-3"
            cx="40"
            cy="-16"
            r="3"
            fill="#FFE500"
          />
        </g>
      </g>
    </svg>
  );
}
