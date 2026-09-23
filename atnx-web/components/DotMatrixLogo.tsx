"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";

// Interactive dot-matrix wordmark.
//
// - Dots assemble from scattered positions on load, then rest.
// - The pointer pushes dots away; they spring back.
// - A click bursts the dots and they re-form as the other shape: the ATNX
//   wordmark ⇄ a large eye (the brand mark's lens, cyan | magenta, pupil as
//   negative space) sized to the wordmark's footprint. One dot pool, two
//   target sets, proportional index mapping so left-of-wordmark becomes
//   left-of-eye and the morph reads as one motion.
// - The swap also happens on its own every SWAP_MS, bursting from a point
//   near the shape's centre; a click resets that timer.
// - At rest the dots are alive: each wanders on a layered, per-dot noise
//   path, twinkles and pulses in size, a soft shimmer wave sweeps across
//   the shape, and the odd dot sparkles.
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

// The wordmark face, resolved from the next/font variable so the canvas draws
// the same self-hosted Archivo the page uses. Heavy weight.
function brandFamily(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--font-archivo").trim();
  return v || "Archivo";
}
function brandFont(px: number): string {
  return `800 ${px}px ${brandFamily()}, system-ui, sans-serif`;
}
const EYE_PUPIL = 0.52; // pupil radius as a fraction of the eye's half-height
const EYE_HEIGHT = 1.15; // eye height relative to the wordmark's cap height
const MOUSE_RADIUS = 80;
const SCATTER_FORCE = 8;
const RETURN_SPEED = 0.08;
const FRICTION = 0.85;
// Click/tap burst: a hard outward kick with a little swirl, then the spring
// is weakened and drag reduced for BURST_MS so the dots hang in the air and
// drift home instead of snapping back. Eases back to normal physics.
const BURST_FORCE = 15;
const BURST_SWIRL = 5;
const BURST_MS = 2600;
const BURST_RETURN = 0.006;
const BURST_FRICTION = 0.945;
// Extra canvas height around the letters so a burst has somewhere to go
// instead of being clipped at the edge.
const BURST_ROOM = 0.45;
// Automatic wordmark ⇄ eye swap.
const SWAP_MS = 10_000;
const AUTO_BURST_FORCE = 11; // gentler than a click so it reads as a breath
// Ambient life while resting. All of this is visual only: physics never sees
// it, so settle detection and the idle throttle are unaffected.
const TWINKLE = 0.28; // alpha swing (fraction of base alpha)
const DRIFT = 1.1; // px of layered per-dot wander
const SWAY = 1.6; // px of slow whole-shape sway
const PULSE = 0.16; // radius swing (fraction of base radius)
const SHIMMER = 0.35; // extra alpha at the crest of the sweeping wave
const SHIMMER_SPEED = 0.55; // waves per second
const SHIMMER_LEN = 260; // px between wave crests
const SPARKLE_RATE = 0.0006; // chance per dot per frame to sparkle
const SPARKLE_FRAMES = 14;
const REST_SPEED = 0.03; // px/frame below which a dot counts as settled
const REST_DIST = 0.15; // px from origin below which a dot snaps home
const IDLE_FPS = 30; // ambient cadence while nothing else moves
const SPRITE = 16; // sprite raster size (px); drawn scaled to each dot
const MAX_DPR = 2;

interface Target {
  x: number;
  y: number;
  c: number;
}

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
  ph: number; // twinkle / drift phase
  ph2: number; // second, unrelated phase so the wander isn't a circle
  s: number; // frames left in a sparkle
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
  const h = Math.round(w * aspect * (1 + BURST_ROOM));
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

function sampleText(w: number, h: number, gap: number): Target[] {
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const ctx = off.getContext("2d", { willReadFrequently: true })!;
  // The letters are sized to the canvas minus the burst room, so adding
  // room doesn't shrink the wordmark.
  const fontSize = (h / (1 + BURST_ROOM)) * 0.7;
  ctx.fillStyle = "#fff";
  ctx.font = brandFont(fontSize);
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
  const targets: Target[] = [];
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
      targets.push({ x, y, c });
    }
  }
  return targets;
}

