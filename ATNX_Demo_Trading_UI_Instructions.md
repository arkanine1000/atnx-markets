# ATNX Demo Layer — Simulated Trading UI for Demo Recording

## Overview

Add a simulated trading layer on top of the existing Phase 1+2 build. This is purely frontend — no real trading, no blockchain, no real money. The purpose is to create a compelling demo recording that shows the full ATNX user journey: see something → capture it → trade on its virality → make profit.

Everything is hardcoded/mocked. This is a video demo, not a production feature.

---

## What To Build

1. **Trade button on each capture card**
2. **Trade modal with buy/sell UI**
3. **Portfolio page showing open positions with mock PnL**
4. **Entry marker on sparkline charts**
5. **Simulated live chart updates (fake ticking data)**
6. **Trade confirmation animations**

---

## Part 1: Trade Button on Capture Cards

Add a button to each existing capture card:

```
┌─────────────────────────────────────────────────────────────┐
│  MEME  Chainsaw Man                      ↘ FALLING  426    │
│  [sparkline chart]                                          │
│  "A video about Chainsaw Man meme culture..."               │
│  SOURCE: youtube.com  CAPTURED: 3m ago                      │
│  ▸ Detected metrics  ▸ Raw text                             │
│                                                              │
│                                    [ 🔥 Trade This ]        │
└─────────────────────────────────────────────────────────────┘
```

- Button text: "Trade This" with a fire emoji or chart icon
- Style: ATNX green border, transparent background, hover fills green
- Positioned bottom-right of the card
- On click: opens the Trade Modal

---

## Part 2: Trade Modal

A modal/overlay that appears when "Trade This" is clicked. Dark themed, centered on screen.

### Layout

```
┌──────────────────────────────────────────────────────┐
│                                                  [X]  │
│   TRADE: Chainsaw Man                                 │
│   Current Virality Index: 426                         │
│   Trend: ↘ FALLING                                    │
│                                                        │
│   ┌────────────────────────────────────────────────┐  │
│   │  [sparkline chart — larger version, ~300x100]  │  │
│   │  with current price line                        │  │
│   └────────────────────────────────────────────────┘  │
│                                                        │
│   Position Type:                                       │
│   ┌──────────────┐  ┌──────────────┐                  │
│   │   🟢 LONG    │  │   🔴 SHORT   │                  │
│   └──────────────┘  └──────────────┘                  │
│                                                        │
│   Amount (USDC):                                       │
│   ┌──────────────────────────────────────┐            │
│   │  100                                  │            │
│   └──────────────────────────────────────┘            │
│                                                        │
│   Quick amounts:  [$10] [$50] [$100] [$500]           │
│                                                        │
│   ─────────────────────────────────────────           │
│   Entry Index:        426                              │
│   Estimated Fee:      $0.50 (0.5%)                    │
│   ─────────────────────────────────────────           │
│                                                        │
│   ┌────────────────────────────────────────────────┐  │
│   │          OPEN LONG POSITION — $100              │  │
│   └────────────────────────────────────────────────┘  │
│                                                        │
└──────────────────────────────────────────────────────┘
```

### Behavior

- **Position type toggle**: LONG (green, selected by default) or SHORT (red). Only one active at a time. Clicking one deselects the other.
- **Amount input**: Text field, numbers only. Pre-filled with 100.
- **Quick amount buttons**: Clicking sets the amount field to that value.
- **Fee display**: Always 0.5% of the entered amount. Calculated live as user types.
- **Entry Index**: Shows the current virality score of this capture.
- **Submit button**: Text changes based on position type — "OPEN LONG POSITION — $100" or "OPEN SHORT POSITION — $100". Green background for long, red for short.
- **On submit**: Close the modal, show a confirmation toast, add the position to the mock portfolio.

### Confirmation Toast

After clicking the submit button, show a brief animated toast notification at the top of the dashboard:

```
┌──────────────────────────────────────────────┐
│  ✅ Position Opened                           │
│  LONG Chainsaw Man @ 426  |  $100 USDC       │
└──────────────────────────────────────────────┘
```

- Slide in from the top or fade in
- Auto-dismiss after 3 seconds
- Green border for long, red for short

---

## Part 3: Portfolio Page

Add a new route/page: `/portfolio`

