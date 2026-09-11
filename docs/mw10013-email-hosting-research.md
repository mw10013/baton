# Google Workspace email for `mw10013.com`

Research date: **September 10, 2026**. Prices are US prices before tax and can change.

## Decision

Use **Google Workspace Business Starter** for human email at `mw10013.com`.

This is the lowest-friction fit because it provides a normal Gmail mailbox at the domain and keeps composing, replying, search, spam filtering, contacts, Calendar, and mobile access inside Google. It also avoids personal Gmail's January 2027 removal of third-party **Send mail as**.

Business Starter costs **$7/user/month on an Annual/Fixed-Term plan** or **$8.40/user/month on a Flexible plan**. One annual license is $84/year.

## Cloudflare's role

Keep the domain registered at Cloudflare and keep Cloudflare authoritative DNS. Domain registration, DNS hosting, and email hosting are separate services.

For human mail at the apex domain, Workspace replaces Cloudflare Email Routing completely:

```text
Before
support@mw10013.com
  -> Cloudflare Email Routing
  -> mw10013@gmail.com

After
support@mw10013.com
  -> Google Workspace MX records
  -> the Workspace Gmail inbox
```

There is no need to forward Workspace mail through Cloudflare or personal Gmail. Cloudflare remains where the Google verification, MX, SPF, DKIM, and DMARC DNS records are entered, but Google receives and stores the mail.

### Important Baton exception

Do **not** remove every Cloudflare email feature indiscriminately. Baton separately sends transactional application mail as:

```text
noreply@mail.mw10013.com
```

The app uses a Cloudflare Email Sending binding configured in `wrangler.jsonc`. That sender is on the `mail.mw10013.com` subdomain, while Workspace human mail is on `mw10013.com`. These can coexist because DNS and authentication records are scoped by hostname.

The migration should therefore:

- disable Cloudflare **Email Routing** for inbound human mail at `@mw10013.com`;
- retain Cloudflare **Email Sending** and its DNS records for `noreply@mail.mw10013.com`;
- avoid deleting records under `mail.mw10013.com` merely because they mention email or Cloudflare.

This separation also prevents Baton from consuming Workspace Gmail sending quotas or requiring the app to authenticate as a human account.

## Baton transactional email

Use **Cloudflare Email Sending through the native Workers binding** for Baton's magic-link and future transactional messages. Do not send these through Google Workspace.

Workspace can relay application mail, but that would introduce Google credentials and quotas into the Worker, couple application delivery to a human productivity account, and mix human and application reputation. Cloudflare's binding is already native to Baton's runtime, needs no SMTP password or API token in the application, and isolates transactional reputation on a subdomain.

Cloudflare Email Sending is still labeled **public beta** as of the research date. It is a reasonable fit for Baton's low-volume authentication mail, but delivery metrics and failures should be monitored and the dependency should remain behind Baton's existing `Email` service so another provider can replace it without changing authentication logic.

### Recommended sender identity

Keep the existing sending domain and address:

```text
Display name: Baton
From:         noreply@mail.mw10013.com
Reply-To:     omitted
```

The message should appear as **`Baton <noreply@mail.mw10013.com>`**. `mail.mw10013.com` is preferable to sending from the apex because it separates application reputation and DNS authentication from human Workspace mail. It is broad enough for future receipts, invitations, or account alerts, so there is little benefit in replacing it with a narrower `auth.mw10013.com` domain.

Omitting `Reply-To` is more honest than pointing replies at `support@` when the message is intentionally not a support channel. The body should say that the message was automatically generated and replies are not monitored. At present, `mail.mw10013.com` has no public MX, A, or AAAA record, so direct replies cannot be delivered. An explicit RFC 7505 null MX (`MX 0 .`) can make the no-inbound policy unambiguous, but verify that addition against the Email Sending dashboard before applying it. Do not alter the separate bounce MX records at `cf-bounce.mail.mw10013.com`.

Do not use `support@mw10013.com` as the transactional sender. That address belongs to Workspace and should remain capable of receiving human replies.

### Current implementation audit

Baton already has a strong base configuration:

