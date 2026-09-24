import type { Metadata } from "next";
import Link from "next/link";
import { LegalSection as Section } from "@/components/LegalSection";

export const metadata: Metadata = {
  title: "Terms of Service — ATNX",
  description: "The rules for using ATNX, its simulated markets and the ATNX Capture extension.",
};

const UPDATED = "September 24, 2026";
const CONTACT = "hello@atnx.app";

export default function TermsPage() {
  return (
    <main className="max-w-2xl mx-auto px-5 py-12 w-full">
      <Link href="/" className="text-xs text-atnx-cyan hover:underline">
        ← atnx.app
      </Link>

      <h1 className="font-display mt-6 text-2xl font-bold text-primary">Terms of Service</h1>
      <p className="mt-1 text-xs text-tertiary">Last updated {UPDATED}</p>

      <p className="mt-6 text-sm text-secondary leading-relaxed">
        These terms are an agreement between you and ATNX, based in Rijeka,
        Croatia (&quot;ATNX&quot;, &quot;we&quot;). They cover the web app at
        atnx.app and the ATNX Capture Chrome extension (together, the
        &quot;Service&quot;). By signing in or using the Service you accept
        them. Our{" "}
        <Link href="/privacy" className="text-atnx-cyan hover:underline">
          Privacy Policy
        </Link>{" "}
        explains what we collect and why.
      </p>

      <Section title="Who can use ATNX">
        <p>
          You must be at least 18 years old and able to enter a binding
          contract. You may hold one account. You sign in with Google or X, and
          you are responsible for what happens under your account and for
          keeping access to that sign-in account secure.
        </p>
      </Section>

      <Section title="Simulated trading, no real money">
        <ul className="list-disc pl-5 space-y-2">
          <li>
            Balances, positions, prices and winnings on ATNX are simulated.
            They have no monetary value, cannot be bought, sold, withdrawn or
            exchanged for money, tokens or anything else, and are not your
            property.
          </li>
          <li>
            We may adjust, reset or remove simulated balances and positions,
            for example to fix errors, reverse abuse, or start a new season.
          </li>
          <li>
            ATNX is not a financial service, exchange, broker or gambling
            service. Nothing on the Service is financial, investment or other
            professional advice.
          </li>
        </ul>
      </Section>

      <Section title="Markets and the Virality Index">
        <p>
          Market prices follow the Virality Index, which we compute from public
          and third-party data sources. Those sources can be incomplete, late or
          wrong, and so can the Index. We may create, rename, merge, pause,
          resolve or remove markets, and correct prices or trades that resulted
          from errors or abuse.
        </p>
      </Section>

      <Section title="What you submit">
        <ul className="list-disc pl-5 space-y-2">
          <li>
            When you submit a link, screenshot or capture, you keep whatever
            rights you have in it. You give ATNX a worldwide, non-exclusive,
            royalty-free licence to store, analyse (including with AI models),
            reproduce and display it on the Service for as long as it is there,
            and to adapt it as needed to do so (for example cropping or
            resizing).
          </li>
          <li>
            Submissions and the markets built from them are visible to other
            users. Only submit material you have the right to share.
          </li>
          <li>
            We may review, edit, refuse or remove any submission or market.
          </li>
        </ul>
      </Section>

      <Section title="What you must not do">
        <ul className="list-disc pl-5 space-y-2">
          <li>Break the law, or infringe anyone&apos;s intellectual property, privacy or other rights.</li>
          <li>
            Submit content that is sexual content involving minors, hateful,
            harassing, threatening, or that exposes a private person&apos;s
            personal information.
          </li>
          <li>
            Manipulate markets, the Virality Index or the leaderboard, including
            by running several accounts or coordinating with others to do so.
          </li>
          <li>
            Scrape the Service, use bots or automation other than the ATNX
            Capture extension, get around rate limits, or interfere with the
            Service&apos;s security or operation.
          </li>
          <li>Impersonate anyone, or choose a handle that is offensive or misleading.</li>
        </ul>
      </Section>

      <Section title="Suspension and closing your account">
        <p>
          We may suspend or close an account that breaks these terms, or when
          the law requires it. You can stop using ATNX at any time and ask us to
          delete your account as described in the Privacy Policy. Simulated
          balances end with the account.
        </p>
      </Section>

      <Section title="Our service">
        <p>
          ATNX is in active development. Features may change, break or be
          discontinued, and the Service may be unavailable at times. The ATNX
          name, logo, software and design belong to us. These terms do not give
          you any right to them beyond using the Service as offered.
        </p>
      </Section>

      <Section title="Disclaimers and liability">
        <p>
          The Service is provided &quot;as is&quot; and &quot;as
          available&quot;. To the extent the law allows, we make no warranties
          about it, and we are not liable for indirect or consequential loss,
          or for any loss arising from decisions you make based on the Service.
          Because the Service is free and involves no real money, our total
          liability to you is limited to EUR 50.
        </p>
        <p>
          Nothing in these terms limits liability for death or personal injury
          caused by negligence, for fraud, for intentional or grossly negligent
          conduct, or any other liability that cannot be limited by law, and
          nothing affects your rights as a consumer under mandatory law.
        </p>
      </Section>

      <Section title="Changes to these terms">
        <p>
          We may update these terms. If a change is significant, we will say so
          in the app before it takes effect. Continuing to use the Service after
          that means you accept the updated terms.
        </p>
      </Section>

      <Section title="Governing law">
        <p>
          These terms are governed by the laws of the Republic of Croatia, and
          the competent courts in Rijeka have jurisdiction. If you are a
          consumer living in the EU, you also keep the protection of the
          mandatory laws of your country and may bring a claim in its courts.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about these terms:{" "}
          <a href={`mailto:${CONTACT}`} className="text-atnx-cyan hover:underline">
            {CONTACT}
          </a>
        </p>
      </Section>
    </main>
  );
}
