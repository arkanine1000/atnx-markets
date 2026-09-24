// The account avatar, drawn the same way the web app draws it
// (atnx-web/components/Identicon.tsx): one ink fills the disc, two or
// three rotated blocks in the other inks lie over it in multiply blend so
// the overlaps print the secondaries, and a black pupil with a glint sits
// a little off centre. Seeded by the user id, so the face here is the one
// on the site. Keep the two files in step.

const IDENTICON_INKS = ['#00D4FF', '#FF00E5', '#FFE500'];
const IDENTICON_PUPIL = '#0A0A0A';
const IDENTICON_GLINT = '#D6D6D6';
const IDENTICON_PUPIL_R = 21;
const IDENTICON_GLINT_OFF = 7.5;
const IDENTICON_GLINT_R = 4;

// FNV-1a: a small, well-spread 32-bit hash for a string.
function identiconHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: a tiny seeded generator, enough for a handful of draws.
function identiconRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function identiconFace(seed) {
  const next = identiconRng(identiconHash(seed || 'atnx'));
  const baseIdx = Math.floor(next() * 3);
  const others = IDENTICON_INKS.filter((_, i) => i !== baseIdx);
  const count = 2 + (next() < 0.5 ? 1 : 0);
  const blocks = [];
  for (let i = 0; i < count; i++) {
    const fill = i < 2 ? others[i] : others[Math.floor(next() * 2)];
    const scale = i === 2 ? 0.55 : 1;
    const w = (34 + next() * 40) * scale;
    const h = (26 + next() * 34) * scale;
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
    base: IDENTICON_INKS[baseIdx],
    blocks,
    gazeX: (next() - 0.5) * 16,
    gazeY: (next() - 0.5) * 8,
  };
}

// An <svg> element for the seed, `size` pixels square. Nothing in it comes
// from the seed as text, only numbers and fixed colours.
function identiconSvg(seed, size) {
  const face = identiconFace(seed);
  const cx = 50 + face.gazeX;
  const cy = 50 + face.gazeY;
  const clipId = `identicon-clip-${identiconHash(seed || 'atnx').toString(16)}`;
  const n = (v) => v.toFixed(1);
  const blocks = face.blocks
    .map((b) =>
      b.circle
        ? `<circle cx="${n(b.x + b.w / 2)}" cy="${n(b.y + b.h / 2)}" r="${n(Math.min(b.w, b.h) / 2)}" fill="${b.fill}" style="mix-blend-mode:multiply"/>`
        : `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${n(b.radius)}" fill="${b.fill}" transform="rotate(${n(b.rotate)} ${n(b.x + b.w / 2)} ${n(b.y + b.h / 2)})" style="mix-blend-mode:multiply"/>`
    )
    .join('');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('identicon');
  svg.innerHTML =
    `<defs><clipPath id="${clipId}"><circle cx="50" cy="50" r="50"/></clipPath></defs>` +
    `<g clip-path="url(#${clipId})"><rect width="100" height="100" fill="${face.base}"/>${blocks}</g>` +
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${IDENTICON_PUPIL_R}" fill="${IDENTICON_PUPIL}"/>` +
    `<circle cx="${n(cx - IDENTICON_GLINT_OFF)}" cy="${n(cy - IDENTICON_GLINT_OFF)}" r="${IDENTICON_GLINT_R}" fill="${IDENTICON_GLINT}" opacity="0.9"/>`;
  return svg;
}
