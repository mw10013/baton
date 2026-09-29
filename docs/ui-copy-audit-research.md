# Screen copy audit

Every string of two or more words on a merchant or member screen, read by slot rather than by page, from `scripts/copy-audit.ts` on 2026-09-29. The slot is a guess from the nearest attribute or element. Words already retired by `scripts/lib/rules-lint.ts` do not appear. Button and badge text are listed last; label constants read from the glossary (`Domain.ts`) are not listed.

One block per string. The quoted line is the copy as it is now, with «…» where a value is filled in. **Recommend** is the implementer's call: keep, cut, or rewrite with the new text, and for a link, keep or cut. **You** is yours: leave it blank to accept the recommendation, or write keep, cut, or the text you want, and anything else you want said. What the blocks agree on becomes the copy table and tone list on `Screen.ts` (`docs/ui-copy-spec-research.md`).

380 strings.

## heading (38)

### heading 1 · (DefaultErrorComponent.tsx) · `components/DefaultErrorComponent.tsx:21`

> Something went wrong

**Recommend:** keep — the boundary for an unknown error; the banner under it carries the message

**You:**

### heading 2 · (layout login-callback) · `routes/login-callback.tsx:60`

> Sign-in failed

**Recommend:** keep

**You:**

### heading 3 · (layout login) · `routes/login.tsx:116`

> Log in

**Recommend:** rewrite: Sign in — one verb for the member side: Sign in, Sign out; the section under it already says Sign in

**You:**

### heading 4 · (layout login) · `routes/login.tsx:125`

> Check your email

**Recommend:** keep

**You:**

### heading 5 · (layout login) · `routes/login.tsx:141`

> Sign in

**Recommend:** keep

**You:**

### heading 6 · (layout shop.$shop) · `routes/shop.$shop.tsx:119`

> No access

**Recommend:** keep

**You:**

### heading 7 · (UsedByCard.tsx) · `components/UsedByCard.tsx:23`

> Used by

**Recommend:** keep

**You:**

### heading 8 · (WorkflowSwitch.tsx) · `components/WorkflowSwitch.tsx:300`

> Turn on «workflow.name»?

**Recommend:** keep — a modal that asks names the thing and ends in ?

**You:**

### heading 9 · (WorkflowSwitch.tsx) · `components/WorkflowSwitch.tsx:374`

> Change the start date

**Recommend:** keep

**You:**

### heading 10 · (WorkflowTag.tsx) · `components/WorkflowTag.tsx:87`

> Edit tag

**Recommend:** keep

**You:**

### heading 11 · the home page · `routes/app.index.tsx:149`

> Usage and capacity

**Recommend:** keep

**You:**

### heading 12 · the home page · `routes/app.index.tsx:163`

> Orders this billing period

**Recommend:** keep

**You:**

### heading 13 · the members page · `routes/app.members.tsx:316`

> No members yet

**Recommend:** keep

**You:**

### heading 14 · the members page · `routes/app.members.tsx:449`

> Add member

**Recommend:** keep

**You:**

### heading 15 · the members page · `routes/app.members.tsx:512`

> Teams for «editing.email»

**Recommend:** keep

**You:**

### heading 16 · the order page · `routes/app.orders.$orderId.tsx:662`

> Order not found

**Recommend:** keep

**You:**

### heading 17 · the order page · `routes/app.orders.$orderId.tsx:1413`

> Change workflow?

**Recommend:** keep

**You:**

### heading 18 · the order page · `routes/app.orders.$orderId.tsx:1624`

> Order note

**Recommend:** keep

**You:**

### heading 19 · the order page · `routes/app.orders.$orderId.tsx:1629`

> Order details

**Recommend:** keep

**You:**

### heading 20 · the orders index · `routes/app.orders.index.tsx:504`

> No open orders

**Recommend:** keep

**You:**

### heading 21 · the orders index · `routes/app.orders.index.tsx:552`

> No order matches «Domain.normaliseOrderSearc…»

**Recommend:** keep — names what was searched for

**You:**

### heading 22 · the shop picker · `routes/shop.index.tsx:35`

> Your shops

**Recommend:** keep

**You:**

### heading 23 · the shop picker · `routes/shop.index.tsx:36`

> Your shops

**Recommend:** cut — this is the section's accessibilityLabel, and the section has a heading (the email)

**You:**

### heading 24 · the team page · `routes/app.teams.$teamId.tsx:453`

> Team members

**Recommend:** cut — this is the section's accessibilityLabel; the heading says Members

**You:**

### heading 25 · the team page · `routes/app.teams.$teamId.tsx:484`

> Rename team

**Recommend:** keep

**You:**

### heading 26 · the team page · `routes/app.teams.$teamId.tsx:539`

> Delete «team.name»?

**Recommend:** keep

**You:**

### heading 27 · the team page · `routes/app.teams.$teamId.tsx:609`

> Add members to «team.name»

**Recommend:** keep

**You:**

### heading 28 · the teams index · `routes/app.teams.index.tsx:148`

> No teams yet

**Recommend:** keep

**You:**

### heading 29 · the teams index · `routes/app.teams.index.tsx:283`

> Create team

**Recommend:** keep

**You:**

### heading 30 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:424`

> Workflow not found

**Recommend:** keep

**You:**

### heading 31 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:972`

> Delete «workflow.name»?

**Recommend:** keep

**You:**

### heading 32 · the workflow page (member) · `routes/shop.$shop.workflows.$runId.tsx:185`

> Not found

**Recommend:** rewrite: Workflow not found — the merchant's page says Workflow not found for the same case

**You:**

### heading 33 · the workflow page (merchant) · `routes/app.workflows.$workflowId.tsx:244`

> Workflow not found

**Recommend:** keep

**You:**

### heading 34 · the workflow page (merchant) · `routes/app.workflows.$workflowId.tsx:350`

> Turn on is unavailable

**Recommend:** keep

**You:**

### heading 35 · the workflow page (merchant) · `routes/app.workflows.$workflowId.tsx:448`

> Duplicate workflow

**Recommend:** keep

**You:**

### heading 36 · the workflow page (merchant) · `routes/app.workflows.$workflowId.tsx:510`

> Delete «workflow.name»?

**Recommend:** keep

**You:**

### heading 37 · the workflows index · `routes/app.workflows.index.tsx:239`

> No item workflows yet

**Recommend:** rewrite: No workflows yet — "item workflows" is not a glossary phrase; the page is Workflows

**You:**

### heading 38 · the workflows index · `routes/app.workflows.index.tsx:351`

> Create workflow

**Recommend:** keep

**You:**

## label (24)

### label 1 · (layout login-callback) · `routes/login-callback.tsx:61`

> Sign-in failed

**Recommend:** keep — the section has no heading, so the label is its accessible name

**You:**

### label 2 · (layout login) · `routes/login.tsx:126`

> Check your email

**Recommend:** cut — the section has a heading with the same words; the heading is the accessible name

**You:**

### label 3 · (layout shop.$shop) · `routes/shop.$shop.tsx:120`

> No access

**Recommend:** keep — the section has no heading, so the label is its accessible name

**You:**

### label 4 · (WorkflowSteps.tsx) · `components/WorkflowSteps.tsx:70`

> Edit «task.name»

**Recommend:** keep

**You:**

### label 5 · (WorkflowSwitch.tsx) · `components/WorkflowSwitch.tsx:322`

> Include them

**Recommend:** keep

**You:**

### label 6 · (WorkflowSwitch.tsx) · `components/WorkflowSwitch.tsx:381`

> Applies to orders placed since

**Recommend:** keep

**You:**

### label 7 · the home page · `routes/app.index.tsx:150`

> Orders and member capacity

**Recommend:** cut — the section has a heading; a second, different name for the same region is one more thing to keep in step

**You:**

### label 8 · the members page · `routes/app.members.tsx:427`

> Search members by email

**Recommend:** keep

**You:**

### label 9 · the order page · `routes/app.orders.$orderId.tsx:1169`

> Choose workflow

**Recommend:** rewrite: Workflow — the label names the field; the placeholder "Choose workflow" already asks

**You:**

### label 10 · the orders index · `routes/app.orders.index.tsx:773`

> Order number

**Recommend:** keep

