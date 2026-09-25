// BigQuery over REST with a service account, for GDELT's public GKG table.
// No SDK: a JWT signed with the account's key is exchanged for an access
// token, and queries go to jobs.query. Every job carries a bytes cap, so a
// bad query fails instead of spending the month's free terabyte (the
// project is a sandbox, which also caps it hard at 1 TiB/month).
import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://bigquery.googleapis.com/bigquery/v2';
const SCOPE = 'https://www.googleapis.com/auth/bigquery';
export const DEFAULT_MAX_BYTES = 10 * 1024 ** 3;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

let token: { value: string; expires: number } | null = null;

export function bigqueryConfigured(): boolean {
  return !!process.env.GCP_SA_KEY_B64;
}

function account(): ServiceAccount {
  const raw = process.env.GCP_SA_KEY_B64;
  if (!raw) throw new Error('GCP_SA_KEY_B64 is not set');
  return JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8')) as ServiceAccount;
}

export function projectId(): string {
  return account().project_id;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

async function accessToken(): Promise<string> {
  if (token && Date.now() < token.expires - 60_000) return token.value;
  const sa = account();
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${b64url(signature)}` }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return token.value;
}

export type QueryParam = { name: string; type: 'STRING' | 'INT64' | 'TIMESTAMP' | 'DATE'; value: string | number } | { name: string; type: 'ARRAY<STRING>'; value: string[] };

export interface QueryResult {
  rows: Record<string, string | null>[];
  bytesProcessed: number;
  bytesBilled: number;
  cacheHit: boolean;
}

function toApiParam(p: QueryParam) {
  if (p.type === 'ARRAY<STRING>') {
    return { name: p.name, parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } }, parameterValue: { arrayValues: p.value.map((v) => ({ value: v })) } };
  }
  return { name: p.name, parameterType: { type: p.type }, parameterValue: { value: String(p.value) } };
}

// Runs a standard-SQL query and waits for it. A dry run returns no rows,
// only what the query would scan (free).
export async function query(sql: string, { params = [], dryRun = false, maxBytes = DEFAULT_MAX_BYTES, timeoutMs = 120_000 }: { params?: QueryParam[]; dryRun?: boolean; maxBytes?: number; timeoutMs?: number } = {}): Promise<QueryResult> {
  const auth = { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' };
  const res = await fetch(`${API}/projects/${projectId()}/queries`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      query: sql,
      useLegacySql: false,
      dryRun,
      maximumBytesBilled: String(maxBytes),
      timeoutMs: Math.min(timeoutMs, 60_000),
      parameterMode: 'NAMED',
      queryParameters: params.map(toApiParam),
    }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`query ${res.status}: ${(await res.text()).slice(0, 300)}`);
  type Page = {
    jobComplete?: boolean;
    jobReference?: { jobId: string; location?: string };
    schema?: { fields: { name: string }[] };
    rows?: { f: { v: string | null }[] }[];
    pageToken?: string;
    totalBytesProcessed?: string;
    totalBytesBilled?: string;
    cacheHit?: boolean;
  };
  let page = (await res.json()) as Page;
  const started = Date.now();
  const rows: Record<string, string | null>[] = [];
  const bytesProcessed = Number(page.totalBytesProcessed ?? 0);
  if (dryRun) return { rows, bytesProcessed, bytesBilled: 0, cacheHit: false };
  const job = page.jobReference!;
  const more = async (pageToken?: string) => {
    const qs = new URLSearchParams({ timeoutMs: '30000', ...(job.location ? { location: job.location } : {}), ...(pageToken ? { pageToken } : {}) });
    const r = await fetch(`${API}/projects/${projectId()}/queries/${job.jobId}?${qs}`, { headers: auth, cache: 'no-store' });
    if (!r.ok) throw new Error(`getQueryResults ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()) as Page;
  };
  while (!page.jobComplete) {
    if (Date.now() - started > timeoutMs) throw new Error(`query timed out after ${timeoutMs} ms (job ${job.jobId})`);
    page = await more();
  }
  const bytesBilled = Number(page.totalBytesBilled ?? 0);
  const fields = page.schema?.fields.map((f) => f.name) ?? [];
  for (;;) {
    for (const r of page.rows ?? []) rows.push(Object.fromEntries(fields.map((f, i) => [f, r.f[i]?.v ?? null])));
    if (!page.pageToken) break;
    page = await more(page.pageToken);
  }
  return { rows, bytesProcessed: Number(page.totalBytesProcessed ?? bytesProcessed), bytesBilled, cacheHit: !!page.cacheHit };
}
