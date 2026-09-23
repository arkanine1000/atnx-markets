import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadDraft } from "@/lib/capture";
import { ReviewError, toView } from "@/lib/review";
import { ReviewClient } from "./ReviewClient";

// The review screen between capture and market creation. The web form and
// the Android share target both land here after /api/captures/propose; the
// extension's side panel shows a compact version calling the same commit
// endpoint. Drafts belong to the signed-in user and expire in fifteen
// minutes; an expired or foreign draft is a dead end with one link back.
export const dynamic = "force-dynamic";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ draftId: string }>;
}) {
  const { draftId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/?redirect=/app/submit/review/${draftId}`);

  let view;
  try {
    view = toView(await loadDraft(draftId, user.id));
  } catch (err) {
    if (err instanceof ReviewError) {
      return (
        <div className="max-w-2xl mx-auto w-full">
          <h1 className="font-display text-xl font-bold text-primary mb-2">Review</h1>
          <p className="text-sm text-secondary mb-4">{err.message}</p>
          <Link href="/app/submit" className="text-sm text-atnx-cyan hover:underline">
            Submit again
          </Link>
        </div>
      );
    }
    throw err;
  }

  return (
    <div className="max-w-2xl mx-auto w-full">
      <h1 className="font-display text-xl font-bold text-primary mb-1">Review</h1>
      <p className="text-sm text-secondary mb-6">
        Check what was found before it lands. Crop the image if it caught too
        much, then add it to a market or create one.
      </p>
      <ReviewClient initial={view} />
    </div>
  );
}