- `mail.mw10013.com` is onboarded as a distinct Cloudflare Email Sending domain.
- Public DNS contains Cloudflare's bounce MX, SPF, and DKIM records under `cf-bounce.mail.mw10013.com` and a `p=reject` DMARC record at `_dmarc.mail.mw10013.com`.
- Every local, staging, and production `send_email` binding pins `allowed_sender_addresses` to exactly `noreply@mail.mw10013.com`.
- Baton uses the native binding's structured `send()` API rather than SMTP or REST credentials.
- Local development simulates delivery unless someone deliberately adds `remote: true`.
- Real magic-link URLs are not persisted in Baton's KV or logs. Demo mode is the explicit exception and retains the URL only for the same five-minute TTL.
- Better Auth stores each token hashed, gives it a five-minute expiration, and atomically consumes it on use.
- The login route checks that the address is an administrator or shop member before sending and returns the same success response for an unknown address.
- Login sends are currently limited to five attempts per minute per source IP.
- Binding errors fail the login request rather than falsely telling the user to check for a message that Cloudflare did not accept.

The main gaps to close before production are recipient-level throttling, verification-endpoint throttling, explicit sender presentation and automated-message headers, delivery monitoring, staging recipient restrictions, and focused tests of the real-email boundary.

Two Better Auth lifecycle details should be accepted deliberately rather than assumed away:

- Each new request creates an independently valid link. Using one does not invalidate other links requested for the same address during the preceding five minutes. Every link is still single-use and expires after five minutes. This is acceptable for the first release; invalidating older links would require additional per-address issuance state or customization around Better Auth.
- Better Auth persists the hashed verification row before awaiting Cloudflare. If sending fails, the undisclosed link cannot be used, but its row remains until expiration. Add periodic deletion of expired verification rows as database hygiene; do not attempt a broad delete from the send callback where concurrent requests could be affected.

### Binding and credential security

Keep the native Workers binding. Do not create a Cloudflare Email Sending API token or SMTP credential for Baton; neither is needed when the Worker calls `env.EMAIL.send()`.

Production should retain this sender restriction:

```jsonc
"allowed_sender_addresses": ["noreply@mail.mw10013.com"]
```

This is a platform-enforced boundary: even if an application bug controls the `from` value, the binding cannot impersonate `michael@`, `support@`, or another sender.

Do not configure `allowed_destination_addresses` in production. Magic links must reach dynamic member addresses, so a static recipient allowlist would prevent the application from functioning. Use application authorization and rate limits instead.

For staging, add `allowed_destination_addresses` containing only designated test accounts, or onboard a separate staging sender domain if staging must send to a broader audience. Keep local sending simulated by default. Never commit `remote: true` to the normal local binding; use it only for an intentional real-delivery test with restricted recipients.

Cloudflare dashboard access should use phishing-resistant MFA where possible. Limit who can edit Workers deployments and Email Sending settings, because either permission can affect outbound mail even though Baton itself has no email credential.

### Abuse controls

The login endpoint is externally reachable and can otherwise be used to annoy known members or damage sender reputation. Apply all of these controls:

1. Keep the existing invite-only membership check and generic response for unknown addresses.
2. Keep the per-IP Cloudflare rate limit.
3. Add a separate per-recipient rate-limit binding with its own namespace and key it by a normalized, non-reversible representation of the email address. This prevents an attacker from bypassing an address limit by rotating IPs.
4. Apply the recipient limiter before revealing whether the address is eligible, and preserve a generic outward response when a send is suppressed.
5. Add a separate coarse limiter to repeated invalid requests against the public magic-link verification endpoint. Token entropy makes guessing impractical, but unlimited invalid verification requests can still consume Worker and D1 capacity.
6. Do not add automatic retries around an uncertain send result. A retry can issue multiple valid login links; let the user request another link explicitly after a clear failure.
7. Keep authentication mail strictly transactional. Do not use the same stream for newsletters or promotions, which have different consent, unsubscribe, volume, and reputation requirements.

Cloudflare's rate-limit binding only supports 10-second or 60-second windows. If stronger rolling limits are needed, such as a small number per address per hour, store a short-lived counter in a Durable Object or another authoritative store rather than pretending the minute limiter provides that protection.

### Magic-link security

Retain the current five-minute expiration and hashed token storage. Before production launch, verify with an integration test that:

