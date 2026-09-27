import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getLeaderboard } from "@/lib/leaderboard";
import { getTreasury } from "@/lib/treasury";
import { AdminDashboard } from "./dashboard-client";

export const dynamic = "force-dynamic";

export interface HandleCandidate {
  id: string;
  handle: string | null;
  title: string;
  subscribers: number | null;
  videos: number;
  evidence: string[];
  name_match: boolean;
}

export interface HandleRow {
  market_id: string;
  platform: "youtube" | "x";
  handle: string | null;
  platform_id: string | null;
  status: "candidate" | "verified" | "rejected";
  review: boolean;
  confidence: string | null;
  evidence: { candidates?: HandleCandidate[] } | null;
  audience: number | null;
  verified_at: string | null;
  checked_at: string;
  market: { entity_name: string } | null;
}

interface MarketRow {
  id: string;
  entity_name: string;
  entity_type: string | null;
  current_vi: number;
  total_captures: number;
  network: "simulated" | "devnet" | "mainnet";
  parent_market_id: string | null;
  deleted_at: string | null;
  created_at: string;
}

interface ReviewCaptureRow {
  id: string;
  image_url: string | null;
  confidence_score: number | null;
  resolution_status: "pending" | "resolved" | "review" | "new_entity";
  created_at: string;
  user_id: string | null;
  market_id: string | null;
  market: { entity_name: string } | null;
  user: { handle: string } | null;
}

interface ModerationLogRow {
  id: string;
  admin_user_id: string;
  action: string;
  target_type: string;
  target_id: string;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  admin: { handle: string } | null;
}

interface WaitlistRow {
  id: string;
  email: string;
  source: string;
  created_at: string;
}

export default async function AdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/");

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile || !["admin", "moderator"].includes(profile.role)) {
    redirect("/app");
  }

  const [
    { data: handles },
    { data: markets },
    { data: reviewCaptures },
    { data: log },
    { data: waitlist },
    traders,
    treasury,
  ] = await Promise.all([
      // Creator channels: the resolver's review queue and what it verified
      // (supabase/017; admin-readable under RLS).
      supabase
        .from("market_handles")
        .select("market_id, platform, handle, platform_id, status, review, confidence, evidence, audience, verified_at, checked_at, market:markets(entity_name)")
        .or("review.eq.true,status.eq.verified")
        .order("checked_at", { ascending: false })
        .limit(200)
        .returns<HandleRow[]>(),
      supabase
        .from("markets")
        .select(
          "id, entity_name, entity_type, current_vi, total_captures, network, parent_market_id, deleted_at, created_at"
        )
        .order("created_at", { ascending: false })
        .limit(200)
        .returns<MarketRow[]>(),
      supabase
        .from("captures")
        .select(
          "id, image_url, confidence_score, resolution_status, created_at, user_id, market_id, market:markets(entity_name), user:user_profiles(handle)"
        )
        .eq("resolution_status", "review")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(100)
        .returns<ReviewCaptureRow[]>(),
      supabase
        .from("moderation_log")
        .select(
          "id, admin_user_id, action, target_type, target_id, reason, metadata, created_at, admin:user_profiles(handle)"
        )
        .order("created_at", { ascending: false })
        .limit(100)
        .returns<ModerationLogRow[]>(),
      // Admin-readable under RLS (supabase/015). Before that file is
      // applied the query errors and the tab shows an empty list.
      supabase
        .from("waitlist")
        .select("id, email, source, created_at")
        .order("created_at", { ascending: false })
        .limit(1000)
        .returns<WaitlistRow[]>(),
      // The full board, with the figures the public page keeps to itself
      // (equity, realized and unrealized, trade counts, volume), and the
      // treasury the fees flow into.
      getLeaderboard(),
      getTreasury(),
    ]);

  return (
    <AdminDashboard
      handles={handles ?? []}
      markets={markets ?? []}
      reviewCaptures={reviewCaptures ?? []}
      log={log ?? []}
      waitlist={waitlist ?? []}
      traders={traders}
      treasury={treasury}
    />
  );
}
