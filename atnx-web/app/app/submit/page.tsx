import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SubmitForm } from "./SubmitForm";

// Web entry point: the only way in for the web-only variant, and a fallback
// for everyone else when the extension or share sheet is not at hand. The
// route stays /app/submit (the extension and share flow link to it); the
// tab and the heading say Create.
export default async function SubmitPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/?redirect=/app/submit");

  return (
    <div className="max-w-2xl mx-auto w-full">
      <h1 className="text-xl font-bold text-primary mb-1">Create</h1>
      <p className="text-sm text-secondary mb-6">
        A screenshot, a link, or a line of text. You get back the market it
        belongs to, a new market, or a reason it was turned away.
      </p>

      <SubmitForm />
    </div>
  );
}
