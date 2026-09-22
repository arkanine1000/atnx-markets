"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { signOut } from "@/app/actions/auth";
import { useAuth } from "@/context/AuthContext";
import { Identicon } from "@/components/Identicon";

export function UserMenu() {
  const { user, loading, openLoginModal } = useAuth();
  const [handle, setHandle] = useState<string | null>(null);
  const [role, setRole] = useState<"user" | "admin" | "moderator" | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Load profile when a user is present. When the user becomes null we render
  // the Login button branch below, so stale handle/role state is never shown.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    async function load(userId: string) {
      const supabase = createClient();
      const { data: profile } = await supabase
        .from("user_profiles")
        .select("handle, role")
        .eq("id", userId)
        .maybeSingle();
      if (!cancelled) {
        setHandle(profile?.handle ?? null);
        setRole(profile?.role ?? null);
      }
    }
    load(user.id);
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (loading) return null;

  if (!user) {
    return (
      <button
        onClick={openLoginModal}
        className="text-xs px-3 py-1.5 rounded border border-atnx-magenta bg-atnx-magenta/10 text-atnx-magenta hover:bg-atnx-magenta hover:text-white cursor-pointer transition-colors font-mono font-bold whitespace-nowrap"
      >
        Login
      </button>
    );
  }

  // The generated face stands in for the handle: it is seeded by the
  // account id, so it is ready before the profile loads and survives a
  // rename. The handle itself heads the menu.
  const name = handle ? `@${handle}` : "Account";
  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${name} menu`}
        title={name}
        className={`h-8 w-8 rounded-full border-2 cursor-pointer transition-colors ${
          open ? "border-atnx-cyan" : "border-surface hover:border-atnx-cyan/60"
        }`}
      >
        <Identicon seed={user.id} size={28} />
      </button>

      {open && (
        <div
          className="absolute right-0 mt-1 w-48 bg-elevated border border-surface rounded-md shadow-lg z-50 py-1"
          role="menu"
        >
          <div className="flex items-center gap-2.5 px-3 py-2 border-b border-surface mb-1">
            <Identicon seed={user.id} size={24} />
            <span className="text-xs font-bold text-atnx-cyan light:text-atnx-cyan-light truncate">
              {name}
            </span>
          </div>
          {/* Portfolio is not in the phone bottom bar, so it lives here on
              phones. From sm up the header pill has it already. */}
          <Link
            href="/app/portfolio"
            onClick={() => setOpen(false)}
            className="block sm:hidden px-3 py-2 text-xs text-primary hover:bg-surface transition-colors"
          >
            Portfolio
          </Link>
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
