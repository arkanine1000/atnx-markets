import { DotMatrixLogo } from "@/components/DotMatrixLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LaunchAppButton } from "@/components/LaunchAppButton";
import { WaitlistButton } from "@/components/WaitlistButton";

export default function LandingPage() {
  return (
    <main className="min-h-[100svh] flex flex-col items-center justify-center px-5 py-16 text-center">
      <div className="fixed top-6 right-6 z-50">
        <ThemeToggle />
      </div>

      <DotMatrixLogo />

      <p className="mt-10 text-xl md:text-2xl font-display font-semibold text-secondary tracking-[0.02em]">
        The Attention Economy Exchange
      </p>
      <p className="mt-2 text-sm font-mono text-tertiary">
        Trade Attention, Not Tokens
      </p>

      <div className="mt-10 flex flex-col sm:flex-row gap-4">
        <WaitlistButton />
        <LaunchAppButton />
        {/* Docs are not published yet: shown greyed out, not a link. Make it
            an <a> to the public docs URL once they are deployed. */}
        <span
          aria-disabled="true"
          title="Docs are coming soon"
          className="inline-flex items-center justify-center gap-2 px-8 py-3 rounded-lg border border-atnx-yellow/35 bg-atnx-yellow/5 text-atnx-yellow/55 font-semibold cursor-not-allowed select-none light:border-atnx-yellow-light/50 light:bg-atnx-yellow/15 light:text-black/45"
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
          <span className="ml-1 rounded-full border border-current px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider leading-none">
            Soon
          </span>
        </span>
      </div>
    </main>
  );
}
