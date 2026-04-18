# ATNX Rebrand — CMYK Color System + Dark/Light Mode

## Overview

Restyle the entire ATNX application (web app + Chrome extension) from the current green-on-black terminal aesthetic to a distinctive CMYK color system. Add a dark/light mode toggle. This is a visual overhaul only — no functionality changes.

The CMYK palette is intentionally distinctive from the typical crypto aesthetic (green terminal, blue DeFi gradients). It gives ATNX its own identity.

---

## Color System

### Core Palette

```
CYAN:     #00D4FF   — Data, charts, information, neutral UI elements
MAGENTA:  #FF00E5   — Actions, capture, extension, interactive elements
YELLOW:   #FFE500   — Scores, alerts, financial numbers, highlights
BLACK:    #000000   — Dark mode background base
WHITE:    #FFFFFF   — Light mode background base
```

### Extended Palette — Dark Mode

```
Background:
  bg-primary:     #0A0A0A    — Main background (near black)
  bg-surface:     #141414    — Card/container backgrounds
  bg-elevated:    #1E1E1E    — Modals, dropdowns, hover states
  bg-border:      #2A2A2A    — Borders, dividers

Text:
  text-primary:   #F0F0F0    — Main text
  text-secondary: #999999    — Muted/secondary text
  text-tertiary:  #666666    — Subtle labels, timestamps

Accents:
  cyan:           #00D4FF    — Primary accent
  cyan-dim:       #00A3CC    — Hover/pressed states
  cyan-glow:      rgba(0, 212, 255, 0.15)  — Subtle glow/background tint
  magenta:        #FF00E5    — Action accent
  magenta-dim:    #CC00B8    — Hover/pressed states
  magenta-glow:   rgba(255, 0, 229, 0.15)  — Subtle glow/background tint
  yellow:         #FFE500    — Score/financial accent
  yellow-dim:     #CCB800    — Hover/pressed states
  yellow-glow:    rgba(255, 229, 0, 0.15)  — Subtle glow/background tint
```

### Extended Palette — Light Mode

```
Background:
  bg-primary:     #FAFAFA    — Main background
  bg-surface:     #FFFFFF    — Card/container backgrounds
  bg-elevated:    #F0F0F0    — Modals, dropdowns, hover states
  bg-border:      #E0E0E0    — Borders, dividers

Text:
  text-primary:   #0A0A0A    — Main text
  text-secondary: #555555    — Muted/secondary text
  text-tertiary:  #888888    — Subtle labels, timestamps

Accents (slightly darker for readability on light backgrounds):
  cyan:           #00B8DB    — Primary accent
  cyan-dim:       #009BB8    — Hover/pressed states
  cyan-glow:      rgba(0, 184, 219, 0.10)  — Subtle background tint
  magenta:        #D900C5    — Action accent
  magenta-dim:    #B300A1    — Hover/pressed states
  magenta-glow:   rgba(217, 0, 197, 0.10)  — Subtle background tint
  yellow:         #D4BE00    — Score/financial accent (darkened for contrast)
  yellow-dim:     #A89600    — Hover/pressed states
  yellow-glow:    rgba(212, 190, 0, 0.10)  — Subtle background tint
```

---

## Tailwind Configuration

### tailwind.config.js

Replace the existing ATNX color configuration entirely:

```javascript
module.exports = {
  darkMode: 'class',   // Use class-based dark mode
  theme: {
    extend: {
      colors: {
        'atnx': {
          'cyan': '#00D4FF',
          'cyan-dim': '#00A3CC',
          'magenta': '#FF00E5',
          'magenta-dim': '#CC00B8',
          'yellow': '#FFE500',
          'yellow-dim': '#CCB800',
        },
        // Dark mode backgrounds
        'dark': {
          'primary': '#0A0A0A',
          'surface': '#141414',
          'elevated': '#1E1E1E',
          'border': '#2A2A2A',
        },
        // Light mode backgrounds
        'light': {
          'primary': '#FAFAFA',
          'surface': '#FFFFFF',
          'elevated': '#F0F0F0',
          'border': '#E0E0E0',
        },
      },
      fontFamily: {
        'mono': ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
        'sans': ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'cyan-glow': '0 0 20px rgba(0, 212, 255, 0.15)',
        'magenta-glow': '0 0 20px rgba(255, 0, 229, 0.15)',
        'yellow-glow': '0 0 20px rgba(255, 229, 0, 0.15)',
      },
    },
  },
}
```

