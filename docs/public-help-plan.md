# Plan: public pages and help

Implements `docs/public-help-research.md` (slice I, the roadmap's last). Every question in its §5 was settled on 2026-10-19, all as recommended (§0 there has the one-line forms). Read the research's §0.1, §1 and §2 first; this plan does not repeat their reasoning.

Legacy paths are relative to `refs/baton-legacy/`. Legacy is the spec: read the legacy file before building its counterpart, and port its copy, structure and JSDoc reasons, translated to this repo's idioms and the glossary's words.

## 0. Rules for the implementer

- **AGENTS.md.**
  - Vite+ only; `vp check --fix` after every change.
  - Effect Schema for parsing (no hand trimming); `Match` for tag dispatch; `Schema.TaggedError`; `Effect.fn("name")`.
  - Layout only in `src/web/components/screen/` parts; every in-site link through `useNavigateOnClick` or a TanStack `<Link>` (the help pages are outside the admin, so a bare Polaris anchor is a full page load). A link from inside the embed into help keeps `target="_blank"` and a relative `href`.
  - The JSDoc rules: never cite this plan, the research or any `docs/` file in code.
- **Commits.** Work on `main`. Commit at the end of each green step. Stage paths explicitly; never `git add -A` or `git commit -a`. Do not push.
- **Each step ends green.**
  - `vp check --fix`, and `vp test <files>` for the tests the step touches.
  - e2e only where a step changes what a spec exercises, and then that spec alone (`vp run test:e2e <spec>`, no `--`). Never the full e2e suite.
  - The full `vp test` once, in Step 7.
  - A step that cannot end green is recorded in §7 before moving on. Do not re-run a test through a failure you understand; record it.
- **What does not change.** No table, no procedure, no `DevRpcs` growth, no stage config value. Never `db:reset` staging, `cloud:reset`, `deploy:staging` or `vp run stage-config`. `shopify.app.staging.toml` is untouched.
- **The dev store is yours for the pictures**, and only through `vp run dev` and `vp run fixture`: the script ends with the dev fixture reloaded, also on failure.
- **Bodies (research Q5):** legacy's prose is the spec. Read each body beside the screen it describes on the dev server and correct only what this repo's screen does differently (a label, a menu entry, a path such as legacy `/login` → `/sign-in`). Record each correction in §7 under Deviations, one line each. A difference in **behaviour** (the screen does something the prose says it does not, or lacks a feature the prose describes) is not yours to decide: record it under Issues as `DECISION:` and keep going with legacy's prose.
- Do not rewrite the steps. Record in §7 what you built differently, and what surprised you, as you go.

## 1. Outcome

- The dev app is named **Baton** in the admin (sidebar, App Home title bar); its handle is still `baton-local`.
- `/` is legacy's landing page (Baton mark, the one sentence, Sign in, Help, Privacy policy) with this repo's session-aware actions (Dashboard and Sign out when signed in). The playground is gone, Backend methods included.
- `/privacy` is legacy's policy, "Last updated" the ship date.
- `/help`, `/help/$section`, `/help/$section/$page`: legacy's tree (6 sections, 26 pages), every page's body, every reference table derived from the domain's labels, the not-found page.
- 42 pictures under `public/assets/help/`, shot on this repo's screens by `vp run help:screenshots`, each in the inventory with an alt text that matches it.
- Seven links into help (research Q8): App Home foot line; the setup guide's three help links; order page foot line; workflow editor foot line; sign-in page foot line; the member bar's Help; the landing's Help.
- Tests: `test/unit/help.test.ts`, `test/e2e/help.spec.ts` (research Q10).

## 2. What this plan rests on

- **The name** is `name` in `shopify.app.toml`; `shopify app dev` (started by `vp run dev`) pushes it once and it stays. No code reads it (checked: `git grep "Baton Dev"` finds only `shopify.app.toml` and docs).
- **The showcase is the dev fixture** (`src/contract/fixture.ts`'s data, loaded by `vp run fixture`, `scripts/fixture.ts` → `scripts/lib/fixture.ts` → `loadFixtureWhenInstalled`). Its orders are not in Shopify (`isFixtureOrder`), so the order page and the orders index show no Shopify controls on them (research Q4).
- **The admin session** for the merchant pictures: `scripts/lib/shopify-admin-auth.ts` (`adminSessionFresh`, `exportShopifyAdminAuth`, `CHROME_PROFILE`), the same export the `shopify-admin` e2e setup writes to `storageStatePath` (`playwright.config.ts`). A stale export reads Chrome's cookies and may raise a macOS Keychain prompt.
- **Embedded helpers** shared by scripts and e2e: `scripts/lib/embedded-app.ts` (`appFrame`, `awaitHydration`, `closeDevConsole`), `test/e2e/embedded/app.ts` (`gotoApp`, `editorFrame`, `clickHoisted`, `openEditor`, `closeEditor`), `test/e2e/embedded/orders-screens.ts` (`openOrder`, `openScreen`).
- **Member sign-in on dev** is inline magic-link delivery (`MagicLinkDelivery`, `inline`): the sign-in page shows the link, as e2e's `requestMagicLink` uses.
- **Existing parts:** `FootLine` (ported, unused outside the kit), `SetupGuide` (its `help` link is optional, today unset), `Things`, `Prose`, `MemberBar` → `TopBar`. Missing: `BatonMark`, `HelpList`, `HelpPicture`, `HelpTable`.
- **Static assets:** `public/` is served by the Website (the app icons are there today).
- **The public e2e specs** run in the `chromium` project (`http.spec.ts`, `sign-in.spec.ts`), against the e2e server.

## 3. Names

| Where                        | Name                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web/help/pages.ts`      | `HelpPage`, `HelpSection`, `HELP_SECTIONS`, `findHelpSection`, `findHelpPage`, `helpTabTitle` (legacy `lib/helpPages.ts`)                                     |
| `src/web/help/pictures.ts`   | `HelpPictureKind`, `HelpPicture`, `HELP_PICTURES`, `HelpPictureName`, `MERCHANT_WINDOW`, `MEMBER_SCREEN`, `HELP_PICTURES_PATH` (legacy `lib/helpPictures.ts`) |
| `src/web/help/reference.ts`  | legacy `lib/helpReference.ts`'s exports, reading this repo's domain label constants                                                                           |
| `src/web/components/help/`   | `bodies.tsx` (`HELP_BODIES`), one file per page under `<section>/<page>.tsx` (legacy `components/help/**`)                                                    |
| `src/web/components/screen/` | `BatonMark`, `HelpList`, `HelpPicture`, `HelpTable` (legacy's parts), each with a kit entry in `KitPage`                                                      |
| Routes                       | `help.tsx`, `help.index.tsx`, `help.$section.index.tsx`, `help.$section.$page.tsx`, `privacy.tsx`; `index.tsx` rewritten                                      |
| Script                       | `scripts/help-screenshots.ts`; `package.json` `"help:screenshots": "node --env-file=.env scripts/help-screenshots.ts"`; `--section <slug>`                    |
| Tests                        | `test/unit/help.test.ts`, `test/e2e/help.spec.ts`                                                                                                             |
| Deleted                      | `src/web/components/Playground.tsx`, `src/web/server/playground.ts`, `src/contract/playground.ts`, `BackendApi`'s `hello` and `shout` and their wiring        |

If `src/web/help/` does not fit the source layout (glossary "Source layout"), put the three modules where the layout says and record it.

## 4. Steps

### Step 1: The name (research Q3)

1. `shopify.app.toml`: `name = "Baton"`. `handle` unchanged.
2. `docs/shopify-stores-runbook.md`: "Baton Dev" → "Baton".
3. Restart the dev server (`vp run dev:stop`, `vp run dev`). Check the App Home on `mw10013-dev-shop-00` reads **Baton** in the admin's title bar and sidebar (Chrome DevTools MCP or Playwright CLI). If it still reads Baton Dev, record what `.logs/dev/current` says about the config push and stop at `WAITING: name`.

### Step 2: Landing and privacy (research Q6, Q7)

1. Port `BatonMark` into `screen/` with a kit entry.
2. `index.tsx` and `HomePage`: legacy `routes/index.tsx`'s content and `head` title, keeping the `shop=` redirect and the session-aware actions (Dashboard and Sign out signed in, Sign in signed out; Sign in also as legacy's link). Links to `/help` and `/privacy` through the router.
3. Delete the playground (§3 Deleted). `git grep -i "hello\|shout\|playground" -- src test scripts` finds nothing of it afterwards.
4. `privacy.tsx`: legacy's text verbatim; "Last updated" the date this step lands; breadcrumb to `/`.
5. Update `HomePage`'s browser test if one exists; add none otherwise (the e2e covers it in Step 7).

### Step 3: Help skeleton

1. `pages.ts` with legacy's tree verbatim.
2. `HelpList`, `HelpTable` (and `HelpPicture` in Step 6) into `screen/` with kit entries.
3. The four help routes as legacy's, the not-found page included, links through the router.
4. `test/unit/help.test.ts`: "every help page has a unique route and a title that is its heading", "a page body is registered only for a page the tree has" (lands with Step 4's registry).
5. With Step 4's `reference.ts` and bodies: legacy `test/integration/help-reference.test.ts`'s "every label constant is on its reference page" and `help-limits.test.ts`'s "every limit a merchant plans around is on the Limits page" and "Plans and billing prints no plan number", as unit tests beside the others (the retired-words titles stay behind, Q10).

### Step 4: Bodies (research Q5)

1. `reference.ts` from legacy's, reading this repo's label constants (`src/domain/`).
2. The 26 bodies, one commit per section. Each read beside its screen on the dev server with the dev fixture loaded (`vp run fixture`); corrections per §0.
3. `HelpPicture` placements: port them with the bodies, against `pictures.ts` ported now with legacy's entries (files, kinds, alts); the part renders nothing for a file not on disk yet, so the step stays green. (If that needs a branch in the part, it is removed in Step 6.)

### Step 5: Links into help (research Q8)

1. App Home: `FootLine` "Learn more in Help." (`/help`, `target="_blank"`); the setup guide's help links, legacy `app.index.tsx`'s `helpLink`, to the Getting started pages; remove the `SetupGuide` and `app.index.tsx` JSDoc that says help is missing.
2. Order page: "Learn more in Reading an order." Workflow editor: "Learn more in Editing steps and tasks." Both `target="_blank"`.
3. Sign-in page: "Learn more in Signing in." (same tab, router).
4. `MemberBar`: **Help** → `/help/members`, as legacy's `MemberBar`.
5. Browser tests for the parts and pages touched, where a test file exists for them.

### Step 6: Pictures (research Q2, Q4, Q9)

Human step first: the admin session export may need the Keychain. If `adminSessionFresh` says the export is stale and the export fails, record under Human steps ("accept the Keychain prompt, or run `vp run test:e2e --project shopify-admin`") and stop at `WAITING: admin session`.

1. `scripts/help-screenshots.ts`: port legacy's script (its JSDoc, gates, `MERCHANT_SHAPES`, `overlapCheck`, `--section`, the closing fixture reload in a finalizer) onto this repo's helpers (§2). The store is `SHOPIFY_DEV_STORE`; the server is this checkout's dev server (`WEBSITE_PORT`); the member is `ana@example.com`. Port it section by section, shooting each section as you go (`--section <slug>`).
2. Shoot all 42. Set every merchant entry's `aspectRatio` from the script's output. Rewrite every alt that no longer matches its new picture, in the same 30 to 60 words; the four fixture-order pictures (`how-baton-works-1`, `first-order-1`, `orders-list-1`, `order-page-1`) lose their Shopify controls (Q4). Look at each picture before accepting it.
3. Add the remaining unit titles: "every picture in the inventory is a file under public/assets/help, and every file there is in the inventory", "every picture in the inventory is placed by a help page body", "a merchant picture's aspect ratio is its file's" (read the PNG's IHDR; no new dependency), "every picture's alt text is 30 to 60 words".
4. Check the App Home picture reads **Baton** in its title bar.

### Step 7: e2e and close (research Q10)

1. `test/e2e/help.spec.ts`, legacy `e2e/help.public.spec.ts`'s six titles, signed out: "the hub lists every section", "a section hub lists its pages and a page's foot lists its siblings", "an unknown page is not found", "the landing page links to help", "the sign-in page links to Signing in", "each page with a body renders it and its pictures load". Run it alone.
2. Full `vp test`; record counts and times.
3. `docs/legacy-port-research.md`: §1.1 rows for landing, privacy, help; §3's I row as implemented; Status line "every slice done" (research Q11: no pruning).
4. Record the staging Human steps (§7).

## 5. Verification checklist

- `grep '^name\|^handle' shopify.app.toml` → `name = "Baton"`, `handle = "baton-local"`; `shopify.app.staging.toml` unchanged (`git diff --stat`).
- No playground left (`git grep -i -E "playground|\bshout\b|getHello" -- src test scripts` empty).
- No `s-stack`, `s-grid`, `s-box` or layout prop outside `screen/` (`git grep -n -E "<s-(stack|grid|box)" -- src/web | grep -v components/screen/`).
- No bare in-site Polaris anchor on the help and public pages without the router's `onClick` (read them).
- 42 files under `public/assets/help/`, 42 inventory entries; every §4 test title exists (`rg -F`).
- The App Home picture shows "Baton".

## 6. Done when

- §1 holds on the dev stage, every step is green and committed, §7 is filled in, and the staging Human steps are listed.

## 7. Deviations and issues

For the implementer. Append as you go. Keep each entry short, dated and tagged with its step (`**2026-10-19, Step 2:** …`).

- A **deviation** is anything built differently from the step that specified it, and each body correction (§0). Say what, and why.
- An **issue** is anything the plan did not predict. Say what you saw, what you did, and whether it is open. A behaviour difference is `DECISION:`.
- **Command results** carry counts and times.
- **Human steps requested** lists what only the lead or the user can do.

### Plan review

- **2026-10-19, lead:** All §2 paths exist; the playground is referenced only from `src/` (`api.ts`, `HomePage`, `Playground`, `index.tsx`, `server/playground.ts`), nothing in `test/` or `scripts/`. The admin session export (`playwright/.auth/shopify-admin.json`) was written 2026-10-18 21:22, fresh until 2026-10-19 21:22; if Step 6 starts after that, the Keychain human step applies. Dev server up on 3900, store `mw10013-dev-shop-00`.
- **2026-10-19, lead, fixed:** Step 2.5 named Step 6 for the e2e; it is Step 7.
- **2026-10-19, lead, fixed:** legacy has two more help test files the plan missed: `help-reference.test.ts` (every label constant on its reference page) and `help-limits.test.ts` (limits on the Limits page, no plan number in Plans and billing). They are the drift guards for `reference.ts` and the Limits/Plans bodies; added as Step 3.5.
- **2026-10-19, lead:** test paths mirror `src/` (glossary "Source layout"; `test/unit/web/` exists). Put the unit tests under `test/unit/web/…` mirroring wherever the help modules land; `test/unit/help.test.ts` in §3 is the name, not a mandate on the folder.

### Deviations

- **2026-10-19, Step 1 (corrects §2 "The name"):** `shopify app dev` does not push `name`; the admin shows the name of the deployed config, and the Dev Dashboard has no rename. The user ran `shopify app deploy --config shopify.app.toml`.
- **2026-10-19, Step 3 (§3 Names, accepted by the lead):** `pages.ts`, `pictures.ts` and `reference.ts` live in `src/web/components/help/` beside the bodies, not a new `src/web/help/`: the source layout lists only `routes/`, `components/`, `client/`, `server/` under `src/web/`. Unit tests under `test/unit/web/components/help/`.
- **2026-10-19, Step 2:** landing: legacy's "Member login" section (one `Sign in` link) shows **Dashboard** to a signed-in visitor instead, beside the page actions (Dashboard and Sign out, or Sign in); its label is "Member sign-in". `BatonMark`'s JSDoc drops legacy's `pnpm icon` provenance (no icon script here) and points at `public/app-icon.svg`'s comment. The root's `description` meta is the landing sentence (was the scaffold's). Privacy's lists are `s-unordered-list` (legacy: bare `ul`). The `ShoutInput` JSDoc rule (a method's input declared once, decoded on both sides) moved to `MagicLinkInput`.
- **2026-10-19, Step 3:** the four help screens are components in `src/web/components/HelpPages.tsx` (`HelpHub`, `HelpSectionHub`, `HelpArticle`, `HelpNotFound`), the routes thin, as this repo's other routes; legacy kept them in the route files. Every breadcrumb and list link goes through `useNavigateOnClick` (`HelpList` included). `HELP_BODIES` lands empty in Step 3 so the registry title exists from the start. The retired-words title stays behind (Q10). Step 3.5's three tests land with the reference bodies in Step 4.
- **2026-10-19, Step 4:** two pieces the plan did not name: the `NumberedList` part (legacy's, 15 bodies use it; in `screen/` with a kit entry) and `HelpLink` in `components/help/` (an `s-link` through `useNavigateOnClick`; every body link is to another help page). `HelpPicture` renders nothing until its name is in a `SHOT` set, removed in Step 6. Bodies' JSDoc keeps legacy's "read against" lists with file paths turned into this repo's component names or dropped; the reference bodies import `domain/platform.ts` and `domain/shop-work.ts` where legacy had one `Domain` barrel.
- **2026-10-19, Step 4, getting-started:** fixed legacy's missing space in Installing ("includes.**Members**", a JSX line break before `<strong>`); no other correction: labels, flows (Create opens the editor, Turn on workflow's modal and blocker, Add member lands on the member's page, the sign-up-free member) match this repo's screens.
- **2026-10-19, Step 4, orders:** no prose correction: the orders index (counts, Show, Any team, columns Order to Shopify, Clear search), the order page (Choose workflow, Attach, Keep workflow, the change warning, the multi-match sentence, the Gone toast) and the webhook topics match. JSDoc: `actorLabel` gives the merchant "You" (legacy's JSDoc said Merchant; its prose already said You).
- **2026-10-19, Step 4, workflows:** no correction: the workflows index (All, Active, Inactive, No steps, the fault badges), the editor (Add step, Add task, the Step or Task panel, Move earlier, Move later, Move to its own step, Join the previous step, Apply changes? and its sentence, More actions with Rename and Delete), Edit tag, Duplicate and the switch match.

### Issues

- **2026-10-19, Step 1, resolved:** after `name = "Baton"` and a restart (`vp run dev:stop`, `vp run dev`, 10:21), the Shopify admin on `mw10013-dev-shop-00` still reads **Baton Dev** in the sidebar, the breadcrumb ("Breadcrumbs for Baton Dev"), the app settings card and the apps table (checked with the Playwright CLI after two full reloads, 10:22–10:25). What the CLI says (its herdr pane; `.logs/dev/current` holds only Alchemy's output): the old session printed `app-config │ App config updated` at 10:20:57 when the toml changed under it; the new session's header still reads `App: Baton Dev` (the Dev Dashboard's name for the app, read before the push), then `app-preview │ Preparing dev preview …` and `✅ Ready`. So the dev preview took the config but the app's name in the admin did not follow: the name the admin shows appears to be the Dev Dashboard app's (its released version's), which a dev preview does not change. Stopped at `WAITING: name`. Resolved by the user's `shopify app deploy --config shopify.app.toml`; on reload the sidebar, breadcrumb, App Home title bar and apps table read **Baton**.

### Command results

- **2026-10-19, Step 1:** `vp run dev:stop` ok 1.5s; `vp run dev` ok, server answering 34.1s; `vp run browser open` ready.
- **2026-10-19, Step 2:** `vp check --fix` clean (381 files); `/` and `/privacy` 200 on the dev server, landing looked at (Playwright CLI). No HomePage browser test exists; none added (Step 7's e2e covers it).
- **2026-10-19, Step 3:** `vp check --fix` clean (391 files); `vp test test/unit/web/components/help` 2 passed, 244ms. `/help`, `/help/orders`, `/help/orders/order-page` 200; `/help/nope`, `/help/orders/nope` 404 with the help not-found page; a page looked at.

### Human steps requested

- **2026-10-19, Step 1, done by the user (app deploy):** make the dev app's name **Baton** in the Shopify admin. Either (a) in the Dev Dashboard (dev.shopify.com → mw10013 → the app now named "Baton Dev", client id of `shopify.app.toml`) rename it to "Baton", or (b) from the main checkout run `shopify app deploy --config shopify.app.toml`, read its summary (the name change, and the `baton-order-link` extension as it is today) and confirm; it releases a new version of the dev app, installed only on dev and e2e stores. Then reload `https://admin.shopify.com/store/mw10013-dev-shop-00/apps/baton-local/app` and check the sidebar reads "Baton". Recommendation: (a), since it touches nothing but the name. Then restart this thread at Step 1.3's check.

Known before the run:

1. Possibly, the Keychain prompt for the admin session export (Step 6).
2. Staging, after the push: `/`, `/privacy`, `/help` and a page with pictures on `https://baton-website-staging.mw10013.workers.dev`; from the embedded staging app, the App Home's foot line opens `/help` in a new tab; a member's Help link.

### Implementation review

## 8. Out of scope

- The App Store listing and its assets.
- Help search, "On this page", next and previous links.
- Renaming Baton Staging, or any production app.
- Pruning the research and plan docs (research Q11).
