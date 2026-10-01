// The on-chain portfolio replaces the simulated one; this page lists a
// wallet's UP and DOWN shares per market once that view is built.
export default function PortfolioPage() {
  return (
    <section>
      <div className="mb-5">
        <h2 className="font-display text-xl sm:text-2xl font-bold text-primary tracking-tight">
          Portfolio
        </h2>
      </div>
      <p className="text-sm text-secondary">
        Your UP and DOWN shares live in your wallet. Connect it on a market
        page to trade; this page will list them per market.
      </p>
    </section>
  );
}
