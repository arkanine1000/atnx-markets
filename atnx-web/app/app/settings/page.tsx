import { createClient } from "@/lib/supabase/server";
import { Nav } from "@/components/Nav";
import { SettingsForm } from "./SettingsForm";
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
    <div className="max-w-2xl mx-auto px-4 py-8 w-full">
      <Nav />

      <h1 className="text-xl font-bold text-primary mb-6">Settings</h1>

      <div className="bg-surface border border-surface rounded-lg p-6">
        <SettingsForm
          userId={user.id}
          email={profile?.email ?? user.email ?? null}
          initialHandle={profile?.handle ?? ""}
        />
      </div>
    </div>
  );
}
