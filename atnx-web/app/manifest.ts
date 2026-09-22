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
    // Long-press on the home-screen icon.
    shortcuts: [
      {
        name: 'Create a market',
        short_name: 'Create',
        description: 'Capture a screenshot, a link, or a line of text',
        url: '/app/submit',
        icons: [{ src: '/app_icon.png', sizes: '192x192', type: 'image/png' }],
      },
      {
        name: 'Portfolio',
        short_name: 'Portfolio',
        description: 'Balance, open positions and PnL',
        url: '/app/portfolio',
        icons: [{ src: '/app_icon.png', sizes: '192x192', type: 'image/png' }],
      },
    ],
    // Android share target: tapping "Share" on an image in any app and
    // picking ATNX POSTs the image + optional text to /share, which runs
    // the same pipeline as /api/captures and redirects to the new market.
    // Next's MetadataRoute.Manifest types `files` as File[] (incorrect —
    // the spec expects {name, accept} entries), so we cast.
    share_target: {
      action: '/share',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        title: 'title',
        text: 'text',
        url: 'url',
        files: [
          {
            name: 'image',
            accept: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
          },
        ],
      },
    } as MetadataRoute.Manifest['share_target'],
  };
}

