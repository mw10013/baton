# Set up Infomaniak email for `mw10013.com`

Updated: **September 14, 2026**.

## Target

```text
Infomaniak login:       mw10013@gmail.com
Primary mailbox:        michael@mw10013.com
Alias into that inbox:  support@mw10013.com
Domain and DNS provider: Cloudflare
```

Sign in to Infomaniak with `mw10013@gmail.com`. That is the account login, not a hosted inbox. Keep it as the login and recovery address so an email or DNS problem at `mw10013.com` cannot lock you out of Infomaniak.

This work moves human mail for the apex `mw10013.com` domain to Infomaniak. MX records apply to the whole domain, so both `michael@mw10013.com` and its `support@mw10013.com` alias will use Infomaniak. It does not change Baton's transactional email from the `mail.mw10013.com` subdomain.

## Current checkpoint

The controlled cutover was completed on September 13, 2026, followed by Gmail and DNS cleanup plus apex DMARC monitoring:

- Cloudflare remains the registrar, authoritative DNS provider, and nameserver provider.
- Human mail at the apex uses the Infomaniak MX record `mta-gw.infomaniak.ch` at priority `5`.
- The apex has exactly one SPF record: `v=spf1 include:spf.infomaniak.ch -all`.
- Infomaniak reports all five DNS diagnostics as valid, including MX, SPF, DKIM, `autoconfig`, and `autodiscover`.
- Cloudflare Email Routing was disabled after the old 300-second MX TTL elapsed and delivery tests passed.
- Cloudflare's disable flow preserved the third-party Infomaniak records as stated in its confirmation dialog.
- Baton's records under `mail.mw10013.com` and `cf-bounce.mail.mw10013.com` remain unchanged.

Delivery verification:

- Fresh messages from both `michael@mw10013.com` and `support@mw10013.com` reached Gmail immediately.
- Gmail's original-message diagnostics reported SPF and DKIM passing for both identities.
- Replies from Gmail to both `michael@mw10013.com` and `support@mw10013.com` arrived in the Infomaniak `michael@` inbox. This confirms the `support@` alias receives correctly.
- Gmail reported DMARC failing because `_dmarc.mw10013.com` is still absent. This did not block delivery; add the monitoring policy in section 7 as a separate follow-up.

Post-cutover Gmail inbox copies are not Cloudflare routing:

- Cloudflare Email Routing shows no onboarded domain and prompts to onboard; public MX/SPF on both `1.1.1.1` and `8.8.8.8` remain Infomaniak-only.
- Gmail has no forwarding address and no Mail Fetcher account configured.
- A Gmail-to-`support@` test arrived in Infomaniak, while the matching Gmail inbox copy has no `Received` headers, Gmail message ID, and `Delivered after 0 seconds`. That is Gmail self-delivery to its own `Send mail as` alias, not an external forward.
- Gmail still has the obsolete `Support mw10013 <support@mw10013.com>` **Send mail as** entry and the `to:(support@mw10013.com)` filter that stars, marks important, and applies the `mw10013/support` label. Together they keep a labeled copy of every Gmail-sent `support@` test in the Gmail inbox alongside the real delivery in Infomaniak.
- Remove those two Gmail leftovers per section 8. Until then, treat Gmail inbox copies of Gmail-sent `support@` messages as expected local duplicates.
- Gmail cleanup completed: the obsolete `Support mw10013 <support@mw10013.com>` **Send mail as** entry is deleted, leaving only the default `mw10013@gmail.com`; the `to:(support@mw10013.com)` filter is deleted. The `mw10013/support` label itself remains for old messages but no longer applies to new mail.
- Cloudflare cleanup completed: Email Routing remains disabled with no onboarded domain, and the leftover `cf2024-1._domainkey.mw10013.com` TXT was deleted. Authoritative NS returns empty for it. Baton records under `mail.mw10013.com` and `cf-bounce.mail.mw10013.com` were not touched.
- Apex DMARC monitoring added on September 13, 2026: TXT at `_dmarc.mw10013.com` with `v=DMARC1; p=none; rua=mailto:support@mw10013.com`, verified on both authoritative NS and public `1.1.1.1`/`8.8.8.8`. `p=none` changes no delivery; it only requests aggregate reports. Do not jump to `quarantine`/`reject` without the review periods in section 7.

