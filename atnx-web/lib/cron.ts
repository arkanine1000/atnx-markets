// Vercel calls a cron route with `Authorization: Bearer $CRON_SECRET` when
// the project has that variable set. Nothing else may trigger the keeper.
export function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  return !!secret && auth === `Bearer ${secret}`;
}
