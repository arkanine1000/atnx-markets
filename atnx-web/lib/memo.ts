// A small in-process memo for reads that many callers repeat within a few
// seconds: the feed the dashboard tabs and the extension all poll, for
// one. A hit inside the TTL is answered from memory; a miss while the same
// key is already loading joins that load rather than starting another. So
// three tabs polling the same feed cost one database read per window per
// server instance, not three, and a burst of identical requests cannot
// fan out into a burst of identical queries.
//
// Per instance only: serverless deployments run several, and each keeps
// its own copy. That is still the whole win for the bursts this exists
// for, which land on the same instance.

type Entry = { value: unknown; expires: number };

const values = new Map<string, Entry>();
const inFlight = new Map<string, Promise<unknown>>();

export function memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = values.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value as T);

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const p = load()
    .then((value) => {
      values.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, p);
  return p;
}

// Drop a cached value so the next caller reads fresh (after a write the
// reader should see straight away).
export function forget(key: string): void {
  values.delete(key);
}

// Drop every cached value under a key prefix: the paged market listings
// after a write, where the page a reader lands on is not known in advance.
export function forgetPrefix(prefix: string): void {
  for (const key of values.keys()) {
    if (key.startsWith(prefix)) values.delete(key);
  }
}
