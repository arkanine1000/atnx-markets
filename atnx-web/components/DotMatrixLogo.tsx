"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";

// Interactive dot-matrix wordmark.
//
// - Dots assemble from scattered positions on load, then rest.
// - The pointer pushes dots away; they spring back.
// - Rendering uses pre-rasterised sprites (one drawImage per dot) instead of
//   a path fill per dot, and the loop sleeps when everything is at rest,
//   off-screen, or the tab is hidden. Reduced-motion users get a static
//   render with no scatter.

const LETTER_COLORS = {
  dark: ["#00D4FF", "#FF00E5", "#FFE500", "#FFFFFF"],
  light: ["#00B8DB", "#D900C5", "#D4BE00", "#000000"],
};
const BG_COLORS = {
  dark: ["#00D4FF", "#FF00E5", "#FFE500"],
  light: ["#00B8DB", "#D900C5", "#D4BE00"],
};

const TEXT = "ATNX";
const MOUSE_RADIUS = 80;
const SCATTER_FORCE = 8;
const BURST_FORCE = 22; // click/tap explosion impulse (px/frame)
const RETURN_SPEED = 0.08;
const FRICTION = 0.85;
const REST_SPEED = 0.03; // px/frame below which a dot counts as settled
const REST_DIST = 0.15; // px from origin below which a dot snaps home
const IDLE_FPS = 20; // background drift cadence while nothing else moves
const SPRITE = 16; // sprite raster size (px); drawn scaled to each dot
const MAX_DPR = 2;

interface Dot {
  ox: number;
  oy: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  c: number; // colour index
  r: number;
  a: number; // base alpha
}

interface BgParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  c: number;
  r: number;
  a: number;
}

function dims(vw: number) {
  // Narrow viewports get more width and a taller aspect so the letters read
  // as a hero rather than a thin strip.
  const widthPct = vw < 640 ? 0.92 : 0.85;
  const aspect = vw < 480 ? 0.55 : vw < 768 ? 0.42 : 0.3;
  // Integers only: the sampling canvas indexes pixel rows by width, so a
  // fractional width shears every row and turns the letters into streaks.
  const w = Math.round(Math.min(vw * widthPct, 1200));
  const h = Math.round(w * aspect);
  return { w, h, gap: vw < 480 ? 4 : vw < 1024 ? 5 : 4 };
}

