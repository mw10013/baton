# Limits, plans and cost: implementation plan

This plan carries out the decisions in `docs/limits-research.md` (under "Recommendations" and "Decisions"). Read that doc first: the plan numbers, the ceilings and the two new per-member caps are decided there, with the reasoning the JSDocs below must carry inline. This plan says what to change, in what order, and how to know each phase is done.

## Before you start

- Read `AGENTS.md` and `docs/vocabulary-runbook.md`. The rules that matter most here:
  - A rule is stated once, in JSDoc, on the symbol that is the concept or enforces it. Other sites `{@link}` it. A JSDoc never cites a file under `docs/`; it carries its reasoning inline. `scripts/lib/cost.ts` is not under `docs/` and may be cited by symbol.
  - A vocabulary word moves in the same change as its symbols. A new word follows the runbook: the row first, then the symbols, then `pnpm spec check`.
  - The connection table on `ConnectionRole` (`src/lib/domain/Platform.ts`), the sync tables on `syncOrder` (`src/lib/domain/Orders.ts`) and the data-model table on `initializeSchema` (`src/lib/ShopAgentSchema.ts`) are parsed by `pnpm spec check`; a `pinned by` title must exist as an `it(...)` title.
  - The Limits help page (`src/components/help/reference/limits.tsx`) reads every number from its constant, and `test/integration/help-limits.test.ts` lists every constant the page must print. A new limit is a row on the page and an entry in that list. The Plans and billing page prints no number; keep it that way.
  - `scripts/rules-lint.ts` refuses retired words and off-vocabulary words in screen copy. "Tab", "device" and "session" are not vocabulary words; screen copy says "signed in elsewhere" and nothing about devices.
  - No migrations while prototyping: edit `initializeSchema` in place and run `pnpm dev:reset` yourself.
  - Do not commit unless the user says so.
