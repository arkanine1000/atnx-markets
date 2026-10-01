import { createClient } from "@/lib/supabase/server";
import { SettingsForm } from "./SettingsForm";
import { Identicon } from "@/components/Identicon";
import { redirect } from "next/navigation";
import { WalletSettings } from "@/components/bm/WalletSettings";

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/");

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("handle")
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
          </div>
        </div>
        <SettingsForm handle={profile?.handle ?? ""} />
      </div>

      <div className="bg-surface border border-surface rounded-lg p-6 mt-4">
        <h2 className="text-sm font-bold text-primary mb-3">Wallet</h2>
        <WalletSettings />
      </div>
    </div>
  );
}