// The eye: a lens (two circular arcs meeting at the corners) with a round
// pupil cut out, left half cyan, right half magenta. Sized from the
// wordmark's bounds so the two shapes share a footprint.
function sampleEye(
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  gap: number
): Target[] {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const hw = (bounds.maxX - bounds.minX) / 2;
  const hh = ((bounds.maxY - bounds.minY) / 2) * EYE_HEIGHT;
  // Arc radius so the lens is hh tall at the centre and 0 at ±hw.
  const R = (hw * hw + hh * hh) / (2 * hh);
  const d = R - hh;
  const pupil = hh * EYE_PUPIL;

  const targets: Target[] = [];
  const y0 = Math.floor((cy - hh) / gap) * gap;
  const y1 = Math.ceil((cy + hh) / gap) * gap;
  const x0 = Math.floor((cx - hw) / gap) * gap;
  const x1 = Math.ceil((cx + hw) / gap) * gap;
  for (let y = y0; y <= y1; y += gap) {
    for (let x = x0; x <= x1; x += gap) {
      const dx = x - cx;
      const dy = y - cy;
      if (Math.abs(dx) > hw) continue;
      const lensHalf = Math.sqrt(Math.max(0, R * R - dx * dx)) - d;
      if (Math.abs(dy) > lensHalf) continue;
      if (dx * dx + dy * dy < pupil * pupil) continue;
      targets.push({ x, y, c: dx < 0 ? 0 : 1 });
    }
  }
  return targets;
}

function boundsOf(targets: Target[]) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const t of targets) {
    if (t.x < minX) minX = t.x;
    if (t.x > maxX) maxX = t.x;
    if (t.y < minY) minY = t.y;
    if (t.y > maxY) maxY = t.y;
  }
  return { minX, maxX, minY, maxY };
}

// One pool of dots big enough for either shape. Each starts scattered so the
// first assignment doubles as the entrance animation.
function makeDots(n: number, w: number, h: number): Dot[] {
  return Array.from({ length: n }, () => {
    const angle = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * Math.max(w, h) * 0.5;
    return {
      ox: w / 2,
      oy: h / 2,
      x: w / 2 + Math.cos(angle) * dist,
      y: h / 2 + Math.sin(angle) * dist,
      vx: 0,
      vy: 0,
      c: 0,
      r: 1.5 + Math.random() * 1.5,
      a: 0.8 + Math.random() * 0.2,
      ph: Math.random() * Math.PI * 2,
      ph2: Math.random() * Math.PI * 2,
      s: 0,
    };
  });
}

