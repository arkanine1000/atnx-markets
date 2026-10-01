"use server";

import { revalidatePath } from "next/cache";
import { isAddress } from "viem";
import { openBoundedMarket, type OpenResult } from "@/lib/bm/open";

// "Open UP/DOWN market" on a market page. Identity on the hackathon
// build is the connected wallet (OAuth sign-in redirects to the main
// site from the subdomain); the seed comes from the treasury wallet, so
// opening costs the user nothing on the testnet.
export async function openBoundedMarketAction(atnxMarketId: string, chainKey: string, wallet: string): Promise<OpenResult> {
  if (typeof atnxMarketId !== "string" || typeof chainKey !== "string") {
    return { ok: false, error: "Bad request", code: "chain" };
  }
  if (typeof wallet !== "string" || !isAddress(wallet)) {
    return { ok: false, error: "Connect a wallet to open a market", code: "chain" };
  }
  const result = await openBoundedMarket({ atnxMarketId, chainKey, openedByWallet: wallet });
  if (result.ok) {
    revalidatePath(`/app/markets/${atnxMarketId}`);
    revalidatePath("/app");
  }
  return result;
}
