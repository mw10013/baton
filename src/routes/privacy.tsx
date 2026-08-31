import { createFileRoute } from "@tanstack/react-router";

const collectItems = [
  "Shopify shop domain and Shopify shop identifier.",
  "Shopify authentication details that keep the app securely connected to your store, including the permissions you granted.",
  "Flow trigger inputs submitted in the app, such as the selected test trigger name.",
  "Flow action request details sent by Shopify Flow, such as action run identifiers and merchant-configured action values.",
  "Technical information generated when the app is used, such as request metadata, error logs, and security/debugging information.",
  "Information merchants provide when contacting support, such as email address and message contents.",
] as const;

const notCollectedItems = [
  "Customer names.",
  "Customer email addresses.",
  "Customer phone numbers.",
  "Customer physical addresses.",
  "Order history.",
  "Payment card or payment account details.",
  "Buyer storefront browsing behavior.",
] as const;

const useItems = [
  "Authenticate merchants and keep the app connected to Shopify.",
  "Send custom Shopify Flow trigger events requested by merchants.",
  "Maintain app security and prevent unauthorized access.",
  "Diagnose bugs, monitor reliability, and provide support.",
  "Comply with Shopify platform requirements and applicable legal obligations.",
] as const;

const sharingItems = [
  "Shopify, which provides the Shopify admin platform, OAuth, APIs, app installation, billing, and compliance webhook infrastructure.",
  "Cloudflare, which hosts the app and related storage/compute services.",
  "Email/support providers used to receive and respond to merchant support requests.",
] as const;

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [{ title: "Privacy policy" }],
  }),
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <s-page heading="Privacy policy" inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/">
        Baton
      </s-link>
      <s-stack gap="base">
        <s-text tone="neutral">Last updated: July 28, 2026</s-text>
        <s-paragraph>
          Baton is a Shopify admin app. This Privacy Policy explains what
          information Baton collects, how we use it, and how merchants can
          contact us about privacy requests.
        </s-paragraph>
        <s-paragraph>
          Baton is operated by Michael Wu. Contact us at support@mw10013.com.
        </s-paragraph>
      </s-stack>
      <PolicySection heading="Information We Collect">
        <s-paragraph>
          When a merchant installs or uses Baton, we collect the information
          needed to operate the app:
        </s-paragraph>
        <PolicyList items={collectItems} />
        <s-paragraph>
          Baton currently requests no Shopify Admin API access scopes. It does
          not request access to products, orders, customers, payment details, or
          checkout data.
        </s-paragraph>
      </PolicySection>
      <PolicySection heading="Information We Do Not Collect">
        <s-paragraph>
          Based on the app's current Shopify permissions and functionality,
          Baton does not collect or store:
        </s-paragraph>
        <PolicyList items={notCollectedItems} />
      </PolicySection>
      <PolicySection heading="How We Use Information">
        <s-paragraph>We use collected information to:</s-paragraph>
        <PolicyList items={useItems} />
        <s-paragraph>We do not sell personal information.</s-paragraph>
      </PolicySection>
      <PolicySection heading="Sharing Information">
        <s-paragraph>
          We share information only as needed to operate Baton, comply with law,
          or protect our rights. Service providers may process information on
          our behalf, including:
        </s-paragraph>
        <PolicyList items={sharingItems} />
        <s-paragraph>
          We may also disclose information if required by law, legal process, or
          a valid government request, or if needed to protect Baton, merchants,
          Shopify, or the public.
        </s-paragraph>
      </PolicySection>
      <PolicySection heading="Data Retention And Deletion">
        <s-paragraph>
          We keep app data for as long as needed to provide Baton and for
          legitimate operational, security, legal, or compliance purposes.
        </s-paragraph>
        <s-paragraph>
          When you uninstall Baton, we delete your store's app session and
          related app data.
        </s-paragraph>
        <s-paragraph>
          Baton does not store any of your customers' data. If Shopify sends a
          customer data request or deletion request on a customer's behalf,
          Baton confirms it but has no customer data to return or delete.
        </s-paragraph>
        <s-paragraph>
          Some technical logs, backups, or security records may persist for a
          limited period where needed for security, debugging, legal compliance,
          or abuse prevention.
        </s-paragraph>
      </PolicySection>
      <PolicySection heading="Security">
        <s-paragraph>
          We use reasonable technical and organizational measures to protect
          information processed by Baton. The app uses HTTPS/TLS, Shopify
          OAuth/session mechanisms, limited Shopify API scopes, and access
          controls. No method of transmission or storage is completely secure,
          so we cannot guarantee absolute security.
        </s-paragraph>
      </PolicySection>
      <PolicySection heading="International Processing">
        <s-paragraph>
          Baton and its service providers may process information in countries
          other than the merchant's country. Where required, we rely on
          appropriate safeguards provided by our service providers or applicable
          law.
        </s-paragraph>
      </PolicySection>
      <PolicySection heading="Merchant Rights And Requests">
        <s-paragraph>
          Merchants can contact us at support@mw10013.com to request access,
          correction, or deletion of information associated with their Baton
          installation.
        </s-paragraph>
        <s-paragraph>
          Customers of merchants should contact the merchant directly for
          privacy requests about customer data. Baton does not currently store
          customer-scoped data.
        </s-paragraph>
      </PolicySection>
      <PolicySection heading="Changes">
        <s-paragraph>
          We may update this Privacy Policy from time to time. Changes are
          effective when posted at this URL. The Last updated date will show the
          latest revision date.
        </s-paragraph>
      </PolicySection>
    </s-page>
  );
}

function PolicySection({
  heading,
  children,
}: {
  readonly heading: string;
  readonly children: React.ReactNode;
}) {
  return (
    <s-section heading={heading}>
      <s-stack gap="base">{children}</s-stack>
    </s-section>
  );
}

function PolicyList({ items }: { readonly items: readonly string[] }) {
  return (
    <ul>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
