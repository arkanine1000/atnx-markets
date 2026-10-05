"use server";

import { revalidatePath } from "next/cache";
import { PublicKey } from "@solana/web3.js";
import { startSeries, type StartResult } from "@/lib/bm/rounds";

// "Start rounds" on a market page. The connected Solana wallet becomes
// the series' finder (it earns the finder's share of the fees); the
// keeper pays for the accounts, so starting costs the user nothing on
// devnet. `fast` is the labelled hourly demo series.
export async function startSeriesAction(atnxMarketId: string, wallet: string, fast: boolean): Promise<StartResult> {
  if (typeof atnxMarketId !== "string" || !/^[0-9a-f-]{36}$/i.test(atnxMarketId)) {
    return { ok: false, error: "Bad request", code: "not_found" };
  }
  let finder: string;
  try {
    finder = new PublicKey(String(wallet)).toBase58();
  } catch {
    return { ok: false, code: "chain", error: "bad wallet" };
  }
  const result = await startSeries({ atnxMarketId, finderWallet: finder, fast: fast === true });
  if (result.ok) {
    revalidatePath(`/app/markets/${atnxMarketId}`);
    revalidatePath("/app");
  }
  return result;
}
