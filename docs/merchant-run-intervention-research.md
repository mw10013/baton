# Merchant intervention on workflow runs

Research date: 2026-09-14. Scope: whether a merchant working in the embedded admin
app should be able to change a running workflow directly (complete or undo a step,
add a note, block or unblock, and so on) as a remediation tool, and if so, how Baton
records who did it when the merchant is not a member and has no member email. The
product question was settled on 2026-09-14 (see Decisions); the merchant UI is
researched in the second half. Mockups of the recommended states are in
`docs/merchant-run-intervention/mockups.html`.

## Implementation status (2026-09-14)

The recording design in "How a merchant action is recorded" is **built and verified
against the running dev server**; the merchant surface in the second half is **not
started**. Order of work and every deviation: `docs/merchant-run-intervention-implementation-plan.md`.

In:

- `Domain.Actor` (plus `ActorDisplay` and `actorLabel`), the three `*ByRole` columns,
  `reopenedAt` / `reopenedByRole` / `reopenedByEmail`, `noteByRole`, and
  `RunFlagDetail.by` as the `Actor` union — in the struct and in the initial schema.
- Repository writes for all six actions, with `teamIds: undefined` as the merchant's
  "skip the team clause" (every other rule still applies), and the step actor accessors
  `stepStartedBy` / `stepCompletedBy` / `stepReopenedBy`.
- Member callables rebuilt on `actor`; six new repository tests for the merchant paths.

Verified live on the dev server after a `d1:reset` + `seed`: the DDL applies, the seed's
start/complete write `'member'` roles with matching ids and emails, a member Undo through
the socket fills the `reopened` slot and clears the completed one while keeping the
starter, the next Done clears `reopened`, a note writes `noteByRole`, and the queue's
blocked banner reads the new `flagDetail.by`.

Not in: the five merchant callables, the Mine-tier-by-email change, and all UI (the
merchant order page, the member-side attribution and "Reopened by" line, the Block /
Unblock copy change).

Companion docs: `docs/member-ux-research.md` (the worker's Undo and its deliberate lack
of an audit trail), `docs/member-auth-and-shopify-access-research.md` (connection roles
and what identity each side carries), `docs/teams-members-ux-research.md` (the merchant
side of teams and members).

## The short version