// Map dot i → target floor(i·m/n). Both lists are in scanline order, so the
// correspondence is spatially coherent; when dots outnumber targets the
// extras stack with a little jitter instead of piling on one pixel.
function applyShape(dots: Dot[], targets: Target[], gap: number) {
  const n = dots.length;
  const m = targets.length;
  if (!m) return;
  for (let i = 0; i < n; i++) {
    const t = targets[Math.floor((i * m) / n)];
    const jitter = n > m ? gap * 0.5 : 0;
    dots[i].ox = t.x + (Math.random() - 0.5) * jitter;
    dots[i].oy = t.y + (Math.random() - 0.5) * jitter;
    dots[i].c = t.c;
  }
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
    let burstStart = -Infinity;
    let nextSwap = performance.now() + SWAP_MS;
    let swapTimer = 0; // reduced-motion fallback: no frame loop to poll from
    let sparkleBudget = 0;
    let shape: "text" | "eye" = "text";
    let textTargets: Target[] = [];
    let eyeTargets: Target[] = [];
    let gapPx = 4;

    const ctx = el.getContext("2d", { alpha: true, desynchronized: true })!;

    function render(now: number) {
      ctx.clearRect(0, 0, w, h);
      for (const p of bg) {
        ctx.globalAlpha = p.a;
        ctx.drawImage(bgSprites[p.c], p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
      }
      const t = now * 0.001;
      // Whole-shape sway: a slow figure-of-eight so the mark never sits
      // perfectly still, like it's floating.
      const swayX = reducedMotion ? 0 : SWAY * Math.sin(t * 0.31);
      const swayY = reducedMotion ? 0 : SWAY * 0.6 * Math.sin(t * 0.47 + 1.3);
      const shimmerPhase = t * SHIMMER_SPEED * Math.PI * 2;
      const shimmerK = (Math.PI * 2) / SHIMMER_LEN;
      if (!reducedMotion) {
        // Pick this frame's sparkles up front (expected count carried as a
        // fractional budget) instead of rolling a random per dot per frame.
        sparkleBudget += SPARKLE_RATE * dots.length;
        while (sparkleBudget >= 1) {
          sparkleBudget -= 1;
          const d = dots[(Math.random() * dots.length) | 0];
          if (d && d.s === 0) d.s = SPARKLE_FRAMES;
        }
      }
      for (const d of dots) {
        let x = d.x + swayX;
        let y = d.y + swayY;
        let a = d.a;
        let r = d.r;
        if (!reducedMotion) {
          // Layered wander: two incommensurate sines per axis, each with its
          // own phase, so the path is a slow, non-repeating loop rather
          // than a circle.
          x +=
            DRIFT *
            (0.65 * Math.sin(t * 0.9 + d.ph) + 0.35 * Math.sin(t * 2.3 + d.ph2));
          y +=
            DRIFT *
            (0.65 * Math.cos(t * 0.7 + d.ph2) + 0.35 * Math.sin(t * 1.9 + d.ph));
          // Twinkle: slow per-dot breathing with a faster flicker on top.
          const tw = 0.7 * Math.sin(t * 1.3 + d.ph) + 0.3 * Math.sin(t * 4.1 + d.ph2);
          a *= 1 - TWINKLE * 0.5 + TWINKLE * 0.5 * tw;
          // Size pulse, out of phase with the twinkle.
          r *= 1 + PULSE * 0.5 * Math.sin(t * 1.1 + d.ph2);
          // Shimmer: a soft diagonal wave of brightness sweeping across the
          // shape. Squared so the crest is narrow and the rest is dark.
          const wave = 0.5 + 0.5 * Math.sin(shimmerPhase - (d.ox + d.oy * 0.6) * shimmerK);
          a += SHIMMER * wave * wave * wave;
          // Sparkle: a rare, brief flare on a single dot.
          if (d.s > 0) {
            const k = d.s / SPARKLE_FRAMES;
            a += 0.6 * k;
            r *= 1 + 0.9 * Math.sin(k * Math.PI);
            d.s--;
          }
        }
        ctx.globalAlpha = Math.min(1, a);
        ctx.drawImage(sprites[d.c], x - r, y - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
    }

    // Swap wordmark ⇄ eye and blow the dots apart from (x, y) so they
    // reassemble as the other shape. Shared by click and the auto timer.
    function toggleShape() {
      if (!eyeTargets.length) return;
      shape = shape === "text" ? "eye" : "text";
      applyShape(dots, shape === "eye" ? eyeTargets : textTargets, gapPx);
      el.setAttribute("aria-label", shape === "eye" ? "ATNX eye" : "ATNX");
    }
    function burst(x: number, y: number, force: number) {
      const now = performance.now();
      nextSwap = now + SWAP_MS;
      toggleShape();
      if (reducedMotion) {
        for (const d of dots) {
          d.x = d.ox;
          d.y = d.oy;
        }
        wake();
        return;
      }
      burstStart = now;
      const spin = Math.random() < 0.5 ? -1 : 1;
      for (const d of dots) {
        const dx = d.x - x;
        const dy = d.y - y;
        const dist = Math.hypot(dx, dy) || 1;
        // Nearer dots fly harder; a tangential component makes it swirl.
        const falloff = 0.5 + 0.5 * Math.min(1, 220 / dist);
        const kick = force * falloff * (0.6 + Math.random() * 0.8);
        const swirl = BURST_SWIRL * falloff * spin * (0.5 + Math.random());
        d.vx += (dx / dist) * kick + (-dy / dist) * swirl;
        d.vy += (dy / dist) * kick + (dx / dist) * swirl;
      }
      wake();
    }
    // The timed swap bursts from somewhere near the middle of the current
    // shape, a little off-centre each time so it doesn't look mechanical.
    function autoSwap() {
      const b = boundsOf(shape === "eye" ? eyeTargets : textTargets);
      const x = (b.minX + b.maxX) / 2 + (Math.random() - 0.5) * (b.maxX - b.minX) * 0.5;
      const y = (b.minY + b.maxY) / 2 + (Math.random() - 0.5) * (b.maxY - b.minY) * 0.5;
      burst(x, y, AUTO_BURST_FORCE);
    }

    // Physics step. Returns true if any text dot is still moving.
    function stepDots(now: number): boolean {
      let moving = false;
      const px = pointer.x;
      const py = pointer.y;

      // 0 → 1 over the burst window, eased so the spring comes back gently.
      const t = Math.min(1, Math.max(0, (now - burstStart) / BURST_MS));
      const ease = t * t * (3 - 2 * t);
      const returnSpeed = BURST_RETURN + (RETURN_SPEED - BURST_RETURN) * ease;
      const friction = BURST_FRICTION + (FRICTION - BURST_FRICTION) * ease;

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
        d.vx *= friction;
        d.vy *= friction;
        d.x += (d.ox - d.x) * returnSpeed;
        d.y += (d.oy - d.y) * returnSpeed;

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
      // `raf` keeps the (already fired) handle until the end of the frame,
      // so a wake() from inside the frame (the auto swap goes through
      // burst → wake) is a no-op. Zeroing it here let each swap start an
      // extra parallel loop, which is why the page slowed down over time.
      if (cancelled || !visible) {
        raf = 0;
        return;
      }

      const dotsMoving = stepDots(now);
      settled = !dotsMoving && !pointer.inside;

      if (settled && !reducedMotion) {
        // Nothing but the ambient drift: throttle to IDLE_FPS.
        if (now - lastIdleFrame < 1000 / IDLE_FPS) {
          raf = requestAnimationFrame(frame);
          return;
        }
        lastIdleFrame = now;
      }

      if (!reducedMotion) {
        stepBg();
        // Timed swap. Wait for the previous burst to settle so two never
        // overlap; a hover scatter is fine to swap over.
        if (now >= nextSwap && !dotsMoving) {
          autoSwap();
          settled = false;
        }
      }
      render(now);

      // Reduced motion: draw once and stop. Otherwise keep the (throttled)
      // ambient loop going while we're on screen.
      raf = reducedMotion ? 0 : requestAnimationFrame(frame);
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
        await document.fonts.load(brandFont(Math.round(h * 0.7)));
      } catch {
        /* fall back to whatever sans is installed */
      }
      if (cancelled) return;

      gapPx = gap;
      sprites = LETTER_COLORS[mode].map(makeSprite);
      bgSprites = BG_COLORS[mode].map(makeSprite);
      textTargets = sampleText(w, h, gap);
      eyeTargets = textTargets.length ? sampleEye(boundsOf(textTargets), gap) : [];
      if (!eyeTargets.length) shape = "text";
      dots = makeDots(Math.max(textTargets.length, eyeTargets.length), w, h);
      applyShape(dots, shape === "eye" ? eyeTargets : textTargets, gap);
      el.setAttribute("aria-label", shape === "eye" ? "ATNX eye" : "ATNX");
      bg = makeBg(50, w, h);
      if (reducedMotion) {
        for (const d of dots) {
          d.x = d.ox;
          d.y = d.oy;
        }
      }
      settled = false;
      nextSwap = performance.now() + SWAP_MS;
      // Reduced motion draws once and stops, so the frame loop can't drive
      // the swap; a plain interval does it instead (skipped while off-screen).
      window.clearInterval(swapTimer);
      if (reducedMotion) {
        swapTimer = window.setInterval(() => {
          if (visible && !cancelled) autoSwap();
        }, SWAP_MS);
      }
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
    // reassemble. Cheap, and the one thing people remember. Also restarts
    // the auto-swap countdown.
    function onPointerDown(e: PointerEvent) {
      toLocal(e);
      burst(pointer.x, pointer.y, BURST_FORCE);
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
      if (visible) {
        // Don't swap the instant the mark scrolls back in; give it a beat.
        nextSwap = Math.max(nextSwap, performance.now() + SWAP_MS / 2);
        wake();
      }
    });
    io.observe(el);

    build();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      window.clearInterval(swapTimer);
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
      className="block mx-auto cursor-pointer [touch-action:pan-y]"
    />
  );
}
