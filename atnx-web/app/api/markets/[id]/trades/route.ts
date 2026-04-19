import { NextResponse } from 'next/server';
import { getMarketTradeLog } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const events = await getMarketTradeLog(id);
    return NextResponse.json({ events });
  } catch (err) {
    console.error('[markets/[id]/trades GET] failed', err);
    return NextResponse.json(
      { events: [], error: (err as Error).message },
      { status: 500 }
    );
  }
}