**You:**

### label 11 · the team page · `routes/app.teams.$teamId.tsx:437`

> More actions

**Recommend:** keep

**You:**

### label 12 · the team page · `routes/app.teams.$teamId.tsx:628`

> Search members by email

**Recommend:** keep

**You:**

### label 13 · the teams index · `routes/app.teams.index.tsx:261`

> Search teams by name

**Recommend:** keep

**You:**

### label 14 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:676`

> More actions

**Recommend:** keep

**You:**

### label 15 · the workflow page (member) · `routes/shop.$shop.workflows.$runId.tsx:186`

> Not found

**Recommend:** keep — the section has no heading, so the label is its accessible name

**You:**

### label 16 · the workflow page (merchant) · `routes/app.workflows.$workflowId.tsx:310`

> More actions

**Recommend:** keep

**You:**

### label 17 · the workflows index · `routes/app.workflows.index.tsx:328`

> Search workflows by name

**Recommend:** keep

**You:**

### label 18 · the workflows list · `routes/shop.$shop.workflows.index.tsx:447`

> Open «run.lineItemTitle» on «run.orderName»

**Recommend:** keep

**You:**

### label 19 · the workflows list · `routes/shop.$shop.workflows.index.tsx:477`

> Actions for «run.orderName»

**Recommend:** keep

**You:**

### label 20 · the workflows list · `routes/shop.$shop.workflows.index.tsx:488`

> Actions for «run.orderName»

**Recommend:** keep

**You:**

### label 21 · the workflows list · `routes/shop.$shop.workflows.index.tsx:536`

> Open «entry.run.lineItemTitle» on «entry.run.orderName»

**Recommend:** keep

**You:**

### label 22 · the workflows list · `routes/shop.$shop.workflows.index.tsx:565`

> Actions for «entry.run.orderName»

**Recommend:** keep

**You:**

### label 23 · the workflows list · `routes/shop.$shop.workflows.index.tsx:576`

> Actions for «entry.run.orderName»

**Recommend:** keep

**You:**

### label 24 · the workflows list · `routes/shop.$shop.workflows.index.tsx:608`

> Open «entry.run.lineItemTitle» on «entry.run.orderName»

**Recommend:** keep

**You:**

## placeholder (11)

### placeholder 1 · (WorkflowTag.tsx) · `components/WorkflowTag.tsx:95`

> e.g. engraved

**Recommend:** keep — shows the shape of a value the label cannot

**You:**

### placeholder 2 · the members page · `routes/app.members.tsx:429`

> Search by email

**Recommend:** keep — a search field's label is hidden, so the placeholder is what names it; "Search by X" says the target

**You:**

### placeholder 3 · the order page · `routes/app.orders.$orderId.tsx:1171`

> Choose workflow

**Recommend:** keep — on a select, the placeholder is the unselected option's text

**You:**

### placeholder 4 · the order page · `routes/app.orders.$orderId.tsx:1421`

> Choose workflow

**Recommend:** keep — on a select, the placeholder is the unselected option's text

**You:**

### placeholder 5 · the orders index · `routes/app.orders.index.tsx:775`

> Order number

**Recommend:** keep — the label is hidden; the placeholder names the field

**You:**

### placeholder 6 · the team page · `routes/app.teams.$teamId.tsx:630`

> Search by email

**Recommend:** keep — a search field's label is hidden, so the placeholder is what names it; "Search by X" says the target

**You:**

### placeholder 7 · the teams index · `routes/app.teams.index.tsx:263`

> Search by name

**Recommend:** keep — a search field's label is hidden, so the placeholder is what names it; "Search by X" says the target

**You:**

### placeholder 8 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:477`

> Choose a team

**Recommend:** keep — on a select, the placeholder is the unselected option's text

**You:**

### placeholder 9 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:499`

> e.g. Engrave

**Recommend:** keep — shows the shape of a value the label cannot

**You:**

### placeholder 10 · the workflows index · `routes/app.workflows.index.tsx:330`

> Search by name

**Recommend:** keep — a search field's label is hidden, so the placeholder is what names it; "Search by X" says the target

**You:**

### placeholder 11 · the workflows index · `routes/app.workflows.index.tsx:360`

> e.g. Engraved ring

**Recommend:** keep — shows the shape of a value the label cannot

**You:**

## help (6)

### help 1 · (MemberTeamsFields.tsx) · `components/MemberTeamsFields.tsx:34`

> Optional. A member with no team has nothing to do yet.

**Recommend:** keep — states a consequence the merchant can trip on

**You:**

### help 2 · the members page · `routes/app.members.tsx:469`

> They'll sign in with this email on the member area. No Shopify account needed.

**Recommend:** rewrite: They sign in with this email. No Shopify account needed. — "on the member area" is not a screen name; the constraint is the second sentence

**You:**

### help 3 · the teams index · `routes/app.teams.index.tsx:303`

> You'll add members next.

**Recommend:** cut — tells the future instead of a constraint; the next screen shows it

**You:**

### help 4 · the workflow page (merchant) · `routes/app.workflows.$workflowId.tsx:475`

> Put this tag on the products the copy should build.

**Recommend:** keep — says what the tag does

**You:**

### help 5 · the workflows index · `routes/app.workflows.index.tsx:361`

> You'll add the steps next.

**Recommend:** cut — same as the team name field: not a constraint, the editor opens next

**You:**

### help 6 · the workflows index · `routes/app.workflows.index.tsx:371`

> Add this tag to your products in Shopify. Their items will follow this workflow.

**Recommend:** keep — says what the tag does

**You:**

## empty (30)

### empty 1 · (layout shop.$shop) · `routes/shop.$shop.tsx:123`

> You no longer have access to this shop.

**Recommend:** keep

**You:**

### empty 2 · (MemberTeamsFields.tsx) · `components/MemberTeamsFields.tsx:46`

> No members

**Recommend:** keep

**You:**

### empty 3 · (workflowShared.ts) · `lib/workflowShared.ts:194`

> No team on «taskList(orphans)». Assign one before you apply.

**Recommend:** keep

**You:**

### empty 4 · (workflowsListViews.ts) · `lib/workflowsListViews.ts:64`

> Nothing in hand.

**Recommend:** rewrite: Nothing started by you. — "in hand" is an idiom; the view is Started by you, and the sentence should echo it

**You:**

### empty 5 · (workflowsListViews.ts) · `lib/workflowsListViews.ts:66`

> Nothing to start.

**Recommend:** rewrite: Nothing is ready. — echoes the view label Ready

**You:**

### empty 6 · (workflowsListViews.ts) · `lib/workflowsListViews.ts:67`

> Nothing is blocked.

**Recommend:** keep

**You:**

### empty 7 · (workflowsListViews.ts) · `lib/workflowsListViews.ts:68`

> Nothing done or closed in the last day.

**Recommend:** keep

**You:**

### empty 8 · (WorkflowSteps.tsx) · `components/WorkflowSteps.tsx:28`

> No team

**Recommend:** keep

**You:**

### empty 9 · the members page · `routes/app.members.tsx:332`

> No members match.

**Recommend:** keep

**You:**

### empty 10 · the order page · `routes/app.orders.$orderId.tsx:329`

> No members on

**Recommend:** keep · link keep — the act (add members) is on the team page, and the link is the team's name

**You:**

### empty 11 · the order page · `routes/app.orders.$orderId.tsx:707`

> Nothing changed.

**Recommend:** keep — a refusal with no message; the write did nothing

**You:**

### empty 12 · the order page · `routes/app.orders.$orderId.tsx:1247`

> No workflows can start.

**Recommend:** rewrite: No workflow matches this item. Create one on Workflows. · link keep — the empty sentence is a fact; the act is off-screen, so a link stays, and its text is the target screen's heading

**You:**

### empty 13 · the order page · `routes/app.orders.$orderId.tsx:1271`

> Nothing starts on this item until you choose a workflow.

**Recommend:** keep

**You:**

### empty 14 · the order page · `routes/app.orders.$orderId.tsx:1402`

> No items.

**Recommend:** keep

**You:**

### empty 15 · the orders index · `routes/app.orders.index.tsx:190`

> No open orders.

**Recommend:** keep

**You:**

