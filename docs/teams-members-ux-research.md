# Teams and Members: UI and UX rework

Research date: 2026-09-12. Scope: bring the Teams and Members pages (index and detail)
in line with the Workflows pages, decide from first principles what a team page and a
member page should carry, and decide whether a member needs a name or a detail page.
Mockups of every recommended screen are in `docs/teams-members-ux/mockups.html`. The
implementation plan is at the end of this doc.

Revised 2026-09-12 from the build: the team page's layout was reworked after seeing it
on screen, and this doc and the mockups now describe what shipped rather than the first
cut. [The team page layout](#the-team-page-layout) has the diagnosis and the three
Polaris constraints that decided it, and
[The Add members dialog](#the-add-members-dialog) records why the App Bridge picker was
built, seen, and replaced with an `s-modal`.

## Conclusion

1. **Copy the Workflows pattern exactly.** Primary-action button in the page header,
   `s-modal` for create, rename, and delete, `More actions` menu on the detail page, an
   empty state that carries the create button, search once the list is non-empty. The
   standing "Create team" / "Add member" cards and the inline confirm rows go away.
2. **No member detail page.** A member has two facts, an email and a list of teams. Both
   fit in one table row. Everything a page would do is done by a modal.
3. **No name field on members.** Email is the identity, the merchant typed it themselves,
   and today only one line in the whole product shows one person's identity to another
   person. Revisit when there is a "completed by" report or activity view.
4. **Add members to teams from both sides, with one component.** The team page gets an
   **Add members** dialog; the Members page gets a **Teams** column and an **Edit teams**
   row action that reuses the same checklist as the **Add member** modal. The new-member
   modal offers teams up front, because "a member with no team sees nothing to do" is the
   trap a no-code merchant walks into today.
5. **Drop the Workflow steps table from the team page.** Replace it with a **Used by**
   card in the page's aside: which workflows use this team, as links. The step list
   belongs to the workflow, where it is edited.
6. **Lay the team page out as Polaris' details template**, like the order and workflow
   detail pages: the roster owns the main column under a **Members** heading, and the
   reference material (Used by, Created) sits in aside cards. This replaced a first
   attempt that put "Used by" as a bare paragraph under the page heading — see
   [The team page layout](#the-team-page-layout).

## Baton today

- `src/routes/app.teams.index.tsx` — a standing "Create team" section with a paragraph,
  name field and button, then a Teams table (Name, Members, Created, Delete). Delete
  opens a confirm banner **as an extra table row**.
- `src/routes/app.teams.$teamId.tsx` — three stacked sections: **Name** (inline rename
  form with a Save button, plus the delete confirm banner), **Workflow steps** (a table of
  every workflow/draft step the team owns), **Members** (one `s-checkbox` per member of
  the shop, checked if on the team). Delete is a red secondary-action button.
- `src/routes/app.members.tsx` — a standing "Add member" section with a five-line
  paragraph, email field and button, then a table (Email, Added, Delete) with the same
  confirm-as-row.
- `src/routes/app.workflows.index.tsx` and `app.workflows.$workflowId.tsx` — the
  pattern to copy: `slot="primary-action"` Create button opening `s-modal` via
  `commandFor`, `SocketBanner`, filter pills plus `s-search-field`, an empty state that
  contains the create button, a `More actions` `s-menu` with Rename / Duplicate / Delete
  each opening its own modal.

What does not scale in the team page:

- The checkbox list is the whole shop roster. At 8 seeded members it is fine; at 30 it is
  a wall, and current members are not separated from candidates.
- The steps table sits **above** the members and grows with steps, not with anything the
  merchant manages on this page. A team owning ten steps across four workflows pushes
  the members below the fold.
- Rename is a permanent form with a Save button for a field that changes once a year.

## What the comparable products do

Sources: `refs/route-to-ship`, `refs/kanbanify`, `refs/makers-production-view`,
`refs/makerbatch`, `refs/benchcue` (marketing sites and listings, not source), plus the
earlier live inspection in `docs/route-to-ship-departments-research.md`.

- **Route to Ship** has real users with their own login, roles, and department
  membership. Departments are created in a four-stage modal wizard whose second stage is
  **Assign users: a multi-select list**; members are also editable from the department
  detail dialog. There is no worker detail page; user management is one screen. Seats
  run 1 / 3 / 10 / 30 / 100 by plan. A quoted customer runs 15 departments with 13 people.
- **Kanbanify** has a flat roster of **name-only** assignees stored in a metafield. No
  teams, no detail page, assignment happens on the card.
- **Maker's Production View, MakerBatch, BenchCue** have no people model at all.
- None of the five reads the Shopify staff list (all declare "Store owner" only). None
  shows a PIN. None shows staff search or pagination.

Reading across: the only product with teams assigns people **from the team side**, in a
**modal**, and has **no person page**. Scale expectation for the segment is tens of
people, not hundreds.

## Question 1: does a member need a name?

### Where identity shows today

| Place                      | What renders                                  | Who sees it |
| -------------------------- | --------------------------------------------- | ----------- |
| `shop.index.tsx:47`        | the member's own email as the section heading | the member  |
| `shop.$shop.queue.tsx:343` | "In progress since … by `startedByEmail`"     | teammates   |
| `app.teams.$teamId.tsx`    | email as checkbox label                       | merchant    |
| `app.members.tsx`          | email in the Email column                     | merchant    |

There is no "completed by" anywhere, and the order page shows team names, not people.
Exactly **one** line shows one person's identity to another person.

### Trade-offs

A `name` field would be optional, free text, non-unique, and called **Name** (not
"display name", which is a developer word). It would need: a column and migration, a
field in the Add member modal, a **Rename** affordance per member (a modal, which starts
to argue for a member page), and a fallback rule (name, else email) applied at every
render site above.

What it buys: "by Jenny" instead of "by jenny.k.1987@gmail.com" on the queue, and a
friendlier roster. What it costs: a second identity string the merchant must maintain,
an edit surface, and the first crack in "a row is access, nothing else"
(`Domain.ts:244-252`).

For a shop of 3 to 30 people the merchant typed each email and knows whose it is. The
member reads their own email. The queue line is the only ambiguous case, and it is a
teammate looking at a colleague's email, which they also know.

### Recommendation

**Email only.** Add nothing. If a name is ever wanted, the better design is
self-service: the member sets it in the member area, the merchant never types it. That
keeps the Members page a pure access list. Trigger to revisit: a "completed by" report,
an activity feed, or a merchant asking for it.

## Question 2: does a member need a detail page?

A page earns itself when a thing has more state than a row can hold, or actions that
need room. A member has:

- an email (immutable; changing it is delete plus add, by design),
- membership of zero or more teams (a short list; teams are a handful),
- an added date,
- one destructive action.

That is one table row with a **Teams** cell. Team membership editing fits a modal with a
checklist, since the choice list is the team list and teams are few. Past work per
member would be the argument for a page, and it is out of scope and not asked for.

Cost of a page: a route, a loader, breadcrumbs, a heading that is just an email, and a
second place to learn. Benefit: none the table plus a modal cannot give.

**Recommendation: no member detail page.** Members stays a single index page.

## Question 3: what belongs on the team page?

The team is the thing a merchant actually manages. A team has a name, people, and it is
referenced by steps. The merchant's questions on this page, in order:

1. Who is on this team? Add someone. Remove someone.
2. Is anything wrong? (nobody on it)
3. Where is this team used? (before renaming or deleting)

### The Workflow steps table

It answers question 3, but with the wrong grain. The merchant does not manage steps
here, cannot change them here, and the list grows with every step in every workflow and
draft. What they need before a delete is already in the delete warning
(`deleteTeamWarning`: counts of workflow, draft and open-run steps). What they need for
orientation is **which workflows**, which is a short list of links.

**Recommendation:** replace the table with a **Used by** card in the page aside: one
`s-link` per workflow, a `draft` badge on draft-only use, and "Not used by any workflow
yet." when empty. This grows with workflows, not steps, and each link goes where steps
are edited. The data is `listStepsOwnedBy` grouped by `workflowId`, no new query.

Built first as prose under the page heading ("Used by **Engraved ring**, **Custom
pendant** and the **Order workflow**.") and rejected on sight — see
[The team page layout](#the-team-page-layout) for why.

### Members on the team page

Replace the whole-roster checkbox list with a table of **current members only** (Email,
Added, Remove). Adding goes through an **Add members** primary action that opens a
dialog listing members **not yet on the team**, with search and multi-select. Two ways
to build it:

- **App Bridge Picker API** (`shopify.picker({ heading, items, multiple: true })`,
  `refs/shopify-docs/.../picker-api.md`): native search, native multi-select, returns
  ids. Zero custom UI. Its limit is that it cannot add a brand-new email inline.
- **`s-modal` with `s-search-field` and checkboxes**: fully in our hands, can carry a
  "Not here? Add a member" link to the Members page.

**Recommendation, revised 2026-09-12 after building both: the `s-modal`.** The Picker
API shipped first, on the reasoning that the platform's own dialog is what the merchant
sees elsewhere in Admin. On screen it was the worst surface on the page — see
[The Add members dialog](#the-add-members-dialog).

Remove is a row action with a confirm modal (copy: "Remove jenny@shop.com from
Engraving? They keep access to the shop and their other teams."). If they are the last
member, the modal says the team will have no members.

### The Add members dialog

Revised 2026-09-12 after building it. `shopify.picker` renders in the admin host
document, outside this iframe, and takes no input beyond `heading`, `headers`, `items`
and `multiple` — no padding, size, or density. A team with one candidate came out as a
full-bleed two-column table: a header row labelling two columns, one row running edge to
edge under it, and a scroll area sized for a long list leaving a scrollbar beside the
single row. None of that is reachable from the API.

Trimming what we feed it (no `headers`, other teams as `badges`) removes the header row
and the second column, but the full-bleed rows, the fixed height and the scrollbar are
the host's and stay. So the dialog is ours:

- `s-modal` with the team in its heading, opened by `commandFor` like every other modal
  on the page, `onShow` clearing the query and the selection.
- An `s-choice-list multiple` of candidates; each candidate's other teams ride along as
  `<s-text slot="details">Already on …</s-text>`, the second line Polaris' choice
  composition provides, rather than a column.
- The search field appears only from six candidates up. A search box over three rows is
  chrome to read past, which is half of what made the picker look wrong at one row.
- The two nobody-to-add cases (no members in the shop, everyone already here) are a
  sentence in the same modal with **Go to Members** as its primary action, so the
  separate fallback modal the picker needed is gone.
- **Add** carries the count (`Add 2`) and is disabled until something is ticked.

One non-obvious bit: `s-choice-list` reports only the choices it currently renders, so a
member ticked before the search narrowed the list would be dropped by the next change
event. The handler replaces the rendered ids and keeps the rest of the selection, which
is what lets a merchant search, tick, search again, and add both.

This also makes the two directions one pattern: the Members page edits the same
membership with a checklist in a modal, and now so does the team page.

### Rename and delete

Move both to a **More actions** menu with modals, as on the workflow detail page. The
Name section disappears; the name is the page heading.

### The team page layout

Revised 2026-09-12 after building it. The first cut kept the page single-column
(`inlineSize="large"`) and put "Used by …" as an `s-paragraph` directly under the page
heading. On screen the sentence floated: it sat on the page background between the
header and the first card, in nothing, labelled by nothing, and an empty team then
showed an untitled white box whose only content was a sentence about absence plus a
second **Add members** button a few pixels under the header's.

Three things caused it:

1. **`s-page` only lays out sections.** Its `children` slot is for `s-section`s; a bare
   paragraph handed to it is not in the layout grid and gets no container, no inset and
   no label. A sentence on a Polaris page has to live _in_ a card.
2. **The Members section had no `heading`.** Without one the card cannot say what it is,
   so the empty state had to say it, in prose, in the body copy.
3. **Nothing owned the "where is this used?" question.** It is reference material a
   merchant checks before a rename or delete, not a caption for the roster.

The fix is Polaris' **details template**, which the order and workflow detail pages
already use: main column for what defines the resource, aside for supporting facts.

- Main column: `s-section heading="Members"` holding the roster table, or the empty
  state.
- Aside: `s-section slot="aside" heading="Used by"` (the workflow links) and
  `s-section slot="aside" heading="Details"` (Members count, Created — `team.createdAt`
  is already on `Domain.Team`, so no server change).

Three constraints the docs and the build settled, all of them non-obvious:

- **`inlineSize` must be `"base"`.** `s-page` renders the `aside` slot _only_ at `base`
  (`refs/shopify-docs/.../layout-and-structure/page.md`: "This slot is only rendered
  when `inlineSize` is 'base'"). At `"large"` the aside sections vanish silently.
- **The index pages stay `"large"`, and that is correct.** Width is per page _type_, not
  per feature: an index carries a wide table, a detail page wants a readable measure plus
  a sidebar. Shopify's own admin steps the same way (Products index full-width, one
  product narrower with a right column), and Baton already does it twice — Workflows and
  Orders index at `large`, their detail pages at `base`.
- **`padding="none"` on a section also strips the inset from its own `heading`.** The
  first build kept `padding="none"` (so the table could run edge to edge, as on the
  index pages) and added a `heading`; the heading came out jammed against the card's
  top-left corner. A titled section keeps `padding="base"`, and the table gets its own
  frame with `s-box border="base" borderRadius="base" overflow="hidden"` — the shape
  Polaris' own details template uses for a table inside a card.

The empty state follows Polaris' **empty-state composition** minus the illustration: a
heading ("No members yet"), one subdued sentence, one action, centered in nested
`s-grid justifyItems="center"` with `paddingBlock="large-400"`. An empty team is a state
to explain, not a footnote; centering is what stops it reading as a stray line in a box.
No illustration, because no other Baton page has one and it would need an asset in the
repo.

Accepted redundancy: the header keeps its `No members` accessory badge while the empty
state says "No members yet" right below it. The badge is what the merchant recognizes
from the Teams table, so it stays.

## Question 4: index pages

### Teams index

- Header: **Create team** primary action, opens a modal with one field (Name). On
  success navigate to the new team page, since the next thing is always adding people.
- Body: a search field once there are teams; table with Name, Members, Used in
  (workflow count), Created. The **No members** badge stays next to the name.
- No per-row delete. Deletion lives on the detail page, as with workflows. Teams are
  few and deletion is rare; a row action invites misclicks on a destructive act.
- Empty state: the two-sentence explanation and the Create button, inside the table
  section (same as workflows).
- The intro paragraph shrinks to one sentence: "Teams are who can work a step. Assign a
  team to each step in a workflow."

### Members index

- Header: **Add member** primary action, opens a modal with Email and a **Teams**
  checklist (optional, all unchecked). The teams checklist is the trap-avoider: a member
  added with no team sees nothing, and today the merchant learns that only from a
  paragraph.
- Body: search by email; table with Email, Teams (chips, or a **No teams** warning
  badge), Added, and a row menu with **Edit teams** and **Remove**.
- **Edit teams** opens the same checklist modal as Add member, minus the email field.
  One component, two entry points.
- **Remove** opens a confirm modal with the existing copy, including the "this will
  leave X with no members" warning from `soleMemberships`.
- Copy in the modal, not on the page: "They'll sign in with this email on the member
  area. No Shopify account needed."

This needs one new read: teams per member for the Members table (a join over
`TeamMember`, shop-scoped, returned alongside `listMembers`). Everything else is served
by existing queries.

## Scale check

| Thing            | Seed | Realistic top (from Route to Ship's ladder) | Design holds?                           |
| ---------------- | ---- | ------------------------------------------- | --------------------------------------- |
| Members per shop | 8    | 30 to 100                                   | Table with search; dialog with search   |
| Teams per shop   | 7    | 15 to 30                                    | Table with search; checklist in a modal |
| Members per team | 2    | 30                                          | Table, no pagination needed             |
| Steps per team   | 1    | tens                                        | Not listed; workflow links only         |

Nothing here needs pagination. If a shop crosses 100 members, `s-table` has `paginate`
props ready.

## Trade-offs accepted

- Membership becomes editable from two places (team page, member row). Both write the
  same `TeamMember` row through `setTeamMember`; the model does not care. The
  alternative, one place only, sends the merchant to N team pages to move one person.
- The team page loses the step-level list. A merchant who wants to know "which step on
  Engraved ring" clicks the link. The delete warning keeps the counts.
- No name field means the queue keeps showing an email in "by …". Accepted for now.

## Out of scope

- Roles, PINs, self-service names, member activity or history.
- Reading Shopify staff accounts.
- Changing `Member`, `Team`, or `TeamMember` schema. The only server change is one read
  query (teams per member).

# Implementation plan

Handoff for an implementing agent. Read this whole doc first; the screens are in
`docs/teams-members-ux/mockups.html`. Work the steps in order. Each step ends with
`pnpm typecheck`, `pnpm lint`, `pnpm test`, and the named e2e spec green, and
`pnpm fmt` run repo-wide with every touched file kept.

## Ground rules

- **Effect v4 idioms, as the repo already does them.** Services are `Context.Service`
  classes with a static `Layer.effect` (`Repository.layerNoDeps`,
  `src/lib/Repository.ts:202-250`). Every method is
  `Effect.fn("Repository.<name>")(function* (...) {...})`. SQL is the tagged template on
  `sqlPrimary` for anything the merchant pages read after a write. Rows decode through
  `decodeRepository(schema, message)`; failures are `Schema.TaggedError` classes. Read
  `refs/effect/ai-docs/src/01_effect/01_basics/02_effect-fn.ts`,
  `.../03_services/01_service.ts`, `.../04_errors/10_catch-tags.ts`, and
  `refs/effect/ai-docs/src/40_sql/10_basics.ts` before touching the repository.
- **Server functions** follow `app.members.tsx:33-59`: `createServerFn` with a
  `Schema.toStandardSchemaV1` validator of plain strings, `shopifyServerFnMiddleware`,
  `runEffect(Effect.gen(...))`, shop decoded per call with `sessionShop(session.shop)`,
  branded ids decoded inside the Effect, tagged errors turned into copy with `failWith`
  via `Effect.catchTag` before the seam. Loaders call a `GET` server fn and return a
  `Domain.*LoaderData` interface with `satisfies`.
- **Forms** use `@tanstack/react-form`: `useForm` with
  `validators: { onSubmit: Schema.toStandardSchemaV1(Input) }`, `form.Field`, and
  `fieldError(field.state.meta.errors)` from `src/lib/form.ts`, exactly as the current
  teams and members pages do. Modals do not change that: the form lives inside the
  `s-modal`, the primary-action button is `type="submit"` on the `<form>` (or calls
  `form.handleSubmit()`), and `onShow` calls `form.reset()`. The workflows index uses
  bare `useState` for its modal; do not copy that, the form hook is the house style for
  validated input.
- **Modals** are `s-modal` opened by `commandFor={ID} command="--show"`, closed on
  success with `await shopify.modal.hide(ID)`, Cancel is a `secondary-actions` button with
  `command="--hide"`. Primary action is gated on `!identified` where the mutation goes
  through the agent. Ids are module constants (`CREATE_MODAL`, `RENAME_MODAL`,
  `DELETE_MODAL`, and new ones named below).
- **Mutations** are `useMutation` over `useServerFn(fn)`, `onSuccess` does
  `router.invalidate({ sync: true })`; errors surface through
  `mutationErrorMessage(error, fallback)` into an `s-banner tone="critical"`.
- **Delete team** stays a socket call (`agent.stub.deleteTeam` via
  `withSocketRecovery`) because the object must null its step pointers after the D1 row
  goes.
- Copy is the copy in this doc and the mockups. Do not invent new sentences.
- Do not commit. Do not create branches.

## Step 0: shared pieces

**0a. `src/lib/teams.ts`** (new). Move out of `app.teams.index.tsx` so the index route
stops owning delete copy it no longer uses: `NAME_TAKEN`, `TEAM_GONE`,
`decodeDeleteTeamResult`, `deleteTeamResultMessage`, `NO_COUNTS`, `plural`,
`deleteTeamWarning`, `failWith`, `sessionShop`, `decodeName`. Update the two imports in
`app.teams.$teamId.tsx`. Pure move, no behaviour change. Typecheck must pass before 0b.

**0b. Repository: `listMemberTeams`.** One shop-scoped read backing the Members page's
Teams column, the Edit-teams modal's initial values, the Add members dialog's "other
teams" hint, and the derived sole-membership warning.

```ts
// Domain.ts, next to MemberAccess
export const MemberTeam = Schema.Struct({
  memberId: MemberId,
  teamId: TeamId,
  teamName: TeamName,
  teamMemberCount: Schema.Number,
});
export type MemberTeam = typeof MemberTeam.Type;
```

```ts
// Repository.ts, template: listSoleMemberships (:512-532)
const listMemberTeams = Effect.fn("Repository.listMemberTeams")(function* (
  shop: Domain.Shop,
) {
  const rows = yield* sqlPrimary`
    select tm.memberId, tm.teamId, t.name as teamName,
      (select count(*) from TeamMember x where x.teamId = tm.teamId) as teamMemberCount
    from TeamMember tm
    join Team t on t.id = tm.teamId
    where t.shop = ${shop}
    order by t.name collate nocase
  `;
  return yield* decodeRepository(
    Schema.Array(Domain.MemberTeam),
    "Invalid MemberTeam rows",
  )(rows);
});
```

Add it to the service interface and to `Repository.of({...})`. **Delete
`listSoleMemberships`** and its interface entry: a sole membership is
`teamMemberCount === 1` in this result, and two reads of the same join is the kind of
redundancy that drifts. Move its vitest case (`test/integration/repository.test.ts:447`)
onto `listMemberTeams`, asserting `teamMemberCount` and ordering.

**0c. Repository: `setMemberTeams`.** Replace a member's whole team set in one
transaction, for the Add member and Edit teams modals.

```ts
const setMemberTeams = Effect.fn("Repository.setMemberTeams")(function* ({
  shop,
  memberId,
  teamIds,
}: {
  shop: Domain.Shop;
  memberId: Domain.MemberId;
  teamIds: readonly Domain.TeamId[];
}) {
  const createdAt = new Date().toISOString();
  yield* sqlPrimary.batch([
    sqlPrimary`
      delete from TeamMember where memberId in (
        select m.id from Member m where m.id = ${memberId} and m.shop = ${shop})`,
    ...teamIds.map(
      (teamId) => sqlPrimary`
        insert or ignore into TeamMember (teamId, memberId, createdAt)
        select t.id, m.id, ${createdAt}
        from Team t join Member m on m.shop = t.shop
        where t.id = ${teamId} and m.id = ${memberId} and t.shop = ${shop}`,
    ),
  ]);
});
```

Cross-shop ids are silently dropped by the join, which is the same posture as
`setTeamMember` (`:709-757`).

**Atomicity: use `batch`, not `withTransaction`.** D1 has no interactive transactions;
the driver dies on `withTransaction` (`@effect/sql-d1` 4.0.0-rc.112,
`dist/D1Client.js:168`, "transactions are not supported in D1") and this repo only uses
`withTransaction` on the Durable Object's sqlite client. What D1 does have is
`db.batch()`: the statements run in order inside one implicit transaction and all roll
back if any fails. The installed driver exposes it as `D1Client.batch(statements)`
(`dist/D1Client.d.ts:48-66`, "Executes SQL statements as a single atomic D1 batch"),
and both `D1Primary` and `D1Session` are typed as `D1Client.D1Client`, so
`sqlPrimary.batch` is already there. A `D1DatabaseSession` implements `batch` too
(`src/lib/D1Session.ts:17-21`). A tagged-template statement is lazy, so building the
array without `yield*` and handing it to `batch` is the idiom; `batch` returns the row
results in order, ignored here. This is the first `batch` call site in `src/`; give it a
JSDoc saying why it is a batch (delete + inserts must land together or not at all) and
that D1 batches cannot nest in a `SqlClient` transaction. Vitest: set, replace with a
subset, replace with empty, cross-shop team id ignored, and one case that proves
atomicity by including a deliberately failing statement in a test-only batch (or, if
that is awkward, skip it and say so in the test file; Cloudflare's documented behaviour
is the guarantee).

**0d. Repository: `addTeamMembers`.** Batch form of `setTeamMember(inTeam: true)` for
the Add members dialog; same insert-select per id in one `sqlPrimary.batch` (see 0c), fails
`TeamNotFoundError` when the team row is absent for the shop (check with one
`select 1 from Team where id = ? and shop = ?` first, as `renameTeam` does at
`:629-661`). Vitest: adds two, ignores one already present, cross-shop member ignored,
missing team fails.

**0e. ShopAgent: `listOwnedSteps`.** The teams index needs "used by" per team. Add
`Domain.OwnedStepByTeam = Schema.Struct({ teamId: TeamId, ...OwnedStep.fields })`, a
`WorkflowRepository.listOwnedSteps()` that is `listStepsOwnedBy`
(`src/lib/WorkflowRepository.ts:1662`) with `s.teamId` selected and the two `where`
clauses replaced by `where s.teamId is not null`, a plain-RPC `ShopAgent.listOwnedSteps()`
next to `countStepsByTeam` (`src/lib/ShopAgent.ts:2853`, same JSDoc reasoning), and a
`ShopAgentClient.listOwnedSteps(shop)` entry (`src/lib/ShopAgentClient.ts:210-221`
pattern, decoding `Schema.Array(Domain.OwnedStepByTeam)`). Vitest next to the existing
`listStepsOwnedBy` test.

**0f. Domain loader interfaces** (`Domain.ts:1686-1713`), final shapes:

```ts
export interface MembersLoaderData {
  readonly members: readonly Member[];
  readonly teams: readonly TeamRoster[]; // for the checklist modal
  readonly memberTeams: readonly MemberTeam[];
}
export interface TeamsIndexLoaderData {
  readonly teams: readonly TeamSummary[];
  readonly ownedSteps: readonly OwnedStepByTeam[];
}
export interface TeamLoaderData extends TeamDetail {
  readonly memberTeams: readonly MemberTeam[]; // Add members dialog hint
  readonly ownedSteps: readonly OwnedStep[];
  readonly stepCounts: TeamDeleteCounts;
}
```

`TeamDetail.members` keeps the whole roster with `inTeam`; the page splits it into the
table (`inTeam`) and the dialog's candidates (`!inTeam`) client-side. Both lists are small.

**0g. `src/lib/usedBy.ts`** (new, pure). `groupUsedBy(steps: readonly OwnedStep[])`
returns `readonly { workflowId, workflowName, draftOnly: boolean, href }[]`, ordered by
name, `href` being `/app/order-workflow` for `Domain.ORDER_WORKFLOW_ID` and
`/app/workflows/${id}` otherwise, `draftOnly` true when every step for that workflow has
`side === "draft"`. A `UsedByCard` component in `src/components/UsedByCard.tsx` renders
the team page's aside card: one `s-link` per workflow with a `draft` badge on draft-only
use, and "Not used by any workflow yet." for empty. The `slot="aside"` lives on the
component's own `s-section` so the route can hand it straight to `s-page`. Unit test the
grouping in `test/integration/domain.test.ts` or a new `test/unit/usedBy.test.ts` if a
unit folder exists.

## Step 1: Teams index (`app.teams.index.tsx`)

Loader: `listTeams` and `ShopAgentClient.listOwnedSteps`; drop `countStepsByTeam`.

Page:

- `<SocketBanner />`, then `createButton(true)` in `slot="primary-action"` when
  `teams.length > 0`, exactly as `app.workflows.index.tsx:445-454`.
- `s-section padding="none"` with an intro box: "Teams are who can work a step. Assign a
  team to each step in a workflow."
- When `teams.length > 0`: an `s-search-field` (label "Search teams by name",
  `labelAccessibilityVisibility="exclusive"`, placeholder "Search by name") in an
  `s-box padding="base"`; filter client-side on `name.toLowerCase().includes(query)`;
  show "Showing X of Y teams." when filtering, and the "No teams match." + Clear filters
  state when the filter empties the list (copy pattern from workflows).
- Table columns: **Team** (link + `No members` warning badge when `memberCount === 0`),
  **Members** (count), **Used by** (names from `groupUsedBy(ownedSteps.filter(teamId))`,
  linked, draft-only gets an `s-badge` "draft"; `—` subdued when none), **Created**
  (`LocalDateTime`). No action column.
- Empty state inside the section: "No teams yet. A team is who can work a step; assign
  one to each step in a workflow." plus `createButton(false)`.
- `s-modal id={CREATE_MODAL} heading="Create team" onShow={() => form.reset()}` holding
  the `useForm` name field (`s-text-field label="Name" details="You'll add members
next." maxLength={64}`), Cancel, and a `primary-action` Create button that is
  `loading` while pending and calls `form.handleSubmit()`.
- `createTeamFn` unchanged. On success: `await shopify.modal.hide(CREATE_MODAL)`, then
  `router.navigate({ to: "/app/teams/$teamId", params: { teamId: created.id } })`. The
  server fn already returns the `Team`; if it returns void today, make it return the
  created row. `NAME_TAKEN` must land as the field error, not the banner: catch it in
  `onError` and call `form.setFieldMeta("name", ...)` or hold a `nameError` state that is
  passed to `error` and cleared on input, as the workflows index does at `:593`.
- Remove: the delete mutation, `confirming`, `confirmRow`, `deleteBanner`, the
  `useShopAgent` import if unused.

E2E: rewrite `e2e/teams.spec.ts:27-82` for this page: empty state copy, click "Create
team", fill the modal, submit, expect navigation to `/app/teams/<id>` with the trimmed
name as heading; go back, create the same name in different case, expect the modal's
field error; search filters the table.

## Step 2: Team page (`app.teams.$teamId.tsx`)

Loader: `findTeamDetail`, `listMemberTeams`, `listStepsOwnedBy`, `countStepsByTeam`
filtered to this team (keep as is).

Page: `inlineSize="base"`, not `"large"` — `s-page` renders the `aside` slot only at
`base`. See [The team page layout](#the-team-page-layout).

Header:

- Breadcrumb `Teams`, heading `team.name`, `No members` accessory badge when
  `inTeam` count is 0.
- `primary-action` button **Add members** (see the dialog below).
- `secondary-actions` button "More actions" with `commandFor="team-actions"` and an
  `s-menu id="team-actions"` containing **Rename** (`commandFor={RENAME_MODAL}`) and
  **Delete** (`tone="critical"`, `commandFor={DELETE_MODAL}`), mirroring
  `app.workflows.$workflowId.tsx:690-715`.
  Main column, one section (`heading="Members"`, `accessibilityLabel="Team members"`,
  default `padding="base"` — `padding="none"` would strip the heading's own inset):

- An `s-stack gap="base"` holding the mutation-error and `deleteBanner` banners, then
  the roster.
- If `inTeam` count is 0: the centered empty state — heading "No members yet", the
  sentence "Nobody is on this team, so its steps sit unclaimed until someone joins.",
  and a second **Add members** button. If the shop has no members at all, the sentence
  is "This shop has no members yet. Add them once, then put them on teams." with an
  `s-button href="/app/members"` "Add members" instead. One module-scope `emptyState`
  helper renders both.
- Else a table inside `s-box border="base" borderRadius="base" overflow="hidden"`:
  **Member** (email), **On team since** (`LocalDateTime`; needs `TeamMember.createdAt` —
  add it to the `findTeamDetail` select as `inTeamSince` nullable, decoded
  `Schema.NullOr(Schema.String)` in `TeamDetail.members`), and an **Actions** column,
  right-aligned with `s-stack alignItems="end"` in both header and cell, holding a
  `tertiary tone="critical"` **Remove** button per row.

Aside:

- `<UsedByCard steps={ownedSteps} />` (carries its own `slot="aside"`).
- `s-section slot="aside" heading="Details"` with a `max-content 1fr` fact grid —
  Members (`current.length`) and Created (`team.createdAt`) — the same grid shape as the
  order page's Order details card.

Remove flow: clicking Remove sets `removing: MemberId | null`; one
`s-modal id={REMOVE_MODAL}` reads the member from state and shows "Remove {email} from
{team}? They keep access to the shop and their other teams." plus, when they are the
last member, "{team} will have no members." Confirm calls the existing `setTeamMemberFn`
with `inTeam: false`, hides the modal, invalidates.

Add members dialog (`ADD_MODAL`), revised 2026-09-12 — see
[The Add members dialog](#the-add-members-dialog) for why this is not the Picker API:

```ts
const candidates = members.filter((m) => !m.inTeam);
const matches =
  query === "" ? candidates : candidates.filter((m) => m.email.includes(query));
/** The list reports only what it renders, so keep the selections it cannot see. */
const changeSelected = (values: readonly string[]) => {
  const rendered = new Set<string>(matches.map((m) => m.id));
  setSelected([...selected.filter((id) => !rendered.has(id)), ...values]);
};
```

An `s-modal` holding an `s-search-field` (only from six candidates up) and an
`s-choice-list multiple`, one `s-choice` per candidate with their other teams as
`<s-text slot="details">Already on …</s-text>`. Cancel plus an **Add** primary action
carrying the count, disabled until something is ticked. When `candidates.length === 0`
the body is one sentence ("This shop has no members yet. Add them once, then put them on
teams." or "Everyone is already on this team.") and the primary action is an
`s-link`-style button to `/app/members`.

`addTeamMembersFn`: POST, validator `Schema.Struct({ teamId: Schema.String, memberIds:
Schema.Array(Schema.String) })`, decodes ids, calls `repository.addTeamMembers`,
`catchTag("TeamNotFoundError", failWith(TEAM_GONE))`.

Rename: `s-modal id={RENAME_MODAL} heading="Rename team"` with the `useForm` name field
initialised from `team.name` on `onShow`; Save is the primary action; `NAME_TAKEN` as
field error. Uses the existing `renameTeamFn`.

Delete: `s-modal id={DELETE_MODAL} heading={`Delete ${team.name}?`}` with
`deleteTeamWarning(stepCounts)` as the body, Cancel, and a `tone="critical"` Delete that
runs the existing socket `deleteMutation`. On `Deleted` navigate to `/app/teams`; on
`NotFound` hide the modal and show `deleteBanner`.

Remove: the Name section and its form, the Workflow steps section and
`renderOwnedSteps`, the checkbox list, `confirming`.

E2E: extend the rewritten `e2e/teams.spec.ts`: from the created team, Add members
opens an in-frame `s-modal#add-team-members`. Scope to that element, tick the candidate
by `getByRole("checkbox", { name: email })` (its text matches both the `s-choice` and
its inner `<label>`, so a text locator is a strict-mode violation), and click the
counted `Add 1`. Expect a row; Remove opens the modal with
the last-member sentence, confirm, expect the empty-team box; Rename via More actions;
Delete via More actions with the "No workflow steps are assigned to it." sentence,
expect `/app/teams` with the empty state. Seed with `seedMembers(config, [MEMBER_EMAIL])`
as today.

## Step 3: Members page (`app.members.tsx`)

Loader: `listMembers`, `listTeams` (as `TeamRoster`: id, name, memberCount),
`listMemberTeams`.

Header: `<SocketBanner />`, **Add member** primary action when `members.length > 0`.

Section (`padding="none"`): intro "Members sign in with their email on the member
area. Put each one on a team, or they have nothing to do."; `s-search-field` "Search by
email" once there are members; table columns **Email**, **Teams**, **Added**
(`LocalDateTime`; replace the bare `toLocaleDateString`), and an action cell.

Teams cell: up to four `s-chip`s from `memberTeams` for that member, then a subdued
`+N`; when none, `s-badge tone="warning"` "No teams".

Action cell: two `tertiary` buttons, **Edit teams** and **Remove** (`tone="critical"`).
Do not build a per-row `s-menu`: Polaris supports it but the table has no row-action
slot, it needs N menu ids in the DOM, and two small buttons read fine at this row count.
The mockup's "···" collapses to these two buttons.

Empty state: "No members yet. Add an email to grant access." plus the Add member
button.

`MemberTeamsFields`: a component in `src/components/MemberTeamsFields.tsx` rendering an
`s-choice-list label="Teams" multiple name="teamIds" values={value}` with one
`s-choice value={team.id}` per team, `details="Optional. A member with no team has
nothing to do yet."`, and "No members" as subdued text after a team name when its
`memberCount === 0`. Read `event.currentTarget.values` on change. It takes
`{ teams, value, onChange }` so both modals below share it. When `teams.length === 0`
render one subdued line: "No teams yet. Create one on Teams." with the link.

**Add member modal** (`ADD_MODAL`): `useForm` with `{ email: "", teamIds: [] as
string[] }`, validator `Schema.Struct({ email: Domain.EmailInput-or-existing MemberInput
email check, teamIds: Schema.Array(Schema.String) })`; fields: `s-email-field` (details:
"They'll sign in with this email on the member area. No Shopify account needed."), then
`MemberTeamsFields` bound to the `teamIds` field. Primary action **Add**. Server fn
`addMemberFn` gains `teamIds`: after `addMember` (returns `void`, `Repository.ts:153-155`),
`yield* repository.findMember({ shop, email })` (`:170-174`, returns `Option`) and call
`setMemberTeams` with the id; treat `Option.none` as a `RepositoryError`, it cannot
happen on the same primary connection. Only call `setMemberTeams` when `teamIds` is
non-empty on the add path, so re-adding an existing email with nothing checked leaves
their teams alone. Re-adding an existing email stays idempotent for the row and now
**also** applies the chosen teams; document that in the fn's JSDoc.

**Edit teams modal** (`EDIT_TEAMS_MODAL`): `editing: Member | null` state; heading
`Teams for ${email}`; `MemberTeamsFields` initialised from `memberTeams` for that
member on open; Save calls `setMemberTeamsFn({ memberId, teamIds })` →
`repository.setMemberTeams`. One modal element, opened by each row's Edit teams button
after setting state (use `shopify.modal.show(EDIT_TEAMS_MODAL)` from the click handler
rather than `commandFor`, so state is set first).

**Remove modal** (`REMOVE_MODAL`): `removing: Member | null`; heading
`Remove ${email}?`; body is today's copy, with the emptied-teams sentence derived as
`memberTeams.filter(row => row.memberId === id && row.teamMemberCount === 1)`; tone
warning when that list is non-empty. Confirm calls the existing `deleteMemberFn`.

E2E: rewrite `e2e/members.spec.ts:18-62`: empty state, Add member modal with padded
mixed-case email and one seeded team checked (seed one team first with
`seedMembers(config, [], [{ name: "Engraving", members: [] }])`), expect the row with an
"Engraving" chip; re-add same email with no teams checked, expect one row still with the
chip (empty selection on add is a no-op); Edit teams re-check Engraving, expect the chip; Remove
shows "This will leave Engraving with no members.", confirm, expect empty state.

## Step 4: member area and docs sweep

- `src/routes/app.tsx` nav: unchanged.
- Grep `src/` for "Create one above", "Add an email above", "Add members" links into
  `/app/teams/...` and "No workflow steps are assigned to this team" and fix any copy
  that pointed at removed UI (the order page links to team pages; those still exist).
- `e2e/fixture.ts` unchanged; `pnpm seed` still works because it goes through the
  seed route, not the pages.
- Run `pnpm graphql-codegen` only if a `#graphql` string changed (none expected).

## Verification checklist

1. `pnpm typecheck && pnpm lint && pnpm test` green.
2. `npm run test:e2e -- e2e/teams.spec.ts e2e/members.spec.ts e2e/member-area.member.spec.ts`
   green; the member-area spec proves membership revocation and "no teams" still hold
   through `setMemberTeams`.
3. Manual, embedded, with `pnpm seed`: Teams shows "Used by" names; Team 07 Empty shows
   the centered empty state beside its **Used by** and **Details** aside cards, and its
   Add members dialog lists all eight members with their
   other teams; adding two paints two rows without reload; Members shows chips and one "No teams" badge
   for member-08; Edit teams on member-08 puts them on Team 01 and the Teams page count
   for Team 01 goes to 3.
4. `pnpm fmt` run last; keep every touched file.

## Files touched

| Area   | Files                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| New    | `src/lib/teams.ts`, `src/lib/usedBy.ts`, `src/components/UsedByCard.tsx`, `src/components/MemberTeamsFields.tsx`                     |
| Domain | `src/lib/Domain.ts` (`MemberTeam`, `OwnedStepByTeam`, `TeamDetail.members.inTeamSince`, three loader interfaces)                     |
| D1     | `src/lib/Repository.ts` (`listMemberTeams`, `setMemberTeams`, `addTeamMembers`, drop `listSoleMemberships`, `findTeamDetail` select) |
| Object | `src/lib/WorkflowRepository.ts`, `src/lib/ShopAgent.ts`, `src/lib/ShopAgentClient.ts` (`listOwnedSteps`)                             |
| Routes | `src/routes/app.teams.index.tsx`, `src/routes/app.teams.$teamId.tsx`, `src/routes/app.members.tsx`                                   |
| Tests  | `test/integration/repository.test.ts`, `e2e/teams.spec.ts`, `e2e/members.spec.ts`, grouping unit test                                |