- the link works once;
- replay after successful use fails;
- use after five minutes fails;
- a malformed token fails without exposing internal details;
- the callback is always on the configured HTTPS Baton origin;
- requesting a newer link has the intended effect on any older unused link.

Never log the URL, query string, raw token, email HTML, or email text in staging or production. Baton's deliberate demo mode does put the URL in KV, the UI, and local logs for five minutes, so pin `DEMO_MODE=false` explicitly in every deployed environment rather than relying on a missing/default value. Cloudflare necessarily processes and may expose sent-message content in its Email Service Activity log; the five-minute expiration sharply limits the value of a retained magic-link URL, but Cloudflare account access must still be treated as sensitive.

Only put trusted or correctly escaped values into HTML templates. The current template contains a Better Auth-generated URL and a fixed expiration value. Any future template containing merchant, customer, or user-controlled text must HTML-escape that text.

### Message design

Keep the email short, recognizable, and useful without remote images or attachments:

```text
From: Baton <noreply@mail.mw10013.com>
Subject: Your Baton sign-in link

Sign in to Baton

[Sign in to Baton]

This link expires in 5 minutes and can only be used to sign in to Baton.
If you did not request this email, you can safely ignore it.

This is an automated message. Replies are not monitored.
```

Include both HTML and plain-text bodies, as Baton already does. The visible button URL and plain-text fallback must use the same HTTPS Baton origin. Do not include the recipient's name unless it is trusted and escaped, and do not put the token in the subject.

Set the structured sender with display name `Baton`, omit `replyTo`, and add `Auto-Submitted: auto-generated`. Cloudflare generates `Date`, `Message-ID`, `Return-Path`, DKIM, and feedback-loop headers, so Baton should not attempt to override them. An unsubscribe link is not appropriate for a requested authentication message; add unsubscribe controls only if a future message stream is promotional or optional.

### Authentication and DNS

The current transactional DNS is correctly separated from Workspace:

```text
Human mail domain:         mw10013.com
Human sender:              Google Workspace
Human SPF/DKIM/DMARC:      records at the apex and Google DKIM selector

Transactional mail domain: mail.mw10013.com
Transactional sender:      Cloudflare Email Sending
Bounce return path:         cf-bounce.mail.mw10013.com
Transactional DKIM:        cf-bounce._domainkey.mail.mw10013.com
Transactional DMARC:       _dmarc.mail.mw10013.com
```

Cloudflare manages the bounce MX, SPF, and DKIM records for the onboarded sending domain. Do not merge the transactional SPF record into Google's apex SPF record, and do not delete the `cf-bounce.mail.mw10013.com` records during the Workspace migration.

The current transactional DMARC policy is already `p=reject`. Confirm SPF, DKIM, and DMARC all pass in messages delivered to Gmail and at least one non-Google provider after every DNS or sending-domain change.

### Capacity, failures, and monitoring

Workers Paid currently includes **3,000 outbound messages per Cloudflare account per month**, followed by **$0.35 per 1,000 messages**. Accepted messages count even if they later hard-bounce; requests rejected at the API boundary do not. New accounts also begin with a conservative adaptive daily limit. The message limit is 5 MiB, far above a plain magic-link email.

Cloudflare automatically suppresses hard-bouncing addresses, repeated soft bounces, and spam complainants. Baton should treat `E_RECIPIENT_SUPPRESSED`, `E_RATE_LIMIT_EXCEEDED`, and `E_DAILY_LIMIT_EXCEEDED` as operationally distinct conditions even if users receive the same safe failure message.

Before production launch:

1. Send deliverability tests to Gmail and a non-Google mailbox and inspect full authentication headers.
2. Check Cloudflare **Email Service -> Email Sending -> Analytics** for delivery, bounce, rejection, complaint, SPF, DKIM, and DMARC results.
3. Establish a lightweight weekly review of failures and suppressions while volume is low. Cloudflare's email analytics retention is currently 31 days.
4. Alert on bursts of send failures, rate-limit errors, daily-limit errors, and a material increase in login-send volume.
5. Record Cloudflare's returned `messageId` with the server-side send event, but never expose it as a credential or substitute it for the magic-link token.

