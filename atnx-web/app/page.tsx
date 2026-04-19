import { DotMatrixLogo } from "@/components/DotMatrixLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LaunchAppButton } from "@/components/LaunchAppButton";

export default function LandingPage() {
  return (
    <main className="h-screen w-screen flex flex-col items-center justify-center overflow-hidden relative">
      {/* Theme toggle — fixed top right */}
      <div className="fixed top-6 right-6 z-50">
        <ThemeToggle />
      </div>

      {/* Dot matrix logo */}
      <DotMatrixLogo />

      {/* Tagline */}
      <p className="mt-10 text-xl md:text-2xl font-sans text-secondary tracking-[0.05em]">
        Trade Attention, Not Tokens
      </p>

      {/* Subtitle */}
      <p className="mt-2 text-sm font-mono text-tertiary">
        The Attention Economy Exchange
      </p>

      {/* CTA Buttons */}
      <div className="mt-10 flex flex-col sm:flex-row gap-4">
        <button
          className="px-8 py-3 rounded-lg border border-atnx-cyan text-atnx-cyan font-mono cursor-pointer transition-colors hover:bg-atnx-cyan hover:text-black"
        >
          Join Waitlist
        </button>
        <LaunchAppButton />
      </div>
    </main>
  );
}
