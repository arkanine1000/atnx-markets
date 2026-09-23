"use client";

import { useId, useMemo } from "react";

// A generated avatar: the ATNX eye from the logo, minus the light cone. The
// same lens (two circular arcs meeting at the corners) split down the middle
// into two flat inks with a black pupil, the way MetaMask's jazzicon gives
// every account a face. Deterministic from a seed (the user id, so a handle
// change keeps the face): the seed picks which two of the three inks make
// the halves and which way the eye looks, and the split follows the pupil.
// Pure SVG, no image request, same picture on server and client.

const INKS = ["#00D4FF", "#FF00E5", "#FFE500"] as const;
const DISC = "#0A0A0A";

// Lens geometry in the 100-unit frame, at the logo's proportions: 88 wide,
// 44 tall, arcs of radius 55 whose centres sit 33 off the midline.
const HW = 44;
const HH = 22;
const R = (HW * HW + HH * HH) / (2 * HH);
const LENS = `M${50 - HW} 50 A${R} ${R} 0 0 1 ${50 + HW} 50 A${R} ${R} 0 0 1 ${50 - HW} 50 Z`;

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

export interface Face {
  left: string;
  right: string;
  // Pupil radius and where it looks, in the 100-unit frame.
  pupilR: number;
  gazeX: number;
  gazeY: number;
}

export function faceFor(seed: string): Face {
  const next = rng(hash(seed || "atnx"));
  // An ordered pair of distinct inks: six faces by colour alone.
  const leftIdx = Math.floor(next() * 3);
  const rightIdx = (leftIdx + 1 + Math.floor(next() * 2)) % 3;
  return {
    left: INKS[leftIdx],
    right: INKS[rightIdx],
    pupilR: HH * (0.56 + next() * 0.1),
    gazeX: (next() - 0.5) * 18,
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
  const rightClip = `${useId()}-right`;
  const cx = 50 + face.gazeX;
  const cy = 50 + face.gazeY;
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
        <clipPath id={rightClip}>
          <rect x={cx} y="0" width={100 - cx} height="100" />
        </clipPath>
      </defs>
      <circle cx="50" cy="50" r="50" fill={DISC} />
      {/* Left ink fills the whole lens; the right ink covers it from the
          pupil's meridian over, so the split moves with the gaze. */}
      <path d={LENS} fill={face.left} />
      <path d={LENS} fill={face.right} clipPath={`url(#${rightClip})`} />
      <circle cx={cx} cy={cy} r={face.pupilR} fill={DISC} />
    </svg>
  );
}