Cloudflare can publish delivered, deferred, bounced, failed, rejected, and complained events to a Queue. A Queue consumer is not necessary for the first low-volume release; add one when automated bounce handling, delivery support, or longer-lived metrics justify the extra system. Cloudflare already prevents repeat sends to suppressed recipients.

### Transactional email implementation plan

1. Keep `mail.mw10013.com` onboarded and confirm all four Email Sending DNS checks remain healthy in the dashboard.
2. Preserve the exact production sender allowlist and add a staging destination allowlist.
3. Extend Baton's email input to set the `Baton` display name and `Auto-Submitted: auto-generated`; leave `Reply-To` unset.
4. Update the HTML and text magic-link templates with the no-reply and unrequested-email language.
5. Add a recipient-based issuance limiter alongside the existing IP limiter and a coarse limiter for invalid verification requests.
6. Pin `DEMO_MODE=false` and the correct HTTPS `BETTER_AUTH_URL` explicitly in staging and production deployment configuration.
7. Add tests for sender pinning, generated message shape, send failures, real-mode KV behavior, eligibility behavior, issuance rate limits, expiration, and replay.
8. Add periodic cleanup of expired Better Auth verification rows and document that overlapping five-minute links remain independently valid.
9. Perform one deliberate remote test to restricted addresses, followed by a deployed staging test.
10. Inspect Cloudflare analytics and received headers, then deploy production.
11. Test transactional delivery again immediately after the Workspace MX/SPF/DKIM migration.
12. Reassess Queue event subscriptions and a backup transactional provider if Baton volume or business criticality grows beyond a low-volume beta dependency.

## Primary address

Recommended structure:

```text
Primary paid user and Google identity: michael@mw10013.com
Free alias:                            mw10013@mw10013.com
Free alias:                            support@mw10013.com
Free alias:                            hello@mw10013.com
```

Use **`michael@mw10013.com` as the primary account**. It reads naturally in direct business correspondence and on Calendar invitations, shared documents, account ownership, and administrative screens. It also remains appropriate if another person later handles support.

Keep **`mw10013@mw10013.com` as an alias**. The repetition is not technically problematic and it is memorable because it mirrors `mw10013@gmail.com`; it is simply less human-looking. Making it an alias preserves that convenience without making it the permanent identity attached to Drive files, Calendar events, and the Workspace administrator account.

`michael@` is preferable to `mike@` unless Michael normally introduces himself as Mike. `mw@` is short but easier to mistype or mishear and provides less identity. An alias can be promoted or reassigned later, but changing a primary account name has more consequences, so the durable human name is the safer primary.

Google allows up to **30 aliases per user at no additional cost**. An alias receives mail in the primary inbox and can be selected as a Gmail `From` address, but it does not have a separate login, mailbox, Drive, or Calendar.

Use Gmail filters and labels for role mail, such as applying a `Support` label to messages addressed to `support@mw10013.com`.

## Business tiers

| Edition           | Annual commitment |  Flexible monthly | Pooled storage added per user | Reasons to upgrade from Starter                                                       |
| ----------------- | ----------------: | ----------------: | ----------------------------: | ------------------------------------------------------------------------------------- |
| Business Starter  |     $7/user/month |  $8.40/user/month |                         30 GB | Custom Gmail, office apps, administration, and Meet for 100                           |
| Business Standard |    $14/user/month | $16.80/user/month |                          2 TB | Shared drives, Meet recording and 150 participants, and richer collaboration features |
| Business Plus     |    $22/user/month | $26.40/user/month |                          5 TB | Vault retention/eDiscovery, advanced endpoint management, and Meet for 500            |

Start with **Business Starter**. Standard and Plus do not improve basic custom-domain email enough to justify their cost here. Upgrade later only if storage, shared drives, Meet recording, compliance, or device-management requirements emerge.

The Annual plan is the sensible choice for a permanent owner account. Licenses can be added during the commitment, but the committed license count generally cannot be reduced until renewal. The Flexible plan costs 20% more in exchange for month-to-month user-count flexibility.

## Adding another person

A second person who needs a private Gmail inbox, Google login, Drive, and Calendar needs a second paid license. Business Starter would then cost **$168/year** on an annual commitment or **$16.80/month** on the Flexible plan, with 60 GB of pooled organizational storage.

