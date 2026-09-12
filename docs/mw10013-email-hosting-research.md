# Set up Infomaniak email for `mw10013.com`

Updated: **September 12, 2026**.

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

Completed in Infomaniak:

- Added `mw10013.com` to kSuite as an **external** domain. The domain was not transferred.
- Created the Mail Service and primary mailbox `michael@mw10013.com`.
- Assigned the existing Michael Wu Infomaniak user to the mailbox.
- Created the active alias `support@mw10013.com`, which delivers into the `michael@` inbox.
- Created the `Support` sending identity with display name `Michael Wu` and both sender and reply address set to `support@mw10013.com`.

Current delivery remains unchanged:

- Cloudflare is still the registrar, authoritative DNS provider, and nameserver provider.
- Cloudflare Email Routing remains enabled.
- Cloudflare still forwards `support@mw10013.com` to `mw10013@gmail.com`.
- No Infomaniak DNS records have been added to Cloudflare yet.
- Infomaniak therefore still reports the external domain as disconnected.
- A Cloudflare DNS export was downloaded on September 12, 2026, before making any DNS changes.

### Resume here

No DNS changes are in progress, so it is safe to stop at this checkpoint.

In the next session, first open Infomaniak's **Connect domain** or **Global Security** screen and keep it open beside **Cloudflare -> mw10013.com -> DNS -> Records**. Add these non-disruptive records one at a time:

1. Add a CNAME named `autoconfig` pointing to `infomaniak.com`, with proxy status **DNS only** and TTL **Auto**.
2. Add a CNAME named `autodiscover` pointing to `infomaniak.com`, with proxy status **DNS only** and TTL **Auto**.
3. Add the Infomaniak DKIM TXT record using the exact host and value from Infomaniak. Copy both fields with Infomaniak's copy buttons because the displayed values may be truncated.

Each record can be added separately, with a pause between them. They do not change inbound mail delivery. The two CNAMEs help mail clients discover Infomaniak's settings; DKIM authenticates outbound Infomaniak mail.

After publishing DKIM:

1. Wait until a public DNS lookup returns the complete DKIM value.
2. Confirm Infomaniak recognizes DKIM as valid.
3. Send test messages from both the `michael@` and `support@` identities to validate them before changing inbound delivery.

SPF can still fail on those test messages because the apex SPF record still authorizes Cloudflare, not Infomaniak. DKIM should pass. Do not enforce apex DMARC until after the cutover.

Do **not** add the Infomaniak MX record, change the apex SPF record, disable Cloudflare Email Routing, or alter the existing Cloudflare `support@` routing rule during those three steps. MX and SPF will be handled later as a separate controlled cutover.

Do not change the domain's nameservers. Cloudflare remains authoritative for DNS.

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
4. In Infomaniak **Mail Service -> Global Security**, copy the exact MX, SPF, and DKIM values shown for `mw10013.com`.
5. Confirm the apex MX TTL is still 300 seconds. It was already 300 seconds on September 12, 2026, so no reduction was needed.

Current public apex records are:

```text
MX:  Cloudflare Email Routing
SPF: v=spf1 include:_spf.mx.cloudflare.net ~all
DMARC: absent
```

Infomaniak currently documents these generic values:

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
7. Open Infomaniak **Global Security** and confirm MX, SPF, and DKIM are healthy.
8. Send a Baton login email and confirm `noreply@mail.mw10013.com` still delivers normally.

DNS caches can continue using the previous MX records temporarily. Monitor both the new Infomaniak inbox and Gmail during the transition.

After all tests pass and mail has remained stable through at least the 300-second old MX TTL, disable Cloudflare Email Routing. Review the records Cloudflare proposes to remove before confirming and verify again that none belong to `mail.mw10013.com` or `cf-bounce.mail.mw10013.com`.

## 7. Add DMARC

After Infomaniak SPF and DKIM consistently pass:

1. Add one TXT record at `_dmarc.mw10013.com` with a monitoring policy:

   ```text
   v=DMARC1; p=none; rua=mailto:support@mw10013.com
   ```

2. Review the reports and confirm Infomaniak is the only legitimate service sending as `@mw10013.com`.
3. Change the policy to `p=quarantine`.
4. After another successful review period, change it to `p=reject`.
5. Keep the separate existing policy at `_dmarc.mail.mw10013.com` unchanged.

DMARC reports are machine-generated XML attachments. A dedicated reporting service can replace delivery to `support@` if the reports become noisy.

## 8. Clean up

Only after all tests pass:

1. Remove the obsolete `support@` **Send mail as** entry from personal Gmail.
2. Remove stale Cloudflare Email Routing rules if disabling the service left any behind.
3. Keep `mw10013@gmail.com` as the Infomaniak login and recovery address.
4. Save a final export or screenshot of the working DNS records.

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