function makeSprite(color: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = SPRITE;
  const ctx = c.getContext("2d")!;
  const half = SPRITE / 2;
  // Solid disc with a one-pixel soft rim so scaled-down dots stay round.
  const g = ctx.createRadialGradient(half, half, half - 1.5, half, half, half);
  g.addColorStop(0, color);
  g.addColorStop(1, `${color}00`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(half, half, half, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

function sampleText(w: number, h: number, gap: number): Dot[] {
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const ctx = off.getContext("2d", { willReadFrequently: true })!;
  const fontSize = h * 0.7;
  ctx.fillStyle = "#fff";
  ctx.font = `bold ${fontSize}px "JetBrains Mono", "Fira Code", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(TEXT, w / 2, h / 2);

  // Letter boundaries → colour per dot.
  const total = ctx.measureText(TEXT).width;
  let cursor = (w - total) / 2;
  const bounds = [...TEXT].map((ch) => {
    const width = ctx.measureText(ch).width;
    const b = { start: cursor, end: cursor + width };
    cursor += width;
    return b;
  });

  const { data } = ctx.getImageData(0, 0, w, h);
  const dots: Dot[] = [];
  for (let y = 0; y < h; y += gap) {
    for (let x = 0; x < w; x += gap) {
      if (data[(y * w + x) * 4 + 3] <= 128) continue;
      let c = 0;
      for (let i = 0; i < bounds.length; i++) {
        if (x >= bounds[i].start && x < bounds[i].end) {
          c = i;
          break;
        }
      }
      // Entrance: start scattered around the canvas and let the spring
      // pull each dot home.
      const angle = Math.random() * Math.PI * 2;
      const dist = 60 + Math.random() * Math.max(w, h) * 0.5;
      dots.push({
        ox: x,
        oy: y,
        x: x + Math.cos(angle) * dist,
        y: y + Math.sin(angle) * dist,
        vx: 0,
        vy: 0,
        c,
        r: 1.5 + Math.random() * 1.5,
        a: 0.8 + Math.random() * 0.2,
      });
    }
  }
  return dots;
}

function makeBg(count: number, w: number, h: number): BgParticle[] {
  return Array.from({ length: count }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 0.3,
    vy: (Math.random() - 0.5) * 0.3,
    c: Math.floor(Math.random() * 3),
    r: 1 + Math.random() * 2,
    a: 0.1 + Math.random() * 0.2,
  }));
}

export function DotMatrixLogo() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { resolvedTheme } = useTheme();
  const mode: "dark" | "light" = resolvedTheme === "light" ? "light" : "dark";

  useEffect(() => {
    const canvas: HTMLCanvasElement | null = canvasRef.current;
    if (!canvas) return;
    const el: HTMLCanvasElement = canvas;

    let cancelled = false;
    let raf = 0;
    let resizeTimer = 0;
    let visible = true;
    let lastWidth = window.innerWidth;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let dots: Dot[] = [];
    let bg: BgParticle[] = [];
    let sprites: HTMLCanvasElement[] = [];
    let bgSprites: HTMLCanvasElement[] = [];
    let w = 0;
    let h = 0;
    let pointer = { x: -1e4, y: -1e4, inside: false };
    let settled = false;
    let lastIdleFrame = 0;

    const ctx = el.getContext("2d", { alpha: true, desynchronized: true })!;

    function render() {
      ctx.clearRect(0, 0, w, h);
      for (const p of bg) {
        ctx.globalAlpha = p.a;
        ctx.drawImage(bgSprites[p.c], p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
      }
      for (const d of dots) {
        ctx.globalAlpha = d.a;
        ctx.drawImage(sprites[d.c], d.x - d.r, d.y - d.r, d.r * 2, d.r * 2);
      }
      ctx.globalAlpha = 1;
    }

    // Physics step. Returns true if any text dot is still moving.
    function stepDots(): boolean {
      let moving = false;
      const px = pointer.x;
      const py = pointer.y;
      for (const d of dots) {
        if (pointer.inside && !reducedMotion) {
          const dx = d.x - px;
          const dy = d.y - py;
          const dist = Math.hypot(dx, dy);
          if (dist < MOUSE_RADIUS && dist > 0) {
            const force = ((MOUSE_RADIUS - dist) / MOUSE_RADIUS) * SCATTER_FORCE;
            d.vx += (dx / dist) * force;
            d.vy += (dy / dist) * force;
          }
        }
        d.x += d.vx;
        d.y += d.vy;
        d.vx *= FRICTION;
        d.vy *= FRICTION;
        d.x += (d.ox - d.x) * RETURN_SPEED;
        d.y += (d.oy - d.y) * RETURN_SPEED;

        if (
          Math.abs(d.vx) > REST_SPEED ||
          Math.abs(d.vy) > REST_SPEED ||
          Math.abs(d.x - d.ox) > REST_DIST ||
          Math.abs(d.y - d.oy) > REST_DIST
        ) {
          moving = true;
        } else {
          d.x = d.ox;
          d.y = d.oy;
          d.vx = 0;
          d.vy = 0;
        }
      }
      return moving;
    }

    function stepBg() {
      for (const p of bg) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = w;
        else if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h;
        else if (p.y > h) p.y = 0;
      }
    }

    function frame(now: number) {
      raf = 0;
      if (cancelled || !visible) return;

      const dotsMoving = stepDots();
      settled = !dotsMoving && !pointer.inside;

      if (settled && !reducedMotion) {
        // Nothing but the ambient drift: throttle to IDLE_FPS.
        if (now - lastIdleFrame < 1000 / IDLE_FPS) {
          raf = requestAnimationFrame(frame);
          return;
        }
        lastIdleFrame = now;
      }

      if (!reducedMotion) stepBg();
      render();

      // Reduced motion: draw once and stop. Otherwise keep the (throttled)
      // ambient loop going while we're on screen.
      if (!reducedMotion) raf = requestAnimationFrame(frame);
    }

    function wake() {
      if (!raf && !cancelled && visible) raf = requestAnimationFrame(frame);
    }

    async function build() {
      const { w: cw, h: ch, gap } = dims(window.innerWidth);
      w = cw;
      h = ch;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Sample the wordmark only once the brand font is actually available,
      // otherwise the dots trace the fallback font's glyphs.
      try {
        await document.fonts.load(`bold ${Math.round(h * 0.7)}px "JetBrains Mono"`);
      } catch {
        /* fall back to whatever monospace is installed */
      }
      if (cancelled) return;

      sprites = LETTER_COLORS[mode].map(makeSprite);
      bgSprites = BG_COLORS[mode].map(makeSprite);
      dots = sampleText(w, h, gap);
      bg = makeBg(50, w, h);
      if (reducedMotion) {
        for (const d of dots) {
          d.x = d.ox;
          d.y = d.oy;
        }
      }
      settled = false;
      wake();
    }

    // --- Events ---

    function toLocal(e: PointerEvent) {
      const rect = el.getBoundingClientRect();
      pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top, inside: true };
    }
    function onPointerMove(e: PointerEvent) {
      toLocal(e);
      wake();
    }
    // Click / tap: blow the wordmark apart from the touch point and let it
    // reassemble. Cheap, and the one thing people remember.
    function onPointerDown(e: PointerEvent) {
      toLocal(e);
      if (reducedMotion) return;
      for (const d of dots) {
        const dx = d.x - pointer.x;
        const dy = d.y - pointer.y;
        const dist = Math.hypot(dx, dy) || 1;
        const kick = BURST_FORCE * (0.6 + Math.random() * 0.8);
        d.vx += (dx / dist) * kick;
        d.vy += (dy / dist) * kick;
      }
      wake();
    }
    function onPointerLeave() {
      pointer = { x: -1e4, y: -1e4, inside: false };
      wake();
    }
    function onResize() {
      // Mobile browsers fire resize when the URL bar shows/hides; only the
      // width matters to the layout, so ignore height-only changes.
      if (window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(build, 150);
    }

    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointerleave", onPointerLeave);
    el.addEventListener("pointercancel", onPointerLeave);
    window.addEventListener("resize", onResize);

    // Sleep while scrolled out of view; wake and resume when back.
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) wake();
    });
    io.observe(el);

    build();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      io.disconnect();
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointerleave", onPointerLeave);
      el.removeEventListener("pointercancel", onPointerLeave);
      window.removeEventListener("resize", onResize);
    };
  }, [mode]);

  return (
    <canvas
      ref={canvasRef}
      aria-label="ATNX"
      role="img"
      className="block mx-auto [touch-action:pan-y]"
    />
  );
}
