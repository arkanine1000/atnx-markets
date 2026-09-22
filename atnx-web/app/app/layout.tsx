import { Nav } from "@/components/Nav";

// One shell for every /app route: the same container width and the same
// header on Markets, Create, Portfolio, market detail and settings. Pages
// used to mount their own <Nav /> inside their own wrapper, so a narrow
// page shrank the header and every navigation re-mounted it. A layout
// keeps it in place across navigations; only the page below swaps.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    // Extra bottom padding on phones clears the fixed bottom bar.
    <div className="max-w-6xl mx-auto px-4 pb-24 sm:pb-12 w-full">
      <Nav />
      {children}
    </div>
  );
}