---

## Color Semantics — What Each Color Means

This is the most important section. Colors encode meaning across the entire app:

### Cyan — Information & Data
Use for:
- Chart lines (sparklines, trend charts)
- Data labels and values (PEAK, NOW values)
- Category badges
- Platform tags (YouTube, Twitter, etc.)
- Navigation links (active state)
- Informational text and descriptions
- Card borders (default state)
- Dashboard header text ("ATNX", "Attention Exchange")

### Magenta — Action & Interaction
Use for:
- "Trade This" button
- Extension capture overlay (selection rectangle)
- Extension popup accent color
- Interactive hover states on cards
- "Open Position" submit button border/accent
- Active selection states
- The capture count badge
- Extension icon tint
- Sort button active state

### Yellow — Financial & Scores
Use for:
- Virality score numbers (the big 585, 426, etc.)
- PnL numbers (both profit and loss — use yellow for neutral, then green tint for profit, red tint for loss)
- Trend indicators (SPIKING, RISING, FALLING, STABLE, NEW)
- Price/index values in the trade modal
- Portfolio balance
- Fee displays
- Alert/notification accents
- Score badge backgrounds (subtle yellow glow)

### Profit/Loss Override
When showing PnL specifically:
- **Profit**: Yellow remains but add a cyan tint — or use a bright cyan-yellow gradient text
- **Loss**: Use magenta for losses instead of traditional red — keeps it on brand
- This way even financial states stay within the CMYK system

Alternative (simpler): Keep yellow for all financial numbers. Use a subtle ▲ or ▼ icon in cyan (profit) or magenta (loss) next to the yellow number. The color of the arrow tells you direction, the yellow number tells you magnitude.

---

## Dark/Light Mode Toggle

### Implementation

Use a class-based approach with `next-themes` or a simple React context:

```bash
npm install next-themes
```

### Theme Provider — app/layout.tsx

```tsx
import { ThemeProvider } from 'next-themes';

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="dark">
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
```

### Toggle Button

Place in the dashboard header, right side:

```
ATNX                                    [☀/🌙] [4] Captures
Attention Exchange
```

The toggle button:
- Dark mode: show a sun icon (☀️) — clicking switches to light
- Light mode: show a moon icon (🌙) — clicking switches to dark
- Smooth transition on the background and text colors (use CSS transition on background-color and color, ~200ms)

```tsx
// components/ThemeToggle.tsx

'use client';

import { useTheme } from 'next-themes';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <button
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      className="p-2 rounded-lg border border-dark-border dark:border-dark-border 
                 hover:border-atnx-cyan transition-colors"
    >
      {/* Sun icon for dark mode (click to go light), Moon for light mode */}
    </button>
  );
}
```

### CSS Class Pattern

For every styled element, use the Tailwind dark: prefix pattern:

```tsx
// Example card
<div className="bg-light-surface dark:bg-dark-surface 
                border border-light-border dark:border-dark-border
                text-light-primary dark:text-dark-primary">
```

Keep `dark` as the default theme since crypto users overwhelmingly prefer dark mode.

---

## Component-by-Component Restyle Guide

### Dashboard Header

```
Dark:  bg-dark-primary, "ATNX" in cyan, "Attention Exchange" in text-secondary
Light: bg-light-primary, "ATNX" in cyan (darker variant), same text hierarchy

Capture count badge: magenta border, magenta text
Sort buttons: cyan when active, text-secondary when inactive, magenta hover
Theme toggle: right-aligned in header
```

### Capture Cards