No migration action is currently in progress. Do not change the domain's nameservers; Cloudflare remains authoritative for DNS.

## Protected Baton records

Do not modify or delete any record under either of these names:

```text
mail.mw10013.com
cf-bounce.mail.mw10013.com
```

Those records are for Baton's separate transactional email. This cutover changes only human mail at the apex `mw10013.com` domain.

## 1. Secure the accounts

Before changing email delivery:

1. Enable two-factor authentication on the Infomaniak account.
2. Store the Infomaniak recovery information offline.
3. Keep `mw10013@gmail.com` accessible and protected with two-factor authentication.
4. Confirm Cloudflare two-factor authentication is enabled.
5. Confirm the Cloudflare registrar transfer lock, auto-renewal, and DNSSEC are enabled.
6. Use unique passwords stored in a password manager.

## 2. Connect the domain without cutting over mail

1. Sign in at `https://manager.infomaniak.com` with `mw10013@gmail.com`.
2. Open the kSuite Free product.
3. Open **Manage domains** and add the external domain `mw10013.com`.
4. Keep the domain registered at Cloudflare and keep the Cloudflare nameservers.
5. Choose the option to keep using external DNS.
6. Record the MX, SPF, and DKIM changes Infomaniak requests, but do not apply them yet.
7. Continue until the pending domain and Mail Service appear in Manager.

If Infomaniak will not create the pending Mail Service without immediate DNS changes, stop rather than changing MX prematurely. The mailbox must be ready as part of the same controlled cutover.

## 3. Create the mailbox and alias

1. In Infomaniak Manager, open the Mail Service associated with `mw10013.com`.
2. Click **Create an email address**.
3. Create `michael@mw10013.com` as the primary address.
4. Assign the current Gmail-based Infomaniak user access to that mailbox.
5. Open `https://ksuite.infomaniak.com/mail` and confirm `michael@mw10013.com` appears at the top left.
6. Open the mailbox's **Aliases** settings.
7. Add `support@mw10013.com` as its one included alias.
8. In Mail, open **Settings -> Signatures** and create or edit a signature.
9. Expand **Advanced Settings** and select `support@mw10013.com` as the sender address.
10. Create a `Support` signature identity so selecting that signature sends as `support@mw10013.com`; sending without it uses the primary address.

Mail sent to `support@` will arrive in the `michael@` inbox. The alias has no separate inbox or password.

Do not enable catch-all delivery. Unknown addresses should bounce rather than create additional spam exposure.

## 4. Record the current configuration

Before the cutover:

1. Export or screenshot the Cloudflare DNS records.
2. Screenshot the Cloudflare Email Routing rules.
3. Record the Gmail **Settings -> Accounts and Import -> Send mail as** entry for `support@mw10013.com`.
4. In Infomaniak **Mail Service -> Domains management -> DNS test**, use **Correct error** beside each record to copy the exact MX and DKIM values shown for `mw10013.com`. The SPF row shows the currently detected value; use Infomaniak's documented SPF value during cutover.
5. Confirm the apex MX TTL is still 300 seconds. It was already 300 seconds on September 12, 2026, so no reduction was needed.

The public apex records before cutover were:

```text
MX:  Cloudflare Email Routing
SPF: v=spf1 include:_spf.mx.cloudflare.net ~all
DMARC: absent
```

The live public apex records after cutover are:

```text
MX priority 5: mta-gw.infomaniak.ch
SPF:           v=spf1 include:spf.infomaniak.ch -all
```

