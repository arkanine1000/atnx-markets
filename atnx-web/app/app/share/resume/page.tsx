"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/context/AuthContext";

// Second half of a share that arrived while signed out. The service worker
// parked the shared image and text in the Cache API and sent the window
// here. Signed out: offer sign-in and remember to come back. Signed in:
// replay the capture through /share and go to the market.

const PENDING_CACHE = "atnx-share-pending";
// Read by AuthContext when Google sign-in starts.
const AFTER_LOGIN_KEY = "atnx:after-login";
// A capture older than this is stale enough that replaying it would surprise.
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

interface PendingMeta {
  fields: Record<string, string>;
  hasImage: boolean;
  savedAt: number;
}

async function readPending(): Promise<{ meta: PendingMeta; image: Blob | null } | null> {
  if (!("caches" in window)) return null;
  try {
    const cache = await caches.open(PENDING_CACHE);
    const metaRes = await cache.match("/pending/meta");
    if (!metaRes) return null;
    const meta = (await metaRes.json()) as PendingMeta;
    if (Date.now() - meta.savedAt > MAX_AGE_MS) {
      await clearPending();
      return null;
    }
    const imageRes = meta.hasImage ? await cache.match("/pending/image") : null;
    const image = imageRes ? await imageRes.blob() : null;
    return { meta, image };
  } catch {
    return null;
  }
}

async function clearPending() {
  try {
    await caches.delete(PENDING_CACHE);
  } catch {
    /* nothing to clear */
  }
}

type State = "checking" | "none" | "signin" | "sending" | "error";

export default function ShareResumePage() {
  const { user, loading, openLoginModal } = useAuth();
  const router = useRouter();
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (loading) return;
    let cancelled = false;

    (async () => {
      const pending = await readPending();
      if (cancelled) return;
      if (!pending) {
        setState("none");
        return;
      }
      if (!user) {
        try {
          window.sessionStorage.setItem(AFTER_LOGIN_KEY, "/app/share/resume");
        } catch {
          /* private mode: the user lands on /app and can share again */
        }
        setState("signin");
        return;
      }
      if (started.current) return;
      started.current = true;
      setState("sending");

      const form = new FormData();
      for (const [k, v] of Object.entries(pending.meta.fields)) form.append(k, v);
      if (pending.image) {
        form.append(
          "image",
          pending.image,
          pending.image.type === "image/jpeg" ? "share.jpg" : "share"
        );
      }
      try {
        const res = await fetch("/share", {
          method: "POST",
          body: form,
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        const body = (await res.json().catch(() => null)) as { redirect?: string; signIn?: boolean } | null;
        if (!body?.redirect) throw new Error(`Capture failed (${res.status})`);
        if (body.signIn) {
          setState("signin");
          return;
        }
        await clearPending();
        router.replace(body.redirect);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        setState("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, loading, router]);

  useEffect(() => {
    if (state === "none") router.replace("/app");
  }, [state, router]);

  return (
    <div className="max-w-md mx-auto w-full pt-8 text-center">
      {state === "signin" ? (
        <>
          <h1 className="font-display text-xl font-bold text-primary">One more step</h1>
          <p className="mt-2 text-sm text-secondary">
            Your capture is saved on this phone. Sign in and it goes straight to its market.
          </p>
          <button
            type="button"
            onClick={openLoginModal}
            className="mt-6 px-6 py-2.5 rounded-full btn-magenta text-sm font-bold cursor-pointer"
          >
            Sign in to finish
          </button>
          <button
            type="button"
            onClick={async () => {
              await clearPending();
              router.replace("/app");
            }}
            className="block mx-auto mt-4 text-xs text-tertiary hover:text-primary cursor-pointer"
          >
            Discard the capture
          </button>
        </>
      ) : state === "error" ? (
        <>
          <h1 className="font-display text-xl font-bold text-primary">Could not finish the capture</h1>
          <p className="mt-2 text-sm text-atnx-magenta">{error}</p>
          <div className="mt-6 flex items-center justify-center gap-4 text-sm">
            <button
              type="button"
              onClick={() => {
                started.current = false;
                setState("checking");
              }}
              className="px-5 py-2 rounded-full btn-magenta font-bold cursor-pointer"
            >
              Try again
            </button>
            <Link href="/app/submit" className="text-atnx-cyan">
              Use the Create form
            </Link>
          </div>
        </>
      ) : (
        <>
          <div
            aria-hidden="true"
            className="mx-auto mb-5 h-12 w-12 rounded-full border-[3px] border-elevated border-t-atnx-magenta border-r-atnx-cyan border-b-atnx-yellow animate-spin"
          />
          <h1 className="font-display text-xl font-bold text-primary">
            {state === "sending" ? "Capturing…" : "One moment…"}
          </h1>
          <p className="mt-2 text-sm text-secondary">
            {state === "sending"
              ? "Working out what this is and finding its market."
              : "Checking for a saved capture."}
          </p>
        </>
      )}
    </div>
  );
}