There are three ways to handle `support@`:

| Design                             | Behavior                                                                 | Cost                                                     | Use                                          |
| ---------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------- |
| User alias                         | Mail reaches one user's inbox                                            | Free                                                     | Best while Michael works alone               |
| Google Group / Collaborative Inbox | Mail can be distributed to both users; Group UI can assign conversations | Group address is free; each person still needs a license | Best lightweight two-person setup            |
| Shared/delegated Gmail inbox       | One central mailbox with shared history, read state, labels, and sending | Confirm mailbox licensing in Admin before creation       | Best when avoiding duplicate replies matters |

Start with `support@` as Michael's alias. When another person joins, remove that alias and recreate `support@` as a Google Group if both people should receive copies. An address cannot be an alias and a Group simultaneously.

If support volume becomes meaningful, use Google's shared inbox or delegated mailbox instead of relying on two independently delivered copies. Business Starter supports shared-inbox functionality, although Google's newer Admin setup remains subject to rollout and its public documentation does not clearly promise that every shared mailbox is license-free. A Group is definitely free; a conventional dedicated `support@` user is definitely another paid license.

## Migration plan

The goal is a short, controlled MX cutover. Do not delete the working route first and then begin Workspace setup.

### 1. Record and protect the current state

1. Export or screenshot Cloudflare DNS records and the Email Routing rules.
2. Record the current Gmail **Settings -> Accounts and Import -> Send mail as** configuration.
3. Mark all records associated with `mail.mw10013.com` and Baton's Cloudflare Email Sending setup as protected from this migration.
4. List every currently used apex address, including `support@`, so each becomes a Workspace user, alias, or Group before cutover.

At the time of this research, public DNS shows Cloudflare Email Routing MX records on `mw10013.com` and this apex SPF record:

```text
v=spf1 include:_spf.mx.cloudflare.net ~all
```

No public DMARC record was found at `_dmarc.mw10013.com`. Recheck all records at migration time rather than treating this snapshot as authoritative.

### 2. Create Workspace without changing mail delivery

1. Sign up for Google Workspace Business Starter using the existing domain.
2. Create `michael@mw10013.com` as the first user and super administrator.
3. Verify domain ownership by adding Google's requested TXT record in Cloudflare DNS. This does not change mail flow.
4. Enable strong two-step verification and store backup codes securely.
5. Create aliases `mw10013@`, `support@`, and `hello@` as needed.
6. Configure Gmail to send from each role alias and choose the intended default/reply behavior.
7. Generate the Workspace DKIM record in Google Admin and add it to Cloudflare DNS. Start DKIM authentication when Google allows it.

Use the exact verification and DKIM values generated for this Workspace tenant rather than values copied from an example.

### 3. Prepare the DNS cutover

1. In Google Admin, obtain the currently prescribed Workspace MX record or records.
2. In Cloudflare, reduce the TTL on the apex MX records in advance if the interface permits it.
3. Confirm the Workspace user and aliases exist before changing MX.
4. Choose a quiet period and keep both Cloudflare and Google Admin open.

Newer Workspace setups commonly use a single `smtp.google.com` MX record, while older documentation and tenants may show Google's legacy five-record set. Follow the value displayed by Google Admin for this tenant.

### 4. Cut over inbound and outbound human mail

1. Disable Cloudflare Email Routing for `mw10013.com`, which removes or releases its apex MX records.
2. Immediately add Google's prescribed MX record or records at the apex in Cloudflare DNS.
3. Replace the old apex SPF record with Google's SPF value if Google Workspace is the only sender using `@mw10013.com`:

   ```text
   v=spf1 include:_spf.google.com ~all
   ```

4. Do not alter the separate SPF, DKIM, verification, or sending configuration for `mail.mw10013.com`.
5. Confirm that only one SPF TXT record exists at each hostname. Multiple SPF records cause SPF evaluation errors.

The precise SPF value must authorize every service that sends as an apex `@mw10013.com` address. If another legitimate apex sender is discovered during the inventory, combine its authorization into one SPF record rather than replacing it blindly.

### 5. Verify before cleanup

