// Re-mounts on every navigation (unlike layout.tsx), which is what gives
// the incoming page its short fade. The header above it stays put.
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return <div className="animate-page-in">{children}</div>;
}
