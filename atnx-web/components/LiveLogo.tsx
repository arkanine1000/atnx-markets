"use client";

import { useEffect, useId, useRef } from "react";

// The brand mark drawn in code: the lens from the logo (two circular arcs
// meeting at the corners), cyan on the left, magenta on the right, with a
// black pupil, minus the light cone. Being live, the pupil follows the
// pointer around the page, glances about on its own when nobody is
// pointing, and the lids blink every few seconds. With reduced motion
// on, it is the still mark.
//
// The flat marks (public/logo_dark.png, public/logo_light.png) are kept
// for a revert: swap this for the <img> in Nav.tsx.

const INK_LEFT = "#00D4FF";
const INK_RIGHT = "#FF00E5";
const PUPIL = "#0A0A0A";

// Lens geometry in the 100-unit frame, at the logo's proportions: 88 wide,
// 44 tall, arcs of radius 55 whose centres sit 33 off the midline.
const HW = 44;
const HH = 22;
const R = (HW * HW + HH * HH) / (2 * HH);
const LENS = `M${50 - HW} 50 A${R} ${R} 0 0 1 ${50 + HW} 50 A${R} ${R} 0 0 1 ${50 - HW} 50 Z`;
const PUPIL_R = HH * 0.62;

// How far the pupil may travel: sideways to where the lens is still tall
// enough to hold it, and vertically whatever room is left at that x.
const MAX_DX = 15;
const MAX_DY = 6;
function lensHalfHeight(dx: number): number {
  return Math.sqrt(R * R - dx * dx) - (R - HH);
}
function clampToLens(x: number, y: number): { x: number; y: number } {
  const cx = Math.max(-MAX_DX, Math.min(MAX_DX, x));
  const room = Math.max(0, lensHalfHeight(cx) - PUPIL_R);
  return { x: cx, y: Math.max(-room, Math.min(room, y)) };
}

// How the pointer's pull grows with distance: half strength this many
// pixels out, most of the way by a few hundred, so a pointer right beside
// the mark still gets a clear glance and one across the page a full one.
const REACH_PX = 80;
// Blinks come 3–7 s apart; one in six is a double.
const BLINK_MIN_MS = 3000;
const BLINK_SPREAD_MS = 4000;
// No pointer movement for this long and the eye starts glancing about.
const IDLE_MS = 3500;

export function LiveLogo({
  size = 32,
  className = "",
  label = "ATNX",
}: {
  size?: number;
  className?: string;
  label?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const lidsRef = useRef<SVGGElement>(null);
  const pupilRef = useRef<SVGGElement>(null);
  const lensClip = `${useId()}-lens`;

  useEffect(() => {
    const svg = svgRef.current;
    const lids = lidsRef.current;
    const pupil = pupilRef.current;
    if (!svg || !lids || !pupil) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let cancelled = false;
    let raf = 0;
    let target = { x: 0, y: 0 };
    const cur = { x: 0, y: 0 };
    let lastMove = 0;
    const timers = new Set<number>();
    const later = (fn: () => void, ms: number) => {
      const t = window.setTimeout(() => {
        timers.delete(t);
        if (!cancelled) fn();
      }, ms);
      timers.add(t);
    };

    // The pupil eases toward its target and the loop stops once it is
    // there, so an idle page costs no frames.
    function frame() {
      raf = 0;
      cur.x += (target.x - cur.x) * 0.18;
      cur.y += (target.y - cur.y) * 0.18;
      pupil!.setAttribute("transform", `translate(${cur.x.toFixed(2)} ${cur.y.toFixed(2)})`);
      if (Math.abs(target.x - cur.x) > 0.03 || Math.abs(target.y - cur.y) > 0.03) {
        raf = requestAnimationFrame(frame);
      }
    }
    function look(x: number, y: number) {
      target = clampToLens(x, y);
      if (!raf && !cancelled) raf = requestAnimationFrame(frame);
    }

    function onMove(e: PointerEvent) {
      const r = svg!.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const dist = Math.hypot(dx, dy) || 1;
      const k = dist / (dist + REACH_PX);
      lastMove = performance.now();
      look((dx / dist) * MAX_DX * k, (dy / dist) * MAX_DY * k);
    }
    function onLeave() {
      look(0, 0);
    }

    // With no pointer about (a phone, or a hand off the mouse), glance
    // somewhere for a moment now and then, then settle back.
    function idleGlance() {
      if (performance.now() - lastMove > IDLE_MS && document.visibilityState === "visible") {
        look((Math.random() - 0.5) * 2 * MAX_DX, (Math.random() - 0.5) * 2 * MAX_DY);
        later(() => {
          if (performance.now() - lastMove > IDLE_MS) look(0, 0);
        }, 500 + Math.random() * 900);
      }
      later(idleGlance, 2500 + Math.random() * 3500);
    }

    // A blink: the lids close in 70 ms and open in 110 ms, the lens
    // squashed to a line about its centre. Inline so the page's global
    // transition rule does not decide the timing.
    function blink(times: number) {
      lids!.style.transition = "transform 70ms ease-in";
      lids!.style.transform = "scaleY(0.06)";
      later(() => {
        lids!.style.transition = "transform 110ms ease-out";
        lids!.style.transform = "scaleY(1)";
        if (times > 1) later(() => blink(times - 1), 150);
      }, 80);
    }
    function scheduleBlink() {
      later(() => {
        if (document.visibilityState === "visible") blink(Math.random() < 1 / 6 ? 2 : 1);
        scheduleBlink();
      }, BLINK_MIN_MS + Math.random() * BLINK_SPREAD_MS);
    }

    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("mouseleave", onLeave);
    scheduleBlink();
    later(idleGlance, IDLE_MS);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      for (const t of timers) window.clearTimeout(t);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={`shrink-0 ${className}`}
      role="img"
      aria-label={label}
    >
      <defs>
        <clipPath id={lensClip}>
          <path d={LENS} />
        </clipPath>
      </defs>
      <circle cx="50" cy="50" r="50" className="fill-[#161616] light:fill-[#ECECEC]" />
      <g
        ref={lidsRef}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
      >
        <g clipPath={`url(#${lensClip})`}>
          <rect x="0" y="0" width="50" height="100" fill={INK_LEFT} />
          <rect x="50" y="0" width="50" height="100" fill={INK_RIGHT} />
          <g ref={pupilRef}>
            <circle cx="50" cy="50" r={PUPIL_R} fill={PUPIL} />
          </g>
        </g>
      </g>
    </svg>
  );
}
