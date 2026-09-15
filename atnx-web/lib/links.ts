// Public links used by the marketing pages.
//
// The Chrome Web Store URL is only known once the listing is published;
// until NEXT_PUBLIC_EXTENSION_URL is set, the landing page shows the
// extension as "coming soon" instead of a dead link.
export const EXTENSION_URL: string | null =
  process.env.NEXT_PUBLIC_EXTENSION_URL?.trim() || null;
