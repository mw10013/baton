# App Store submission preparation

Status: 2026-10-22. Draft listing updated and saved; no review submission made. The editor loading bug is closed: Codex Browser Use caused it, not Baton. The production development-store smoke test passed; usage events reaching Shopify remain unverified until a paid billing cycle (see [Production deployment research](production-deployment-research.md)).

## Saved listing content

- [English listing](https://apps.shopify.com/services/partner-app-submissions/5dbed6b0306c3bc52945dd24bd7b0ff9/en).
- Name: Baton (unchanged).
- Primary category: Orders and shipping → Orders → Orders - Other. This describes production order management without claiming shipment tracking, inventory optimization, or order editing.
- Language: English.
- Introduction: “Manage made-to-order production. Give teams clear tasks and follow orders from start to finish.”
- App details: “Baton organizes made-to-order production after an order is paid. Build workflows with ordered steps and team tasks. Match products to workflows using product tags and follow each item in Shopify admin. Members use email sign-in on a phone or tablet to start work, complete tasks, and flag blockers.”
- Features:
  - Match paid order items to production workflows using product tags.
  - Build ordered steps with parallel tasks assigned to your teams.
  - Let members start tasks, mark work done, and flag blockers on a phone or tablet.
- Subtitle: “Manage production workflows for made-to-order products”.
- Search term: “made to order”.
- No required Online Store or POS sales channel. No geographic restrictions added.
- Support, merchant-review notifications, and submission contact: `support@mw10013.com`.
- Privacy: `https://baton.mw10013.com/privacy`.
- Website: `https://baton.mw10013.com`.
- Documentation: `https://baton.mw10013.com/help`.
- Existing plan display names, prices, trial descriptions and features preserved.

Claims were checked against README, billing configuration, and the implemented help pages for workflow matching, ordered steps/parallel tasks, and member email sign-in. No optional tracking integrations or unsupported service integrations added.

## Reviewer instructions

Corrected the prior claim that Baton runs only in Shopify admin. Merchant setup and order management are embedded; members also have a separate passwordless email sign-in flow. There is no storefront customer flow.

Saved notes retain the existing fourteen-step merchant workflow and add how to test member access: provision an inbox the reviewer controls in Members, assign it to the test team, sign in at the production site using the emailed link within five minutes, then test tasks on a new paid order if the original tasks are complete.

The Test account response is still blank. Do not supply owner/admin credentials or incorrectly claim member access requires no account. Before submission, settle how Shopify reviewers will exercise passwordless member access and whether the self-provisioning instructions satisfy the form or additional reviewer access is needed. No shared credentials were created or disclosed.

## Four remaining listing issues

Shopify's listing validation went from 16 issues to 4 after saving the changes:

1. **Feature media:** supply a feature image or video. The form requests a 1600 × 900 image (or video thumbnail). A feature video must be no longer than three minutes. This is separate from the reviewer screencast.
2. **Screenshots:** supply at least three valid desktop screenshots, each with alt text. Use actual app UI, fictional fixture data, no browser/desktop chrome, and distinct features/views. Existing help screenshots are candidates; they have not been uploaded to the listing.
3. **Test account:** resolve passwordless member testing as described above.
4. **Screencast URL:** local video exists but is not hosted. Owner confirmed this in the current session. File: `tmp/screencast/out/baton-review.mp4`; existing build record describes 2:51, 1920 × 1080 H.264/AAC. Do not invent a URL or mark this complete. Hosting destination remains to be chosen. The existing video concentrates on the merchant flow; review its coverage against the member-access listing claim before submission.

Candidate source images include `public/assets/help/workflows/editing-1.png`, `public/assets/help/orders/order-page-1.png`, and member task screenshots under `public/assets/help/members/`. Inspect sizing, fictional data and current UI before use. No marketing images or screenshots uploaded yet.

## Submission summary

Inspected [App Store review](https://partners.shopify.com/2798461/apps/438449864705/distribution/app-store). Submit for review was disabled. The page lists supported API versions, configuration requirements, emergency contact, listing completion, protected customer data request, automated checks, app capabilities, embedded checks, and AI self review / requirements confirmation.

Viewed capabilities: Embedded was automatically represented; no optional capabilities applied (no storefront modification, sales channel, payments, blockchain, etc.). Used Show review requirements without selecting unsupported capabilities.

Do not infer pass/fail from a heading alone: the text snapshot did not expose every status icon. These prerequisites still need a final status audit. Automated checks were not run; the page says they expire after 30 days and recommends running them last. The AI self-review completion and all-requirements confirmation were not marked complete.

## Remaining sequence

1. Prepare and review listing media; upload the approved assets.
2. Choose hosting for the existing reviewer video, verify coverage, and set the accessible URL.
3. Resolve reviewer access; verify the saved instructions on a clean test install.
4. After the editor bug and production smoke tests pass, audit the submission prerequisites and run Shopify's automated checks.
5. Review the complete listing and submission with the owner before submitting.

## Sources

- The live English listing and submission summary above, inspected 2026-10-22.
- [Shopify App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements), especially 4.4 (listing and images), 4.5.3 (screencast), 4.5.4–4.5.5 (test credentials), and 4.5.6 (emergency contact).
- [Screencast research](screencast-research.md) and [implementation record](screencast-plan.md).
