"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface AdminActionResult {
  success: boolean;
  error?: string;
}

async function callRpc<Args extends Record<string, unknown>>(
  rpc:
    | "admin_soft_delete_market"
    | "admin_restore_market"
    | "admin_edit_market_name"
    | "admin_soft_delete_capture"
    | "admin_reassign_capture"
    | "admin_set_parent_market",
  args: Args,
  // Pages beyond /admin and /app that show the changed row.
  extraPaths: string[] = []
): Promise<AdminActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not signed in" };

  // @ts-expect-error — generic dispatch; each rpc name is narrowed to the
  // matching signature on the call sites below.
  const { error } = await supabase.rpc(rpc, args);
  if (error) return { success: false, error: error.message };

  revalidatePath("/admin");
  revalidatePath("/app");
  for (const path of extraPaths) revalidatePath(path);
  return { success: true };
}

// Points a market at the subject it is about, or clears the pointer with a
// null parent. The RPC enforces the one-level rule (a parent has no parent,
// a market with children takes none) and writes the moderation_log row.
export async function setParentMarket(
  marketId: string,
  parentId: string | null,
  reason: string
): Promise<AdminActionResult> {
  if (parentId === marketId) {
    return { success: false, error: "A market cannot be its own parent" };
  }
  const paths = [`/app/markets/${marketId}`];
  if (parentId) paths.push(`/app/markets/${parentId}`);
  return callRpc(
    "admin_set_parent_market",
    { market_id: marketId, parent_id: parentId, reason: reason || null },
    paths
  );
}

export async function softDeleteMarket(
  marketId: string,
  reason: string
): Promise<AdminActionResult> {
  return callRpc("admin_soft_delete_market", {
    market_id: marketId,
    reason: reason || null,
  });
}

export async function restoreMarket(
  marketId: string,
  reason: string
): Promise<AdminActionResult> {
  return callRpc("admin_restore_market", {
    market_id: marketId,
    reason: reason || null,
  });
}

export async function editMarketName(
  marketId: string,
  newName: string,
  reason: string
): Promise<AdminActionResult> {
  const trimmed = newName.trim();
  if (trimmed.length < 1) {
    return { success: false, error: "Name cannot be empty" };
  }
  return callRpc("admin_edit_market_name", {
    market_id: marketId,
    new_name: trimmed,
    reason: reason || null,
  });
}

export async function softDeleteCapture(
  captureId: string,
  reason: string
): Promise<AdminActionResult> {
  return callRpc("admin_soft_delete_capture", {
    capture_id: captureId,
    reason: reason || null,
  });
}

export async function reassignCapture(
  captureId: string,
  newMarketId: string,
  reason: string
): Promise<AdminActionResult> {
  return callRpc("admin_reassign_capture", {
    capture_id: captureId,
    new_market_id: newMarketId,
    reason: reason || null,
  });
}

export async function approveCapture(
  captureId: string,
  reason: string
): Promise<AdminActionResult> {
  // Approval = keep the current market_id, just flip the status. We do this
  // through reassign-to-self so every admin touch still leaves a log row.
  const supabase = await createClient();
  const { data: capture, error } = await supabase
    .from("captures")
    .select("market_id")
    .eq("id", captureId)
    .maybeSingle();
  if (error) return { success: false, error: error.message };
  if (!capture?.market_id) {
    return { success: false, error: "Capture has no market" };
  }

  return callRpc("admin_reassign_capture", {
    capture_id: captureId,
    new_market_id: capture.market_id,
    reason: reason || "approved",
  });
}
