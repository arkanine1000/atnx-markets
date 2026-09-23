"use client";

import { useCallback, useState, type CSSProperties } from "react";

// A brand logo on a tile whose shade suits it. Logos come as marks on a
// transparent ground and most are dark, but some brands publish a white
// one, which would vanish on a light tile the way a dark one vanishes on
// black. Once the image has loaded it is sampled on a small canvas: the
// mean lightness of its opaque pixels picks a light or a dark tile. Our
// storage serves images with open CORS, so the sample is allowed; if it
// is not (a manual image on another host), the light tile stays.

export const LOGO_TILE_LIGHT = "#F0F0F0";
export const LOGO_TILE_DARK = "#1E1E1E";

// Above this lightness (0..1) the mark is pale and wants the dark tile.
const PALE = 0.62;
// Pixels this transparent are the ground, not the mark.
const GROUND_ALPHA = 96;

export function LogoImage({
  src,
  className = "",
  imgClassName = "",
  style,
}: {
  src: string;
  // The tile: fills its positioned parent by default.
  className?: string;
  // The image inside the tile, for padding and fit.
  imgClassName?: string;
  style?: CSSProperties;
}) {
  const [tile, setTile] = useState(LOGO_TILE_LIGHT);

  const onLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    try {
      const canvas = document.createElement("canvas");
      const size = 32;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, size, size);
      const { data } = ctx.getImageData(0, 0, size, size);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < GROUND_ALPHA) continue;
        // Relative luminance, close enough on sRGB bytes for a threshold.
        sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
        n++;
      }
      if (n > 0 && sum / n > PALE) setTile(LOGO_TILE_DARK);
    } catch {
      // A tainted canvas (no CORS): keep the light tile.
    }
  }, []);

  return (
    <div
      className={`absolute inset-0 ${className}`}
      style={{ background: tile, ...style }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        loading="lazy"
        crossOrigin="anonymous"
        onLoad={onLoad}
        className={`absolute inset-0 w-full h-full object-contain ${imgClassName}`}
      />
    </div>
  );
}
