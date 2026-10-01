import { USDG_UNIT } from "@/lib/bm/chains";

// Numbers for the ticket: USDG units (6 decimals) to text.
export function fmtUsdg(units: bigint, digits = 2): string {
  const whole = units / USDG_UNIT;
  const frac = units % USDG_UNIT;
  const n = Number(whole) + Number(frac) / 1_000_000;
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtCents(price: number): string {
  return `${Math.round(price * 100)}¢`;
}

export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function shortHash(h: string): string {
  return `${h.slice(0, 10)}…`;
}

export function parseUsdg(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d+(\.\d{0,6})?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  return BigInt(w) * USDG_UNIT + BigInt((f + "000000").slice(0, 6));
}
