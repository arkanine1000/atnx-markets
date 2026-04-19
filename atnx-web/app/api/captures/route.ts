import { addCapture, getCaptures, type Capture } from '@/lib/store';
import { normalizeSearchTerm } from '@/lib/trends';
import { composeVi } from '@/lib/signals';
import { createClient } from '@/lib/supabase/server';
import { analyzeScreenshot, type VisionMediaType } from '@/lib/claude-vision';

// CORS with credentials requires echoing the caller's Origin (not `*`) so the
// Chrome extension's auth cookie is accepted on cross-origin requests.
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

const SUPPORTED_MEDIA: VisionMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

function toMediaType(mime: string): VisionMediaType {
  const normalized = (mime || '').toLowerCase() as VisionMediaType;
  return SUPPORTED_MEDIA.includes(normalized) ? normalized : 'image/png';
}

export async function POST(request: Request) {
  const headers = corsHeaders(request);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json(
      { success: false, error: 'Not signed in' },
      { status: 401, headers }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { success: false, error: 'Expected multipart/form-data' },
      { status: 400, headers }
    );
  }

  const image = form.get('image');
  if (!(image instanceof File) || image.size === 0) {
    return Response.json(
      { success: false, error: 'image field is required (File)' },
      { status: 400, headers }
    );
  }

  const sourceUrl = (form.get('sourceUrl') as string | null) ?? undefined;
  const pageTitle = (form.get('pageTitle') as string | null) ?? undefined;
  const pageContext = (form.get('pageContext') as string | null) ?? undefined;

  const mediaType = toMediaType(image.type);
  const buffer = Buffer.from(await image.arrayBuffer());
  const imageBase64 = buffer.toString('base64');

  try {
    const analysis = await analyzeScreenshot({
      imageBase64,
      mediaType,
      sourceUrl,
      pageTitle,
      pageContext,
    });

    const searchTerm = normalizeSearchTerm(analysis);
    const signal = await composeVi({ term: searchTerm, analysis });

    const input: Capture = {
      id: crypto.randomUUID(),
      marketId: null,
      timestamp: new Date().toISOString(),
      pageUrl: sourceUrl ?? '',
      pageTitle: pageTitle ?? '',
      screenshot: imageBase64,
      analysis,
      trends: signal.trends,
      viralityScore: signal.score,
    };

    const { capture, isNew } = await addCapture(input, supabase, user.id);

    return Response.json(
      {
        success: true,
        marketId: capture.marketId,
        isNew,
        vi: signal.score,
        source: signal.source,
      },
      { headers }
    );
  } catch (err) {
    console.error('[captures POST] failed', err);
    return Response.json(
      { success: false, error: (err as Error).message },
      { status: 500, headers }
    );
  }
}

export async function GET(request: Request) {
  const headers = corsHeaders(request);
  try {
    const captures = await getCaptures();
    return Response.json({ captures }, { headers });
  } catch (err) {
    console.error('[captures GET] failed to load', err);
    return Response.json(
      { captures: [], error: (err as Error).message },
      { status: 500, headers }
    );
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
