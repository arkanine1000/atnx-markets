// A titled block of body copy for the legal pages (/privacy, /terms).
export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-bold uppercase tracking-wider text-primary">{title}</h2>
      <div className="mt-3 text-sm text-secondary leading-relaxed space-y-3">{children}</div>
    </section>
  );
}
