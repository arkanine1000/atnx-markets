import type { MetadataRoute } from 'next';

// PWA manifest. Icons point at the existing 1024px app icon; Chrome scales
// to the requested size. When/if we want pixel-perfect renditions we can
// add properly-sized assets under /public and swap the entries here.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ATNX — Attention Exchange',
    short_name: 'ATNX',
    description: 'Capture, identify, and trade the virality of anything on the internet.',
    start_url: '/app',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0A0A0A',
    theme_color: '#0A0A0A',
    icons: [
      {
        src: '/app_icon.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/app_icon.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/app_icon.png',
        sizes: '1024x1024',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
