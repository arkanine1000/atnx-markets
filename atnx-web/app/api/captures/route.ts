import { addCapture, getCaptures, type Capture } from '@/lib/store';

export async function POST(request: Request) {
  const data = await request.json();

  const capture: Capture = {
    id: data.id || Date.now().toString(),
    timestamp: data.timestamp || new Date().toISOString(),
    pageUrl: data.pageUrl,
    pageTitle: data.pageTitle,
    screenshot: data.screenshot,
    analysis: data.analysis,
  };

  addCapture(capture);

  return Response.json({ success: true, id: capture.id }, {
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function GET() {
  return Response.json({ captures: getCaptures() }, {
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