- After each phase run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt`. Keep every file `pnpm fmt` touches.
- Record anything that does not go as written under [Deviations and issues](#deviations-and-issues) as you go, with the two options you saw and the one you took.
- Each phase is one change. Do not merge phases.

## The decisions, in the order the phases take them

| decision                                   | what                                                                                                   | phase |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ----- |
| plans 5, 6, 9                              | 200 and 1,500 orders included; Pro at $0.05 an order and $7 a seat; 14-day trial on both; README table | 1     |
| ceilings 1, 3, 4, 7                        | 50 members, 200 workflows, 50 teams kept; plan-independent; JSDocs carry the model's reasoning         | 2     |
| decision 8, half one                       | 2 connections a member, newest wins, close code the screen shows as signed in elsewhere                | 3     |
| decision 8, half two                       | 2 sign-in sessions a member, newest wins; the displaced device's sockets revoked                       | 4     |
| gap 2                                      | line-item properties capped at 8 KB an item on write                                                   | 5     |
| gap 3, the help pages, `pnpm cost` presets | the Limits page rows, the DDL note, the presets match the ceilings                                     | 6     |

Decision 2 (no cap on counted orders a cycle) and the open-order ceiling at 2,500 change nothing.

## Phase 1: the plans

### 1.1 `ENTITLEMENTS` (`src/lib/domain/Billing.ts`)

- `basic: { ordersPerCycle: 200, membersIncluded: 3 }`, `pro: { ordersPerCycle: 1500, membersIncluded: 10 }`.
- Rewrite the "Provisional" paragraph on `ENTITLEMENTS`. It is no longer provisional. Say what the numbers are set against, inline: Route to Ship's ladder ($39 for 3 users and 250 orders, $99 for 10 and 1,000, $249 for 30 and 5,000), and that infrastructure is cents an order and cents a seat at every size the app serves (`scripts/lib/cost.ts`), so positioning sets the numbers, not cost. Keep the paragraph on the dashboard tiers having to equal tier 1, and the paragraph on raising being safe and lowering not.

### 1.2 `README.md`, "Plans"

Update the table and the top-feature lines:

| field           | Basic                                  | Pro                                      |
| --------------- | -------------------------------------- | ---------------------------------------- |
| Free trial      | 14 days                                | 14 days                                  |
| Meter 1, tier 1 | Units 1 to 200 at $0.00                | Units 1 to 1500 at $0.00                 |
| Meter 1, tier 2 | Units 201 and up at $0.12              | Units 1501 and up at $0.05               |
| Meter 2, tier 1 | Units 1 to 3 at $0.00                  | Units 1 to 10 at $0.00                   |
| Meter 2, tier 2 | Units 4 and up at $12.00               | Units 11 and up at $7.00                 |
| Top feature 1   | `200 orders included, then $0.12 each` | `1,500 orders included, then $0.05 each` |
| Top feature 2   | `3 members included, then $12 each`    | `10 members included, then $7 each`      |

Both top-feature lines are under 40 characters; count them. Drop "All numbers are provisional." Add one line under the table: the numbers were set 2026-10-08 against Route to Ship's published ladder, and a change starts at `ENTITLEMENTS`, the dashboard and this table together.

### 1.3 The Partner Dashboard

The dashboard is the user's to edit, not the implementer's. Add a line to the Deviations section when phase 1 is done saying the dashboard for `baton-local` still carries the old tiers until the user updates it, and that `pnpm test:e2e:billing` (headed, against the dev store) is the check once it is.

### 1.4 Tests

`grep -rn "20\b\|30\b" test e2e | grep -i "order\|entitle\|included"` for a test that pins 20 or 30 as the included allowance; read each hit. A test that reads `entitlementsOfPlan` or `MAX_ENTITLEMENTS` needs no change. A test with a literal does: use the constant.

### 1.5 Done when

`pnpm typecheck`, `pnpm lint`, `pnpm test` green; the README table, `ENTITLEMENTS` and the top-feature lines agree; the Plans and billing help page still prints no number (`help-limits.test.ts`, "Plans and billing prints no number").

## Phase 2: the ceilings

### 2.1 `ShopLimits` and `WorkflowLimits` (`src/lib/domain/Platform.ts`)

- `maxMembers: 50`. Replace "Provisional; enterprise fencing, not a tier" with the reason: a member is one live screen per publish, so members load the object's single thread, not its storage; at 50 members and 5,000 orders a month the model (`scripts/lib/cost.ts`) puts the busiest hour at 17% busy and at 100 members and 10,000 a month at 52%, where reads queue; 50 is the fence, two pages of the members index. Plan-independent because the object never sees the plan.
- `maxWorkflows: 200`. Keep the paragraph saying nothing per order depends on it; replace 1,000 with 200 and say why: eight pages with search is what the workflows index carries, and a shop near 200 has a tag design problem.
- `maxTeams: 50`. Replace "Provisional, like every ceiling here" with: a team is a D1 row and a name copied onto run tasks, no read is linear in teams, and 50 is what the orders index's team filter (a select) and the member page's checklist carry; the UI is the thing to change if a shop reaches it.
- `maxOpenOrders: 2500`: drop "Provisional" and keep the rest.
- Rewrite the paragraph on `ShopLimits` itself: these are plan-independent ceilings set 2026-10-08 from the cost model and the screens, not provisional.

### 2.2 The screens

- `MEMBER_CEILING` in `src/routes/app.members.index.tsx` and the teams and workflows "A shop can have N …" copy read the constants; no edit unless a literal is found. `grep -rn "\b12\b\|1,000\|1000" src/routes src/components | grep -iv "px\|ms\|limit:"` and read the hits.
- The Limits help page reads the constants; no edit.

### 2.3 Tests

- `test/integration/repository.test.ts` loops `maxMembers` adds; 50 is fine. Run it.
- `e2e/members.spec.ts` asserts the seed is under `maxMembers`; fine.
- `test/integration/help-limits.test.ts` passes unchanged.

### 2.4 Done when

Green, and `grep -rn "rovisional" src/lib/domain/` finds nothing on a limit. (It may still find the usage-cycle "provisional cycle", which is a different word and stays.)

## Phase 3: connections a member

### 3.1 The vocabulary row (`src/lib/domain/Platform.ts`)

Add a row under `revoke`, following the runbook:

| word     | meaning                                                                                                                                 | symbol                                              | screen                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------- |
| displace | the object closing a member's oldest connection because a newer one took the last of `maxConnectionsPerMember`; the screen stays closed | `CONNECTION_CLOSE_DISPLACED`, `displaceConnections` | (none): Signed in elsewhere |

### 3.2 The ceiling

`ShopLimits.maxConnectionsPerMember: 2`, JSDoc: a member is a person with at most a bench computer and a phone; each is one connection, one live screen per publish; a shared sign-in across a floor is many connections on one member id, and this cap with `maxSessionsPerMember` is what makes a member one person. Newest wins: the worker who just opened the app is the one at the bench. Merchants are not capped: Shopify's staff-account limits bound them, and a merchant has no seat to share.

### 3.3 The close code and the object (`src/lib/domain/Platform.ts`, `src/lib/ShopAgent.ts`)

- `CONNECTION_CLOSE_DISPLACED = 4409`. A 4xxx code: terminal to the socket like `CONNECTION_CLOSE_FORBIDDEN`, so the displaced screen does not reconnect and displace the newer one back. The JSDoc says so.
- `Domain.ConnectionState` gains `connectedAt` (epoch ms), set in `onConnect` from `Clock`. The agents SDK does not order `getConnections`, so the state carries the order.
- In `onConnect`, after the identity decodes and the state is set, for a member: read `getConnections(memberConnectionTag(memberId))`, sort by `connectedAt`, and close every one but the newest `maxConnectionsPerMember` with `CONNECTION_CLOSE_DISPLACED`. One log line per displaced connection: `ShopAgent.displaceConnections: shop=<shop> memberId=<id> connectionId=<id>`. The method is `displaceConnections`, private, beside `revokeMemberConnections`.
- The connection table on `ConnectionRole` gets two rows, in the words the column lists allow (check the parser's lists in `scripts/lib/spec.ts` first and extend them if "displaced" is not allowed; note it under Deviations):

| event                                             | side   | answer                                                                             | pinned by                                                  |
| ------------------------------------------------- | ------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| a member's connect past `maxConnectionsPerMember` | object | the member's oldest connections closed 4409 until the cap holds; the new one stays | displaces the oldest connection past the member's cap      |
| close 4409 (displaced)                            | tab    | stays closed; the screen says Signed in elsewhere and offers Reconnect             | the tab stays closed on 4409 and shows signed in elsewhere |

### 3.4 The screen (`src/lib/ShopAgentSocketHost.tsx`, `src/lib/SocketBanner.tsx`)

- `ShopAgentSocketHost` treats 4409 as terminal (as 4403) and exposes it through `onSocketClose`.
- The member subtree (`src/routes/shop.$shop.tsx`) shows the socket banner with the copy "Signed in elsewhere. Reconnect to keep working here." and a Reconnect button that opens a new socket, which displaces the other screen in turn. Add the copy to the copy table on `CopySlot` in `src/lib/Screen.ts` under the banner slot, with the example; `pnpm spec check` refuses an example no screen shows.
- The merchant subtree never receives 4409; nothing to add there.

### 3.5 Tests

- `test/integration/shop-agent-connections.test.ts` (or the file that holds the connection table's existing pins; find it by one of the existing `pinned by` titles): "displaces the oldest connection past the member's cap": three connects on one member id, the first is closed with 4409, the other two stay; a merchant's third connect is not closed.
- Browser project: "the tab stays closed on 4409 and shows signed in elsewhere".
- `pnpm spec check` finds both titles.

### 3.6 Done when

Green; two member screens stay live and a third displaces the oldest, checked by hand on the dev server with three windows (`pnpm dev:start`, sign in as `lead@m.com`).

## Phase 4: sign-in sessions a member

### 4.1 The ceiling

`ShopLimits.maxSessionsPerMember: 2`, JSDoc: the other half of the one-person rule on `maxConnectionsPerMember`. A magic-link sign-in creates a better-auth session per device; this keeps the newest two and revokes the rest, so a sign-in shared across a floor signs the others out. Why revoke rather than refuse: refusing the new sign-in locks the person out of the device in their hand; revoking the oldest signs out the one they are not using.

### 4.2 The hook (`src/lib/Auth.ts`)

- `databaseHooks.session.create.after`: list the user's sessions by `createdAt`, delete every one but the newest `maxSessionsPerMember` (through the adapter, or a `Repository` method on the `Session` table; read `refs/better-auth/docs/content/docs/concepts/database.mdx`, "Database Hooks", and the session routes in `refs/better-auth/packages/better-auth/src/api/routes/session.ts` for `revokeOtherSessions` as the pattern).
- When a session was deleted, revoke the member's connections on every shop the email belongs to (`listMemberShops`, then `revokeMemberConnections` on each shop's stub). 3401 makes every device reconnect through the gate, where the displaced device's cookie no longer resolves and it is refused, and the kept devices come back. Without this the displaced device keeps a live socket with its old identity until it reloads.
- One log line: `Auth.sessionCreate: email=<email> revoked=<n>`.

### 4.3 Tests

- `test/integration/auth.test.ts` (or wherever `Auth` is exercised; find by `signInMagicLink`): "a third sign-in revokes the oldest session": three sign-ins, two sessions remain, the first token no longer resolves.
- "a revoked session's connections are revoked": the stub's `revokeMemberConnections` is called for the member's shop. If a stub is hard to observe in that project, test the two halves separately and say so under Deviations.

### 4.4 Done when

Green; on the dev server, sign in on three browser profiles as `lead@m.com` (`pnpm playwright-cli` with three sessions), and the first lands on the sign-in page at its next navigation.

## Phase 5: line-item properties

### 5.1 The ceiling

`ShopLimits.maxPropertiesBytesPerItem: 8192`, JSDoc: `properties` is JSON of whatever the storefront attached; a storefront app can attach kilobytes (a data-URL proof), the row limit is 2 MB and a statement is 100 KB, and the run copies the list. Keep properties in order while the encoded JSON stays under the cap, drop the rest, and log once per order. Truncated, not refused: the order still syncs and the merchant still sees the properties that fit.

### 5.2 The write

- In `src/lib/OrderSync.ts`, where `properties: node.customAttributes` is mapped, apply `Domain.capProperties` (a pure `Domain` function in `src/lib/domain/Orders.ts`: the list, the cap, returns the kept prefix and the dropped count). Both paths (the webhook fetch and the stream) go through this mapping; confirm, and if the stream maps separately, cap there too.
- The run's `lineItemProperties` copies the stored item, so it inherits the cap. Confirm in `RunRepository`.
- Log: `OrderSync.capProperties: shop=<shop> orderId=<id> dropped=<n>`.

### 5.3 The sync table (`src/lib/domain/Orders.ts`)

Add rule 11 beside rule 10: "an item keeps at most 8 KB of properties on either path; the rest are not stored" | `OrderSync` mapping, `capProperties` | pinned by "keeps the properties that fit in 8 KB and drops the rest". Check the parser's enforcers column accepts the symbol names.

### 5.4 The data-model row (`src/lib/ShopAgentSchema.ts`)

On the `OrderLineItem` row (or add one if there is none): `properties` is at most `maxPropertiesBytesPerItem` of JSON, `holds by` app, `pinned by` the same title.

### 5.5 Tests

- `test/integration/domain.test.ts`: "keeps the properties that fit in 8 KB and drops the rest": a list whose third property overflows keeps two; an empty list is unchanged; one property over the cap alone keeps nothing.
- `test/integration/order-repository.test.ts` or the sync test: an order whose item overflows stores the capped list and syncs.

### 5.6 Done when

Green, `pnpm spec check` finds the title, `pnpm dev:reset` runs.

## Phase 6: the help pages, the DDL note and the presets

### 6.1 The Limits page (`src/components/help/reference/limits.tsx`)

Add rows, each reading its constant:

- "Screens signed in as one member" | `maxConnectionsPerMember` | "The oldest screen says “Signed in elsewhere” and offers Reconnect."
- "Sign-ins as one member" | `maxSessionsPerMember` | "The oldest sign-in is signed out at its next page."
- "Properties on an item" | `maxPropertiesBytesPerItem` as "8 KB" (print through the formatter the page uses for bytes, or add one) | "The properties that fit are shown. The rest are not stored."

Add the three constants to the list in `test/integration/help-limits.test.ts`. The page's JSDoc lists every constant it reads; add the three.

### 6.2 The DDL note

On `ShopOrder.note` in `initializeSchema`, a comment: Shopify caps an order note at 5,000 characters, so the column is bounded by Shopify, not by Baton (gap 3).

### 6.3 `pnpm cost` presets (`scripts/lib/cost.ts`)

The `ceiling` preset is 50 members and 3 merchants; it now matches `maxMembers`. Add a comment on `PRESETS` saying `ceiling` is the members ceiling and `stress` is past it. No number changes.

### 6.4 The Installing page

`src/components/help/getting-started/installing.tsx` speaks of the trial without a length; confirm and leave it.

### 6.5 Done when

Green; `/help/reference/limits` on the dev server shows the three rows with the numbers.

## Phase 7: the whole

- `pnpm typecheck && pnpm lint && pnpm test && pnpm fmt`.
- `pnpm dev:reset`, then `npm run test:e2e --`, then `pnpm seed`.
- Read `docs/limits-research.md` "Recommendations" once more against the tree: every number in the plans table and the hard-limits table is in a constant or the README.
- Update the memory note and the research's Status line: implemented, date, uncommitted.

## Deviations and issues

Record here, as you go, anything that did not go as written: what the plan said, what you found, the two options you saw, and the one you took. One entry per item, dated.

### Phase 1

- 2026-10-08. **Partner Dashboard not updated (1.3, as planned).** The dashboard for `baton-local` still carries the old tiers (20 and 30 orders included, $0.15 and $0.10 an order, $15 and $10 a seat, no Pro trial) until the user updates it to the README table. The check once it is: `pnpm test:e2e:billing`, headed, against the dev store.
- 2026-10-08. **README path.** The README said tier 1 sizes must match `ENTITLEMENTS` in `src/lib/Domain.ts`; it lives in `src/lib/domain/Billing.ts`. Options: leave the stale path, or correct it while editing the paragraph. Took the correction.
- 2026-10-08. **1.4 found no test literal.** No test or e2e spec pins 20 or 30 as an included allowance; every reader goes through `entitlementsOfPlan` or `MAX_ENTITLEMENTS`. No test changed.

### Phase 2

- 2026-10-08. **2.4's grep finds `RUN_PAGE` and `RUN_LIMIT_MAX` in `ShopWork.ts`.** `grep -rn "rovisional" src/lib/domain/` still finds "Provisional" on `RUN_PAGE` and `RUN_LIMIT_MAX` (the rows one run state returns before "Show more"), besides the usage-cycle "provisional cycle". These are page sizes, not ceilings, and the research did not decide them. Options: leave them, or rewrite their JSDoc too. Left them: no decision covers them, and the plan's scope is the limits on `ShopLimits` and `WorkflowLimits`. Nothing on `ShopLimits`, `WorkflowLimits` or `ENTITLEMENTS` says provisional now.
- 2026-10-08. **2.2 found no literal.** The grep of `src/routes` and `src/components` found no member, team or workflow ceiling written as a literal; `MEMBER_CEILING` and the Limits page read the constants. No screen edit.

### Phase 3

- 2026-10-08. **The parser's lists needed nothing.** The connection table's only closed column is `side` (`CONNECTION_SIDE_WORDS`: Worker, object, tab); both new rows use `object` and `tab`. No change to `scripts/lib/spec.ts`.
- 2026-10-08. **Where the displaced state lives (3.4).** The plan said the host exposes 4409 through `onSocketClose` and the member subtree (`src/routes/shop.$shop.tsx`) shows the banner. What I found: the banner is `SocketBanner`, mounted by each page (both member pages already mount it), not by the subtree, so state held in `shop.$shop.tsx` would have to be passed down through a new context anyway. Options: (a) hold a `displaced` flag in `shop.$shop.tsx` and add a context for it; (b) hold `displaced` in `ShopAgentSocketProvider` beside `identified` (true from a 4409 close until the socket opens again) and have `SocketBanner` read it from `useShopAgent()`. Took (b): one owner for socket state, no new context, and the merchant subtree is unaffected because it never receives 4409. `onSocketClose` still receives the close; `shop.$shop.tsx` is unchanged. Reconnect calls `agent.reconnect()`, which partysocket allows after a terminal close.
- 2026-10-08. **The copy table has one row per slot (3.4).** The plan said to add the copy to the copy table under the banner slot, with the example. `parseCopyTable` refuses two rows for one slot, so a second banner row is not possible. Options: (a) keep "Every item is done." as the banner example and mention the new copy only in the `form` cell, where `pnpm spec check` never verifies it; (b) make the new copy the banner row's example and keep "Every item is done." as an inline illustration in the `form` cell. Took (b), so `pnpm spec check` verifies a screen shows the new copy. The `form` cell and the controls table's banner row gained the rule the copy follows: a fault only the person can clear carries the one button that clears it. "Every item is done." stays cited in the controls table and still shows on the order page.
- 2026-10-08. **`SocketBanner.tsx` added to `copyFiles` (`scripts/lib/copy-files.ts`).** It was not a copy file, so neither its existing "Not connected" banner nor the new copy was linted or visible to the example check. Options: leave it out (the example check would then fail, since no copy file shows the example), or add it. Added it; both its banners pass `rules-lint`.
- 2026-10-08. **`connectedAt` on both connection states.** The plan said `Domain.ConnectionState` gains `connectedAt`; I added it to both `MerchantConnectionState` and `MemberConnectionState`, since the union is one schema and decoding is strict. Merchants carry it unused. `connectionStateFromHeaders` now takes the stamp; `getConnectionTags` passes 0 because tags never read it. The tests that compared a stored state with `toEqual` now split the stamp off with a test helper (`splitConnectedAt` in `test/integration/agent-socket.ts`) rather than `expect.any(Number)`, which the linter flags as an unsafe `any`. A connection identified before this change has no `connectedAt` and decodes as unidentified; a deploy restarts the object and drops its sockets, so none survives.
- 2026-10-08. **Ties.** Two connects can read the same millisecond (workerd's clock moves only across I/O). `displaceConnections` treats the connection being identified as the newest whatever its stamp, and orders only the others by `connectedAt`.
- 2026-10-08. **Hand check (3.6) done.** On the dev server, one headless `playwright-cli` session signed in as `lead@m.com` opened the member workflows list in three tabs. The first tab showed "Signed in elsewhere. Reconnect to keep working here." with Reconnect, the other two stayed live, and the log had one `ShopAgent.displaceConnections` line. Reconnect on the first tab displaced the second in turn. Three tabs on one sign-in, not three windows: each tab is its own socket, which is what the cap counts.

### Phase 4

- 2026-10-08. **The hook deletes through a `Repository` method, not the better-auth adapter (4.2).** The plan offered either. Options: (a) `ctx.context.internalAdapter.listSessions` and `deleteSessions` from the hook's endpoint context, as `revokeOtherSessions` does; (b) a `Repository` method on the `Session` table. Took (b), `Repository.keepNewestSessions`: one `delete ... returning id` on the primary, which keeps the session just created whatever its `createdAt` (two sign-ins can read the same millisecond) and the newest others up to the cap; the hook's endpoint context is typed nullable and the adapter path would have needed a list, a sort and a delete in three calls. The app runs no secondary storage, so nothing better-auth caches is bypassed.
- 2026-10-08. **`Auth` now depends on `ShopAgentClient`.** To revoke connections the hook calls `ShopAgentClient.revokeMemberConnections` per shop, so `Auth.layerNoDeps` needs `ShopAgentClient`: `src/worker.ts`, `test/integration/auth.test.ts` and `test/integration/member-fixtures.ts` provide it. Options: call `env.SHOP_AGENT` directly (as `api.dev.seed.ts` does), or go through the client. Took the client, the Worker's one typed path to the object. The member id per shop comes from `Repository.findMember`, one read per shop the email belongs to.
- 2026-10-08. **The cap applies to every user, operators included.** The plan said "the user's sessions". Options: cap members only (skip `ADMIN_EMAILS` users), or every user. Took every user: a sign-in is the same row whoever holds it, and the JSDoc on `maxSessionsPerMember` says so. The connection revoke runs only for the shops the email is a member of.
- 2026-10-08. **Best-effort.** The hook logs and swallows a failure (`Auth.sessionCreate: userId=<id>: session cap failed`), like the expired-auth sweep, so the cap is never the reason a sign-in fails. The cost: a failed delete leaves more than two sessions until the next sign-in.
- 2026-10-08. **A data-model row on `D1_TABLES`.** The plan did not name one. A `Session` row was added: a user holds at most `maxSessionsPerMember` sessions, `holds by` app, pinned by both new test titles, because AGENTS.md makes the D1 table the spec for structural rules on D1.
- 2026-10-08. **Tests (4.3) observe the revoke end to end.** "a revoked session's connections are revoked" opens a member socket to the shop's object with the gate's headers, signs in a third time, and sees it close 3401; no stub needed.
- 2026-10-08. **Hand check (4.4) done.** Three headless `playwright-cli` sessions signed in as `lead@m.com` in turn. The third sign-in logged `Auth.sessionCreate: email=lead@m.com revoked=1`; at its next navigation the first session landed on `/login`, and the second and third stayed on the workflows list. Side effect: any other `lead@m.com` session in the local D1 (for example the user's own browser) is signed out by the same rule.

### Phase 5

- 2026-10-08. **The new rule is 11, and every rule after it moved up one.** The plan said "add rule 11 beside rule 10". The rules table numbers 1 to 17 in sequence and `parseSyncRules` refuses a gap, so the old 11 to 17 became 12 to 18. Options: append the new rule as 18 (no renumbering, but out of the order a sync meets the rules), or insert it as 11 and renumber. Took the insert, and moved every `rule <n> on syncOrder` reference in `ShopAgent.ts`, `OrderRepository.ts`, `OrdersSyncWorkflow.ts`, `ShopAgentOrdersStream.ts`, `domain/Orders.ts` and the reconcile-all pass table in `domain/ShopWork.ts`. Midway I misread rules 15 to 17 as missing (they sit below the rows I had read) and briefly dropped three of those references; they are restored and renumbered to 16 to 18. Check by `grep -rn "rule 1[0-9]" src`: each reference names the rule it means.
- 2026-10-08. **One mapping for both paths, with the log in it.** Both paths already went through `toOrderLineItem` (`src/lib/OrderSync.ts`). The plan said to apply `capProperties` there and log once per order. A pure per-item mapper cannot log once per order, so `toOrderLineItem` became module-private and returns the dropped count beside the item, and a new `toOrderLineItems({ shop, orderId, nodes })` maps an order's items, sums the dropped count and logs `OrderSync.capProperties: shop=<shop> orderId=<id> dropped=<n>` once. Both `OrdersAgent.fetchAndUpsertOrder` and the stream call it. Options: log in each caller, or in the shared mapper. Took the mapper, so the paths cannot drift.
- 2026-10-08. **`runShopAgentOrdersStream` takes `shop`.** The stream had no shop in scope for the log line. Options: log without `shop=` (as its existing truncation warning does), or pass the shop in. Took the parameter; `ShopAgent.onOrdersStream` passes it and the stream tests pass a fixed name.
- 2026-10-08. **The run copy needed no change (5.2).** `RunRepository.insertRun` writes `lineItemProperties` from the stored `OrderLineItem.properties`, so a run copies the capped list.
- 2026-10-08. **The cap is on UTF-8 bytes of the stored JSON array.** `capProperties` keeps the longest prefix whose `JSON.stringify` is at most 8,192 bytes, counting the brackets and commas, without re-encoding the prefix at each step. The domain test covers the exact boundary with a two-byte character.
- 2026-10-08. **Two titles pin the rule.** The sync rule and the data-model `item` row are each pinned by the domain test "keeps the properties that fit in 8 KB and drops the rest" and the stream test "an item's properties past 8 KB are not stored and the order syncs" (the write path, 5.5's second test). The data-model row is new; there was no row for `properties` before.
- 2026-10-08. **`pnpm dev:reset` ran clean** after this phase: stop, wipe, migrations, start, tunnel, install, seed.

### Phase 6

- 2026-10-08. **A bytes formatter added (6.1).** The page had none. Added `Domain.formatKilobytes` in `src/lib/domain/Platform.ts` beside `formatNumber` (whole kilobytes of 1,024 bytes, through `formatNumber`), so the page prints "8 KB". `help-limits.test.ts` checks the three new constants: the two counts through the existing number list, and the properties cap by `formatKilobytes`, since its printed form is not `formatNumber(8192)`.
- 2026-10-08. **Where the rows sit.** The two member rows went under Members and the properties row under Items on an order, all in the "Things in the shop" table, whose third column is "At the limit". The page's JSDoc lists the three constants and `SocketBanner`.
- 2026-10-08. **DDL note (6.2) checked against `refs/`.** The 5,000-character cap on an order note is in `refs/shopify-docs/docs/api/admin-graphql/latest/queries/order.md` (the `note` field), and the SQL comment on `ShopOrder.note` cites it.
- 2026-10-08. **6.4 needed nothing.** `src/components/help/getting-started/installing.tsx` gives no trial length ("If a plan has a trial, the pricing page says how long it is"). Left as is.
- 2026-10-08. **Hand check (6.5) done.** `/help/reference/limits` on the dev server shows "Screens signed in as one member 2", "Sign-ins as one member 2" and "Properties on an item 8 KB", plus the new ceilings (Members 50, Workflows 200).

### Phase 7

- 2026-10-08. **The whole run.** `pnpm typecheck`, `pnpm lint` (no warnings) and `pnpm test` (39 files, 791 tests) green; `pnpm fmt` kept; `pnpm dev:reset` clean; `npm run test:e2e --` 92 passed in 3.4 minutes; `pnpm seed` reseeded the dev store (members 3, teams 9, workflows 12, orders 75).
- 2026-10-08. **Recommendations read against the tree (7.3).** Every number in the research's plans table is in `ENTITLEMENTS` (200 and 1,500 orders, 3 and 10 members) or the README table (the $29 and $79 charges, 14-day trials on both, $0.12 and $0.05 an order, $12 and $7 a seat). Every number in the hard-limits table is a constant: `maxMembers` 50, `maxOpenOrders` 2,500, `maxWorkflows` 200, `maxTeams` 50, `maxTasks` 20, `maxLineItemsPerOrder` 250, `maxConnectionsPerMember` 2, `maxSessionsPerMember` 2, `maxPropertiesBytesPerItem` 8,192, `orderRetentionDays` 365. Counted orders a cycle have no cap, as decided.
- 2026-10-08. **7.4 in part.** The research's Status line is updated. The memory note is left to the caller, as instructed.
- 2026-10-08. **Not verified.** The Partner Dashboard and `pnpm test:e2e:billing` (1.3), which wait on the user. The session cap and the connection cap were checked headless on one machine; nothing here measures the cost model's 25% figure for 100 member connections.
