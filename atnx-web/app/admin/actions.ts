"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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

// Permanently deletes a soft-deleted market: the row, its captures and
// their images, its VI history and its curated image. The RPC refuses a
// market that is live, and one with trades on record unless withTrades is
// set, in which case it deletes the trades and unwinds them from every
// balance and the treasury (supabase/019). It writes the moderation_log
// row; the files are removed here, since storage is not reachable from SQL.
export async function purgeMarket(
  marketId: string,
  { withTrades = false }: { withTrades?: boolean } = {}
): Promise<AdminActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not signed in" };

  const { data, error } = await supabase.rpc("admin_purge_market", {
    market_id: marketId,
    reason: withTrades
      ? "purged with its trades from the admin dashboard"
      : "purged from the admin dashboard",
    // Only sent when set, so a plain purge also works before 019 is applied.
    ...(withTrades ? { with_trades: true } : {}),
  });
  if (error) return { success: false, error: error.message };

  const purged = (data ?? {}) as { image_urls?: string[]; thumbnail_url?: string | null };
  const admin = createAdminClient();
  const bucket = admin.storage.from("captures");
  const paths = (purged.image_urls ?? [])
    .concat(purged.thumbnail_url ? [purged.thumbnail_url] : [])
    .map(storagePath)
    .filter((p): p is string => p !== null);
  // Curated images live in a per-market folder; sweep whatever is in it.
  const { data: curated } = await bucket.list(`markets/${marketId}`);
  for (const f of curated ?? []) paths.push(`markets/${marketId}/${f.name}`);
  if (paths.length > 0) {
    const { error: rmErr } = await bucket.remove([...new Set(paths)]);
    if (rmErr) console.warn("[admin] purge: could not remove files", rmErr.message);
  }

  revalidatePath("/admin");
  revalidatePath("/app");
  return { success: true };
}

// The object path inside the captures bucket for one of its public URLs.
function storagePath(url: string): string | null {
  const marker = "/storage/v1/object/public/captures/";
  const i = url.indexOf(marker);
  return i === -1 ? null : decodeURIComponent(url.slice(i + marker.length));
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

// A creator market's YouTube channel (supabase/017_market_handles): the
// resolver verifies what it can prove and queues the rest here. Verifying
// a candidate channel makes it score the market's creator reach, ramping
// in over 48 h from now; rejecting stops it. The decision is final: the
// resolver's weekly re-check leaves an admin-decided row alone.
export async function decideHandle(
  marketId: string,
  decision: "verify" | "reject",
  channel?: { id: string; handle: string | null; subscribers: number | null }
): Promise<AdminActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: "Not signed in" };
  const { data: profile } = await supabase.from("user_profiles").select("role").eq("id", user.id).maybeSingle();
  if (!profile || !["admin", "moderator"].includes(profile.role)) return { success: false, error: "Not allowed" };
  if (decision === "verify" && !channel) return { success: false, error: "No channel to verify" };

  const admin = createAdminClient();
  const now = new Date().toISOString();
  const update =
    decision === "verify"
      ? { status: "verified" as const, platform_id: channel!.id, handle: channel!.handle, audience: channel!.subscribers, verified_at: now }
      : { status: "rejected" as const, verified_at: null };
  const { error } = await admin
    .from("market_handles")
    .update({ ...update, review: false, confidence: "admin", checked_at: now })
    .eq("market_id", marketId)
    .eq("platform", "youtube");
  if (error) return { success: false, error: error.message };

  await admin.from("moderation_log").insert({
    admin_user_id: user.id,
    action: decision === "verify" ? "verify_handle" : "reject_handle",
    target_type: "market",
    target_id: marketId,
    metadata: { platform: "youtube", channel_id: channel?.id ?? null, handle: channel?.handle ?? null },
  });
  revalidatePath("/admin");
  return { success: true };
}
