"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MAX_EMAIL_LENGTH } from "@/lib/waitlist";

// The landing page's Join Waitlist button. It opens a small dialog asking
// for an email, posts it to /api/waitlist, and remembers a successful
// signup in this browser so the button reads "On the list" afterwards.

const JOINED_KEY = "atnx:waitlist:joined";

// Read through useSyncExternalStore so the server render and the first
// client render agree (not joined) and the saved value applies right
// after hydration, the same way the markets view remembers grid or list.
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}
function readJoined(): string {
  try {
    return window.localStorage.getItem(JOINED_KEY) ?? "";
  } catch {
    return "";
  }
}
function writeJoined(email: string) {
  try {
    window.localStorage.setItem(JOINED_KEY, email);
  } catch {
    /* private mode etc. */
  }
  for (const l of listeners) l();
}

export function WaitlistButton() {
  const [open, setOpen] = useState(false);
  const joined = useSyncExternalStore(subscribe, readJoined, () => "");

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-8 py-3 rounded-lg border border-atnx-cyan text-atnx-cyan font-semibold cursor-pointer transition-colors hover:bg-atnx-cyan hover:text-black light:border-atnx-cyan-light light:bg-atnx-cyan/15 light:text-black light:hover:bg-atnx-cyan"
      >
        {joined ? "On the list ✓" : "Join Waitlist"}
      </button>
      {open && (
        <WaitlistDialog
          joinedEmail={joined}
          onJoined={writeJoined}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

type Phase = "idle" | "sending" | "done";

function WaitlistDialog({
  joinedEmail,
  onJoined,
  onClose,
}: {
  joinedEmail: string;
  onJoined: (email: string) => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [phase, setPhase] = useState<Phase>(joinedEmail ? "done" : "idle");
  const [status, setStatus] = useState<"joined" | "already">("already");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    (inputRef.current ?? closeRef.current)?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (phase === "sending") return;
    setError(null);
    setPhase("sending");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, company }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        status?: "joined" | "already";
        error?: string;
      };
      if (!res.ok || !body.success) {
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      setStatus(body.status ?? "joined");
      onJoined(email.trim().toLowerCase());
      setPhase("done");
    } catch (err) {
      setError((err as Error).message);
      setPhase("idle");
    }
  }

  const shown = joinedEmail || email.trim().toLowerCase();

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      style={{
        backgroundColor: "rgba(0,0,0,0.7)",
        backdropFilter: "blur(6px)",
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="waitlist-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md bg-surface border border-surface rounded-t-2xl sm:rounded-2xl shadow-2xl animate-slide-up pb-[env(safe-area-inset-bottom)] text-left"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-1">
          <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-tertiary">
            Waitlist
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-8 w-8 -mr-2 rounded-full inline-flex items-center justify-center text-secondary hover:text-primary hover:bg-elevated cursor-pointer transition-colors"
          >
            {"✕"}
          </button>
        </div>

        {phase === "done" ? (
          <div className="px-5 pb-5">
            <h2
              id="waitlist-title"
              className="font-display text-xl font-bold text-primary tracking-tight"
            >
              {status === "already" ? "Already on the list" : "You’re on the list"}
            </h2>
            <p className="mt-2 text-sm text-secondary">
              We&rsquo;ll write to{" "}
              <span className="font-mono text-primary break-all">{shown}</span>{" "}
              when ATNX launches.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-5 w-full btn-magenta rounded-lg px-4 py-2.5 text-sm font-bold cursor-pointer"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="px-5 pb-5">
            <h2
              id="waitlist-title"
              className="font-display text-xl font-bold text-primary tracking-tight"
            >
              Get in early
            </h2>
            <p className="mt-2 text-sm text-secondary">
              Leave an email and we&rsquo;ll let you know the moment ATNX
              launches. Nothing else, no newsletter.
            </p>
            <label className="block mt-4">
              <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-tertiary">
                Email
              </span>
              <input
                ref={inputRef}
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                maxLength={MAX_EMAIL_LENGTH}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                disabled={phase === "sending"}
                className="mt-1 w-full rounded-xl border border-surface bg-elevated px-3 py-2.5 text-sm text-primary placeholder:text-tertiary focus:outline-none focus:border-atnx-cyan disabled:opacity-60"
              />
            </label>
            {/* Honeypot: hidden from people, filled by bots. The server
                answers a filled one with a success and stores nothing. */}
            <label className="hidden" aria-hidden="true">
              Company
              <input
                type="text"
                name="company"
                tabIndex={-1}
                autoComplete="off"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="mt-2 text-xs text-atnx-magenta">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={phase === "sending"}
              className="mt-4 w-full btn-magenta rounded-lg px-4 py-2.5 text-sm font-bold cursor-pointer disabled:opacity-60 disabled:cursor-wait"
            >
              {phase === "sending" ? "Joining…" : "Join the waitlist"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
