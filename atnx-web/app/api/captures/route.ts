import { getCaptures } from '@/lib/store';
import { processCapture, toMediaType } from '@/lib/capture';
import { createClient } from '@/lib/supabase/server';
import { corsHeaders, corsPreflight } from '@/lib/cors';

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
    const result = await processCapture({
      imageBase64,
      mediaType,
      sourceUrl,
      pageTitle,
      pageContext,
      supabase,
      userId: user.id,
    });

    return Response.json(
      {
        success: true,
        marketId: result.marketId,
        entityName: result.entityName,
        isNew: result.isNew,
        vi: result.vi,
        source: result.source,
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
  return corsPreflight(request);
}
