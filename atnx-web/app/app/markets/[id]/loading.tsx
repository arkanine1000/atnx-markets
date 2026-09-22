// Market page skeleton: back link, title block, chart, trade panel.
export default function MarketLoading() {
  return (
    <div aria-busy="true" aria-label="Loading market" className="animate-pulse">
      <div className="h-3 w-16 rounded bg-surface mb-4" />
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] gap-4">
        <div>
          <div className="h-4 w-24 rounded bg-surface" />
          <div className="h-8 w-2/3 rounded bg-surface mt-3" />
          <div className="h-12 w-32 rounded bg-surface mt-4" />
          <div className="h-[280px] rounded-2xl bg-surface border border-surface mt-6" />
        </div>
        <div className="h-[420px] rounded-2xl bg-surface border border-surface" />
      </div>
    </div>
  );
}
