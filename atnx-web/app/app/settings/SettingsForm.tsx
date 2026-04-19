"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { validateHandle } from "@/lib/handle";

export function SettingsForm({
  userId,
  email,
  initialHandle,
}: {
  userId: string;
  email: string | null;
  initialHandle: string;
}) {
  const [handle, setHandle] = useState(initialHandle);
  const [savedHandle, setSavedHandle] = useState(initialHandle);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = validateHandle(handle, savedHandle);
    if (!result.ok) {
      setMsg({ tone: "err", text: result.error });
      return;
    }

    setBusy(true);
    setMsg(null);
    const supabase = createClient();
    const { error } = await supabase
      .from("user_profiles")
      .update({ handle: handle.trim(), updated_at: new Date().toISOString() })
      .eq("id", userId);

    setBusy(false);
    if (error?.code === "23505") {
      setMsg({ tone: "err", text: "That handle is taken" });
      return;
    }
    if (error) {
      setMsg({ tone: "err", text: `Update failed: ${error.message}` });
      return;
    }
    setSavedHandle(handle.trim());
    setMsg({ tone: "ok", text: "Handle updated" });
  }

  const dirty = handle.trim() !== savedHandle;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className="text-xs text-secondary uppercase tracking-wider block mb-2">
          Email
        </label>
        <div className="bg-surface border border-surface rounded px-3 py-2.5 text-primary font-mono text-sm">
          {email ?? "\u2014"}
        </div>
      </div>

      <div>
        <label
          htmlFor="handle"
          className="text-xs text-secondary uppercase tracking-wider block mb-2"
        >
          Handle
        </label>
        <input
          id="handle"
          type="text"
          value={handle}
          onChange={(e) => {
            setHandle(e.target.value);
            setMsg(null);
          }}
          minLength={3}
          maxLength={24}
          className="w-full bg-surface border border-surface rounded px-3 py-2.5 text-primary font-mono text-sm focus:border-atnx-cyan outline-none"
        />
        <p className="text-xs text-tertiary mt-1.5">
          3-24 chars. Letters, numbers, _ and # only.
        </p>
      </div>

      {msg && (
        <div
          className={`text-sm ${
            msg.tone === "ok" ? "text-atnx-cyan" : "text-atnx-magenta"
          }`}
        >
          {msg.text}
        </div>
      )}

      <button
        type="submit"
        disabled={busy || !dirty}
        className="px-6 py-2.5 rounded bg-atnx-magenta text-black font-mono font-bold text-sm hover:bg-atnx-magenta-dim disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
      >
        {busy ? "Saving\u2026" : "Save"}
      </button>
    </form>
  );
}
