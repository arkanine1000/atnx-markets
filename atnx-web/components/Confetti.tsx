"use client";

import { useEffect, useRef } from "react";

// A one-shot confetti burst in the brand colours, drawn on a full-screen
// canvas that ignores the pointer. Two cannons fire up and inwards from the
// bottom corners; pieces flutter down and the canvas clears itself. Skipped
// entirely for people who ask for reduced motion.

const COLORS = ["#00D4FF", "#FF00E5", "#FFE500", "#FFFFFF"];
const PIECES = 160;
const GRAVITY = 0.32;
const DRAG = 0.985;
const MAX_MS = 4500;

type Piece = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  spin: number;
  wobble: number;
  wobbleSpeed: number;
  color: string;
};

export function Confetti() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const W = window.innerWidth;
    const H = window.innerHeight;
    const speed = Math.max(16, Math.min(26, H / 32));
    const pieces: Piece[] = Array.from({ length: PIECES }, (_, i) => {
      const left = i % 2 === 0;
      // Up and inwards, spread over ~35°.
      const angle = (-60 - Math.random() * 35) * (Math.PI / 180);
      const v = speed * (0.6 + Math.random() * 0.55);
      return {
        x: left ? -10 : W + 10,
        y: H + 10,
        vx: Math.cos(angle) * v * (left ? 1 : -1),
        vy: Math.sin(angle) * v,
        w: 6 + Math.random() * 6,
        h: 8 + Math.random() * 8,
        rot: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.3,
        wobble: Math.random() * Math.PI * 2,
        wobbleSpeed: 0.05 + Math.random() * 0.08,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      };
    });

    let raf = 0;
    const started = performance.now();
    const frame = (now: number) => {
      const elapsed = now - started;
      ctx.clearRect(0, 0, W, H);
      let alive = 0;
      for (const p of pieces) {
        p.vx *= DRAG;
        p.vy = p.vy * DRAG + GRAVITY;
        p.wobble += p.wobbleSpeed;
        p.x += p.vx + Math.sin(p.wobble) * 0.8;
        p.y += p.vy;
        p.rot += p.spin;
        if (p.y > H + 20) continue;
        alive++;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        // Squash on one axis to fake a paper flip.
        ctx.scale(1, Math.cos(p.wobble));
        ctx.globalAlpha = elapsed > MAX_MS - 800 ? Math.max(0, (MAX_MS - elapsed) / 800) : 1;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (alive > 0 && elapsed < MAX_MS) raf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="fixed inset-0 z-[60] pointer-events-none"
      style={{ width: "100vw", height: "100vh" }}
    />
  );
}