### empty 16 · the orders index · `routes/app.orders.index.tsx:191`

> No open orders have issues.

**Recommend:** keep

**You:**

### empty 17 · the orders index · `routes/app.orders.index.tsx:192`

> No open orders are waiting to start.

**Recommend:** keep

**You:**

### empty 18 · the orders index · `routes/app.orders.index.tsx:193`

> Nothing is being made.

**Recommend:** keep

**You:**

### empty 19 · the orders index · `routes/app.orders.index.tsx:196`

> No orders are made and waiting to be fulfilled.

**Recommend:** keep

**You:**

### empty 20 · the orders index · `routes/app.orders.index.tsx:198`

> No orders have been fulfilled yet.

**Recommend:** keep

**You:**

### empty 21 · the orders index · `routes/app.orders.index.tsx:199`

> No cancelled orders.

**Recommend:** keep

**You:**

### empty 22 · the orders index · `routes/app.orders.index.tsx:200`

> No orders stored.

**Recommend:** rewrite: No orders yet. — "stored" is an implementation word

**You:**

### empty 23 · the orders index · `routes/app.orders.index.tsx:203`

> No orders match these filters.

**Recommend:** keep

**You:**

### empty 24 · the shop picker · `routes/shop.index.tsx:39`

> You do not have access to any shops yet. Ask your shop owner to add

**Recommend:** rewrite: You don't have access to any shops yet. Ask the shop owner to add your email on their Members page. — contraction; "the shop owner" as the merchant's word; names the screen where the act is

**You:**

### empty 25 · the team page · `routes/app.teams.$teamId.tsx:354`

> No members yet

**Recommend:** rewrite: No members yet — keep; the body under it changes (see body 142)

**You:**

### empty 26 · the team page · `routes/app.teams.$teamId.tsx:360`

> No members yet

**Recommend:** rewrite: Nobody on this team yet — the shop has members, the team has none; "No members yet" reads as the shop having none

**You:**

### empty 27 · the team page · `routes/app.teams.$teamId.tsx:638`

> No members match.

**Recommend:** keep

**You:**

### empty 28 · the teams index · `routes/app.teams.index.tsx:163`

> No teams match.

**Recommend:** keep

**You:**

### empty 29 · the workflows index · `routes/app.workflows.index.tsx:249`

> No item workflows match.

**Recommend:** keep

**You:**

### empty 30 · the workflows list · `routes/shop.$shop.workflows.index.tsx:803`

> You’re not on a team yet. Ask the shop owner to add you to

**Recommend:** keep — fact, then the act, which is off-screen

**You:**

## banner (8)

### banner 1 · (QuotaBanners.tsx) · `components/QuotaBanners.tsx:27`