1. **Yes, the merchant should be able to intervene.** Every run already lives in the
   merchant's shop; the merchant can already cancel it, un-cancel it, and reassign an open
   step to another team. Refusing to let them also mark a step done or reopen it only
   forces the workaround the user already named: make yourself a member and join every
   team. That workaround is worse for the data (a fake worker on every team, counted in
   every team's queue) than a first-class merchant action would be.
2. **The merchant is a distinct actor, not a member.** Do not create a member row for
   them. Each actor slot on a step (`startedBy*`, `completedBy*`) gains a **role**
   column typed as the existing `ConnectionRole` (`"merchant" | "member"`), because
   that is literally the distinction being recorded: which side of the app the action
   came from. The member id and email columns stay null for a merchant action.
3. **One "Merchant", no staff distinction.** The label is "Merchant" and Baton does
   not tell staff users apart. The session token's `sub` claim (the staff user id) is
   free to read, but storing it buys nothing a small shop will look at, and a name needs
   online access tokens, a second token path the app does not have. If a shop ever asks
   "which of us did that?", the answer is one nullable column and one header, added
   then.
4. **No event log. Record the last actor on the step, nothing more.** An append-only
   audit table was considered and rejected: it grows at roughly five rows per run
   forever, needs its own pruning, and needs a screen to justify keeping it. The one
   hole that matters, "who reopened my finished step?", is closed by a `reopened*`
   slot on the step, cleared on the next completion. Bounded by the number of steps,
   which the shop already stores.
5. **Same rules, minus the team check.** A merchant action skips "is this step's team
   one of yours" and nothing else: stage order still applies, a terminal run still
   refuses, and Undo still refuses when someone downstream has started. A merchant who
   needs to unwind further does it step by step, with the page telling them which step
   to undo first.
6. **One note per step, whoever wrote it last.** The step's single `note` stays; the
   merchant can edit it like a member can, and the row records `noteByRole` so the card
   can say "note by Merchant". Overwriting is visible before it happens (the current
   text is in the field). A second note column or a notes table is more than this needs.
7. **Nothing new for live updates.** Every mutation in `ShopAgent` calls `publish`
   after its write, whoever called it. Merchant callables go through the same path, so
   the worker's queue and work page update exactly as they do for a teammate's action.

## Vocabulary

- **Merchant**: whoever opens Baton inside the Shopify admin. Authenticated by an App
  Bridge session token; identified to Baton only by the shop domain today.
- **Member**: a worker who signs in at `/login` with a magic link and belongs to teams.
  Identified by a `Member` row (`id`, `shop`, `email`).
- **Run**: a `WorkflowRun` row with its `WorkflowRunStep` rows in the shop's Durable
  Object SQLite. The merchant never sees the word; they see a workflow on an order.
- **Intervention**: a merchant changing run or step state directly, as a fix, not as the
  normal way the work gets done.
- **Role**: which side of the app an action came from, `merchant` or `member`. Already
  the name of the socket connection's discriminator (`Domain.ConnectionRole`). Not to
  be confused with `UserRole` (`user | admin`), which is the operator console's
  better-auth role and never appears near a run.

## What the code does today

### Who can change a run, and what gets recorded

All mutations are in `src/lib/WorkflowRunRepository.ts`. The actor columns live only on
`WorkflowRunStep`: `startedAt/startedBy/startedByEmail` and
`completedAt/completedBy/completedByEmail`, plus a single `note`. `WorkflowRun` has no
actor columns; the only run-level attribution is `by`/`byEmail` inside the `blocked`
flag's `flagDetail` JSON.

| Operation                             | Who can call it today       | What it records                                              |
| ------------------------------------- | --------------------------- | ------------------------------------------------------------ |
| `startStep`, `completeStep`           | member, own team's step     | member id + email, timestamps                                |
| `uncompleteStep` (Undo)               | member, own team's step     | nothing; clears `completedBy*`, keeps `startedBy*`           |
| `setStepNote`                         | member, own team's step     | the note text only; `memberId` is accepted but never written |
| `blockRun`                            | member, a ready step's team | member id + email in `flagDetail`                            |
| `dismissFlag`                         | member, a ready step's team | nothing                                                      |
| `cancelRun`, `uncancelRun`            | merchant                    | nothing                                                      |
| `assignRunStepTeam`                   | merchant                    | new team only                                                |
| reconcile / order deleted / fulfilled | system                      | a flag, no actor                                             |

There is no event, history, or audit table anywhere, in the object's SQLite or in D1.
The only trail of an undo or a cancel is a Workers log line.

The team check is the whole permission model: `requireActionable` refuses unless the
step's `teamId` is in the caller's `teamIds`, and `requireReadyTeam` does the same for
run-level actions. `teamIds` comes off the socket connection, never off the wire.

### What each side knows about who is acting

The member socket carries `{ role: "member", memberId, memberEmail, teamIds }` in its
connection state, set by the Worker gate from the better-auth cookie and the `Member` and
`TeamMember` rows. The merchant socket carries `{ role: "merchant", subscription }` and
nothing else. Merchant server functions get the offline `Session`, which has the shop
domain and an access token and no user.

The session token JWT that App Bridge mints does contain the staff user: the `sub` claim
is "the user the token was issued for" and `sid` is a per-user, per-app session id
(`refs/shopify-docs/docs/apps/build/authentication-authorization/id-tokens.md:67-68`).
Baton decodes the token on every admin request and reads only `dest` (the shop).

### How members are identified in run rows, and why both id and email travel together

`Member.id` is the D1 primary key; `(shop, email)` is unique; `TeamMember` edges point
at the id. There is no facility to change a member's email. Removing a member and
re-adding the same email mints a **new id** (`migrations/0001_init.sql`, the `Member`
comment). The run tables snapshot both at the moment of the action, and the migration
comment is explicit about which one is durable: the email is the readable history, "the
bare `startedBy` / `completedBy` ids carry no FK and simply stop resolving."

The pair cannot drift. `requireMember` reads `memberId` and `email` from the same
`Member` row when the socket connects (`src/lib/MemberAccess.ts`), the Worker gate
puts both on the upgrade headers, and the object stores them together in the
connection state. Inputs never carry identity. If the member row changes, the
merchant's team or member edit revokes the connection (`revokeMemberConnections`), so
a stale pair never writes.

One place uses the id today: the queue's "Mine" tier compares `step.startedBy` to the
connection's `memberId` (`src/lib/queueTiers.ts:22`). Its comment says the id is used
"so a member whose email the merchant re-enters still owns their work," which is the
opposite of what the migration guarantees: re-entering an email mints a new id, so an
id comparison is the one that _loses_ the work, and an email comparison would keep it.
This is a pre-existing inconsistency, not something this feature causes; fixing it is in
scope (decision 12).

### What the merchant sees of a run

`src/routes/app.orders.$orderId.tsx` renders each run as a status badge, a flag badge,
and an inline step trail ("1 Cut ✓ · 2 Engrave ● · 2 Polish") with a team select on
unassigned steps and a note line per step. It shows no timestamps and no
`completedByEmail`; the merchant cannot see who did a step. The workflow page shows the
definition only and says so on purpose.

### Live updates

Every mutating method on `ShopAgent` ends with `this.publish(...)` (scoped to the
touched orders or `"all"`), which re-renders every subscribed queue and run page on
every connection, member and merchant alike. Attribution is not part of the publish;
who acted is simply whatever the re-read step rows say. A merchant callable that calls
the same repository operation and the same `publish` is therefore fully covered.
There is no notification layer beyond this (no email, no push), and none is proposed.

## The Shopify identity options, grounded

What a merchant action could be attributed to, from cheapest to dearest:

| Option                                   | What you get                                                                                          | Cost                                                                                                       | Verdict                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Shop only                                | "the merchant"                                                                                        | none                                                                                                       | **this**                                    |
| `sub` from the session token             | a stable staff user id per action                                                                     | read one more claim from a JWT already decoded, one nullable column                                        | not now; trivial to add if asked            |
| Online access token (`associated_user`)  | id, first/last name, email (trust only if `email_verified`), `account_owner`, `associated_user_scope` | a second token exchange per staff user, 24 h expiry, a per-user session row, a second session-storage path | later, if a multi-staff shop asks for names |
| `read_users` scope + `StaffMember` query | names for any staff id                                                                                | Shopify Plus only (`refs/shopify-docs/docs/api/usage/access-scopes.md:105`)                                | no                                          |

Sources: online token behaviour and fields in
`refs/shopify-docs/docs/apps/build/authentication-authorization/access-tokens.md:58-71`
and `implement-token-exchange.md:1896-1906`. Baton exchanges for offline tokens only
(`src/lib/Shopify.ts:1320-1328`) and rehydrates sessions with `isOnline: false`
(`src/lib/Shopify.ts:721`).

Why one "Merchant" is enough: the shops in scope have one owner and maybe one or two
staff with admin access; the question "was it you or me?" is answered across the bench,
not in the app. Storing `sub` would distinguish staff users in data that no screen
shows, which is the kind of unused column that later nobody dares drop. Should a shop
ask, the change is one header from the merchant gate, one column on the step, and a
label that says "Merchant (1234)" or, with online tokens later, a name. Nothing below
closes that door.

## How a merchant action is recorded

### The shape: one role column per actor slot

`WorkflowRunStep` has two actor slots today, _started_ and _completed_, each a
`(By, ByEmail)` pair of nullable columns. This adds a third slot, _reopened_, and gives
every slot a role:

```
startedAt    startedByRole    startedBy    startedByEmail
completedAt  completedByRole  completedBy  completedByEmail
reopenedAt   reopenedByRole                reopenedByEmail
note         noteByRole
```

- `*ByRole` is `Domain.ConnectionRole` (`"merchant" | "member"`), nullable, null when
  the slot is empty.
- For a member action, `*By` is the member id and `*ByEmail` the email, as today.
- For a merchant action, `*ByRole = 'merchant'` and the id and email are null.

In the domain this decodes to one union used by all three slots:

```ts
Actor =
  | { role: "member"; memberId: MemberId; email: Email }
  | { role: "merchant" }
```

and the page renders it as `by <email>` or `by Merchant`.

### Why "role"

Decided: `role`. It is `Domain.ConnectionRole` (`"merchant" | "member"`), already the
socket connection's discriminator with exactly this meaning, so socket and row share one
vocabulary. Inferring the actor from a null email was rejected: the rule would live in
a reader's head and leave no value for a third actor later.

### Email versus id in the run rows

Raised during review: Baton passes member id and email around together; could the email
be the member's identity and the id go away? Two separate questions hide in that.

**Should `Member.id` stop being the primary key?** No. `(shop, email)` is unique so it
_could_ key a member, but `TeamMember` edges, the connection tag
(`member:<memberId>`), and the revocation path all key on the id, and a future "fix a
typo in this member's email" is possible only because the id is stable. There is no
email-edit facility today; keeping the id is what makes adding one cheap. This is
foundational and should stay closed.

**Do the run rows need the id at all?** Weaker case. The migration already declares the
email the durable snapshot and the id an FK-less pointer that "stops resolving". The one
consumer of the id, the Mine tier, would be _more_ correct on email (see the
inconsistency noted above). So for the **new** `reopened` slot, store only
`reopenedByRole` and `reopenedByEmail`; nothing needs to compare a reopen to "me" by
id, and "Reopened by <email>" is what the card shows. The existing `startedBy` and
`completedBy` id columns stay as they are; dropping them is a separate cleanup and not
worth bundling here.

### What goes into the columns for each merchant action

| Merchant action                | Step snapshot                                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete a step                | `completedAt=now`, `completedByRole='merchant'`, `completedBy=null`, `completedByEmail=null`; `startedAt` backfilled if null with `startedByRole='merchant'`; `reopened*` cleared |
| Undo a step                    | `completedAt/ByRole/By/ByEmail = null`; `startedBy*` kept; `reopenedAt=now`, `reopenedByRole='merchant'`, `reopenedByEmail=null`                                                  |
| Start a step                   | as the backfill above                                                                                                                                                             |
| Note                           | `note=text`, `noteByRole='merchant'` (member edits set `'member'`)                                                                                                                |
| Block                          | `flagDetail.by` becomes the `Actor` union: `{ role: "merchant" }`                                                                                                                 |
| Dismiss flag                   | as today, no actor                                                                                                                                                                |
| Cancel, un-cancel, assign team | as today, no actor                                                                                                                                                                |

A member undo writes the same `reopened*` slot with `'member'` and their email, so a
teammate's card reads "Reopened by <email>". The earlier decision "undo records
nobody" was made when there was no place to show it; there is now.

Cancel and reassign stay unattributed: they are merchant-only already, so "who" is
implied, and a cancelled run is not something a worker acts on. Dismissing a flag is
the merchant or a teammate clearing a block; if that ever needs attribution, the same
role column pattern applies.

`flagDetail` today has `by?: MemberId, byEmail?: Email`. It should carry the `Actor`
union under one key. **Built as:** `by?: Actor`, `byEmail` removed, and no old-shape
compatibility in the decoder — every Durable Object is reset from scratch while the app
is in prototyping, so there are no old rows to read.

### What this does not keep

Only the _current_ state. A second undo overwrites the first; a completed step forgets
it was ever reopened. The worker's live question ("why is this back, who do I ask?") is
answered; the historian's ("how many times?") is not, and nobody is asking it. An event
table remains purely additive if a merchant ever asks for history: the snapshot columns
stay whatever happens.

## What a merchant may do, and under which rules

| Rule                                                         | Member today                 | Merchant, recommended                                   |
| ------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------- |
| Step's team must be one of mine                              | yes                          | **skipped**; merchant has no teams                      |
| Earlier stages must be closed before start/complete          | yes                          | **kept**                                                |
| Run must not be `done`/`cancelled` for start/complete/block  | yes                          | **kept**                                                |
| Undo refused when a later stage or the order run has started | yes                          | **kept**                                                |
| Undo allowed on a `done` run                                 | yes                          | yes                                                     |
| Complete an unassigned step (`teamId is null`)               | impossible (no team matches) | **allowed**; this is the very case a merchant is fixing |
| Dismiss a block                                              | yes                          | **allowed**; the obvious "get it moving again" move     |

Two rules deserve an argument.

**Stage order stays.** Letting the merchant complete step 3 while step 2 is open would
require `recomputeStatus` and readiness to tolerate holes, and it would make the
worker's queue show step 2 as ready on a run whose step 3 is already done. The merchant
closing steps in order is a few clicks and keeps every invariant.

**The downstream Undo guard stays.** The guard exists because reopening step 2 when step
3 is in progress puts two teams on the same run at once. A merchant needing to unwind
further undoes step 3 first, then step 2; the existing `StepUndoBlockedError` already
names the step and team to undo first, so the page can say exactly that.

Not recommended for the merchant: **claim/start on behalf of a specific member**
(pretending a worker started it), and **editing timestamps**. Both are "pretend it
happened differently", not "make it right now".

## Trade-offs accepted

- **"Merchant" is a coarse label.** In a shop with three staff users the card says
  "Merchant" whoever acted. Accepted for the target size; one column and one header
  if a shop asks.
- **No history, only current state.** See "What this does not keep".
- **The merchant can overwrite a worker's note.** The text is on screen when they
  edit it; `noteByRole` says who wrote the current one. Accepted over a second note
  column or a notes table.
- **Interventions show up in the members' "Done today" tier.** A step the merchant
  completes belongs to a team and lists under that team's done work, labelled
  "by Merchant". Correct (the work is done) and a little surprising; the label carries
  it, and hiding it would hide the fact the worker most needs to see.
- **No cascade-undo, no complete-through.** Step by step, both directions.

## Decisions (2026-09-14)

1. **Label is "Merchant".**
2. **Undo is step by step.** No one-shot unwind, no cascade.
3. **Members see merchant actions on the work page and queue card**: "Completed by
   Merchant", "Reopened by Merchant", "note by Merchant".
4. **No staff distinction.** One "Merchant"; no `sub`, no online tokens.
5. **No "complete through here".** Step by step; evaluate after it ships.
6. **No event table.** Last-actor snapshot on the step, plus the `reopened` slot.
   Rejected because it grows without bound per run, needs pruning, and needs a screen
   nobody has asked for; it stays additive if that changes.
7. **Merchant can dismiss a block.**
8. **Live updates need nothing new.** Existing `publish` after every mutation covers
   merchant actions.
9. **Stats are not this decision.** The role column keeps interventions separable if
   per-team stats ever come; nothing more now.
10. **Member id stays the primary key.** Not reopened. The run rows keep their existing
    id columns; the new `reopened` slot stores role and email only.
11. **Column name is `role`.**
12. **Mine tier moves to email, in scope.** `queueTiers.tierOf` compares
    `step.startedByEmail` to the connection's `memberEmail` instead of `startedBy` to
    `memberId`, and its comment is corrected: re-entering an email mints a new id, so
    email is what survives.
13. **Block / Unblock on both sides.** The member page's "Mark blocked" and "Dismiss"
    buttons and its explanatory line change to match; code names stay.

## The merchant surface

### Where

The order page, per run, and nowhere else. It is already the merchant's only view of a
run, it already holds the two interventions that exist (Cancel, Reassign), and it is
where a merchant lands from the orders index's **Flagged** badge and `?attention=true`
filter, which is how a stuck run gets noticed today. The workflow page stays
definition-only; the orders index gains nothing.

### The shape: one disclosure per run

The page already has a per-run **Reassign** disclosure: a tertiary button that expands a
list of open steps, each with a team select. That is the right pattern for interventions
too, and there should be one of them, not two. Rename it **Manage** and put every
intervention inside it:

- The trail (`1 Cut ✓ · 2 Engrave ● · 2 Polish`) stays read-only and compact. Nothing on
  it becomes a click target, so scanning an order never risks a stray "done".
- **Manage** expands to one row per step. Each row shows the step name, its team, its
  state line with attribution and time (`Done by a@shop.com · 14:02`, `In progress since
13:40 by b@shop.com`, `Reopened by Merchant · 10 min ago`, `Ready`, `Waiting on step
1`), the note if any, and the actions that apply.
- Below the step rows, the run-level actions: **Block** with a reason field (or
  **Unblock** with the reason shown, when blocked), and **Cancel** (or **Undo cancel**).
  Cancel moves in from the run header so the header is facts only: name, status badge,
  flag badge.

Collapsed, a run reads exactly as it does today plus nothing. Expanded, everything a
merchant can do to it is in one place, in the same order the worker sees it on the work
page.

### Per-step actions

| Step state                                 | Actions                                           | Notes                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ready (lowest open stage), assigned or not | **Mark done**, **Note**                           | No Start. A merchant is not claiming work; Mark done backfills `startedAt` with the merchant actor, as `completeStep` already does.                                  |
| Ready and unassigned                       | **Mark done**, **Note**, the existing team select | The "assign a team" prompt stays; Mark done is the way past it when nobody should.                                                                                   |
| In progress (started, not done)            | **Mark done**, **Note**, team select              | Marking done over a worker's start keeps their `startedBy*`; the row then reads "Done by Merchant", started by the worker.                                           |
| Waiting (a lower stage is open)            | **Note**, team select                             | Stage order holds. The state line says which step to finish first.                                                                                                   |
| Done, nobody downstream started            | **Reopen**, **Note**                              | Reverses with Mark done.                                                                                                                                             |
| Done, downstream started                   | **Note**                                          | Reopen is replaced by the reason: `Polish started by c@shop.com · reopen it first`. Same sentence shape the worker sees, with the instruction instead of "ask them". |
| Any, run cancelled or done                 | **Note** only on done; nothing on cancelled       | Matches `requireActionable`.                                                                                                                                         |

Team select stays per row, so Reassign is simply one of the actions rather than its own
disclosure.

### Confirmation: none, with a toast

Mark done and Reopen are each other's undo, Cancel has Undo cancel, Block has Unblock.
The member UX principle applies unchanged: "mistakes are undone from where they land,
not from a confirm dialog." Each action shows the existing App Bridge toast (`Cut marked
done`, `Cut reopened`, `Run blocked`) so the merchant gets acknowledgement without a
modal. Reopen on a step with downstream work never gets far enough to need a
confirmation; the button is not there.

The one place a confirm was considered is Reopen on a step a _worker_ completed, since
it takes work off a done list they can see. Rejected: the worker's card says "Reopened
by Merchant", which is the accountability a confirm would only pretend to add.

### Copy

- **Manage** / **Hide** for the disclosure.
- **Mark done**, not "Done": the worker's button is "Done" because they did it; the
  merchant is recording it.
- **Reopen**, not "Undo": the merchant is not undoing their own action.
- **Block** / **Unblock**, on both sides; the member page's "Mark blocked" and
  "Dismiss" change to match (see "Block wording, both sides").
- **Note** / **Edit note**, as on the work page.
- Attribution reads `by Merchant` or `by <email>`; the merchant label is the literal
  word, capitalised, never the shop name.

### What the worker sees

No new surface. The queue card and work page already render `by <email>` on started and
done lines; they render `by Merchant` from the role, and the work page's step box gains
one line, `Reopened by Merchant · 10 min ago` (or `by <email>`), shown while the
`reopened` slot is set. A note the merchant wrote shows as `Note (Merchant): …`. The
Done tier's entries read `by Merchant` where that is the case. Live updates arrive
through the existing `publish`.

### Disabled and error states

- All actions follow the page's `disabled={!identified || busy}` rule: nothing is
  clickable until the socket is identified, and one mutation at a time per page.
- A refused action (`NotReady`, `UndoBlocked`, `Terminal`) is a state the row should
  not have offered; it can happen when a worker acted between render and click. The
  result is the same as on the work page: the subscription re-renders the row, and the
  toast says what changed (`Cut was already done`). No error banner.

### Mockups

`docs/merchant-run-intervention/mockups.html` shows: a run collapsed (unchanged), the
same run with Manage open in the ordinary case, the blocked case, the reopen-refused
case, and the worker's card and work-page step box as they read after a merchant
action. Copy in the mockups is the copy above.

### Block wording, both sides

Decided: one pair of words on both surfaces.

| Where                        | Today (member page)                                                                | Both sides                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Section heading, not blocked | Block this work                                                                    | Block this work                                                                    |
| Button, not blocked          | Mark blocked                                                                       | **Block** (critical tone)                                                          |
| Section heading, blocked     | Blocked                                                                            | Blocked                                                                            |
| Explanatory line, blocked    | Dismiss once the reason is resolved; the card goes back to its place in the queue. | Unblock once the reason is resolved; the card goes back to its place in the queue. |
| Button, blocked              | Dismiss                                                                            | **Unblock**                                                                        |
| Badge                        | Blocked: <reason>                                                                  | Blocked: <reason>                                                                  |
| Attribution line (new)       |                                                                                    | Blocked by <email or Merchant> · <time>: <reason>                                  |

Why this pair: "Block" and "Unblock" are the same verb in both directions, name the
outcome rather than the mechanism (a worker does not know the block is a "flag" that
gets "dismissed"), and read the same to a merchant and a worker. "Mark blocked" was the
member page's way of matching "Mark done" phrasing on a form; with the merchant's button
being "Mark done" and the worker's "Done", there is no phrasing to match and the shorter
verb wins. The code keeps `dismissFlag` as the callable and repository name; only copy
changes.

## Implementation notes, for when it is decided

The first two bullets are built (see "Implementation status" at the top); the rest are not.

- **Repository.** Generalise the `memberId, memberEmail, teamIds` arguments to an
  `Actor` plus an optional `teamIds`; a merchant actor passes `teamIds: undefined`
  and `requireActionable`/`requireReadyTeam` skip the team clause when it is absent.
  `uncompleteStep` gains the actor and writes the `reopened` slot; `completeStep`
  clears it. `setStepNote` starts writing `noteByRole` (it already receives `memberId`
  and drops it).
- **Schema.** `startedByRole`, `completedByRole`, `noteByRole` (text, nullable,
  `check (... in ('merchant','member'))`), `reopenedAt`, `reopenedByRole`,
  `reopenedByEmail` on `WorkflowRunStep`. **Built as** columns in `"1_initialize schema"`
  rather than a second `SqliteMigrator` migration, and with no backfill: the app is in
  prototyping and every Durable Object is reset from scratch, so a migration would be
  ceremony over an empty table. This is the one point in this doc that is worth
  revisiting the day the app has real shops — from then on, a column is a migration.
- **Member page copy.** `shop.$shop.work.$runId.tsx`: "Mark blocked" → "Block",
  "Dismiss" → "Unblock", and the explanatory sentence; nothing else.
- **Mine tier.** `tierOf` takes `memberEmail` and compares `startedByEmail`; its
  caller in the queue page passes the connection's email. One test: a re-added member
  (new id, same email) still sees their started work under Mine.
- **Merchant identity.** None needed beyond `role: "merchant"` on the connection,
  which already exists.
- **Callables.** New `role: "merchant"` callables `merchantCompleteStep`,
  `merchantUncompleteStep`, `merchantSetStepNote`, `merchantBlockRun`,
  `merchantDismissFlag`, each building `{ role: "merchant" }` and calling the same
  repository operation and the same `publish` the member callables use. No merchant
  start.
- **Order page.** The `reassigning` set becomes `managing`; `stepTrail` keeps the
  trail and loses the reassign block; a new `manageRows` renders the per-step rows and
  run-level actions from `WorkflowRunDetail`, which already has the step rows and the
  `undoBlockedBy` inputs (`undoBlockedBy` is a pure helper in the repository module and
  runs client-side as on the work page). Cancel moves out of the header.
- **Views.** `RunStepView` and `DoneItem` carry the `Actor` union and the `reopened`
  slot so the queue card and the work page render "by Merchant" and "Reopened by …";
  `WorkflowRunDetail` already carries the step rows the order page needs.
- **Tests.** Repository tests for: merchant completes an unassigned step; merchant undo
  refused downstream with the right blocker; a member's downstream start refuses a
  merchant undo the same way; undo sets the `reopened` slot and the next complete clears
  it; `flagDetail` old shape decodes.
