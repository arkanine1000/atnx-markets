"use client";

import { useId, useMemo } from "react";

// A generated avatar: the ATNX eye, with an iris in the house inks, the
// way MetaMask's jazzicon gives every account a face. Deterministic from a
// seed (the user id, so a handle change keeps the face): one ink fills the
// iris and two or three rotated blocks in the other inks lie over it in
// multiply blend, so the overlaps print the secondaries (cyan over magenta
// is blue, cyan over yellow green, magenta over yellow red) and a triple
// overlap goes black. The eye also looks a little to one side, per seed.
// Pure SVG, no image request, same picture on server and client.
//
// The eye itself is line work in the app's greys, like the nav icons: a
// lid outline over an elevated-grey almond with a fainter crease above it.
// Only the iris carries colour, so the inks read against the dark disc
// instead of fighting a white sclera.

const INKS = ["#00D4FF", "#FF00E5", "#FFE500"] as const;
const DISC = "#0A0A0A";
const SCLERA = "#1E1E1E"; // dark-elevated
const LID = "#999999"; // text-secondary
const CREASE = "#555555";
const GLINT = "#D6D6D6";
// Almond from x=8 to x=92, lids meeting at the corners.
const ALMOND = "M8 50 Q50 12 92 50 Q50 88 8 50 Z";
// The upper lid's crease, a shallower arc a little above it.
const CREASE_ARC = "M16 42 Q50 4 84 42";

// FNV-1a: a small, well-spread 32-bit hash for a string.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: a tiny seeded generator, enough for a handful of draws.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Block {
  fill: string;
  w: number;
  h: number;
  x: number;
  y: number;
  rotate: number;
  radius: number;
  circle: boolean;
}

export interface Face {
  base: string;
  blocks: Block[];
  // Iris radius and where it looks, in the 100-unit frame.
  irisR: number;
  gazeX: number;
  gazeY: number;
}

export function faceFor(seed: string): Face {
  const next = rng(hash(seed || "atnx"));
  const baseIdx = Math.floor(next() * 3);
  const others = INKS.filter((_, i) => i !== baseIdx);
  const count = 2 + (next() < 0.5 ? 1 : 0);
  const blocks: Block[] = [];
  for (let i = 0; i < count; i++) {
    // The first two blocks take the two other inks; a third, smaller one
    // repeats one of them. Sizes and offsets are kept modest so the two
    // inks overlap in a sliver (the black where all three meet stays an
    // accent) and the base ink keeps most of the disc.
    const fill = i < 2 ? others[i] : others[Math.floor(next() * 2)];
    const scale = i === 2 ? 0.55 : 1;
    const w = (34 + next() * 40) * scale;
    const h = (26 + next() * 34) * scale;
    // Blocks are pushed to opposite sides so they meet only at an edge.
    const side = i === 0 ? -1 : i === 1 ? 1 : next() < 0.5 ? -1 : 1;
    blocks.push({
      fill,
      w,
      h,
      x: 50 - w / 2 + side * (12 + next() * 22),
      y: 50 - h / 2 + (next() - 0.5) * 64,
      rotate: next() * 360,
      radius: 4 + next() * 14,
      circle: next() < 0.3,
    });
  }
  return {
    base: INKS[baseIdx],
    blocks,
    irisR: 20 + next() * 4,
    gazeX: (next() - 0.5) * 16,
    gazeY: (next() - 0.5) * 6,
  };
}

export function Identicon({
  seed,
  size = 32,
  label,
  className = "",
}: {
  seed: string;
  size?: number;
  // Accessible name; omit when the avatar sits next to the name it stands for.
  label?: string;
  className?: string;
}) {
  const face = useMemo(() => faceFor(seed), [seed]);
  const id = useId();
  const lidClip = `${id}-lid`;
  const irisClip = `${id}-iris`;
  const cx = 50 + face.gazeX;
  const cy = 50 + face.gazeY;
  const r = face.irisR;
  // The ink pattern is laid out in the 100-unit frame; scale it into the
  // iris so it fills the iris the way it would fill a whole disc.
  const intoIris = `translate(${cx.toFixed(1)} ${cy.toFixed(1)}) scale(${(r / 50).toFixed(3)}) translate(-50 -50)`;
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={`shrink-0 rounded-full ${className}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <clipPath id={lidClip}>
          <path d={ALMOND} />
        </clipPath>
        <clipPath id={irisClip}>
          <circle cx="50" cy="50" r="50" />
        </clipPath>
      </defs>
      <circle cx="50" cy="50" r="50" fill={DISC} />
      <path d={ALMOND} fill={SCLERA} />
      {/* Everything inside the lids: iris pattern, pupil, highlight. */}
      <g clipPath={`url(#${lidClip})`}>
        <g transform={intoIris}>
          <g clipPath={`url(#${irisClip})`}>
            <rect width="100" height="100" fill={face.base} />
            {face.blocks.map((b, i) =>
              b.circle ? (
                <circle
                  key={i}
                  cx={b.x + b.w / 2}
                  cy={b.y + b.h / 2}
                  r={Math.min(b.w, b.h) / 2}
                  fill={b.fill}
                  style={{ mixBlendMode: "multiply" }}
                />
              ) : (
                <rect
                  key={i}
                  x={b.x}
                  y={b.y}
                  width={b.w}
                  height={b.h}
                  rx={b.radius}
                  fill={b.fill}
                  transform={`rotate(${b.rotate.toFixed(1)} ${(b.x + b.w / 2).toFixed(1)} ${(b.y + b.h / 2).toFixed(1)})`}
                  style={{ mixBlendMode: "multiply" }}
                />
              ),
            )}
          </g>
        </g>
        <circle cx={cx} cy={cy} r={r * 0.42} fill={DISC} />
        <circle cx={cx - r * 0.3} cy={cy - r * 0.3} r={r * 0.13} fill={GLINT} opacity={0.9} />
      </g>
      {/* Lid line over the iris edge, then the crease above it. */}
      <path
        d={ALMOND}
        fill="none"
        stroke={LID}
        strokeWidth={5}
        strokeLinejoin="round"
      />
      <path
        d={CREASE_ARC}
        fill="none"
        stroke={CREASE}
        strokeWidth={3.5}
        strokeLinecap="round"
      />
    </svg>
  );
}
