'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import {
  closePositionFor,
  openPositionFor,
  type ClosePositionResult,
  type OpenPositionInput,
  type OpenPositionResult,
} from '@/lib/trading';

// The site's own trade entry points. The checks and the database calls
// live in lib/trading.ts, shared with the /api/positions routes the
// extension calls; this file only adds the page revalidation.

export async function openPosition(
  input: OpenPositionInput
): Promise<OpenPositionResult> {
  const supabase = await createClient();
  const result = await openPositionFor(supabase, input);
  if (result.success) {
    revalidatePath('/app');
    revalidatePath('/app/portfolio');
  }
  return result;
}

export async function closePosition(
  positionId: string
): Promise<ClosePositionResult> {
  const supabase = await createClient();
  const result = await closePositionFor(supabase, positionId);
  if (result.success) {
    revalidatePath('/app');
    revalidatePath('/app/portfolio');
  }
  return result;
}
