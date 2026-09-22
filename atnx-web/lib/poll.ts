// Polling for client components, in one place so every poller behaves the
// same way:
//
// - runs `tick` every `intervalMs` while the document is visible and not
//   at all while it is hidden, catching up when it comes back only if the
//   last run is older than an interval (a user flicking between tabs is
//   not a reason to fetch on every flick);
// - never overlaps runs;
// - backs off while ticks fail, doubling the wait up to `maxIntervalMs`,
//   so an outage upstream turns into a slow trickle rather than a storm
//   of retries that keeps the outage going;
// - does not run at start unless asked: the callers render server-fetched
//   data on mount, and fetching the same thing again in the same second
//   was the "identical pairs" in the edge logs.
//
// `tick` reports failure by throwing (a non-OK response counts: check
// `res.ok` and throw). Returns the stop function for the effect cleanup.

export interface PollOptions {
  intervalMs: number;
  // Default ten intervals.
  maxIntervalMs?: number;
  // Run once as soon as polling starts.
  immediate?: boolean;
}

export function startPolling(tick: () => Promise<unknown>, opts: PollOptions): () => void {
  const base = opts.intervalMs;
  const max = opts.maxIntervalMs ?? base * 10;
  let delay = base;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;
  let lastRun = opts.immediate ? 0 : Date.now();

  function clear() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function arm(wait: number) {
    clear();
    if (stopped || document.visibilityState !== 'visible') return;
    timer = setTimeout(run, wait);
  }

  async function run() {
    if (stopped || running) return;
    running = true;
    lastRun = Date.now();
    let ok = true;
    try {
      await tick();
    } catch {
      ok = false;
    } finally {
      running = false;
    }
    delay = ok ? base : Math.min(max, delay * 2);
    arm(delay);
  }

  function onVisibility() {
    if (document.visibilityState !== 'visible') {
      clear();
      return;
    }
    const due = lastRun + delay - Date.now();
    if (due <= 0) run();
    else arm(due);
  }

  document.addEventListener('visibilitychange', onVisibility);
  if (opts.immediate) run();
  else arm(delay);

  return () => {
    stopped = true;
    clear();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