```
Dark:  bg-dark-surface, border-dark-border
Light: bg-light-surface, border-light-border

Hover state: border changes to cyan (subtle glow optional)

Type badge ("MEME", "PERSON", "TREND"):
  — bg: cyan-glow background, cyan text, cyan border

Name: cyan text, bold

Virality score box:
  — yellow text, large monospace
  — bg: yellow-glow background
  — border: subtle yellow border

Trend indicator:
  — yellow text for SPIKING, RISING
  — text-secondary for STABLE
  — magenta for FALLING

Sparkline chart line: cyan stroke

Category label: text-secondary
Sentiment label: cyan for positive, magenta for negative, yellow for mixed, text-secondary for neutral

PEAK/NOW values: text-secondary labels, cyan values

Description quote: text-primary, italic

Source/timestamp: text-tertiary

"Detected metrics" / "Raw text" expand toggles: cyan text

"Trade This" button:
  — magenta border, magenta text, transparent bg
  — hover: magenta bg, black/white text
```

### Trade Modal

```
Backdrop: rgba(0,0,0,0.7) dark, rgba(0,0,0,0.5) light — with backdrop-blur

Modal container:
  Dark:  bg-dark-elevated, border-dark-border
  Light: bg-light-elevated, border-light-border

Title: cyan text
Current index value: yellow, large monospace
Chart inside modal: cyan line, larger version of sparkline

LONG button:  cyan border/text, when selected: cyan bg with black text
SHORT button: magenta border/text, when selected: magenta bg with black text

Amount input:
  Dark:  bg-dark-surface, border-dark-border, text-primary
  Light: bg-light-surface, border-light-border, text-primary
  Focus: border-cyan

Quick amount buttons: border-dark-border, text-secondary, hover: border-cyan

Fee display: text-tertiary label, yellow value
Entry index: text-tertiary label, yellow value

Submit button (LONG):  cyan bg, black text, full width
Submit button (SHORT): magenta bg, black text, full width
```

### Portfolio Page

```
Balance: yellow text, large
Open Positions count: text-secondary
Total PnL: yellow number, cyan ▲ for profit / magenta ▼ for loss

Position cards:
  — Same card style as capture cards (bg-surface, border)
  — LONG indicator: cyan dot/badge
  — SHORT indicator: magenta dot/badge
  — Entry/Current/Change labels: text-tertiary
  — Entry/Current values: cyan
  — Change percent: yellow with direction arrow (cyan ▲ / magenta ▼)
  — Size: text-secondary
  — PnL amount: yellow
  — Value: text-primary

Close Position button: magenta border, magenta text, hover: magenta bg

Chart with entry marker:
  — Line: cyan
  — Entry point dot: magenta for the marker
  — Entry reference line: magenta dashed
```

### Confirmation Toast

```
Container: bg-dark-elevated (dark) / bg-light-elevated (light)
Border: cyan for long positions, magenta for short positions
Icon: ✅ or checkmark in cyan
Text: text-primary
Position details: cyan for name, yellow for index value
```

### Profit/Loss Close Screen

```
Profitable close:
  — Border: cyan
  — Profit number: yellow
  — Direction arrows: cyan
  — Progress bar fill: cyan

Loss close:
  — Border: magenta
  — Loss number: yellow
  — Direction arrows: magenta
  — Progress bar fill: magenta
```

### Live Mode Toggle

```
Inactive: text-secondary, border-dark-border
Active: magenta text, magenta border, subtle magenta-glow pulse animation
Label: "▶ LIVE" in magenta when active
```

---

## Chrome Extension Restyle

### Selection Overlay (content.css)

The selection rectangle is the signature ATNX interaction — make it magenta:

```css
.atnx-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 2147483647;
  cursor: crosshair;
  background: rgba(0, 0, 0, 0.15);
}

.atnx-selection {
  position: fixed;
  border: 2px solid #FF00E5;
  background: rgba(255, 0, 229, 0.08);
  box-shadow: 0 0 20px rgba(255, 0, 229, 0.2),
              inset 0 0 20px rgba(255, 0, 229, 0.05);
  z-index: 2147483647;
  pointer-events: none;
}

.atnx-tooltip {
  position: fixed;
  background: #0A0A0A;
  color: #FF00E5;
  border: 1px solid #FF00E5;
  padding: 4px 10px;
  border-radius: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  z-index: 2147483647;
  pointer-events: none;
  box-shadow: 0 0 10px rgba(255, 0, 229, 0.2);
}

/* Optional: animated corner markers on the selection */
.atnx-selection::before,
.atnx-selection::after {
  content: '';
  position: absolute;
  width: 12px;
  height: 12px;
  border-color: #FF00E5;
  border-style: solid;
}
.atnx-selection::before {
  top: -1px;
  left: -1px;
  border-width: 2px 0 0 2px;
}
.atnx-selection::after {
  bottom: -1px;
  right: -1px;
  border-width: 0 2px 2px 0;
}
```

### Extension Popup (popup.html / popup.css)

```
Background: #0A0A0A
"ATNX" title: cyan
"Capture" button: magenta bg, black text
API key input: dark surface bg, cyan focus border
Status text: text-secondary, magenta when capturing, cyan when done
"Open Dashboard" link: cyan text, underline on hover
```

The popup should feel like a mini version of the web app — same CMYK language.

### Extension Icon

If generating new icons, use a simple mark:
- Black background
- Magenta crosshair/capture symbol
- Or a simple "A" in magenta

For now, keeping existing icons is fine. The extension popup and overlay do the branding work.

---

## Typography

Keep monospace as the primary font for the terminal/exchange feel, but introduce a sans-serif for longer text:

```
Headings, scores, labels, code-like content: JetBrains Mono (monospace)
Descriptions, paragraphs, long text: Inter (sans-serif)
```

Both are available from Google Fonts. Add to the app layout:

```html
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
```

---

## Transitions & Polish

Add smooth transitions for the theme toggle and interactive elements:

```css
/* Global transition for theme switching */
* {
  transition: background-color 200ms ease, 
              border-color 200ms ease, 
              color 200ms ease;
}

/* Disable transitions on page load to prevent flash */
.no-transitions * {
  transition: none !important;
}
```

For the live mode, add a subtle pulse animation on the "LIVE" indicator:

```css
@keyframes live-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.live-indicator {
  animation: live-pulse 2s ease-in-out infinite;
}
```

---

## Implementation Priority

1. **Tailwind config update** — new color system
2. **Theme provider + toggle** — next-themes setup
3. **Global styles** — backgrounds, text colors, transitions
4. **Dashboard header** — restyle with CMYK
5. **Capture cards** — full restyle (biggest visual impact)
6. **Trade modal** — restyle
7. **Portfolio page** — restyle
8. **Extension overlay** — magenta selection rectangle
9. **Extension popup** — restyle
10. **Polish** — glow effects, hover states, animations

---

## Important Notes

- **Dark mode is the default.** Most crypto/trading users prefer dark. Light mode is a nice-to-have for differentiation and accessibility.
- **Don't change any functionality.** This is purely visual. All existing features from Phase 1, 2, and demo layer should work exactly the same.
- **Test both modes.** Every component must look good in both dark AND light mode. Check contrast ratios — yellow on white can be hard to read, hence the darkened yellow variants for light mode.
- **The CMYK colors are intentionally vivid.** They should pop. Don't mute them too much. The boldness is the brand.
- **Remove ALL traces of the old green (#00FF66) color.** Search the entire codebase for any hex codes, Tailwind classes, or inline styles referencing the old palette and replace them.

---

## Success Criteria

The restyle is done when:

1. ✅ All old green-on-black styling is completely replaced
2. ✅ Cyan is used consistently for data/information elements
3. ✅ Magenta is used consistently for action/interaction elements
4. ✅ Yellow is used consistently for scores/financial elements
5. ✅ Dark/light mode toggle works and is accessible from the header
6. ✅ Dark mode is the default
7. ✅ Both modes have proper contrast and readability
8. ✅ Extension selection overlay is magenta
9. ✅ Extension popup matches the CMYK brand
10. ✅ Transitions between themes are smooth (no flash)
11. ✅ The app looks visually distinct from pump.fun, Polymarket, and typical crypto UIs