Use the values displayed in the Infomaniak account if they differ. DKIM is account-specific and must be copied from **Global Security**.

## 5. Cut over

Perform these steps together during a quiet period:

1. Confirm the Infomaniak mailbox, alias, sending identities, and published DKIM are ready.
2. In **Cloudflare -> Email Routing -> Settings**, unlock the Email Routing DNS records. If Cloudflare presents a **Start disabling** flow, choose **Unlock records and continue**, not **Delete and Disable**. Unlocking preserves the existing routing configuration for easier rollback.
3. Add the exact Infomaniak MX record at the apex. The currently documented value is `mta-gw.infomaniak.ch` at priority `5`, but use the value in Infomaniak Manager if it differs.
4. Remove the three Cloudflare Email Routing MX records from the apex. A brief overlap is acceptable because Infomaniak's priority `5` is preferred over the current Cloudflare priorities `18`, `89`, and `99`; remove the Cloudflare records promptly rather than leaving a mixed configuration.
5. Delete the Cloudflare-managed apex SPF record, then create a new apex TXT record with Infomaniak's exact SPF value. Do not edit the Cloudflare-managed record in place because disabling Email Routing later could remove that same managed record.
6. Ensure mail-related Cloudflare records are DNS-only wherever proxy status is offered.
7. Confirm there is exactly one SPF record at `mw10013.com` and exactly the intended Infomaniak MX record.
8. Recheck that no record under `mail.mw10013.com` or `cf-bounce.mail.mw10013.com` changed.

Do not disable Cloudflare Email Routing until the tests below pass. Changing the apex MX records stops new mail from selecting Cloudflare while retaining its routing configuration for rollback. After a successful monitoring period, disable Email Routing; Cloudflare will remove any routing-related DNS records it still manages at the apex.

## 6. Test immediately

Use Gmail and one non-Google account to test:

1. Send a message to `michael@mw10013.com`.
2. Send a separate message to `support@mw10013.com`.
3. Confirm both arrive in the `michael@` inbox.
4. Reply from `michael@` and verify the visible sender.
5. Reply from `support@` and verify the visible sender is `support@mw10013.com`.
6. Inspect received-message headers and confirm SPF and DKIM pass.
7. Open Infomaniak **Mail Service -> Domains management -> DNS test** and confirm MX, SPF, and DKIM are healthy.
8. Send a Baton login email and confirm `noreply@mail.mw10013.com` still delivers normally.

DNS caches can continue using the previous MX records temporarily. Monitor both the new Infomaniak inbox and Gmail during the transition.

After all tests pass and mail has remained stable through at least the 300-second old MX TTL, disable Cloudflare Email Routing. Review the records Cloudflare proposes to remove before confirming and verify again that none belong to `mail.mw10013.com` or `cf-bounce.mail.mw10013.com`.

## 7. Add DMARC

Apex DMARC monitoring is live as of September 13, 2026 with `p=none`. Later enforcement to `quarantine` then `reject` is still required after report review; do not treat DMARC as finished.

After Infomaniak SPF and DKIM consistently pass:

1. Add one TXT record at `_dmarc.mw10013.com` with a monitoring policy:

   ```text
   v=DMARC1; p=none; rua=mailto:support@mw10013.com
   ```

   Completed September 13, 2026 and verified publicly. Reports go to `support@mw10013.com`, which delivers to the Infomaniak `michael@` inbox.

2. Review the reports and confirm Infomaniak is the only legitimate service sending as `@mw10013.com`.
3. Change the policy to `p=quarantine`.
4. After another successful review period, change it to `p=reject`.
5. Keep the separate existing policy at `_dmarc.mail.mw10013.com` unchanged.

DMARC reports are machine-generated XML attachments. A dedicated reporting service can replace delivery to `support@` if the reports become noisy.

## 8. Clean up

Only after all tests pass:

