"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { signOut } from "@/app/actions/auth";

export function UserMenu() {
  const [handle, setHandle] = useState<string | null>(null);
  const [role, setRole] = useState<"user" | "admin" | "moderator" | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        if (!cancelled) {
          setHandle(null);
          setRole(null);
        }
        return;
      }
      const { data: profile } = await supabase
        .from("user_profiles")
        .select("handle, role")
        .eq("id", user.id)
        .maybeSingle();
      if (!cancelled) {
        setHandle(profile?.handle ?? null);
        setRole(profile?.role ?? null);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (!handle) return null;

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs px-3 py-1.5 rounded border border-surface bg-surface text-atnx-cyan hover:border-atnx-cyan/50 cursor-pointer transition-colors font-mono whitespace-nowrap"
      >
        {handle}
      </button>

      {open && (
        <div
          className="absolute right-0 mt-1 w-44 bg-elevated border border-surface rounded-md shadow-lg z-50 py-1"
          role="menu"
        >
          <Link
            href="/app/settings"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-xs text-primary hover:bg-surface transition-colors"
          >
            Settings
          </Link>
          {(role === "admin" || role === "moderator") && (
            <Link
              href="/admin"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-xs text-atnx-yellow hover:bg-surface transition-colors"
            >
              Admin
            </Link>
          )}
          <form action={signOut}>
            <button
              type="submit"
              className="w-full text-left px-3 py-2 text-xs text-atnx-magenta hover:bg-surface transition-colors cursor-pointer"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
