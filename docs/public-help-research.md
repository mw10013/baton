# Public pages and help slice: research

Status: research, written 2026-10-19. **Settled** 2026-10-19 in one review round: Q1–Q11 accepted as recommended (§0). **Implemented** 2026-10-19 (`docs/public-help-plan.md`), pushed 7ca7a83, staging verified; closed. One correction to §2: `shopify app dev` does not push `name`; the rename took `shopify app deploy`.

The work itself: roadmap §3 row I, the last slice. The public landing page, the privacy policy, the help (hub, six section hubs, 26 pages with bodies, 42 pictures), the links from the merchant and member screens into help, and the script that shoots the pictures. Plus one Shopify-side change the pictures need: the dev app is named **Baton** again, not Baton Dev.

Legacy paths are relative to `refs/baton-legacy/`.

---

## 0. Decisions

Agreed in review, 2026-10-19.

| Q   | Decision                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------- |
| Q1  | One implement-plan thread on `main`, §3's steps in order; the Keychain prompt is the one expected human step. |
| Q2  | Port the script and retake all 42 pictures here.                                                              |
| Q3  | Rename the dev app to "Baton", handle `baton-local` unchanged, as the plan's first step.                      |
| Q4  | Shoot fixture orders as the screen shows them; rewrite the four alts; prose unchanged.                        |
| Q5  | Legacy's prose, corrected to this repo's screens, every change in §7.                                         |
| Q6  | Legacy's landing plus the session-aware actions; delete the playground.                                       |
| Q7  | Privacy verbatim, "Last updated" set to the ship date.                                                        |
| Q8  | All seven links into help.                                                                                    |
| Q9  | Member pictures show the dev store's name.                                                                    |
| Q10 | Unit `help.test.ts` (legacy's titles minus retired words) and e2e `help.spec.ts` (legacy's six titles).       |
| Q11 | Mark the roadmap done when I closes; prune the docs as a separate task.                                       |

### 0.1 What this repo has today, and what the slice needs

| Piece              | Here today                                                                                                                                                                                           | Legacy                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Landing `/`        | `HomePage`: a scaffold heading "Build on the edge with Effect", the **playground** (`Playground.tsx`, `server/playground.ts`, Backend `hello`/`shout`), session-aware Sign in / Dashboard / Sign out | `routes/index.tsx`: `BatonMark`, one sentence, links to Sign in, Help, Privacy policy                                    |
| Privacy `/privacy` | None                                                                                                                                                                                                 | `routes/privacy.tsx`, 212 lines, "Last updated: September 15, 2026"                                                      |
| Help `/help/…`     | None. `FootLine` is ported (kit only); `SetupGuide`'s `help` link is optional because help is missing                                                                                                | `routes/help*.tsx`, `lib/helpPages.ts` (the tree), `components/help/**` (26 bodies), `lib/helpReference.ts`, three parts |
| Pictures           | None. `public/` has only the icons                                                                                                                                                                   | `public/assets/help/<section>/<page>-<n>.png`, 42 files; inventory `lib/helpPictures.ts`                                 |
| Screenshot script  | None. The Shopify admin session export it needs exists (`scripts/lib/shopify-admin-auth.ts`, the `shopify-admin` e2e setup)                                                                          | `scripts/help-screenshots.ts`, 1,564 lines, Playwright library API                                                       |
| Links into help    | None                                                                                                                                                                                                 | App Home foot line and three setup guide steps, order page, workflow editor, sign-in page, member bar's Help, landing    |
| Showcase data      | The dev fixture is legacy's showcase in full (`src/contract/fixture.ts`, `scripts/lib/load-fixture.ts`)                                                                                              | `e2e/showcaseFixture.ts`                                                                                                 |
| Dev app name       | `shopify.app.toml`: `name = "Baton Dev"`, `handle = "baton-local"`                                                                                                                                   | `name = "Baton"`, same `client_id`, same handle                                                                          |

---

## 1. The slice

### 1.1 What legacy does