Add navigation to the dashboard header:

```
┌──────────────────────────────────────────────────────┐
│  ATNX                                                 │
│  Attention Exchange                                    │
│                                                        │
│  [📊 Dashboard]  [💰 Portfolio]          [4] Captures  │
└──────────────────────────────────────────────────────┘
```

### Portfolio Page Layout

```
┌──────────────────────────────────────────────────────────┐
│  ATNX Portfolio                                           │
│                                                            │
│  Balance: $10,000.00 USDC                                 │
│  Open Positions: 3                                         │
│  Total PnL: +$847.20 (+8.47%)                             │
│                                                            │
├──────────────────────────────────────────────────────────┤
│                                                            │
│  ┌──────────────────────────────────────────────────────┐│
│  │  🟢 LONG  Chainsaw Man                               ││
│  │                                                        ││
│  │  Entry: 310        Current: 426        Change: +37.4% ││
│  │  Size: $500.00     Value: $687.10      PnL: +$187.10 ││
│  │  Opened: 2h ago                                       ││
│  │                                                        ││
│  │  ┌──────────────────────────────────────────────┐     ││
│  │  │  chart with entry point marker ●              │     ││
│  │  └──────────────────────────────────────────────┘     ││
│  │                                                        ││
│  │                              [ Close Position ]       ││
│  └──────────────────────────────────────────────────────┘│
│                                                            │
│  ┌──────────────────────────────────────────────────────┐│
│  │  🔴 SHORT  Say Wallahi                                ││
│  │                                                        ││
│  │  Entry: 460        Current: 424        Change: -7.8%  ││
│  │  Size: $200.00     Value: $215.60      PnL: +$15.60  ││
│  │  Opened: 45m ago                                      ││
│  │                                  [ Close Position ]   ││
│  └──────────────────────────────────────────────────────┘│
│                                                            │
│  ┌──────────────────────────────────────────────────────┐│
│  │  🟢 LONG  Leon Kennedy One Liners                     ││
│  │                                                        ││
│  │  Entry: 590        Current: 585        Change: -0.8%  ││
│  │  Size: $100.00     Value: $99.15       PnL: -$0.85   ││
│  │  Opened: 15m ago                                      ││
│  │                                  [ Close Position ]   ││
│  └──────────────────────────────────────────────────────┘│
│                                                            │
└──────────────────────────────────────────────────────────┘
```

### Mock Portfolio Data

Store positions in React state (or localStorage for persistence across page reloads). When a user "opens" a position via the trade modal, add it to the portfolio state.

For the demo recording, also pre-populate some positions so the portfolio looks active:

```typescript
const DEMO_POSITIONS = [
  {
    id: 'demo-1',
    type: 'long',
    name: 'Chainsaw Man',
    category: 'entertainment',
    entryIndex: 310,
    currentIndex: 426,
    size: 500,
    openedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),  // 2h ago
  },
  {
    id: 'demo-2',
    type: 'short',
    name: 'Say Wallahi',
    category: 'entertainment',
    entryIndex: 460,
    currentIndex: 424,
    size: 200,
    openedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),  // 45m ago
  },
  {
    id: 'demo-3',
    type: 'long',
    name: 'Leon Kennedy One Liners',
    category: 'entertainment',
    entryIndex: 590,
    currentIndex: 585,
    size: 100,
    openedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),  // 15m ago
  },
];
```

### PnL Calculation

Simple formula for display purposes:

```typescript
function calculatePnL(position) {
  const indexChange = position.currentIndex - position.entryIndex;
  const changePercent = (indexChange / position.entryIndex) * 100;

  // For short positions, PnL is inverted
  const direction = position.type === 'long' ? 1 : -1;
  const pnlPercent = changePercent * direction;
  const pnlAmount = position.size * (pnlPercent / 100);
  const currentValue = position.size + pnlAmount;

  return {
    pnlPercent: pnlPercent.toFixed(2),
    pnlAmount: pnlAmount.toFixed(2),
    currentValue: currentValue.toFixed(2),
    isProfit: pnlAmount >= 0,
  };
}
```

### Close Position

When "Close Position" is clicked:

1. Show a brief confirmation: "Closed LONG Chainsaw Man — Profit: +$187.10"
2. Remove the position from the list with a fade-out animation
3. Update the total PnL and balance at the top

