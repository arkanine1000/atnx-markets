import type { Metadata } from "next";
import Link from "next/link";
import { LegalSection as Section } from "@/components/LegalSection";

export const metadata: Metadata = {
  title: "Privacy Policy — ATNX",
  description:
    "What the ATNX web app and the ATNX Capture Chrome extension collect, why, and how to delete it.",
};

const UPDATED = "September 25, 2026";

export default function PrivacyPage() {
  return (
    <main className="max-w-2xl mx-auto px-5 py-12 w-full">
      <Link href="/" className="text-xs text-atnx-cyan hover:underline">
        ← atnx.app
      </Link>

      <h1 className="font-display mt-6 text-2xl font-bold text-primary">Privacy Policy</h1>
      <p className="mt-1 text-xs text-tertiary">Last updated {UPDATED}</p>

      <p className="mt-6 text-sm text-secondary leading-relaxed">
        This policy covers the ATNX web app at atnx.app and the ATNX Capture
        Chrome extension. ATNX, based in Rijeka, Croatia, is the controller of
        the personal data described here. In short: the extension sends only the region of the
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
          your browsing history, and requests access only to atnx.app. (ATNX
          staff can point it at a local development copy of ATNX; Chrome asks
          them to grant access to that one local address.)
        </p>
      </Section>

      <Section title="What we do with it">
        <ul className="list-disc pl-5 space-y-2">
          <li>
            The screenshot is analyzed by an AI vision model (Gemini, by
            Google) to identify the subject and extract visible text and
            metrics. Google processes the image to return that analysis and,
            under its paid API terms, does not use it to train its models.
          </li>
          <li>
            The screenshot, its analysis, and the source URL are stored with
            your account and shown on the market it belongs to. Markets and
            their captures are visible to other ATNX users.
          </li>
          <li>
            Market names are looked up against public and third-party sources
            (such as Google Trends, Wikipedia, YouTube, Bluesky, Hacker News,
            GDELT, and X and TikTok through data providers) to compute the
            Virality Index. Only the market name is sent; your identity is not.
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
          You sign in with Google or X, through our authentication provider
          Supabase. The sign-in provider shares your account ID and the basic
          profile it makes available (name, username, profile picture, and your
          email address if you have one and allow it); we keep these in our
          authentication records and do not show them to other users.
        </p>
        <p>
          We also store the handle shown on your profile and the markets and
          captures you submit. Your handle and submissions are visible to
          other users. Trades use testnet tokens that have no value (mock
          USDG) and are made from your own wallet on a public blockchain,
          where anyone can see them.
        </p>
      </Section>

      <Section title="Waitlist">
        <p>
          If you join the waitlist, we store the email address you enter and
          use it only to tell you about ATNX access. Ask us and we will remove
          it.
        </p>
      </Section>

      <Section title="Cookies">
        <p>
          We use only the cookies needed to keep you signed in. We use no
          advertising or analytics cookies.
        </p>
      </Section>

      <Section title="Who processes your data">
        <ul className="list-disc pl-5 space-y-2">
          <li>Supabase: database, file storage and sign-in.</li>
          <li>Vercel: hosting, and routing requests to AI models.</li>
          <li>Google (Gemini): AI analysis of captures and submissions.</li>
          <li>Google and X: only when you choose them to sign in.</li>
        </ul>
        <p>
          Some of these providers process data outside the EU. Where they do,
          the transfer relies on safeguards recognised under the GDPR, such as
          the EU Standard Contractual Clauses.
        </p>
      </Section>

      <Section title="Why we are allowed to">
        <ul className="list-disc pl-5 space-y-2">
          <li>
            To run your account and the features you use: because it is
            necessary to provide the service you signed up for.
          </li>
          <li>
            To keep ATNX secure and prevent abuse, such as rate limiting by IP
            address: our legitimate interest in running a safe service.
          </li>
          <li>The waitlist: your consent, which you can withdraw at any time.</li>
        </ul>
      </Section>

      <Section title="Your rights">
        <p>
          You can ask for a copy of your data, and ask us to correct, delete or
          export it, or to restrict or stop processing it. You can also complain
          to a data protection authority; in Croatia that is the Personal Data
          Protection Agency (AZOP, azop.hr).
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
          from the address on your account. If your account has no email
          address (possible when signing in with X), include your handle and we
          will confirm it is you through the account before acting. Uninstalling
          the extension removes its local settings immediately.
        </p>
      </Section>

      <Section title="Age">
        <p>ATNX is for people aged 18 and over.</p>
      </Section>

      <Section title="Changes">
        <p>
          If this policy changes in a way that affects what is collected, the
          date above will change and the extension&apos;s store listing will
          link to the new version. See also our{" "}
          <Link href="/terms" className="text-atnx-cyan hover:underline">
            Terms of Service
          </Link>
          .
        </p>
      </Section>
    </main>
  );
}