- **The help is public, at `/help`, one tree for both readers** (legacy `docs/help-research.md`, modelled on the Shopify Flow manual): three levels (Help, section, page), no sidebar, no search. A page is breadcrumbs, the page's one-line lead, its body, then the section's page list with the current page unlinked (the sideways device in place of a sidebar; on a phone it is the visible way up). `HELP_SECTIONS` is the one source the three routes read.
- **Sections:** Getting started (5), Orders (5), Workflows (5), Teams and members (3), For members (4), Reference (4: badges, who can do what, limits, plans and billing). `helpReference.ts` builds the reference tables from the domain's label constants, so a badge's help row cannot drift from the screen's badge.
- **Bodies** are components built from parts only (`HelpList`, `HelpPicture`, `HelpTable`, `Things`, `Prose`…), registered in `HELP_BODIES` by `<section>/<page>`.
- **Pictures** have an inventory (`HELP_PICTURES`): file, kind (`merchant` shot in the admin at 1280 × 800 @2x in one of four shapes: page, modal, window, editor modal; `member` a 390 × 844 phone @2x), alt text of 30 to 60 words, and a merchant picture's aspect ratio so the column reserves its height. A body places a picture by name, so it cannot place one the inventory lacks.
- **The script** (`pnpm help:screenshots [--section <slug>]`) checks the dev server, refreshes the admin session from Chrome when it is older than a day, loads the showcase, shoots every merchant picture in the admin and every member picture signed in as `ana@example.com`, then reloads the showcase (the shots create a workflow, a team and a Done) also on failure. An overlap check refuses a shot an admin overlay would land in. Items are found by order number, so a picture follows its item if the fixture's order changes.
- **Links into help:** a foot line, "Learn more in <page heading>.", one per screen that has one, `target="_blank"` inside the embed (App Home → Help; order page → Reading an order; workflow editor → Editing steps and tasks; sign-in → Signing in); the setup guide's three help links (Getting started pages); the member bar's **Help** → `/help/members`; the landing page → `/help`.
- **Tests:** an integration file (tree unique and titled, bodies registered only for tree pages, every inventory file exists and every file is in the inventory, every picture placed, aspect ratio equals the file's, alt length, help copy free of retired words) and `e2e/help.public.spec.ts` (hub, section hubs and foot lists, not found, landing → help, sign-in → Signing in, every body renders and its pictures load).

### 1.2 What carries over unchanged

- The tree, its slugs and titles, the three routes' shape, `helpTabTitle`, the not-found page.
- The bodies' prose as the spec (with §1.3's check), the reference tables' derivation from the domain's label constants.
- The three parts, into `src/web/components/screen/` with kit entries.
- The picture inventory's shape and rules (kinds, shapes, sizes, alt length, aspect ratio), and the script's order of work, `--section`, overlap check and closing reload.
- Privacy policy text (Q7), the landing page's content (Q6).

### 1.3 What must change

1. **Every picture is retaken here** (Q2). Legacy's pictures show legacy's screens on `sandbox-shop-00`; ours are ports, not copies (Polaris 2.0 RC, the member bar here has no Help link yet, fixture orders carry no Shopify controls, Q4). A picture that does not match the screen beside the prose is worse than none.
2. **The app's name in the admin.** The App Home's title bar shows the app's name, and `installing-1.png` is the App Home: shot today it reads "Baton Dev". The admin's sidebar lists it under that name too. Q3.
3. **Bodies are checked against this repo's screens**, not ported blind. The implementer reads each body beside the screen it describes and fixes the prose where the port differs (a label, a menu, a sign-in path: legacy `/login` is `/sign-in` here). Each difference goes in the plan's §7.
4. **Navigation.** Help pages are outside the admin, so `AGENTS.md`'s rule applies: in-site links go through the router (`<Link>`, or `href` plus the router `onClick`, `useNavigateOnClick`), not bare Polaris anchors. Links from inside the embed stay `target="_blank"` with a relative `href` (the iframe's origin is the Website's).
5. **Script plumbing.** `scripts/help-screenshots.ts` runs with `node --env-file=.env`, as `scripts/dev.ts` does; uses this repo's admin session export (`scripts/lib/shopify-admin-auth.ts`), frame helpers from `test/e2e/`, the dev store `mw10013-dev-shop-00`, and `load-fixture.ts` for the showcase load and the closing reload. Effect 4 idioms (`Schema.TaggedError`, `Effect.fn`).
6. **Tests move** (Q10): legacy's integration file becomes a unit test (it reads files and modules, no Worker); the e2e spec joins the project that runs the public specs. The retired-words title goes: roadmap Q4 left `rules-lint` behind.
7. **The landing page loses the playground** (Q6): the Backend's `hello` and `shout`, their contract, server functions and component. Nothing in `test/` or `scripts/` calls them.

### 1.4 Risks

