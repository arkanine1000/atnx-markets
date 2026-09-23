// The account's identity, read-only. Handles are fixed (supabase/014): the
// leaderboard, the trade log and the fee ledger name people by handle, so
// a change would let a record walk away from its owner. The fields keep
// the form's shape so the page reads as settings, greyed and with the
// default cursor to say they are not editable.
export function SettingsForm({
  email,
  handle,
}: {
  email: string | null;
  handle: string;
}) {
  const field =
    "w-full bg-elevated border border-surface rounded px-3 py-2.5 text-secondary font-mono text-sm cursor-default select-text";
  return (
    <div className="space-y-5">
      <div>
        <div className="text-xs text-tertiary font-mono uppercase tracking-wider mb-2">
          Email
        </div>
        <div className={field}>{email ?? "—"}</div>
      </div>

      <div>
        <div className="text-xs text-tertiary font-mono uppercase tracking-wider mb-2">
          Handle
        </div>
        <div className={field}>{handle ? `@${handle}` : "—"}</div>
      </div>
    </div>
  );
}
