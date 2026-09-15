import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — ATNX",
  description:
    "What the ATNX web app and the ATNX Capture Chrome extension collect, why, and how to delete it.",
};

const UPDATED = "September 15, 2026";

export default function PrivacyPage() {
  return (
    <main className="max-w-2xl mx-auto px-5 py-12 w-full">
      <Link href="/" className="text-xs text-atnx-cyan hover:underline">
        ← atnx.app
      </Link>

      <h1 className="mt-6 text-2xl font-bold text-primary">Privacy Policy</h1>
      <p className="mt-1 text-xs text-tertiary">Last updated {UPDATED}</p>

      <p className="mt-6 text-sm text-secondary leading-relaxed">
        This policy covers the ATNX web app at atnx.app and the ATNX Capture
        Chrome extension. In short: the extension sends only the region of the
        page you deliberately select, we use it to identify the content and
        create or update a market, and you can delete everything by contacting
        us.
      </p>

      <Section title="What the extension collects">
        <ul className="list-disc pl-5 space-y-2">
          <li>
            <strong className="text-primary">The screenshot you select.</strong>{" "}
            When you press the capture shortcut or button and drag a box, the
            pixels inside that box are sent to atnx.app. Nothing outside the
            box, and nothing on pages where you do not capture.
          </li>
          <li>
            <strong className="text-primary">The page URL and title</strong> of
            the tab you captured from, so the market can link back to its
            source.
          </li>
          <li>
            <strong className="text-primary">Your ATNX sign-in cookie</strong>,
            sent with each capture so it is attributed to your account. The
            extension never sees your password and stores no credentials.
          </li>
          <li>
            <strong className="text-primary">Local settings</strong> kept in
            your browser only: the web app URL, whether the portfolio card is
            expanded, and the last capture status.
          </li>
        </ul>
        <p>
          The extension does not run on pages in the background, does not read
          your browsing history, and requests access only to atnx.app. If you
          point it at a self-hosted ATNX instance, Chrome asks you to grant
          access to that one site.
        </p>
      </Section>

      <Section title="What we do with it">
        <ul className="list-disc pl-5 space-y-2">
          <li>
            The screenshot is analyzed by an AI vision model (Claude, by
            Anthropic) to identify the subject and extract visible text and
            metrics. Anthropic processes the image to return that analysis and
            does not use API inputs to train its models.
          </li>
          <li>
            The screenshot, its analysis, and the source URL are stored with
            your account and shown on the market it belongs to. Markets and
            their captures are visible to other ATNX users.
          </li>
          <li>
            Market names are looked up against public sources (Google Trends
            and Wikipedia) to compute the Virality Index. Your identity is not
            sent to those services.
          </li>
        </ul>
      </Section>

      <Section title="What we do not do">
        <ul className="list-disc pl-5 space-y-2">
          <li>We do not sell or rent your data.</li>
          <li>We do not use it for advertising.</li>
          <li>
            We do not use it for purposes unrelated to running ATNX, and we do
            not use it to determine creditworthiness or for lending.
          </li>
        </ul>
      </Section>

      <Section title="Accounts">
        <p>
          Signing in uses Google OAuth through Supabase. We store your email,
          the handle you choose, and your simulated trading balance and
          positions. Simulated trades involve no real money.
        </p>
      </Section>

      <Section title="Retention and deletion">
        <p>
          Captures and account data are kept until you delete them. To delete a
          capture, a market you created, or your entire account and all
          associated data, email{" "}
          <a href="mailto:privacy@atnx.app" className="text-atnx-cyan hover:underline">
            privacy@atnx.app
          </a>{" "}
          from the address on your account. Uninstalling the extension removes
          its local settings immediately.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          If this policy changes in a way that affects what is collected, the
          date above will change and the extension&apos;s store listing will
          link to the new version.
        </p>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-bold uppercase tracking-wider text-primary">{title}</h2>
      <div className="mt-3 text-sm text-secondary leading-relaxed space-y-3">{children}</div>
    </section>
  );
}