---

## Part 4: Entry Marker on Charts

When a position is open for a capture, show the entry point on that capture's sparkline chart in the dashboard view AND in the portfolio view.

```
  ┌──────────────────────────────────────────┐
  │       ╱╲    ╱╲  ╱╲╱╲                     │
  │  ╱╲ ╱    ╲╱    ╲╱      ╲                 │
  │ ╱  ●                      ╲              │
  │     ↑                                     │
  │   entry point                              │
  └──────────────────────────────────────────┘
```

Implementation:

- On the recharts LineChart, add a ReferenceDot at the data point closest to the entry index value
- Use a green dot for long entries, red dot for short entries
- Optional: add a horizontal ReferenceLine at the entry index level (dashed, subtle)

```tsx
import { ReferenceDot, ReferenceLine } from 'recharts';

// Inside the LineChart:
<ReferenceLine
  y={entryIndex}
  stroke={position.type === 'long' ? '#00FF66' : '#FF0040'}
  strokeDasharray="3 3"
  strokeOpacity={0.5}
/>
<ReferenceDot
  x={entryDataPointIndex}
  y={entryIndex}
  r={4}
  fill={position.type === 'long' ? '#00FF66' : '#FF0040'}
  stroke="none"
/>
```

---

## Part 5: Simulated Live Chart Updates

For the demo recording, make the charts appear to be updating in real time. This creates the feeling of a live market.

### Fake Ticker

Add a `useFakeTicker` hook that periodically appends new data points to the trends chart data:

```typescript
// hooks/useFakeTicker.ts

import { useState, useEffect } from 'react';

export function useFakeTicker(
  initialDataPoints: { date: string; value: number }[],
  enabled: boolean = true
) {
  const [dataPoints, setDataPoints] = useState(initialDataPoints);

  useEffect(() => {
    if (!enabled || initialDataPoints.length === 0) return;

    const interval = setInterval(() => {
      setDataPoints(prev => {
        const lastValue = prev[prev.length - 1]?.value ?? 50;

        // Random walk: small random change from last value
        // Bias slightly upward for more exciting demos
        const change = (Math.random() - 0.45) * 8;
        const newValue = Math.max(0, Math.min(100, lastValue + change));

        const newPoint = {
          date: new Date().toISOString(),
          value: Math.round(newValue),
        };

        // Keep last 168 points (7 days of hourly data), drop oldest
        const updated = [...prev, newPoint];
        if (updated.length > 168) updated.shift();

        return updated;
      });
    }, 3000); // New data point every 3 seconds for demo

    return () => clearInterval(interval);
  }, [enabled, initialDataPoints.length]);

  return dataPoints;
}
```

### Enable with a toggle

Add a small hidden toggle or URL parameter to enable the fake ticker:

- `localhost:3000?demo=true` enables fake live updates
- Or a small "▶ Live" toggle button in the dashboard header

When enabled:
- All sparkline charts start ticking with new data points every 3 seconds
- Virality scores recalculate with each tick
- Portfolio PnL values update as scores change
- The whole dashboard feels alive and dynamic

### Virality Score Live Update

As the fake ticker changes chart values, recalculate and display the updated virality score:

```typescript
// Recalculate score from the updated (fake) data points
// Use the same calculateViralityScore function from Phase 2
// Update the score badge and PnL in real time
```

This means during the demo recording, the user can watch scores tick up and down, PnL change, and charts extend in real time. Very compelling on video.

---

## Part 6: Close Position Profit Screen

When closing a profitable position, show a brief celebratory screen/modal:

```
┌──────────────────────────────────────────────┐
│                                                │
│              🎉 Position Closed                │
│                                                │
│         Chainsaw Man — LONG                    │
│                                                │
│         Entry:    310                          │
│         Exit:     426                          │
│         Change:   +37.4%                       │
│                                                │
│         Size:     $500.00                      │
│         Profit:   +$187.10                     │
│                                                │
│         ██████████████████░░░ +37.4%           │
│                                                │
│              [ Back to Portfolio ]              │
│                                                │
└──────────────────────────────────────────────┘
```

- Green border and accents for profitable close
- Red border for loss
- Show a simple progress/profit bar
- Auto-dismiss after 5 seconds or click to close
- Optional: confetti animation for profits over 20% (use a lightweight library like canvas-confetti or just skip it)

