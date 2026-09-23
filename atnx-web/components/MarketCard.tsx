"use client";

import Link from "next/link";
import { ViSparkline, deltaColor } from "@/components/charts/ViArea";
import { Chip, DeltaChip, ScoreBadge } from "@/components/ui";
import { viChange24h } from "@/lib/capture-view";
import type { Capture } from "@/lib/store";

interface Props {
  capture: Capture;
  captureCount: number;
  rank: number;
  /** Denser tile for the grid under the featured row. */
  compact?: boolean;
}

// The picture on a tile: the curated market image when the slow refresh
// has found one (lib/thumbnails.ts), else the capture itself. A logo is a
// dark mark on a transparent ground, often a wide wordmark, so it is drawn
// whole with padding on a light tile rather than cropped to fill.
export function tileImage(capture: Capture): { src: string; logo: boolean } {
  const src = capture.marketImage || capture.screenshot;
  const logo = Boolean(capture.marketImage) && capture.marketImageSource === "wikidata:logo";
  return { src, logo };
}

const LOGO_TILE = "#F0F0F0";

// Grid tile: the market image is the hero and the VI history is drawn
// straight over its lower half, the way pump.fun overlays a chart on the coin
// art. Name, category, score and 24h delta sit underneath.
export function MarketCard({ capture, captureCount, rank, compact }: Props) {
  const { analysis, trends, viralityScore, marketId } = capture;
  const points = trends?.dataPoints ?? [];
  const change24h = viChange24h(points, viralityScore);
  const stroke = deltaColor(change24h);
  const pending = !marketId;
  const image = tileImage(capture);

  const body = (
    <>
      <div
        className={`relative overflow-hidden rounded-t-2xl bg-black ${
          compact ? "aspect-[16/11]" : "aspect-[4/3]"
        }`}
        style={image.logo ? { background: LOGO_TILE } : undefined}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.src}
          alt=""
          loading="lazy"
          className={`absolute inset-0 w-full h-full ${
            image.logo ? "object-contain p-[12%] pb-[30%]" : "object-cover"
          }`}
        />
        <div
          className="absolute inset-x-0 bottom-0 h-[62%]"
          style={{
            background:
              "linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.45) 55%, rgba(0,0,0,0) 100%)",
          }}
        />
        <div className="absolute inset-x-0 bottom-0 h-[46%] px-0">
          <ViSparkline
            dataPoints={points}
            height="100%"
            overlay
            color={stroke}
          />
        </div>

        <span className="absolute top-2 left-2 h-6 min-w-6 px-1.5 inline-flex items-center justify-center rounded-md bg-black/60 backdrop-blur text-white text-[11px] font-bold font-mono tabular-nums">
          #{rank}
        </span>
        <div className="absolute top-2 right-2 flex items-center gap-1">
          {captureCount > 1 && (
            <Chip tone="magenta" className="backdrop-blur bg-black/50">
              {captureCount} captures
            </Chip>
          )}
          {pending && (
            <Chip
              tone="neutral"
              className="backdrop-blur bg-black/50 text-white border-white/20"
            >
              processing
            </Chip>
          )}
        </div>
      </div>

      <div className={`flex items-start gap-3 ${compact ? "p-3" : "p-3.5"}`}>
        <div className="min-w-0 flex-1">
          <div
            className={`font-bold text-primary truncate ${compact ? "text-[13px]" : "text-sm"}`}
          >
            {analysis.name || "Untitled"}
          </div>
          <div className="text-xs text-tertiary truncate mt-0.5">
            {analysis.category || "—"}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <ScoreBadge value={viralityScore} />
          <DeltaChip value={change24h} />
        </div>
      </div>
    </>
  );

  const shell =
    "block bg-surface border border-surface rounded-2xl overflow-hidden";
  if (pending) {
    return (
      <div className={`${shell} opacity-70`} aria-disabled="true">
        {body}
      </div>
    );
  }
  return (
    <Link href={`/app/markets/${marketId}`} className={`${shell} card-hover`}>
      {body}
    </Link>
  );
}

// Compact row for the list view.
export function MarketRow({ capture, captureCount, rank }: Props) {
  const { analysis, trends, viralityScore, marketId } = capture;
  const points = trends?.dataPoints ?? [];
  const change24h = viChange24h(points, viralityScore);
  const pending = !marketId;
  const image = tileImage(capture);

  const body = (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <span className="w-6 text-right text-xs text-tertiary font-mono tabular-nums shrink-0">
        {rank}
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image.src}
        alt=""
        loading="lazy"
        className={`w-10 h-10 rounded-lg border border-surface shrink-0 ${
          image.logo ? "object-contain p-1" : "object-cover bg-black"
        }`}
        style={image.logo ? { background: LOGO_TILE } : undefined}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-primary truncate flex items-center gap-2">
          <span className="truncate">{analysis.name || "Untitled"}</span>
          {captureCount > 1 && (
            <Chip tone="magenta">{captureCount} captures</Chip>
          )}
          {pending && <Chip>processing</Chip>}
        </div>
        <div className="text-xs text-tertiary truncate">
          {analysis.category || "—"}
        </div>
      </div>
      <div className="hidden sm:block w-28 shrink-0">
        <ViSparkline
          dataPoints={points}
          height={36}
          color={deltaColor(change24h)}
        />
      </div>
      <div className="hidden xs:block sm:w-20 shrink-0 text-right">
        <DeltaChip value={change24h} />
      </div>
      <ScoreBadge value={viralityScore} className="w-14 sm:w-16" />
      <span
        className="text-tertiary text-sm w-3 text-center shrink-0"
        aria-hidden="true"
      >
        {pending ? "" : "›"}
      </span>
    </div>
  );

  const shell =
    "block bg-surface border border-surface rounded-xl overflow-hidden";
  if (pending) {
    return (
      <div className={`${shell} opacity-70`} aria-disabled="true">
        {body}
      </div>
    );
  }
  return (
    <Link
      href={`/app/markets/${marketId}`}
      className={`${shell} transition-colors hover:border-atnx-cyan/35`}
    >
      {body}
    </Link>
  );
}