- **The screenshot script is the biggest single piece** (1,564 legacy lines) and talks to the real admin, whose overlays and frame timing are the flakiest thing in this repo. Mitigation: port its gates as they are (overlap check, settle), run it once per section while porting, and keep it out of every test suite.
- **The admin session export may prompt for the Keychain** (it reads Chrome's cookies). That is a human step; the plan lists it before the screenshot step.
- **The rename lands only through `shopify app dev`.** Until the next `vp run dev` after the edit, the admin still says Baton Dev. The plan checks the title bar before any shot.
- **Bodies describe behaviour.** A body that says something the port does differently is a product question, not copy; the implementer records it rather than deciding it.

---

## 2. The app name

`shopify.app.toml`'s `name` is the label the admin shows: the sidebar's app list, the App Home's title bar, the install and permission screens, the Dev Dashboard. `handle` (`baton-local`) is the URL (`/apps/baton-local/…`) and stays. A one-time change: the next `vp run dev` (its `shopify app dev`) pushes the new `name` and it stays; no `app deploy` (staging config research §3.6).

Why it is "Baton Dev" (6c03db3, 2026-10-15): the staging app was installed on `sandbox-shop-00` beside the dev app, and the two needed telling apart. That reason is gone: staging now lives on `mw10013-staging-shop-00`, dev on `mw10013-dev-shop-00`, e2e on `mw10013-e2e-shop-00`. The rename also ends the flip-flop §3.6 accepted: legacy's toml, which shares this `client_id`, still says "Baton".

What it touches: `shopify.app.toml` (one line); `docs/shopify-stores-runbook.md` (names "Baton Dev" twice); nothing in `src/`, `test/` or `scripts/` (checked: no code reads the name; the Partner API's `app.name` is only in `docs/billing-plan.md`'s history, left as written). Staging stays "Baton Staging"; no picture is shot there.

---

## 3. Proposed order of work

One plan, steps in this order, each ending green:

1. **Name.** `name = "Baton"`, runbook wording, restart the dev server, see "Baton" in the App Home's title bar.
2. **Landing and privacy.** Legacy's landing with this repo's session-aware actions; the playground removed; `/privacy` ported; `BatonMark` ported as a part.
3. **Help skeleton.** The tree, the three routes, the three parts with kit entries, not-found; the unit tests for the tree; the e2e spec's hub, section and not-found titles.
4. **Bodies.** The 26 bodies and `helpReference.ts`, each checked against its screen (§1.3.3), with the picture inventory but `HelpPicture` placements waiting for files (the inventory tests that need files land in step 6).
5. **Links into help.** The foot lines, the setup guide's help links, the member bar's Help, the landing's Help; their e2e titles.
6. **Pictures.** The script, then all 42 pictures shot on the dev store; inventory aspect ratios from the script's output; alt texts checked against the new pictures; the file and placement tests; the e2e title that every picture loads.

The full `vp test` and one full e2e run by the reviewer (the implement-plan skill), then push and the staging check: `/`, `/privacy`, `/help` and a page with pictures on the staging Website, and one foot link from inside the embedded staging app.

---

## 4. Out of scope

- The App Store listing (its screenshots, its copy). The help's pictures are not listing assets.
- Search in help, an "On this page" list, next and previous links (legacy decided against all three).
- A production help host or domain. Help is served by whichever Website is running.
- Pruning the research and plan docs once the roadmap is done (Q11).

---

## 5. Questions and recommendations

:::question
Q1. Where does it run?

Nothing else is in flight. One plan, one implement-plan thread on `main`, §3's steps in order. The only human step expected is the Keychain prompt for the admin session export before the screenshot step.

- [ ] One implement-plan thread on main, steps in §3's order
- [ ] Two plans: pages and links first, pictures as a second plan

Recommended: One implement-plan thread on main, steps in §3's order
:::

:::question
Q2. Do we take new screenshots?

Yes, in the recommendation. Legacy's 42 pictures show legacy's screens on `sandbox-shop-00`. Ours differ in details a reader would notice beside the prose (Polaris 2.0 RC styling, member bar, Q4's Shopify controls). The alternative copies legacy's PNGs as they are and retakes later; it ships pictures that disagree with the screens.

- [ ] Port the script and retake all 42 here
- [ ] Copy legacy's PNGs now, retake later
- [ ] No pictures in this slice; bodies without them

Recommended: Port the script and retake all 42 here
:::

:::question
Q3. Rename the dev app from "Baton Dev" back to "Baton"?

Only `name` in `shopify.app.toml` changes; `handle = "baton-local"` stays, so no URL or admin link changes. It shows in the admin's sidebar and in the App Home's title bar, which is in `installing-1.png`. The reason for "Baton Dev" (telling it from Baton Staging on one store) is gone: each app has its own store now. Applied by the next `vp run dev`; no deploy. Staging stays "Baton Staging".

![The App Home picture: the title bar shows the app's name](../refs/baton-legacy/public/assets/help/getting-started/installing-1.png)

- [ ] Rename to "Baton", handle unchanged, as the plan's first step
- [ ] Keep "Baton Dev" and edit the name out of the one picture

Recommended: Rename to "Baton", handle unchanged, as the plan's first step
:::

:::question
Q4. Fixture orders have no Shopify controls. How do pictures that show them get shot?

The dev fixture's orders are not in Shopify (`isFixtureOrder`), so the order page has no Sync from Shopify, View in Shopify or Fulfill in Shopify, and the orders index has no Shopify link. Four legacy pictures show those controls: `how-baton-works-1`, `first-order-1` (Fulfill in Shopify), `orders-list-1` (Shopify column), `order-page-1`. The prose describes real orders and stays true.

- [ ] Shoot them as the fixture shows them; rewrite those four alts; prose unchanged
- [ ] Shoot those four from the fixture's real store orders (no showcase runs on them)
- [ ] Make fixture orders show Shopify controls on the dev stage (links that lead nowhere)

Recommended: Shoot them as the fixture shows them; rewrite those four alts; prose unchanged
:::

:::question
Q5. How closely do the bodies follow legacy's prose?

Legacy is the spec. The implementer reads each body beside its screen here and fixes only what the port does differently (labels, paths such as `/login` → `/sign-in`), recording each change in §7. A difference in behaviour, not wording, comes to you.

- [ ] Legacy's prose, corrected to this repo's screens, every change in §7
- [ ] Rewrite the bodies fresh from the screens

Recommended: Legacy's prose, corrected to this repo's screens, every change in §7
:::

:::question
Q6. What does the landing page become?

Legacy's content (Baton mark, "Baton gives made-to-order Shopify merchants a clear production workflow from order to completion.", Sign in, Help, Privacy policy) keeps this repo's session-aware actions (Dashboard and Sign out when signed in). The playground goes: `Playground.tsx`, `server/playground.ts`, `contract/playground.ts`, the Backend's `hello` and `shout`. Nothing in tests or scripts calls them.

- [ ] Legacy's landing plus the session-aware actions; delete the playground
- [ ] Legacy's landing exactly (Sign in link only); delete the playground
- [ ] Legacy's landing; keep the playground somewhere (for example `/dev/playground`)

Recommended: Legacy's landing plus the session-aware actions; delete the playground
:::

:::question
Q7. The privacy policy: port verbatim?

Legacy's text names you as operator, `support@mw10013.com`, Shopify and Cloudflare as processors, and "email/support providers". It is still true here: the compliance webhooks exist (`/webhooks/compliance`), hosting is Cloudflare. Only "Last updated" changes, to the date it ships. One wording point: it says "production runs", a word legacy's screens retired; it reads fine to a merchant.

- [ ] Verbatim, "Last updated" set to the ship date
- [ ] Verbatim, and "production runs" reworded to "production workflows"
- [ ] I will supply new text

Recommended: Verbatim, "Last updated" set to the ship date
:::

:::question-multi
Q8. Which links into help land?

All are legacy's. A screen here that legacy did not have gets none.

- [ ] App Home foot line → Help
- [ ] Setup guide's three help links → Getting started pages
- [ ] Order page foot line → Reading an order
- [ ] Workflow editor foot line → Editing steps and tasks
- [ ] Sign-in page foot line → Signing in
- [ ] Member bar's Help → For members
- [ ] Landing → Help

Recommended: all seven
:::

:::question
Q9. Member pictures show the dev store's name.

The member bar names the shop, so every member picture reads `mw10013-dev-shop-00` (legacy's read `sandbox-shop-00.myshopify.com`). A store named for show would need a new store and its setup.

- [ ] Accept the dev store's name
- [ ] Create a store with a presentable name for the pictures

Recommended: Accept the dev store's name
:::

:::question
Q10. Tests.

Unit (`test/unit/help.test.ts`): legacy's integration titles minus retired words (tree unique and titled; bodies only for tree pages; every inventory file exists and every file is in the inventory; every picture placed; aspect ratio equals the file's; alt 30 to 60 words). E2E (`test/e2e/help.spec.ts`, in the project with the other public specs): legacy's six titles. The script itself is never part of a suite.

- [ ] As above
- [ ] Leaner: unit inventory tests only, e2e just the hub and one page

Recommended: As above
:::

:::question
Q11. When I is done, the roadmap is done. What happens to `docs/legacy-port-research.md` and the slice docs?

The `AGENTS.md` rule deletes research once the code carries the reasons. Pruning ~40 docs is its own review.

- [ ] Mark the roadmap done when I closes; prune the docs as a separate task
- [ ] Prune as part of closing I

Recommended: Mark the roadmap done when I closes; prune the docs as a separate task
:::
