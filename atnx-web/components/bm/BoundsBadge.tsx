import { Chip } from "@/components/ui";

// "UP/DOWN 20–500": the bounds of the live bounded market on a tile.
export function BoundsBadge({ lower, upper, className = "" }: { lower: number; upper: number; className?: string }) {
  return (
    <Chip tone="cyan" className={`backdrop-blur bg-black/50 ${className}`}>
      <span className="font-mono tabular-nums">
        UP/DOWN {lower}–{upper}
      </span>
    </Chip>
  );
}
