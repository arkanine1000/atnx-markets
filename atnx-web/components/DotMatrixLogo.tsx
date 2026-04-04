"use client";

import { useRef, useEffect, useCallback } from "react";
import { useTheme } from "next-themes";

const LETTER_COLORS = {
  dark: { A: "#00D4FF", T: "#FF00E5", N: "#FFE500", X: "#FFFFFF" },
  light: { A: "#00B8DB", T: "#D900C5", N: "#D4BE00", X: "#000000" },
};

interface Dot {
  originX: number;
  originY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  opacity: number;
  letterIdx: number;
}

interface BgParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  opacity: number;
}

const MOUSE_RADIUS = 80;
const SCATTER_FORCE = 8;
const RETURN_SPEED = 0.08;
const FRICTION = 0.85;

function getGap(): number {
  if (typeof window === "undefined") return 4;
  if (window.innerWidth < 768) return 6;
  if (window.innerWidth < 1024) return 5;
  return 4;
}

function getCanvasDims() {
  if (typeof window === "undefined") return { w: 800, h: 240 };
  const w = Math.min(window.innerWidth * 0.85, 1200);
  const h = w * 0.3;
  return { w, h };
}

function createDots(
  text: string,
  w: number,
  h: number,
  mode: "dark" | "light"
): { dots: Dot[]; letterBounds: { startX: number; endX: number }[] } {
  const offscreen = document.createElement("canvas");
  offscreen.width = w;
  offscreen.height = h;
  const ctx = offscreen.getContext("2d")!;

  const fontSize = h * 0.7;
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `bold ${fontSize}px "JetBrains Mono", "Fira Code", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2);

  // Calculate letter bounds
  const totalWidth = ctx.measureText(text).width;
  const textStartX = (w - totalWidth) / 2;
  const bounds: { startX: number; endX: number }[] = [];
  let curX = textStartX;
  for (const ch of text) {
    const mw = ctx.measureText(ch).width;
    bounds.push({ startX: curX, endX: curX + mw });
    curX += mw;
  }

  const colors = LETTER_COLORS[mode];
  const colorArr = [colors.A, colors.T, colors.N, colors.X];

  const imageData = ctx.getImageData(0, 0, w, h);
  const dots: Dot[] = [];
  const gap = getGap();

  for (let y = 0; y < h; y += gap) {
    for (let x = 0; x < w; x += gap) {
      const idx = (y * w + x) * 4;
      if (imageData.data[idx + 3] > 128) {
        let letterIdx = 0;
        for (let i = 0; i < bounds.length; i++) {
          if (x >= bounds[i].startX && x < bounds[i].endX) {
            letterIdx = i;
            break;
          }
        }
        dots.push({
          originX: x,
          originY: y,
          x,
          y,
          vx: 0,
          vy: 0,
          color: colorArr[letterIdx],
          size: 1.5 + Math.random() * 1.5,
          opacity: 0.8 + Math.random() * 0.2,
          letterIdx,
        });
      }
    }
  }

  return { dots, letterBounds: bounds };
}

function createBgParticles(
  count: number,
  w: number,
  h: number,
  mode: "dark" | "light"
): BgParticle[] {
  const colors = LETTER_COLORS[mode];
  const palette = [colors.A, colors.T, colors.N];
  return Array.from({ length: count }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 0.3,
    vy: (Math.random() - 0.5) * 0.3,
    color: palette[Math.floor(Math.random() * 3)],
    size: 1 + Math.random() * 2,
    opacity: 0.1 + Math.random() * 0.2,
  }));
}

export function DotMatrixLogo() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { resolvedTheme } = useTheme();
  const stateRef = useRef<{
    dots: Dot[];
    bgParticles: BgParticle[];
    letterBounds: { startX: number; endX: number }[];
    mouseX: number;
    mouseY: number;
    animId: number;
    w: number;
    h: number;
  } | null>(null);

  const init = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const mode = (resolvedTheme === "light" ? "light" : "dark") as
      | "dark"
      | "light";
    const { w, h } = getCanvasDims();
    const dpr = window.devicePixelRatio || 1;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { dots, letterBounds } = createDots("ATNX", w, h, mode);
    const bgParticles = createBgParticles(50, w, h, mode);

    if (stateRef.current?.animId) {
      cancelAnimationFrame(stateRef.current.animId);
    }

    const state = {
      dots,
      bgParticles,
      letterBounds,
      mouseX: -1000,
      mouseY: -1000,
      animId: 0,
      w,
      h,
    };
    stateRef.current = state;

    function animate() {
      // Update text dots
      for (const dot of state.dots) {
        const dx = dot.x - state.mouseX;
        const dy = dot.y - state.mouseY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < MOUSE_RADIUS && dist > 0) {
          const force = (MOUSE_RADIUS - dist) / MOUSE_RADIUS;
          const angle = Math.atan2(dy, dx);
          dot.vx += Math.cos(angle) * force * SCATTER_FORCE;
          dot.vy += Math.sin(angle) * force * SCATTER_FORCE;
        }

        dot.x += dot.vx;
        dot.y += dot.vy;
        dot.vx *= FRICTION;
        dot.vy *= FRICTION;
        dot.x += (dot.originX - dot.x) * RETURN_SPEED;
        dot.y += (dot.originY - dot.y) * RETURN_SPEED;
      }

      // Update bg particles (wrap around)
      for (const p of state.bgParticles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = state.w;
        if (p.x > state.w) p.x = 0;
        if (p.y < 0) p.y = state.h;
        if (p.y > state.h) p.y = 0;
      }

      // Render
      ctx.clearRect(0, 0, state.w, state.h);

      // Background particles first
      for (const p of state.bgParticles) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.opacity;
        ctx.fill();
      }

      // Text dots on top
      for (const dot of state.dots) {
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, dot.size, 0, Math.PI * 2);
        ctx.fillStyle = dot.color;
        ctx.globalAlpha = dot.opacity;
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      state.animId = requestAnimationFrame(animate);
    }

    state.animId = requestAnimationFrame(animate);

    // Mouse events
    function onMouseMove(e: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      state.mouseX = e.clientX - rect.left;
      state.mouseY = e.clientY - rect.top;
    }
    function onMouseLeave() {
      state.mouseX = -1000;
      state.mouseY = -1000;
    }
    function onTouchMove(e: TouchEvent) {
      e.preventDefault();
      const touch = e.touches[0];
      const rect = canvas!.getBoundingClientRect();
      state.mouseX = touch.clientX - rect.left;
      state.mouseY = touch.clientY - rect.top;
    }
    function onTouchEnd() {
      state.mouseX = -1000;
      state.mouseY = -1000;
    }

    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseleave", onMouseLeave);
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);

    return () => {
      cancelAnimationFrame(state.animId);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseleave", onMouseLeave);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
    };
  }, [resolvedTheme]);

  useEffect(() => {
    const cleanup = init();

    function onResize() {
      cleanup?.();
      init();
    }

    window.addEventListener("resize", onResize);
    return () => {
      cleanup?.();
      window.removeEventListener("resize", onResize);
    };
  }, [init]);

  return <canvas ref={canvasRef} className="block mx-auto touch-none" />;
}