1. Remove the obsolete `support@` **Send mail as** entry from personal Gmail. While it remains, Gmail treats `support@mw10013.com` as one of its own addresses: a Gmail-sent test to `support@` gets an internal inbox copy with no `Received` headers in addition to the real external delivery to Infomaniak. Completed: only the default `mw10013@gmail.com` sender remains.
2. Update or remove the Gmail `to:(support@mw10013.com)` filter that stars, marks important, and applies the `mw10013/support` label. While it remains, it labels those Gmail-sent duplicate copies and makes them look like forwarded mail. Prefer deleting it once Infomaniak is the mailbox of record; if retained temporarily, add `Skip Inbox` understanding that it only affects incoming mail handling. Completed: filter deleted; label retained only for old messages.
3. Remove stale Cloudflare Email Routing records if disabling the service left any behind. Completed: `cf2024-1._domainkey.mw10013.com` deleted after verifying Email Routing shows no onboarded domain.
4. Keep `mw10013@gmail.com` as the Infomaniak login and recovery address.
5. Save a final export or screenshot of the working DNS records.

## 9. Use Gmail as a client for the Infomaniak inbox

Researched September 14, 2026. Question: can Gmail on the web and on iPhone show the Infomaniak inbox (both `michael@` and `support@`) and send as those identities.

Short answer: yes for viewing, yes for sending, but do not build the workflow on Gmail-web POP fetching plus **Send mail as**. Google is removing exactly that path in January 2027. Use IMAP on iPhone and treat Infomaniak Mail as the webmail of record.

### 9.1. One inbox, two identities; signatures do not cross over

- `support@mw10013.com` remains an alias into the `michael@mw10013.com` inbox. It has no separate inbox, password, or IMAP folder. Any client logged in as `michael@` sees mail sent to either address. Distinguish by the `To:` header, not by account.
- The Infomaniak **Settings -> Signatures -> Advanced Settings -> sender address** control only affects sending from the Infomaniak Mail web app at `https://ksuite.infomaniak.com/mail`. Infomaniak states there is no link between those signature settings and external mail clients. Each client defines its own `From:`.
- Consequence: no `michael@` signature file is needed to make Gmail or iPhone work, and creating one does not help them. Keep the existing `Support` signature identity only for sending as `support@` from Infomaniak webmail. Sending as `support@` from an external client works because the alias exists on the Mail Service, not because a signature exists.

### 9.2. Device passwords and server settings

The Infomaniak login password does not work for IMAP/SMTP. Create one device password per client so each can be revoked independently:

1. In Manager, open the Mail Service for `mw10013.com`, click `michael@mw10013.com`, open the **Devices** tab, click **Add a device**, name it (for example `gmail-app-iphone` or `apple-mail`), and copy the shown password once into a password manager. The same can be done from Infomaniak Mail web app -> Address settings -> Manage password.
2. Use the full address `michael@mw10013.com` as the username everywhere.

```text
IMAP: mail.infomaniak.com, port 993, SSL/TLS
SMTP: mail.infomaniak.com, port 587 + STARTTLS (recommended; 465 + SSL/TLS fallback)
Auth: required, username = michael@mw10013.com + device password
POP:  mail.infomaniak.com, port 995, SSL/TLS (avoid; see 9.3)
```

Do not mix POP and IMAP against the same mailbox. Infomaniak troubleshooting guidance is one protocol at a time for a given mailbox; POP plus IMAP together causes duplicates and sync surprises.

### 9.3. Gmail on the web: possible today, removed January 2027

The legacy bridge is **Check mail from other accounts** (POP3 fetch) plus **Send mail as** through Infomaniak SMTP:

