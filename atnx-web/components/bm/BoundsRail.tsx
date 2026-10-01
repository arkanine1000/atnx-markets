// The open UP/DOWN market as a rail: the lower bound at the magenta end,
// the upper at the cyan end, and a dot where the VI sits now. Bounds are
// symmetric in log space (VI·m and VI/m), so the dot is placed on a log
// scale and a market opens with its dot in the middle; a lower bound of
// 0 falls back to a linear scale from 0.
export function BoundsRail({
  lower,
  upper,
  vi,
  compact = false,
  className = "",
}: {
  lower: number;
  upper: number;
  vi: number;
  compact?: boolean;
  className?: string;
}) {
  const pos = position(lower, upper, vi);
  const pct = `${(pos * 100).toFixed(1)}%`;
  return (
    <div
      className={`flex items-center gap-1.5 ${compact ? "text-[9px]" : "text-[10px]"} font-mono tabular-nums ${className}`}
      title={`DOWN pays at VI ${lower}, UP pays at VI ${upper}. VI now ${Math.round(vi)}.`}
      aria-label={`Bounds ${lower} to ${upper}, VI ${Math.round(vi)}`}
    >
      <span className="text-atnx-magenta light:text-atnx-magenta-light shrink-0 w-7 text-right">{lower}</span>
      <span className="relative flex-1 h-3 flex items-center">
        <span
          className="absolute inset-x-0 h-[3px] rounded-full"
          style={{ background: "linear-gradient(to right, rgba(255,0,229,0.9), rgba(255,0,229,0.25) 35%, rgba(0,212,255,0.25) 65%, rgba(0,212,255,0.9))" }}
        />
        <span
          className="absolute h-2.5 w-2.5 rounded-full bg-white border-2 border-black/70 shadow-[0_0_6px_rgba(255,255,255,0.6)] -translate-x-1/2"
          style={{ left: pct }}
        />
      </span>
      <span className="text-atnx-cyan light:text-atnx-cyan-light shrink-0 w-8">{upper}</span>
    </div>
  );
}

export function position(lower: number, upper: number, vi: number): number {
  if (!(upper > lower)) return 0.5;
  let p: number;
  if (lower > 0 && vi > 0) p = Math.log(vi / lower) / Math.log(upper / lower);
  else p = (vi - lower) / (upper - lower);
  return Math.min(1, Math.max(0, p));
}