> Baton is built for shops under «formatNumber(Domain.ShopLi…» orders a billing period, so new orders have stopped syncing.

**Recommend:** rewrite: New orders stopped syncing at «N» this billing period. — the fact first, without the app naming itself; the effect and the reset date follow

**You:**

### banner 2 · (QuotaBanners.tsx) · `components/QuotaBanners.tsx:30`

> Syncing resumes on

**Recommend:** rewrite: Syncing resumes on «date». — keeps the reset date as its own sentence

**You:**

### banner 3 · (QuotaBanners.tsx) · `components/QuotaBanners.tsx:38`

> Baton stopped attaching workflows because «formatNumber(Domain.ShopLi…» items are in production. Cancel a workflow, or wait until an item is done or closed.

**Recommend:** keep — fact, effect, what clears it

**You:**

### banner 4 · the order page · `routes/app.orders.$orderId.tsx:656`

> Could not load the order.

**Recommend:** rewrite: Couldn't load the order. — contractions throughout (Shopify grammar guide); every refusal starts "Couldn't"

**You:**

### banner 5 · the order page · `routes/app.orders.$orderId.tsx:1382`

> Every item is done.

**Recommend:** keep · link keep — the act is in Shopify; see link 4 for its text

**You:**

### banner 6 · the orders index · `routes/app.orders.index.tsx:528`

> Could not load orders.

**Recommend:** rewrite: Couldn't load orders. — contractions throughout (Shopify grammar guide); every refusal starts "Couldn't"

**You:**

### banner 7 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:702`

> Turn on is unavailable

**Recommend:** keep — the banner heading names what is unavailable; the body names the act

**You:**

### banner 8 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:702`

> Not ready to apply

**Recommend:** keep — the banner heading names what is unavailable; the body names the act

**You:**

## toast (13)

### toast 1 · (workflowShared.ts) · `lib/workflowShared.ts:84`

> Workflow renamed

**Recommend:** keep

**You:**

### toast 2 · (workflowShared.ts) · `lib/workflowShared.ts:85`

> Workflow deleted

**Recommend:** keep

**You:**

### toast 3 · (WorkflowSwitch.tsx) · `components/WorkflowSwitch.tsx:223`

> Turned on

**Recommend:** keep

**You:**

### toast 4 · the order page · `routes/app.orders.$orderId.tsx:546`

> Nothing changed.

**Recommend:** keep — an error toast for a refusal with no message

**You:**

### toast 5 · the order page · `routes/app.orders.$orderId.tsx:833`

> «task.name» done

**Recommend:** keep

**You:**

### toast 6 · the order page · `routes/app.orders.$orderId.tsx:847`

> «task.name» put back

**Recommend:** keep

**You:**

### toast 7 · the order page · `routes/app.orders.$orderId.tsx:861`

> «task.name» reopened

**Recommend:** keep

**You:**

### toast 8 · the order page · `routes/app.orders.$orderId.tsx:1507`

> «cancelling.workflowName» cancelled on «cancelling.item».

**Recommend:** rewrite: «workflow» cancelled on «item» — a one-phrase toast has no period; only a two-sentence toast is punctuated

**You:**

### toast 9 · the order page · `routes/app.orders.$orderId.tsx:1580`

> Note saved

**Recommend:** keep

**You:**

### toast 10 · the order page · `routes/app.orders.$orderId.tsx:1617`

> Reason saved

**Recommend:** keep

**You:**

### toast 11 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:280`

> Changes applied. New items get this version.

**Recommend:** keep — two sentences, so punctuated

**You:**

### toast 12 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:302`

> Draft discarded.

**Recommend:** rewrite: Draft discarded — a one-phrase toast has no period; only a two-sentence toast is punctuated

**You:**

### toast 13 · the workflow page (merchant) · `routes/app.workflows.$workflowId.tsx:187`

> Copied to “«result.workflow.name»”.

**Recommend:** rewrite: Copied to “«name»” — a one-phrase toast has no period; only a two-sentence toast is punctuated

**You:**

## error (5)

### error 1 · (layout login-callback) · `routes/login-callback.tsx:30`

> Magic link sign-in could not be completed.

**Recommend:** rewrite: Couldn't complete sign-in. — contractions throughout (Shopify grammar guide); every refusal starts "Couldn't"; the link under it says what to do

**You:**

### error 2 · (layout login-callback) · `routes/login-callback.tsx:52`

> This magic link is invalid or has expired.

**Recommend:** rewrite: This magic link has expired or was already used. — "invalid" is on Shopify's list of words to avoid; say what happened

**You:**

### error 3 · (layout login) · `routes/login.tsx:53`

> Too many attempts. Try again later.

**Recommend:** keep

**You:**

### error 4 · (useMemberRunActions.ts) · `lib/useMemberRunActions.ts:19`

> Couldn't save. Try again.

**Recommend:** keep

**You:**

### error 5 · the orders index · `routes/app.orders.index.tsx:161`

> Could not read import status.

**Recommend:** keep

**You:**

## confirm (14)

### confirm 1 · (WorkflowSwitch.tsx) · `components/WorkflowSwitch.tsx:312`

> Your tasks are applied at the same time.

**Recommend:** keep

**You:**

### confirm 2 · (WorkflowSwitch.tsx) · `components/WorkflowSwitch.tsx:316`

> Checking earlier orders…

**Recommend:** keep — a loading state is named so a disabled button does not read as broken

**You:**

### confirm 3 · (WorkflowSwitch.tsx) · `components/WorkflowSwitch.tsx:377`

> It starts on orders placed on or after this date. Earlier orders are

**Recommend:** keep

**You:**

### confirm 4 · (WorkflowTag.tsx) · `components/WorkflowTag.tsx:90`

> Put this tag on the products this workflow should build, in Shopify. Changing it here changes nothing on your products.

**Recommend:** keep

**You:**

### confirm 5 · the members page · `routes/app.members.tsx:546`

> Remove member?

**Recommend:** keep — the null fallback; never rendered while the modal is open

**You:**

### confirm 6 · the members page · `routes/app.members.tsx:546`

> Remove «removing.email»?

**Recommend:** keep

**You:**

### confirm 7 · the members page · `routes/app.members.tsx:551`

> They leave their teams and can no longer sign in. This will leave «removingEmptied.join(", ")» with no members.

**Recommend:** keep

**You:**

### confirm 8 · the members page · `routes/app.members.tsx:552`

> They leave their teams and can no longer sign in. Their past work stays on the record.

**Recommend:** keep

**You:**

### confirm 9 · the team page · `routes/app.teams.$teamId.tsx:566`

> Remove member?

**Recommend:** keep — the null fallback; never rendered while the modal is open

**You:**

### confirm 10 · the team page · `routes/app.teams.$teamId.tsx:567`

> Remove «removingMember.email»?

**Recommend:** keep

**You:**

### confirm 11 · the team page · `routes/app.teams.$teamId.tsx:572`

> Remove «removingMember.email» from «team.name»? They keep access to the shop and their other teams.

**Recommend:** keep

**You:**

### confirm 12 · the team page · `routes/app.teams.$teamId.tsx:573`

> «team.name» will have no members.

**Recommend:** keep

**You:**

### confirm 13 · the team page · `routes/app.teams.$teamId.tsx:621`

> This shop has no members yet. Add them once, then put them on teams.

**Recommend:** rewrite: This shop has no members yet. Add them on Members, then put them on teams. — names the screen where the act is; the primary button already goes there

**You:**

### confirm 14 · the team page · `routes/app.teams.$teamId.tsx:622`

> Everyone is already on this team.

**Recommend:** keep

**You:**

## link (6)

### link 1 · (layout login) · link · `routes/login.tsx:135`

> Open your magic link

**Recommend:** keep

**You:**

### link 2 · (MemberRun.tsx) · link · `components/MemberRun.tsx:238`

> Show less

**Recommend:** keep

**You:**

### link 3 · (MemberRun.tsx) · link · `components/MemberRun.tsx:238`

> Show more

**Recommend:** keep

**You:**

### link 4 · the order page · link · `routes/app.orders.$orderId.tsx:1384`

> Fulfil this order in the Shopify admin

**Recommend:** rewrite: Fulfil in Shopify — the orders index says Fulfil in Shopify for the same act; one text for one destination

**You:**

### link 5 · the orders index · link · `routes/app.orders.index.tsx:634`

> Fulfil in Shopify

**Recommend:** keep

**You:**

### link 6 · the orders index · link · `routes/app.orders.index.tsx:635`

> View in Shopify

**Recommend:** keep

**You:**

## button (48)

### button 1 · (DefaultErrorComponent.tsx) · `components/DefaultErrorComponent.tsx:45`

> Try again

**Recommend:** keep

**You:**

### button 2 · (DefaultErrorComponent.tsx) · `components/DefaultErrorComponent.tsx:56`

> Back to app home

**Recommend:** rewrite: Back to Baton — the home page's heading is Baton; "app home" is not a screen name

**You:**

### button 3 · (layout login) · `routes/login.tsx:177`

> Send magic link

**Recommend:** keep

**You:**

### button 4 · (ManagePlanButton.tsx) · `components/ManagePlanButton.tsx:76`

> Manage plan

**Recommend:** keep

**You:**

### button 5 · (MemberBar.tsx) · `components/MemberBar.tsx:86`

> Sign out

**Recommend:** keep

**You:**

### button 6 · (WorkflowSwitch.tsx) · `components/WorkflowSwitch.tsx:284`

> Turn off

**Recommend:** keep

**You:**

### button 7 · (WorkflowSwitch.tsx) · `components/WorkflowSwitch.tsx:294`

> Turn on

**Recommend:** keep

**You:**

### button 8 · (WorkflowSwitch.tsx) · `components/WorkflowSwitch.tsx:348`

> Turn on

**Recommend:** keep

**You:**

### button 9 · (WorkflowSwitch.tsx) · `components/WorkflowSwitch.tsx:370`

> Turn off

**Recommend:** keep

**You:**

### button 10 · (WorkflowTag.tsx) · `components/WorkflowTag.tsx:84`

> Edit tag

**Recommend:** keep

**You:**

### button 11 · the members page · `routes/app.members.tsx:287`

> Add member

**Recommend:** keep

**You:**

### button 12 · the members page · `routes/app.members.tsx:339`

> Clear filters

**Recommend:** rewrite: Clear search — the members page has a search and no filter

**You:**

### button 13 · the members page · `routes/app.members.tsx:372`

> Edit teams

**Recommend:** keep

**You:**

### button 14 · the order page · `routes/app.orders.$orderId.tsx:1355`

> View in Shopify

**Recommend:** keep

**You:**

### button 15 · the order page · `routes/app.orders.$orderId.tsx:1365`

> Resync from Shopify

**Recommend:** keep

**You:**

### button 16 · the order page · `routes/app.orders.$orderId.tsx:1452`

> Keep «changing.from»

**Recommend:** rewrite: Cancel — the dismiss verb is Cancel everywhere (workflowShared.ts says so); "Keep X" is a second convention

**You:**

### button 17 · the order page · `routes/app.orders.$orderId.tsx:1495`

> Keep workflow

**Recommend:** keep — the one modal where Cancel would sit beside a primary that says Cancel workflow; Keep workflow is the exception, and its JSDoc should say so

**You:**

### button 18 · the order page · `routes/app.orders.$orderId.tsx:1550`

> Keep «assigning.teamName»

**Recommend:** rewrite: Cancel — same as button 16

**You:**

### button 19 · the orders index · `routes/app.orders.index.tsx:485`

> Import open orders

**Recommend:** keep

**You:**

### button 20 · the orders index · `routes/app.orders.index.tsx:724`

> Show issues

**Recommend:** keep

**You:**

### button 21 · the shop picker · `routes/shop.index.tsx:61`

> Sign out

**Recommend:** keep

**You:**

### button 22 · the team page · `routes/app.teams.$teamId.tsx:347`

> Add members

**Recommend:** keep

**You:**

### button 23 · the team page · `routes/app.teams.$teamId.tsx:432`

> Orders waiting on this team

**Recommend:** keep

**You:**

### button 24 · the team page · `routes/app.teams.$teamId.tsx:435`

> More actions

**Recommend:** keep

**You:**

### button 25 · the team page · `routes/app.teams.$teamId.tsx:676`

> Go to Members

**Recommend:** keep — link text is the target screen's heading

**You:**

### button 26 · the team page · `routes/app.teams.$teamId.tsx:688`

> Add «String(selected.length)»

**Recommend:** keep

**You:**

### button 27 · the teams index · `routes/app.teams.index.tsx:137`

> Create team

**Recommend:** keep

**You:**

### button 28 · the teams index · `routes/app.teams.index.tsx:170`

> Clear filters

**Recommend:** rewrite: Clear search — the teams index has a search and no filter

**You:**

### button 29 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:545`

> Add step

**Recommend:** keep

**You:**

### button 30 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:545`

> Add task

**Recommend:** keep

**You:**

### button 31 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:585`

> Add a task to this step

**Recommend:** rewrite: Add task — the add form's button says Add task; one label for one act

**You:**

### button 32 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:612`

> Add the first step

**Recommend:** rewrite: Add step — the add form's button says Add step

**You:**

### button 33 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:612`

> Add a step

**Recommend:** rewrite: Add step — same as button 32

**You:**

### button 34 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:635`

> More actions

**Recommend:** keep

**You:**

### button 35 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:657`

> Discard changes

**Recommend:** keep

**You:**

### button 36 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:672`

> Apply changes

**Recommend:** keep

**You:**

### button 37 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:798`

> Move earlier

**Recommend:** keep

**You:**

### button 38 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:812`

> Move later

**Recommend:** keep

**You:**

### button 39 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:822`

> Move to its own step

**Recommend:** keep

**You:**

### button 40 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:833`

> Join the previous step

**Recommend:** keep

**You:**

### button 41 · the workflow page (merchant) · `routes/app.workflows.$workflowId.tsx:308`

> More actions

**Recommend:** keep

**You:**

### button 42 · the workflows index · `routes/app.workflows.index.tsx:229`

> Create workflow

**Recommend:** keep

**You:**

### button 43 · the workflows index · `routes/app.workflows.index.tsx:257`

> Clear filters

**Recommend:** keep — the workflows index has a status filter as well as a search

**You:**

### button 44 · the workflows list · `routes/shop.$shop.workflows.index.tsx:646`

> Show «String(Math.min(Domain.RUN…» more of «String(hidden)»

**Recommend:** keep

**You:**

### button 45 · the workflows list · `routes/shop.$shop.workflows.index.tsx:680`

> All teams

**Recommend:** keep

**You:**

### button 46 · the workflows list · `routes/shop.$shop.workflows.index.tsx:681`

> All teams

**Recommend:** keep

**You:**

### button 47 · the workflows list · `routes/shop.$shop.workflows.index.tsx:689`

> All teams · «String(list.counts.total)»

**Recommend:** keep

**You:**

### button 48 · the workflows list · `routes/shop.$shop.workflows.index.tsx:766`

> Go to «VIEW_LABEL[goTo]» · «String(list.counts[goTo])»

**Recommend:** keep

**You:**

## badge (4)

### badge 1 · (MemberRun.tsx) · `components/MemberRun.tsx:87`

> Quantity changed · «formatNumber(run.quantityC…» → «formatNumber(run.quantity)»

**Recommend:** keep

**You:**

### badge 2 · the members page · `routes/app.members.tsx:294`

> No teams

**Recommend:** keep

**You:**

### badge 3 · the orders index · `routes/app.orders.index.tsx:456`

> Unknown team

**Recommend:** rewrite: Deleted team — the team filter on the same page calls this case Deleted team

**You:**

### badge 4 · the teams index · `routes/app.teams.index.tsx:195`

> No members

**Recommend:** keep

**You:**

## body (173)

### body 1 · (changeWarning.ts) · `lib/changeWarning.ts:41`

> «formatNumber(done)» of «total» steps done

**Recommend:** keep

**You:**

### body 2 · (changeWarning.ts) · `lib/changeWarning.ts:42`

> «formatNumber(started)» of «total» steps started

**Recommend:** keep

**You:**

### body 3 · (changeWarning.ts) · `lib/changeWarning.ts:43`

> That work and the note

**Recommend:** keep

**You:**

### body 4 · (changeWarning.ts) · `lib/changeWarning.ts:43`

> That work

**Recommend:** keep

**You:**

### body 5 · (changeWarning.ts) · `lib/changeWarning.ts:44`

> «from» has «progress». Change to «to» anyway? «lost» will not carry over.

**Recommend:** keep

**You:**

### body 6 · (changeWarning.ts) · `lib/changeWarning.ts:49`

> Cancel «workflow» on «item»?

**Recommend:** keep

**You:**

### body 7 · (changeWarning.ts) · `lib/changeWarning.ts:60`

> Work on it stops. Steps already done stay on record. You can attach another workflow to the item afterwards.

**Recommend:** keep

**You:**

### body 8 · (layout __root) · `routes/__root.tsx:30`

> Baton | Made-to-order production workflows

**Recommend:** rewrite: Baton — Made-to-order production workflows — every other title uses the em dash separator

**You:**

### body 9 · (layout __root) · `routes/__root.tsx:46`

> Not Found

**Recommend:** rewrite: Not found — sentence case, as every other heading

**You:**

### body 10 · (layout login) · `routes/login.tsx:83`

> Log in — Baton

**Recommend:** rewrite: Sign in — Baton — with heading 3

**You:**

### body 11 · (layout login) · `routes/login.tsx:111`

> Could not send the magic link.

**Recommend:** rewrite: Couldn't send the magic link. — contractions throughout (Shopify grammar guide); every refusal starts "Couldn't"

**You:**

### body 12 · (layout login) · `routes/login.tsx:130`

> If that email has access to a shop, a magic sign-in link has been

**Recommend:** keep

**You:**

### body 13 · (layout login) · `routes/login.tsx:145`

> Demo mode: no emails are sent — the magic link appears here after you submit.

**Recommend:** keep — dev only

**You:**

### body 14 · (layout login) · `routes/login.tsx:146`

> Enter your email to receive a magic sign-in link.

**Recommend:** keep

**You:**

### body 15 · (layout shop.$shop) · `routes/shop.$shop.tsx:125`

> Your shops

**Recommend:** keep

**You:**

### body 16 · (layout shop) · `routes/shop.tsx:19`

> Your shops — Baton

**Recommend:** keep

**You:**

### body 17 · (MemberRun.tsx) · `components/MemberRun.tsx:32`

> Fulfilled in Shopify

**Recommend:** keep

**You:**

### body 18 · (MemberRun.tsx) · `components/MemberRun.tsx:33`

> Order cancelled in Shopify

**Recommend:** keep

**You:**

### body 19 · (MemberRun.tsx) · `components/MemberRun.tsx:34`

> Item removed or refunded in Shopify

**Recommend:** keep

**You:**

### body 20 · (MemberRun.tsx) · `components/MemberRun.tsx:36`

> Cancelled by you

**Recommend:** keep

**You:**

### body 21 · (MemberRun.tsx) · `components/MemberRun.tsx:36`

> Cancelled by the merchant

**Recommend:** keep

**You:**

### body 22 · (MemberRun.tsx) · `components/MemberRun.tsx:169`

> SKU «run.sku»

**Recommend:** keep

**You:**

### body 23 · (RunSteps.tsx) · `components/RunSteps.tsx:61`

> «task.teamName» · since

**Recommend:** keep

**You:**

### body 24 · (RunSteps.tsx) · `components/RunSteps.tsx:62`

> «task.teamName» · «Domain.actorLabel(startedBy)» · since

**Recommend:** keep

**You:**

### body 25 · (RunSteps.tsx) · `components/RunSteps.tsx:133`

> Reopened by «Domain.actorLabel(reopened…» ·

**Recommend:** keep

**You:**

### body 26 · (RunSteps.tsx) · `components/RunSteps.tsx:156`

> Step «String(step)»

**Recommend:** keep

**You:**

### body 27 · (RunTextModals.tsx) · `components/RunTextModals.tsx:15`

> «formatNumber(maxLength - d…» characters left

**Recommend:** keep

**You:**

### body 28 · (RunTextModals.tsx) · `components/RunTextModals.tsx:207`

> Block reason

**Recommend:** keep

**You:**

### body 29 · (RunTextModals.tsx) · `components/RunTextModals.tsx:208`

> Block «run.lineItemTitle» on «run.orderName»?

**Recommend:** keep

**You:**

### body 30 · (UsedByCard.tsx) · `components/UsedByCard.tsx:25`

> Not used by any workflow yet.

**Recommend:** keep

**You:**

### body 31 · (useMemberRunActions.ts) · `lib/useMemberRunActions.ts:15`

> Still connecting. Try again in a moment.

**Recommend:** keep — one sentence, one fix, the same everywhere

**You:**

### body 32 · (useMemberRunActions.ts) · `lib/useMemberRunActions.ts:26`

> That work no longer exists.

**Recommend:** rewrite: This workflow no longer exists. — "work" is not a glossary word; the member's row is the item's workflow

**You:**

### body 33 · (useMemberRunActions.ts) · `lib/useMemberRunActions.ts:31`

> That isn't available on this work now. It changed, or it belongs to another team.

**Recommend:** rewrite: This changed just now, or belongs to another team. Refresh. — "work" is not a glossary word; say what to do

**You:**

### body 34 · (useMemberRunActions.ts) · `lib/useMemberRunActions.ts:34`

> This work is no longer blocked.

**Recommend:** rewrite: This workflow is no longer blocked. — same

**You:**

### body 35 · (useMemberRunActions.ts) · `lib/useMemberRunActions.ts:37`

> This task or an earlier one changed just now, or this task is waiting on another team. Refresh.

**Recommend:** keep

**You:**

### body 36 · (useMemberRunActions.ts) · `lib/useMemberRunActions.ts:39`

> This work is already done or closed.

**Recommend:** rewrite: This workflow is already done or closed. — same

**You:**

### body 37 · (useMemberRunActions.ts) · `lib/useMemberRunActions.ts:42`

> This work was blocked just now. Unblock it first.

**Recommend:** rewrite: This workflow was blocked just now. Unblock it first. — same

**You:**

### body 38 · (useMemberRunActions.ts) · `lib/useMemberRunActions.ts:44`

> «teamName» already started «taskName». Ask them.

**Recommend:** keep

**You:**

### body 39 · (workflowShared.ts) · `lib/workflowShared.ts:21`

> A workflow with that name already exists.

**Recommend:** keep

**You:**

### body 40 · (workflowShared.ts) · `lib/workflowShared.ts:35`

> “«tag»” is already «workflowName»'s tag. Choose another.

**Recommend:** keep

**You:**

### body 41 · (workflowShared.ts) · `lib/workflowShared.ts:44`

> That workflow no longer exists.

**Recommend:** keep

**You:**

### body 42 · (workflowShared.ts) · `lib/workflowShared.ts:46`

> This shop has reached its limit of «String(limit)» workflows.

**Recommend:** rewrite: A shop can have «limit» workflows. Delete one to add another. — the team limit message has this shape; one shape for every limit

**You:**

### body 43 · (workflowShared.ts) · `lib/workflowShared.ts:54`

> That workflow no longer exists.

**Recommend:** keep

**You:**

### body 44 · (workflowShared.ts) · `lib/workflowShared.ts:74`

> Apply changes?

**Recommend:** keep — a modal that asks ends in ?

**You:**

### body 45 · (workflowShared.ts) · `lib/workflowShared.ts:76`

> This workflow is turned on. Once you apply changes, they'll take effect immediately. Items already on it keep the tasks they started with.

**Recommend:** rewrite: This workflow is on, so the changes take effect now. Items already on it keep the tasks they started with. — the state word is On; "immediately" and "once you apply" restate the button

**You:**

### body 46 · (workflowShared.ts) · `lib/workflowShared.ts:77`

> Discard changes?

**Recommend:** keep — a modal that asks ends in ?

**You:**

### body 47 · (workflowShared.ts) · `lib/workflowShared.ts:78`

> Are you sure you want to discard these changes?

**Recommend:** rewrite: Your unsaved changes will be lost. — the heading already asks Discard changes?; the body says the consequence, never "Are you sure"

**You:**

### body 48 · (workflowShared.ts) · `lib/workflowShared.ts:79`

> Turn off workflow?

**Recommend:** keep — a modal that asks ends in ?

**You:**

### body 49 · (workflowShared.ts) · `lib/workflowShared.ts:81`

> New orders won't start this workflow. Items already on it keep going.

**Recommend:** keep

**You:**

### body 50 · (workflowShared.ts) · `lib/workflowShared.ts:82`

> Rename workflow

**Recommend:** keep

**You:**

### body 51 · (workflowShared.ts) · `lib/workflowShared.ts:83`

> New name

**Recommend:** keep

**You:**

### body 52 · (workflowShared.ts) · `lib/workflowShared.ts:93`

> This workflow will be permanently deleted. Items already on it keep their tasks.

**Recommend:** keep — says what survives

**You:**

### body 53 · (workflowShared.ts) · `lib/workflowShared.ts:102`

> Starts when an order contains a product tagged “«tag»”. Orders placed before this workflow was turned on are skipped.

**Recommend:** keep

**You:**

### body 54 · (workflowShared.ts) · `lib/workflowShared.ts:106`

> Every order placed from now with an item tagged “«tag»” will start this workflow on that item.

**Recommend:** keep

**You:**

### body 55 · (workflowShared.ts) · `lib/workflowShared.ts:113`

> That workflow no longer exists.

**Recommend:** keep

**You:**

### body 56 · (workflowShared.ts) · `lib/workflowShared.ts:114`

> This workflow is off, so there is no date to change.

**Recommend:** keep

**You:**

### body 57 · (workflowShared.ts) · `lib/workflowShared.ts:128`

> Turned off

**Recommend:** keep

**You:**

### body 58 · (workflowShared.ts) · `lib/workflowShared.ts:145`

> «verb». «orders» moved to the workflow that still matches.

**Recommend:** keep

**You:**

### body 59 · (workflowShared.ts) · `lib/workflowShared.ts:211`

> That task

**Recommend:** keep

**You:**

### body 60 · (workflowShared.ts) · `lib/workflowShared.ts:211`

> Those tasks

**Recommend:** keep

**You:**

### body 61 · (workflowsListViews.ts) · `lib/workflowsListViews.ts:52`

> Started by you

**Recommend:** keep

**You:**

### body 62 · (workflowsListViews.ts) · `lib/workflowsListViews.ts:53`

> Started by others

**Recommend:** keep

**You:**

### body 63 · (workflowsListViews.ts) · `lib/workflowsListViews.ts:56`

> Done or closed

**Recommend:** keep

**You:**

### body 64 · (workflowsListViews.ts) · `lib/workflowsListViews.ts:65`

> Nobody else has work.

**Recommend:** rewrite: Nothing started by others. — echoes the view label Started by others

**You:**

### body 65 · (WorkflowSteps.tsx) · `components/WorkflowSteps.tsx:116`

> Step «String(index + 1)»

**Recommend:** keep

**You:**

### body 66 · (WorkflowSwitch.tsx) · `components/WorkflowSwitch.tsx:63`

> That workflow no longer exists.

**Recommend:** keep

**You:**

### body 67 · (WorkflowSwitch.tsx) · `components/WorkflowSwitch.tsx:64`

> Add a step to this workflow.

**Recommend:** keep

**You:**

### body 68 · (WorkflowSwitch.tsx) · `components/WorkflowSwitch.tsx:66`

> Assign a team to «taskNames.join(", ")».

**Recommend:** keep

**You:**

### body 69 · (WorkflowSwitch.tsx) · `components/WorkflowSwitch.tsx:165`

> Still connecting. Try again in a moment.

**Recommend:** keep — one sentence, one fix, the same everywhere

**You:**

### body 70 · (WorkflowSwitch.tsx) · `components/WorkflowSwitch.tsx:219`

> Turned off. Items already on it keep going.

**Recommend:** keep

**You:**

### body 71 · (WorkflowTag.tsx) · `components/WorkflowTag.tsx:66`

> Couldn't save the tag. Try again.

**Recommend:** keep

**You:**

### body 72 · the home page · `routes/app.index.tsx:165`

> «formatNumber(usage.ordersT…» of «formatNumber(entitlements.…» included

**Recommend:** keep

**You:**

### body 73 · the home page · `routes/app.index.tsx:171`

> «formatNumber(ordersOverBy)» over. Extra orders are billed at your plan's rate.

**Recommend:** keep

**You:**

### body 74 · the home page · `routes/app.index.tsx:172`

> Each order synced from Shopify counts once.

**Recommend:** keep

**You:**

### body 75 · the home page · `routes/app.index.tsx:186`

> Members sign in with their email on the member area.

**Recommend:** rewrite: Members sign in with their email. — "the member area" is not a screen name

**You:**

### body 76 · the lapsed page · `routes/shop.$shop_.lapsed.tsx:16`

> Subscription inactive — Baton

**Recommend:** keep

**You:**

### body 77 · the lapsed page · `routes/shop.$shop_.lapsed.tsx:22`

> Subscription inactive

**Recommend:** keep

**You:**

### body 78 · the lapsed page · `routes/shop.$shop_.lapsed.tsx:28`

> This shop’s Baton subscription is not active, so its workflows are

**Recommend:** keep

**You:**

### body 79 · the lapsed page · `routes/shop.$shop_.lapsed.tsx:30`

> Baton app in their Shopify admin.

**Recommend:** keep

**You:**

### body 80 · the lapsed page · `routes/shop.$shop_.lapsed.tsx:32`

> Back to your shops

**Recommend:** rewrite: Your shops — link text is the target screen's heading

**You:**

### body 81 · the members page · `routes/app.members.tsx:26`

> Email is required

**Recommend:** rewrite: Enter an email — an error says what to do, not what is required

**You:**

### body 82 · the members page · `routes/app.members.tsx:43`

> That member no longer exists.

**Recommend:** keep

**You:**

### body 83 · the members page · `routes/app.members.tsx:45`

> This shop has reached the maximum number of members. Contact support to raise it.

**Recommend:** keep

**You:**

### body 84 · the members page · `routes/app.members.tsx:257`

> Could not add the member.

**Recommend:** rewrite: Couldn't add the member. — contractions throughout (Shopify grammar guide); every refusal starts "Couldn't"

**You:**

### body 85 · the members page · `routes/app.members.tsx:258`

> Could not update their teams.

**Recommend:** rewrite: Couldn't update their teams. — contractions throughout (Shopify grammar guide); every refusal starts "Couldn't"

**You:**

### body 86 · the members page · `routes/app.members.tsx:259`

> Could not remove the member.

**Recommend:** rewrite: Couldn't remove the member. — contractions throughout (Shopify grammar guide); every refusal starts "Couldn't"

**You:**

### body 87 · the members page · `routes/app.members.tsx:318`

> Add an email to grant access. Members sign in with it on the

**Recommend:** rewrite: Members sign in with their email. Put each one on a team, or they have nothing to do. — the same sentence the non-empty page shows (body 91), so both say one thing

**You:**

### body 88 · the members page · `routes/app.members.tsx:417`

> Members sign in with their email on the member area. Put each one

**Recommend:** rewrite: Members sign in with their email. Put each one on a team, or they have nothing to do. — drops "on the member area"

**You:**

### body 89 · the members page · `routes/app.members.tsx:437`

> Showing «String(rows.length)» of «String(members.length)» members.

**Recommend:** keep

**You:**

### body 90 · the order page · `routes/app.orders.$orderId.tsx:55`

> Still connecting. Try again in a moment.

**Recommend:** keep — one sentence, one fix, the same everywhere

**You:**

### body 91 · the order page · `routes/app.orders.$orderId.tsx:62`

> That workflow is already running on this item.

**Recommend:** rewrite: That workflow is already on this item. — "running" is a retired-word neighbour; the screen says a workflow is on an item

**You:**

### body 92 · the order page · `routes/app.orders.$orderId.tsx:63`

> That item no longer exists.

**Recommend:** keep

**You:**

### body 93 · the order page · `routes/app.orders.$orderId.tsx:65`

> That workflow cannot start: it is off, has no tasks, or has an unassigned task.

**Recommend:** rewrite: That workflow can't start: it's off, has no steps, or has a task with no team. — contractions; "unassigned" is the code word, the screen says Needs a team

**You:**

### body 94 · the order page · `routes/app.orders.$orderId.tsx:67`

> «formatNumber(limit)» items are in production, the most Baton tracks at once. Cancel a workflow, or wait until an item is done or closed.

**Recommend:** keep

**You:**

### body 95 · the order page · `routes/app.orders.$orderId.tsx:71`

> This item is done on «workflowName». Reopen its last task to change it.

**Recommend:** keep

**You:**

### body 96 · the order page · `routes/app.orders.$orderId.tsx:73`

> This order is cancelled or fulfilled in Shopify, so there is no work left to attach.

**Recommend:** keep

**You:**

### body 97 · the order page · `routes/app.orders.$orderId.tsx:75`

> This item has nothing left to make, so no workflow can start on it.

**Recommend:** keep

**You:**

### body 98 · the order page · `routes/app.orders.$orderId.tsx:83`

> That task no longer exists.

**Recommend:** keep

**You:**

### body 99 · the order page · `routes/app.orders.$orderId.tsx:84`

> That team no longer exists. Choose another.

**Recommend:** keep

**You:**

### body 100 · the order page · `routes/app.orders.$orderId.tsx:85`

> That task is already done and keeps its team.

**Recommend:** keep

**You:**

### body 101 · the order page · `routes/app.orders.$orderId.tsx:87`

> That item's workflow is done or closed.

**Recommend:** keep

**You:**

### body 102 · the order page · `routes/app.orders.$orderId.tsx:88`

> That task can no longer be assigned.

**Recommend:** keep

**You:**

### body 103 · the order page · `routes/app.orders.$orderId.tsx:94`

> That workflow is no longer on this item.

**Recommend:** keep

**You:**

### body 104 · the order page · `routes/app.orders.$orderId.tsx:99`

> That item changed just now, so nothing was done.

**Recommend:** keep

**You:**

### body 105 · the order page · `routes/app.orders.$orderId.tsx:101`

> That item is no longer blocked.

**Recommend:** keep

**You:**

### body 106 · the order page · `routes/app.orders.$orderId.tsx:104`

> That task changed just now, or a task in an earlier step is still open.

**Recommend:** keep

**You:**

### body 107 · the order page · `routes/app.orders.$orderId.tsx:106`

> That item's workflow is done or closed.

**Recommend:** keep

**You:**

### body 108 · the order page · `routes/app.orders.$orderId.tsx:109`

> That item is blocked. Unblock it first.

**Recommend:** keep

**You:**

### body 109 · the order page · `routes/app.orders.$orderId.tsx:114`

> «teamName» already started «taskName».

**Recommend:** keep

**You:**

### body 110 · the order page · `routes/app.orders.$orderId.tsx:162`

> More than one workflow matches this item, so none was started.

**Recommend:** keep — fact, then effect

**You:**

### body 111 · the order page · `routes/app.orders.$orderId.tsx:183`

> «team.name» (no members)

**Recommend:** keep

**You:**

### body 112 · the order page · `routes/app.orders.$orderId.tsx:248`

> «current[0].name» and «formatNumber(current.lengt…» more

**Recommend:** keep

**You:**

### body 113 · the order page · `routes/app.orders.$orderId.tsx:258`

> Step «String(lowest)» of «String(stepCount(tasks))» · «names»

**Recommend:** keep

**You:**

### body 114 · the order page · `routes/app.orders.$orderId.tsx:295`

> «task.name»: assign a team.

**Recommend:** keep

**You:**

### body 115 · the order page · `routes/app.orders.$orderId.tsx:521`

> Attached «result.run.workflowName».

**Recommend:** rewrite: Attached «workflow» — a one-phrase toast has no period; only a two-sentence toast is punctuated

**You:**

### body 116 · the order page · `routes/app.orders.$orderId.tsx:522`

> Changed to «result.run.workflowName».

**Recommend:** rewrite: Changed to «workflow» — a one-phrase toast has no period; only a two-sentence toast is punctuated

**You:**

### body 117 · the order page · `routes/app.orders.$orderId.tsx:667`

> That order is not stored here. It may be outside the sync window, or

**Recommend:** rewrite: This order isn't in Baton. It may be older than the import window, or deleted in Shopify. — "stored here" and "sync window" are implementation words

**You:**

### body 118 · the order page · `routes/app.orders.$orderId.tsx:814`

> «run.workflowName» workflow

**Recommend:** keep

**You:**

### body 119 · the order page · `routes/app.orders.$orderId.tsx:913`

> Can’t reopen: «blocker.taskName» («blocker.teamName») already started — put it back or reopen it first

**Recommend:** rewrite: Can’t reopen: «task» («team») already started. Put it back or reopen it first. — no dash; two sentences

**You:**

### body 120 · the order page · `routes/app.orders.$orderId.tsx:1232`

> SKU «item.sku»

**Recommend:** keep

**You:**

### body 121 · the order page · `routes/app.orders.$orderId.tsx:1575`

> That workflow is no longer on this item.

**Recommend:** keep

**You:**

### body 122 · the order page · `routes/app.orders.$orderId.tsx:1601`

> That workflow is no longer on this item.

**Recommend:** keep

**You:**

### body 123 · the order page · `routes/app.orders.$orderId.tsx:1612`

> That workflow is no longer on this item.

**Recommend:** keep

**You:**

### body 124 · the orders index · `routes/app.orders.index.tsx:164`

> Importing… this page updates as orders arrive.

**Recommend:** keep

**You:**

### body 125 · the orders index · `routes/app.orders.index.tsx:176`

> «formatNumber(n)» open orders have issues

**Recommend:** keep

**You:**

### body 126 · the orders index · `routes/app.orders.index.tsx:419`

> Could not start the import.

**Recommend:** rewrite: Couldn't start the import. — contractions throughout (Shopify grammar guide); every refusal starts "Couldn't"

**You:**

### body 127 · the orders index · `routes/app.orders.index.tsx:582`

> Waiting on

**Recommend:** keep

**You:**

### body 128 · the orders index · `routes/app.orders.index.tsx:841`

> Any team

**Recommend:** keep

**You:**

### body 129 · the orders index · `routes/app.orders.index.tsx:853`

> Deleted team

**Recommend:** keep

**You:**

### body 130 · the team page · `routes/app.teams.$teamId.tsx:45`

> Name is required

**Recommend:** rewrite: Enter a name — with body 83

**You:**

### body 131 · the team page · `routes/app.teams.$teamId.tsx:236`

> Could not rename the team.

**Recommend:** rewrite: Couldn't rename the team. — contractions throughout (Shopify grammar guide); every refusal starts "Couldn't"

**You:**

### body 132 · the team page · `routes/app.teams.$teamId.tsx:271`

> Still connecting. Try again in a moment.

**Recommend:** keep — one sentence, one fix, the same everywhere

**You:**

### body 133 · the team page · `routes/app.teams.$teamId.tsx:298`

> Could not rename the team.

**Recommend:** rewrite: Couldn't rename the team. — contractions throughout (Shopify grammar guide); every refusal starts "Couldn't"

**You:**

### body 134 · the team page · `routes/app.teams.$teamId.tsx:301`

> Could not add members.

**Recommend:** rewrite: Couldn't add members. — contractions throughout (Shopify grammar guide); every refusal starts "Couldn't"

**You:**

### body 135 · the team page · `routes/app.teams.$teamId.tsx:302`

> Could not remove the member.

**Recommend:** rewrite: Couldn't remove the member. — contractions throughout (Shopify grammar guide); every refusal starts "Couldn't"

**You:**

### body 136 · the team page · `routes/app.teams.$teamId.tsx:303`

> Could not delete the team.

**Recommend:** rewrite: Couldn't delete the team. — contractions throughout (Shopify grammar guide); every refusal starts "Couldn't"

**You:**

### body 137 · the team page · `routes/app.teams.$teamId.tsx:355`

> This shop has no members yet. Add them once, then put them on teams.

**Recommend:** rewrite: This shop has no members yet. Add them on Members, then put them on teams. — with confirm 13

**You:**

### body 138 · the team page · `routes/app.teams.$teamId.tsx:361`

> Nobody is on this team, so its tasks wait until a member joins.

**Recommend:** keep

**You:**

### body 139 · the team page · `routes/app.teams.$teamId.tsx:373`

> On team since

**Recommend:** keep

**You:**

### body 140 · the team page · `routes/app.teams.$teamId.tsx:657`

> Already on «names.join(", ")»

**Recommend:** keep

**You:**

### body 141 · the teams index · `routes/app.teams.index.tsx:23`

> A shop can have «String(limit)» teams. Delete one to add another.

**Recommend:** keep

**You:**

### body 142 · the teams index · `routes/app.teams.index.tsx:26`

> Name is required

**Recommend:** rewrite: Enter a name — with body 83

**You:**

### body 143 · the teams index · `routes/app.teams.index.tsx:102`

> Could not create the team.

**Recommend:** rewrite: Couldn't create the team. — contractions throughout (Shopify grammar guide); every refusal starts "Couldn't"

**You:**

### body 144 · the teams index · `routes/app.teams.index.tsx:116`

> Could not create the team.

**Recommend:** rewrite: Couldn't create the team. — contractions throughout (Shopify grammar guide); every refusal starts "Couldn't"

**You:**

### body 145 · the teams index · `routes/app.teams.index.tsx:183`

> Used by

**Recommend:** keep

**You:**

### body 146 · the teams index · `routes/app.teams.index.tsx:251`

> Teams are who can work a task. Assign a team to each task in a

**Recommend:** rewrite: A team is who can work a task. Assign one to each task in a workflow. — the teams index's empty state (under heading 28) says this; make the two identical

**You:**

### body 147 · the teams index · `routes/app.teams.index.tsx:271`

> Showing «String(rows.length)» of «String(teams.length)» teams.

**Recommend:** keep

**You:**

### body 148 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:65`

> That task no longer exists. Reload the page.

**Recommend:** keep

**You:**

### body 149 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:66`

> A workflow can have at most «String(limit)» tasks.

**Recommend:** rewrite: A workflow can have «limit» tasks. — with body 43: one shape for every limit

**You:**

### body 150 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:67`

> That team no longer exists. Choose another.

**Recommend:** keep

**You:**

### body 151 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:73`

> That workflow no longer exists.

**Recommend:** keep

**You:**

### body 152 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:74`

> There are no changes to apply.

**Recommend:** keep

**You:**

### body 153 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:75`

> Add a step to this workflow.

**Recommend:** keep

**You:**

### body 154 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:77`

> Assign a team to «taskNames.join(", ")».

**Recommend:** keep

**You:**

### body 155 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:85`

> That workflow no longer exists.

**Recommend:** keep

**You:**

### body 156 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:86`

> There are no changes to discard.

**Recommend:** keep

**You:**

### body 157 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:190`

> Still connecting. Try again in a moment.

**Recommend:** keep — one sentence, one fix, the same everywhere

**You:**

### body 158 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:429`

> That workflow no longer exists.

**Recommend:** keep

**You:**

### body 159 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:485`

> «team.name» (no members)

**Recommend:** keep

**You:**

### body 160 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:495`

> New step

**Recommend:** keep

**You:**

### body 161 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:495`

> New task in step «String(step)»

**Recommend:** keep

**You:**

### body 162 · the workflow editor · `routes/app.workflows.$workflowId_.edit.tsx:597`

> Create a team before adding steps.

**Recommend:** keep — the act is off-screen; the link under it is the screen's heading

**You:**

### body 163 · the workflow page (member) · `routes/shop.$shop.workflows.$runId.tsx:75`

> «loaderData?.page?.run.line…» — Baton

**Recommend:** keep

**You:**

### body 164 · the workflow page (member) · `routes/shop.$shop.workflows.$runId.tsx:188`

> This workflow is not on one of your teams, or it no longer exists.

**Recommend:** keep

**You:**

### body 165 · the workflow page (member) · `routes/shop.$shop.workflows.$runId.tsx:209`

> Your merchant will review this.

**Recommend:** rewrite: The merchant will review this. — the glossary: "the merchant" to a member, never "your merchant"

**You:**

### body 166 · the workflow page (member) · `routes/shop.$shop.workflows.$runId.tsx:279`

> «run.workflowName» workflow · «run.orderName»

**Recommend:** keep

**You:**

### body 167 · the workflow page (member) · `routes/shop.$shop.workflows.$runId.tsx:331`

> From the order:

**Recommend:** keep

**You:**

### body 168 · the workflow page (merchant) · `routes/app.workflows.$workflowId.tsx:133`

> Still connecting. Try again in a moment.

**Recommend:** keep — one sentence, one fix, the same everywhere

**You:**

### body 169 · the workflow page (merchant) · `routes/app.workflows.$workflowId.tsx:249`

> That workflow no longer exists.

**Recommend:** keep

**You:**

### body 170 · the workflows index · `routes/app.workflows.index.tsx:132`

> Still connecting. Try again in a moment.

**Recommend:** keep — one sentence, one fix, the same everywhere

**You:**

### body 171 · the workflows index · `routes/app.workflows.index.tsx:339`

> Showing «String(rows.length)» of «String(workflows.length)» workflows.

**Recommend:** keep

**You:**

### body 172 · the workflows list · `routes/shop.$shop.workflows.index.tsx:100`

> Workflows — Baton

**Recommend:** keep

**You:**

### body 173 · the workflows list · `routes/shop.$shop.workflows.index.tsx:555`

> by «doneActorLabel(entry.task,…» at

**Recommend:** keep

**You:**
