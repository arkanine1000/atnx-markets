import { createClient } from "@/lib/supabase/server";
import { SettingsForm } from "./SettingsForm";
import { Identicon } from "@/components/Identicon";
import { redirect } from "next/navigation";

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/");

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("handle, email")
    .eq("id", user.id)
    .maybeSingle();

  return (
    <div className="max-w-2xl mx-auto w-full">

      <h1 className="font-display text-xl font-bold text-primary mb-6">Settings</h1>

      <div className="bg-surface border border-surface rounded-lg p-6">
        <div className="flex items-center gap-4 mb-6 pb-6 border-b border-surface">
          <Identicon seed={user.id} size={64} className="border-2 border-surface" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-primary truncate">
              {profile?.handle ? `@${profile.handle}` : "Your account"}
            </div>
            <div className="text-xs text-tertiary mt-0.5">
              Your face on the leaderboard and in the header, drawn from your
              account in the three inks. Your handle is fixed: the leaderboard
              and the trade log know you by it.
            </div>
          </div>
        </div>
        <SettingsForm
          email={profile?.email ?? user.email ?? null}
          handle={profile?.handle ?? ""}
        />
      </div>
    </div>
  );
}
