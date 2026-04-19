// Shared handle validation used by the settings form and server code.

const BLOCKED = new Set([
  'admin',
  'atnx',
  'official',
  'system',
  'mod',
  'moderator',
  'support',
]);

const HANDLE_REGEX = /^[A-Za-z0-9_#]+$/;
const DEFAULT_PATTERN = /^Attn_seeker#\d+$/;

export function validateHandle(
  next: string,
  currentHandle: string
): { ok: true } | { ok: false; error: string } {
  const trimmed = next.trim();

  if (trimmed.length < 3 || trimmed.length > 24) {
    return { ok: false, error: 'Handle must be 3-24 characters' };
  }
  if (!HANDLE_REGEX.test(trimmed)) {
    return { ok: false, error: 'Only letters, numbers, _ and # allowed' };
  }
  if (BLOCKED.has(trimmed.toLowerCase())) {
    return { ok: false, error: 'That handle is reserved' };
  }
  // Allow the user to keep their auto-assigned Attn_seeker handle, but block
  // switching to a different one of the same pattern (to prevent impersonation).
  if (DEFAULT_PATTERN.test(trimmed) && trimmed !== currentHandle) {
    return { ok: false, error: 'Cannot impersonate a default handle' };
  }
  return { ok: true };
}