Test all of the following from unrelated external accounts:

1. Send to `michael@mw10013.com` and every alias.
2. Reply from each alias and confirm the visible `From` and reply-to behavior.
3. Send new outbound messages to Gmail and a non-Google provider.
4. Inspect message headers and Google Admin's email log search for SPF, DKIM, and delivery results.
5. Test Calendar invitations and account recovery.
6. Trigger a Baton email and confirm `noreply@mail.mw10013.com` still passes authentication and delivers.

DNS caches can preserve the old MX path temporarily. Keep the old personal Gmail account monitored during the transition and do not infer failure from one early test.

### 6. Add DMARC and retire obsolete configuration

1. After SPF and DKIM pass consistently, add a DMARC record at `_dmarc.mw10013.com`, beginning with monitoring policy `p=none` and aggregate reports to a deliberately chosen reporting mailbox.
2. Review reports before moving to `quarantine` or `reject`.
3. Remove the obsolete third-party `support@` sender entry from personal Gmail only after Workspace sending is verified.
4. Remove stale Cloudflare apex routing rules or destination-address configuration if disabling Email Routing did not already remove them.
5. Retain the old Gmail messages as an archive, or migrate selected historical business mail into Workspace using Google's migration tools. The MX cutover moves future delivery only; it does not move old messages.
6. Document the final Cloudflare DNS records and Workspace aliases.

## Expected final state

```text
Registrar and authoritative DNS: Cloudflare

Human inbound mail at @mw10013.com:
  Google Workspace MX -> Workspace Gmail

Human outbound mail at @mw10013.com:
  Workspace Gmail -> Google

Application outbound mail at @mail.mw10013.com:
  Baton -> Cloudflare Email Sending

Cloudflare Email Routing for @mw10013.com:
  Disabled

Personal mw10013@gmail.com:
  Separate personal account / optional historical archive
```

## Sources

Primary sources accessed September 10, 2026:

- [Google: Learn about changes to third-party email account support in Gmail](https://support.google.com/mail/answer/17101213?hl=en)
- [Google Workspace: Business editions and official prices](https://knowledge.workspace.google.com/admin/getting-started/editions/business-editions)
- [Google Workspace: Flexible versus Annual/Fixed-Term plans](https://knowledge.workspace.google.com/admin/billing/compare-flexible-and-annual-fixed-term-payment-plans)
- [Google Workspace: Set up MX records](https://knowledge.workspace.google.com/admin/domains/set-up-mx-records-for-google-workspace)
- [Google Workspace: Set up SPF](https://support.google.com/a/answer/33786?hl=en)
- [Google Workspace: Add or delete an email alias](https://knowledge.workspace.google.com/admin/users/add-or-delete-an-alternate-email-address-email-alias)
- [Google Workspace: Create a shared inbox](https://support.google.com/a/answer/16343077?hl=en)
- [Google Workspace: Delegate a user's email address](https://support.google.com/a/answer/11946994?hl=en)
- [Google Groups: Make a group a Collaborative Inbox](https://support.google.com/a/users/answer/10375787?hl=en)
- [Cloudflare: Disable Email Routing](https://developers.cloudflare.com/email-routing/setup/email-routing-addresses/#disable-email-routing)
- [Cloudflare: Email Sending overview](https://developers.cloudflare.com/email-service/)
- [Cloudflare: Configure send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/)
- [Cloudflare: Workers Email Sending API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [Cloudflare: Email authentication](https://developers.cloudflare.com/email-service/concepts/email-authentication/)
- [Cloudflare: Suppression lists](https://developers.cloudflare.com/email-service/concepts/suppressions/)
- [Cloudflare: Limits](https://developers.cloudflare.com/email-service/platform/limits/)
- [Cloudflare: Pricing](https://developers.cloudflare.com/email-service/platform/pricing/)
- [Cloudflare: Email Sending analytics](https://developers.cloudflare.com/email-service/observability/metrics-analytics/)
- [Cloudflare: Event subscriptions](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)
- [Cloudflare: Email headers](https://developers.cloudflare.com/email-service/reference/headers/)
- [Cloudflare: Local email sending](https://developers.cloudflare.com/email-service/local-development/sending/)