1. Gmail web -> Settings -> See all settings -> Accounts and Import -> **Check mail from other accounts** -> Add `michael@mw10013.com` with POP server `mail.infomaniak.com:995`, SSL, username plus device password. Leaving a copy on the server is required if Infomaniak stays the mailbox of record.
2. In the same tab, **Send mail as** -> Add `michael@mw10013.com`, then `support@mw10013.com`, choosing the external-SMTP path with `mail.infomaniak.com:587`, TLS, username plus device password. Do not use the default Gmail relay for a custom domain: relaying breaks SPF/DKIM alignment and can show `on behalf of` in Outlook. Enable `Reply from the same address the message was sent to`. Verification codes arrive in the Infomaniak inbox.

Do not adopt this except as a short bridge:

- Google's removal notice states that starting January 2027, Gmail removes **Send as** for third-party addresses, Gmailify, and POP fetching on the web. Q3-Q4 2026 (now) is the transition period and Google says it may already restrict new configurations. Mobile IMAP access and Gmail-to-Gmail or Workspace Send-as are not affected.
- POP is one-way, polled rather than push, drops folders/labels, and Sent mail stays split between Gmail Sent and Infomaniak Sent.
- Re-adding a `support@` Send-as entry reintroduces the duplicate-copy behavior removed in section 8: Gmail-sent tests to `support@` get a local Gmail inbox copy with no `Received` headers alongside the real Infomaniak delivery.

Imported messages already pulled into Gmail stay after removal; only fetching and sending stop.

### 9.4. iPhone: supported and unaffected by the web removal

Google keeps third-party accounts in the Gmail mobile app. Infomaniak documents the Gmail-app path directly.

Option A, Gmail app (stays in the familiar app):

1. Gmail app -> profile -> Add another account -> **Other (IMAP)**.
2. Enter `michael@mw10013.com`, choose IMAP, enter the device password and `mail.infomaniak.com` for both incoming and outgoing servers.
3. The Infomaniak mailbox appears as a separate switchable account, not merged into `mw10013@gmail.com`. The mobile app cannot configure POP fetching into one merged inbox the way Gmail web did.

Limitation: the Gmail iOS app has no `From:` picker for IMAP-account aliases when composing, so plan phone sending as `support@` through option B or C.

Option B, Apple Mail:

Settings -> Apps -> Mail -> Mail Accounts -> Add Account -> Other -> Add Mail Account, choose IMAP, enter the section 9.2 servers, then add `support@mw10013.com` as an additional `From:` identity or second account entry pointing at the same mailbox. Verify SSL on (IMAP 993, SMTP 587 or 465) and SMTP authentication with the full address plus device password.

Option C, Infomaniak Mail iOS app:

Native alias and signature handling plus Push, versus IMAP polling in Gmail and Apple Mail. Use this on the phone if sending as `support@` from iOS matters. Infomaniak also offers signed `.mobileconfig` profiles for Apple Mail on iOS/macOS through its setup assistant at `https://config.infomaniak.com/`.

### 9.5. Sending as `support@` from clients

Because `support@` is a regular alias, Infomaniak SMTP accepts `From: support@mw10013.com` when authenticated as `michael@mw10013.com` with a device password. Configure the client identity, not the Infomaniak signature:

- Desktop clients with identities (Thunderbird and equivalents): add the account once as `michael@`, then add `support@` as an alternate identity using the same SMTP credentials.
- Clients without identities (Gmail iOS app IMAP): they send as the login address only. To send as `support@`, use Apple Mail with an alias identity, Infomaniak Mail app with the `Support` signature selected, or desktop webmail.
- Gmail-web bridge only: add two separate **Send mail as** entries, one per identity, both using Infomaniak SMTP.

### 9.6. Recommendation

- Keep Infomaniak as the mailbox of record. Do not POP-drain it into Gmail.
- On iPhone, add `michael@` as IMAP in the Gmail app if staying in that UI matters, and add Apple Mail or the Infomaniak Mail app for alias sending and Push.
- On desktop web, keep `ksuite.infomaniak.com/mail` pinned alongside Gmail rather than re-creating the deleted Gmail Send-as and filter from section 8.
- If a merged Gmail-web inbox is needed temporarily, the section 9.3 bridge works only until the January 2027 removal and should not gain new filters, labels, or automation.