---

## Navigation Structure

```
/                — Dashboard (capture list, sorted by virality)
/portfolio       — Portfolio (open positions, PnL)
```

Header navigation on both pages:

```
ATNX                                              [n] Captures
Attention Exchange
[📊 Dashboard]  [💰 Portfolio]     [▶ Live] (demo toggle)
```

Active page is highlighted in green. Capture count badge always visible.

---

## State Management

For demo purposes, use React Context or simple useState at the app layout level. No need for Redux or external state management.

```typescript
// context/DemoContext.tsx

interface Position {
  id: string;
  type: 'long' | 'short';
  name: string;
  category: string;
  entryIndex: number;
  currentIndex: number;
  size: number;
  openedAt: string;
  captureId: string;  // links back to the capture
}

interface DemoState {
  positions: Position[];
  balance: number;          // Starting: 10000
  isLiveMode: boolean;      // Fake ticker enabled
}
```

Store in localStorage so it persists across page reloads during the recording session. Pre-populate with DEMO_POSITIONS on first load.

---

## Implementation Priority

1. **Trade modal** — the core UI for placing a simulated trade
2. **Portfolio page** — display mock positions with PnL
3. **State management** — context/localStorage for positions and balance
4. **Navigation** — header links between dashboard and portfolio
5. **Confirmation toast** — feedback when opening a position
6. **Close position flow** — with profit/loss screen
7. **Entry markers on charts** — ReferenceDot on sparklines
8. **Fake ticker** — simulated live chart updates
9. **Demo toggle** — URL param or button to enable live mode
10. **Polish** — animations, transitions, colors

---

## Styling Notes

- Keep all existing ATNX styling: dark background (#0D0D1A), green accents (#00FF66), monospace font
- Profit = green (#00FF66)
- Loss = red (#FF0040)
- Neutral = gray (#888888)
- Modal backdrop: rgba(0, 0, 0, 0.7) with blur if possible
- All numbers in monospace font for that terminal/exchange feel
- Subtle animations: fade in cards, slide in toasts, pulse on score changes

---

## Important Notes

- **This is NOT real trading.** No blockchain, no smart contracts, no real money. It is a UI simulation for a demo video. Make sure there is no confusion in the code — name variables and components with "mock" or "demo" prefixes where appropriate.
- **Pre-populated data is key.** The demo will look better with some positions already open when the recording starts. Make sure DEMO_POSITIONS load on first visit.
- **The fake ticker should be smooth.** Janky or jumpy updates look bad on video. Use CSS transitions on score numbers and smooth chart animations.
- **Keep the trade modal simple.** Don't over-engineer with leverage, order types, slippage settings etc. Just long/short, amount, and submit. This is an MVP demo.

---

## Demo Recording Script (for reference)

The intended flow for the demo video:

1. Open browser, show YouTube/Twitter with trending content
2. Press Ctrl+Shift+X, drag selection over a trending meme
3. Switch to ATNX dashboard — new entry appears with virality score
4. Click "Trade This" on the entry
5. Select LONG, enter $500, click submit
6. Toast confirms position opened
7. Navigate to Portfolio — new position visible alongside pre-populated ones
8. Enable live mode — charts start ticking, scores updating
9. Watch PnL change in real time as virality updates
10. Close the profitable pre-populated position (Chainsaw Man)
11. Profit screen shows +37.4% gain
12. End on the dashboard with multiple active markets, live updating

Total demo time: ~60-90 seconds

---

## Success Criteria

The build is done when:

1. ✅ Each capture card has a "Trade This" button
2. ✅ Clicking "Trade This" opens a trade modal with long/short toggle and amount input
3. ✅ Submitting a trade shows a confirmation toast and adds to portfolio
4. ✅ Portfolio page shows all open positions with calculated PnL
5. ✅ PnL is color-coded green for profit, red for loss
6. ✅ Closing a position shows a profit/loss summary screen
7. ✅ Charts show entry point markers for open positions
8. ✅ Live demo mode makes charts tick with simulated data updates
9. ✅ Virality scores and PnL update in real time during live mode
10. ✅ Navigation between Dashboard and Portfolio works smoothly
11. ✅ Pre-populated demo positions load on first visit
