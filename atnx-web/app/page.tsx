import { DotMatrixLogo } from "@/components/DotMatrixLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LaunchAppButton } from "@/components/LaunchAppButton";

// In-house testing target for the docs site; swap for the public docs URL
// once it's deployed.
const DOCS_URL = "http://localhost:3001/";

export default function LandingPage() {
  return (
    <main className="min-h-[100svh] flex flex-col items-center justify-center px-5 py-16 text-center">
      <div className="fixed top-6 right-6 z-50">
        <ThemeToggle />
      </div>

      <DotMatrixLogo />

      <p className="mt-10 text-xl md:text-2xl font-sans text-secondary tracking-[0.05em]">
        Trade Attention, Not Tokens
      </p>
      <p className="mt-2 text-sm font-mono text-tertiary">
        The Attention Economy Exchange
      </p>

      <div className="mt-10 flex flex-col sm:flex-row gap-4">
        <button
          type="button"
          className="px-8 py-3 rounded-lg border border-atnx-cyan text-atnx-cyan font-mono cursor-pointer transition-colors hover:bg-atnx-cyan hover:text-black light:border-atnx-cyan-light light:bg-atnx-cyan/15 light:text-black light:hover:bg-atnx-cyan"
        >
          Join Waitlist
        </button>
        <LaunchAppButton />
        <a
          href={DOCS_URL}
          className="inline-flex items-center justify-center gap-2 px-8 py-3 rounded-lg border border-atnx-yellow text-atnx-yellow font-mono transition-colors hover:bg-atnx-yellow hover:text-black light:border-atnx-yellow-light light:bg-atnx-yellow/25 light:text-black light:hover:bg-atnx-yellow"
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5" />
            <path d="M9 13h6M9 17h6" />
          </svg>
          Read Docs
        </a>
      </div>
    </main>
  );
}
