import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SubmitForm } from "./SubmitForm";

// Web entry point: the only way in for the web-only variant, and a fallback
// for everyone else when the extension or share sheet is not at hand. The
// route stays /app/submit (the extension and share flow link to it); the
// tab and the heading say Create.
//
// The Android share target lands here with ?url=, ?text= and ?notice= when
// it could not finish on its own (a site that blocks link previews, or text
// the model turned away), so the person only has to add a screenshot.
export default async function SubmitPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/?redirect=/app/submit");

  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

  return (
    <div className="max-w-2xl mx-auto w-full">
      <h1 className="font-display text-xl font-bold text-primary mb-1">Create</h1>
      <p className="text-sm text-secondary mb-6">
        A screenshot, a link, or a line of text. You get back the market it
        belongs to, a new market, or a reason it was turned away.
      </p>

      <SubmitForm
        initialUrl={first(params.url)}
        initialText={first(params.text)}
        notice={first(params.notice)}
      />
    </div>
  );
}
