// Shown under the header while a page in /app fetches on the server, so a
// navigation responds instantly with the page's shape instead of a pause.
// Sized to the markets page; the other pages are quick and only flash it.
export default function AppLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="animate-pulse">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:h-[400px] gap-4 mb-8">
        <div className="rounded-2xl bg-surface border border-surface min-h-[260px]" />
        <div className="rounded-2xl bg-surface border border-surface min-h-[260px] hidden lg:block" />
      </div>
      <div className="flex items-end justify-between gap-3 mb-4">
        <div>
          <div className="h-6 w-36 rounded bg-surface" />
          <div className="h-3 w-52 rounded bg-surface mt-2" />
        </div>
        <div className="h-9 w-56 rounded-full bg-surface" />
      </div>
      <div className="grid grid-cols-1 xs:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="rounded-2xl bg-surface border border-surface overflow-hidden">
            <div className="aspect-[16/11] bg-elevated" />
            <div className="p-3">
              <div className="h-4 w-3/4 rounded bg-elevated" />
              <div className="h-3 w-1/2 rounded bg-elevated mt-2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