## Rollback

If Infomaniak cannot receive mail:

1. If Cloudflare Email Routing has not yet been disabled, restore the recorded Cloudflare apex MX records and previous apex SPF value. Its existing `support@` routing rule should resume forwarding to Gmail after DNS propagation.
2. If Email Routing has already been disabled, enable it again, confirm or recreate the `support@` routing rule, and restore the recorded Cloudflare apex MX and SPF records.
3. Remove the Infomaniak apex MX record so only the Cloudflare MX set remains.
4. Continue forwarding `support@` to Gmail while correcting the Infomaniak configuration.
5. Monitor both Gmail and Infomaniak until the 300-second MX TTL and any external caches have passed.
6. Do not alter Baton's subdomain records during rollback.

## Mail retention

Messages in the inbox and ordinary folders have no expiration. Deleted messages normally remain in Trash for 30 days. Infomaniak takes daily backups, but kSuite Free does not include direct restoration; upgrading can unlock up to 30 days of backups. This is adequate for normal use if Trash is not manually emptied and important messages are not stored in Trash or Spam.

## Official references

- [kSuite prices and plan limits](https://www.infomaniak.com/en/ksuite/ksuite-pro/prices#comparision)
- [Understand Infomaniak account and mailbox identifiers](https://www.infomaniak.com/en/support/faq/1980/understanding-the-different-infomaniak-identifiers)
- [Link a domain to kSuite](https://www.infomaniak.com/en/support/faq/2629/link-a-domain-name-to-ksuite)
- [Create an email address](https://www.infomaniak.com/en/support/faq/1993/create-a-new-email-address-within-a-mail-service)
- [Create an alias](https://www.infomaniak.com/en/support/faq/2129/create-a-mail-address-alias)
- [Send from an alias](https://www.infomaniak.com/en/support/faq/2490/send-messages-from-a-different-email-address)
- [Configure Infomaniak mail with external DNS](https://www.infomaniak.com/en/support/faq/1775/link-an-infomaniak-mail-service-to-an-external-service)
- [Add Infomaniak DKIM to Cloudflare](https://www.infomaniak.com/en/support/faq/1619/add-infomaniak-dkim-to-cloudflare)
- [Restore deleted email](https://www.infomaniak.com/en/support/faq/1203/restore-a-mail-account-recover-deleted-emails)
- [Sync email across devices (IMAP/SMTP settings, device passwords)](https://www.infomaniak.com/en/support/faq/2427/sync-your-emails-across-all-your-devices)
- [Create a mail device password from the Mail Service](https://www.infomaniak.com/en/support/faq/1321/add-a-device-create-a-mail-password-from-the-mail-service)
- [Manage device passwords from Infomaniak webmail](https://www.infomaniak.com/en/support/faq/711/manage-devices-passwords-from-the-infomaniak-web-mail-app)
- [Configure Gmail app (iOS/Android) with IMAP](https://www.infomaniak.com/en/support/faq/1208/sync-gmail-ios-android)
- [Manually configure Apple Mail on iOS with IMAP](https://www.infomaniak.com/en/support/faq/2369/manually-configure-apple-mail-ios-using-imap-email)
- [Messaging ports and protocols](https://www.infomaniak.com/en/support/faq/468/understanding-messaging-ports-and-protocols)
- [Gmail: send from a different address](https://support.google.com/mail/answer/22370?hl=en)
- [Gmail: check mail from other accounts](https://support.google.com/mail/answer/21289?hl=en)
- [Gmail: add another account in the Gmail app](https://support.google.com/mail/answer/6078445?hl=en&co=GENIE.Platform%3DiOS)
- [Gmail: changes to third-party email support (Send-as and POP removal January 2027)](https://support.google.com/mail/answer/17101213?hl=en)
