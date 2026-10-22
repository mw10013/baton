# Plan: review screencast

Implements `docs/screencast-research.md`. Every question in its §6 was answered on 2026-10-21. Read the research's §0, §2, §3 and §5 first. This plan does not repeat their reasoning.

## 0. Rules for the implementer

- **AGENTS.md.**
  - Vite+ only. Run `vp check --fix` after every change.
  - Effect Schema for parsing, `Match` for tag dispatch, `Effect.fn("name")`.
  - The JSDoc rules: never cite this plan, the research or any `docs/` file in code.
- **Commits.**
  - Work on `main`. Commit at the end of each green step.
  - Stage paths explicitly. Never `git add -A` or `git commit -a`. Do not push.
- **Tests, per step.**
  - `vp check --fix`, and `vp test <files>` for the unit tests the step touches.
  - The full `vp test` once at the end.
  - No e2e: nothing here changes a screen. The one exception is Step 2, which touches `applyStoreFixture`: run `vp run fixture` once after it, and record the output in §7.
- **Spikes first.** Step 0's three spikes decide constants and one design fallback each. A spike that fails takes its stated fallback, recorded in §7, before Step 1 starts.
- **What does not change.**
  - Nothing under `src/`, no stack or table change, no new Alchemy resource. Voice tooling is separate from the stacks.
  - No new Mac installs. Playwright 1.64.1, ffmpeg, ffprobe, ImageMagick and `mpv` are already there.
- **Stores.** The dev store only (`SHOPIFY_DEV_STORE`). Never staging or production.
  - The take ends by loading the dev fixture again, also when it fails, as `scripts/help-screenshots.ts` does.
  - Never run `db:reset`, `cloud:reset` or `deploy:staging`.
- **Paid calls.**
  - Text to speech is metered. Render only through the cache (Step 3), and never in a test.
  - Unit tests mock `fetch`.
- **The take's copy.**
  - Draft the narration and the steps from research §4's merchant flow, in `docs/glossary.md`'s words.
  - Follow the copy rules: plain words, no metaphor, no semicolons.
  - The user edits the copy. That's a human step (§7), not a blocker for Steps 1–6.
- Do not rewrite the steps. Record in §7 what you built differently, and what surprised you, as you go.

## 1. Outcome

`vp run screencast all` turns one scene table into the review submission's video and its testing instructions:

- `tmp/screencast/out/baton-review.mp4`: about 4 minutes, 1920×1080, H.264 with AAC, narrated by Aura-2.
- `tmp/screencast/out/testing-instructions.txt`: the same steps in the same order, under 2,800 characters.
- `tmp/screencast/out/contact-sheet.png`: one frame from the middle of each scene, to review before watching.

The take is Baton only. It opens on Home and builds a team, a member, a workflow with its tag, an order and a run to Made, from an empty Baton. The product's tag and the paid order are made off camera by the script. The narration tells the tester to do those two Shopify steps themselves. Re-running after a copy edit re-renders only the lines that changed.

## 2. What this plan rests on

- **A1. Playwright 1.64.1's `page.screencast`.** It records cross-origin iframes and draws its own cursor inside them (research §3.1, spiked).
  - Not yet checked: offsets on the frame clock (S1), sharpness above `deviceScaleFactor` 1 (S2), and the real embedded admin (S3).
- **A2. Legacy's `../baton-legacy/scripts/tts.ts` works.** It authenticates with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the shell.
  - Both are set in the user's shell today, from `~/.zshrc`, and `.env` has neither.
  - Run the scripts from that shell.
- **A3. The fixture can be emptied.** `LoadFixture` replaces the shop's members, teams, workflows and orders with whatever `ShopFixtureData` it gets, empty arrays included. `applyStoreFixture` archives every product its table doesn't name and cancels open orders without the `seed` tag.
  - Not yet checked: that empty arrays pass `referencesResolve`. Step 2 starts with it.
- **A4. A paid order completed from a draft reaches Baton.** It arrives through the dev app's order webhook, and the Orders page shows it without a reload, through the socket notice (S3).
- **A5. Bang's ffmpeg lessons** (research §2):
  - Narration gets its own pass.
  - `aresample` plus `asetpts=N/SR/TB` around `adelay`.
  - Finite inputs only, no `-stream_loop -1`.

## 3. Names and constants

| Name                 | Where                                         | Value or meaning                                                                                                     |
| -------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `vp run tts`         | `package.json`                                | `node scripts/tts.ts`, ported from legacy: `gen`, `play`                                                             |
| `vp run screencast`  | `package.json`                                | `node --env-file=.env scripts/screencast.ts <voice\|record\|build\|instructions\|all>`                               |
| `synthesize`         | `scripts/lib/tts.ts`                          | One Aura request, written to a given path. Shared by `tts gen` and `screencast voice`                                |
| `SCENES`             | `scripts/screencast-scenes.ts`                | The scene table. `Scene = { id, chapter?, say, act, step? }`                                                         |
| `screencastFixture`  | `screencast-fixture.ts`, next to `fixture.ts` | A `ShopFixture` with one product carrying `SCREENCAST_TAG`, and no store orders, members, teams, workflows or orders |
| `SCREENCAST_TAG`     | `screencast-fixture.ts`                       | The workflow tag the take types on camera. It must equal the product's tag                                           |
| `createStoreOrder`   | `scripts/lib/stores.ts`                       | One paid order for a product variant, on the dev store. Extracted from `applyStoreFixture`'s step 4                  |
| `HIDE_OVERLAYS`      | `scripts/lib/embedded-app.ts`                 | Moved from `scripts/help-screenshots.ts`, which imports it                                                           |
| `tmp/screencast/`    | ignored by `/tmp/`                            | `voice/<sha256>.mp3`, `voice.json`, `raw.webm`, `scenes.json`, `out/`                                                |
| `VOICE`              | `scripts/lib/screencast.ts`                   | `{ model: "aura-2", speaker: "luna" }` (picked 2026-10-21)                                                           |
| `VIEWPORT`, `SCALE`  | `scripts/lib/screencast.ts`                   | 1600×900 at 1, scaled to 1920×1080 in `build` (S2: the screencast records CSS pixels)                                |
| `FPS`                | `scripts/lib/screencast.ts`                   | 30                                                                                                                   |
| `GAP_MS`             | `scripts/lib/screencast.ts`                   | 600: the silence after a scene's line and action, before the next scene                                              |
| `TYPE_DELAY_MS`      | `scripts/lib/screencast.ts`                   | 60: per character in `pressSequentially`, so typing is watchable                                                     |
| `INSTRUCTIONS_LIMIT` | `scripts/lib/screencast.ts`                   | 2,800 characters                                                                                                     |

## 4. Steps

### Step 0: Spikes S1–S3

Throwaway scripts in the scratchpad, never committed. Record each result and the constant it sets in §7.

Done 2026-10-21. S1 and S3 passed, and S2 took its fallback. A short narrated mini-take also ran the whole pipeline. Results and fixes are in §7, and the review files are in `tmp/screencast/spikes/`.

**S1. Offsets on the frame clock.**

- Record a local page, headless, with `page.screencast.start({ path, onFrame, fps: 30 })`.
- The page fills itself with a new solid color at five scene starts, spaced 1–3 s apart.
- For each one, compute the offset as the `onFrame` timestamp of the first frame after the change, minus the first frame's timestamp.
- Find the true color change in the file with ffmpeg: `signalstats` or per-frame `showinfo`, then the first frame of each color.
- Pass: every offset within one frame (34 ms) of the file.
- Fail: the fallback is a painted marker. At each scene start, `record` paints a 4×4 px corner square in a scene-unique color for two frames, and `build` finds it with ffmpeg. Note it in §7, and Step 4 builds that instead.

**S2. Sharpness.**

- Record the same text-heavy page two ways: 1280×720 at `deviceScaleFactor: 1.5` with `size: 1920×1080`, and 1600×900 at 1 scaled up to 1080p with lanczos.
- Check the file's dimensions with `ffprobe`.
- Compare a crop of small text from each, and look at both.
- Pass: the first gives 1920×1080 frames with sharper text. Set `VIEWPORT` and `SCALE` from it.
- Fail: frames are capped at CSS pixels, so use the second.

**S3. The real admin and an arriving order.**

- Dev server running (`vp run dev:status`), dev store, storage state fresh (`vp run e2e:auth` when older than a day).
- Headless real Chrome (`channel: "chrome"`), the S2 viewport, `HIDE_OVERLAYS`, `gotoApp`, then `page.screencast` and `showActions({ cursor: "pointer" })`.
- In the real admin:
  - Create a team.
  - Create a workflow whose tag matches a fixture product, add a step on that team, and turn it on.
  - Open Orders.
- From the spike, with the screencast still running, create a paid order for that product (draft create, then complete, with a variant line, as `applyStoreFixture` does).
- Note how long the order takes to appear on Orders, with no reload and no Sync.
- Pass, all four:
  - The recording shows the admin and app frame with no Shopify challenge.
  - The cursor and highlight land on Polaris `s-*` controls.
  - The order appears within 30 s.
  - No overlay is filmed.
- Fail, by part:
  - **A challenge:** run headed (`headless: false`). The screencast records the page either way.
  - **Highlight off target:** keep the cursor and turn the highlight off.
  - **The order doesn't appear:** the order scene presses Sync open orders, and its step says so.
- Finish with `vp run fixture`.

### Step 1: Port text to speech

- Port legacy's `scripts/tts.ts`, `scripts/lib/tts-naming.ts` and `scripts/lib/tts-playback.ts` with their tests. Tests go to `test/unit/scripts/`, mocked `fetch`, no paid call.
- Changes from legacy:
  - **Account:** read only `CLOUDFLARE_ACCOUNT_ID`. Baton has no `wrangler.jsonc`.
  - **Request:** move the request into `synthesize(options: { text, model, speaker, output })` in `scripts/lib/tts.ts`, keeping legacy's guarantees: one request, no retry, bounded read, no overwrite, and fixed error messages.
  - **Output:** `gen` writes to `tmp/tts/…` as before. Add `tmp/` to `.gitignore` if it isn't covered.
  - **Format:** keep MP3. ffprobe measures it, and its encoder delay of a few tens of ms is below `GAP_MS`.
- Check: `vp run tts gen "…"` once, then `vp run tts play`.
- **Human step, the voice:** render one line of the draft copy in four voices (luna, thalia, athena, cora) and have the user pick one. Until then `VOICE.speaker` is luna.

### Step 2: The screencast fixture and one order

- **Check A3 first.** Decode a `ShopFixture` with one product and empty members, teams, workflows, orders and store orders. If it fails, record the failing rule in §7. Relax it only if the rule is about references, never about names.
- Take the fixture as a parameter:
  - `applyStoreFixture(store, data)` and `applyFixture({ waitForInstall, fixture })`.
  - `vp run fixture` and `help-screenshots` pass the dev `fixture` and behave as before.
- Add `screencast-fixture.ts`:
  - `screencastFixture` holds one product from the dev fixture, with the variants it has there, and `tags: [SCREENCAST_TAG]`. Pick one with a single, plain option, for example the cutting board, and drop its other tags.
  - Its docblock says why the product is already tagged: tagging is a Shopify step the take doesn't film.
- Extract `createStoreOrder(store, order: StoreOrder)` from `applyStoreFixture`'s step 4. It's paid, with no customer or notice, and allowed on the stores `requireFixtureStore` accepts. `applyStoreFixture` calls it.
- Check:
  - `vp run fixture` prints what it did before.
  - A spike call applies `screencastFixture`: Baton empty, one product, no open orders.
  - `vp run fixture` again.

### Step 3: The scene table and `voice`

- **`scripts/lib/screencast.ts`:**
  - The `Scene` type.
  - `voiceKey(model, speaker, text)`, a sha256.
  - `voiceDurations`, through ffprobe, cached in `voice.json`.
  - `instructionsText(scenes)`.
  - Unit tests for the key, the instructions cap and the timing math in Step 4.
- **`scripts/screencast-scenes.ts`:** the draft copy, as `SCENES`. Chapters, from research Q12:
  1. **Intro.** Baton is an admin-only app with no customer flow, said within the first 15 s. Members sign in by email, and this video stays on the merchant's side.
  2. **Team and member.** Create a team. Add a member by email. Add the member to the team.
  3. **Workflow and tag.** Create a workflow, name it, and note the tag. Add one step on the team, then a second task or step. Turn the workflow on.
  4. **Order arrives.** "In Shopify, put this tag on a product and place a paid order for it." The scene's `act` opens Orders and chooses the Not started tile first. Orders defaults to Making, so a new order isn't listed there. Then it calls `createStoreOrder` off camera, and the order appears in about 2 s (S3).
  5. **Run to Made.** Open the order. Under Manage, press Done on each task until the order reads Made.
- Every scene's `step` names exact values and what the tester sees. A scene with no `step` (the intro, or narration with no action) adds nothing to the instructions.
- **`voice`:**
  - Render each scene's `say` through `synthesize` into `tmp/screencast/voice/<key>.mp3`, skipping files that exist.
  - Print the characters rendered and their estimated cost.
  - Prune files no scene uses, and print what was removed.

### Step 4: `record`

`scripts/screencast.ts record`:

1. **Gates:**
   - The dev server is healthy.
   - The storage state is fresh, re-exported as in `help-screenshots`.
   - `voice.json` covers every scene.
2. **State:** apply `screencastFixture`. Wrap the take so the dev fixture loads again on exit, also on failure.
3. **Open:** Chrome with the storage state, `VIEWPORT` and `SCALE`, then `HIDE_OVERLAYS`. `gotoApp` to Home, which runs `closeDevConsole`. Fix that first: see §7 Issues.
4. **Record:**
   - `page.screencast.start({ path: raw.webm, size, fps: FPS, onFrame })`.
   - Then `showActions({ cursor: "pointer", style })`:
     - `style.title` is `display: none`. Otherwise every action prints its Playwright selector on screen (S3).
     - `style.highlight` is the mini-take's outline.
   - The cursor first shows at the first action. Hover the page's centre once before scene 1 so the intro has a cursor.
5. **Each scene:**
   - Mark its start: `Date.now()` minus the first `onFrame` timestamp (S1). `onFrame` fires only when the page repaints, so a scene's mark is never "the next frame".
   - Show its `chapter`, if any, with `showChapter` for 2 s, and hold until it clears.
   - Run `act` (typing at `TYPE_DELAY_MS`).
   - Wait until the voice's duration since the scene start has passed.
   - Then wait `GAP_MS`.
   - An `act` that outlasts its line is fine: the picture waits for nothing, and the next scene starts after it.
6. **Write `scenes.json`:** `{ id, startMs, voiceMs, endMs }` per scene, plus the file's duration.

Unit test the timing math: scene end = start + max(act, voice) + gap, offsets taken from the frame clock.

### Step 5: `build`

- **Narration pass:**
  - Each clip is `adelay`ed by its scene's `startMs`, inside `aresample=48000,asetpts=N/SR/TB`, then `amix=normalize=0`.
  - Then `loudnorm=I=-16:TP=-1.5`, `apad`, and `atrim` to the video's length.
  - Output is `narration.wav`.
- **Mux:** `raw.webm` plus `narration.wav` into `baton-review.mp4`:
  - `scale=1920:1080:flags=lanczos`, then `libx264 -crf 18 -preset slow -pix_fmt yuv420p`.
  - `aac -b:a 192k`, `-movflags +faststart`.
- **Checks:**
  - `OVER`: fail when a clip's end runs past the next scene's start.
  - The final duration is within one frame of `raw.webm`.
- **Contact sheet:** a frame at each scene's midpoint, then `magick montage` with the scene ids as labels.
- Keep the argument building in a pure function with a unit test. The test checks the filter text, not ffmpeg itself.

### Step 6: `instructions` and `all`

- **`instructions`:**
  - Write `testing-instructions.txt`: the opening line (no merchant login, optional member email sign-in), then the numbered `step`s in scene order.
  - Fail over `INSTRUCTIONS_LIMIT`, printing the length.
- **`all`:** `voice`, `record`, `build`, `instructions`, stopping at the first failure.

### Step 7: The full take

- Run `vp run screencast all`.
- Look at the contact sheet, then watch `baton-review.mp4` through once. Check:
  - Narration matches the picture, scene by scene.
  - No overlay or dev chrome in frame.
  - The order reaches Made.
- Record the length, the characters rendered and the cost in §7.
- **Human step:** the user reviews the copy and the video. Copy edits go in `SCENES`, and `all` runs again.

## 5. Verification checklist

- [x] S1, S2 and S3 results recorded, and constants or fallbacks set.
- [ ] `vp run tts gen` and `play` work. Unit tests pass with no paid call.
- [ ] `vp run fixture` behaves as before Step 2. `screencastFixture` leaves an empty Baton and one tagged product.
- [ ] A second `voice` run renders nothing. An edit to one line renders one clip.
- [ ] `record` leaves the dev fixture loaded, after a success and after a forced failure.
- [ ] `baton-review.mp4` is 1920×1080, about 4 minutes, H.264 with AAC, with narration in sync to within one frame at each scene start.
- [ ] `testing-instructions.txt` is under 2,800 characters and lists the video's steps in the same order.
- [ ] `vp check` and the full `vp test` pass.

## 6. Done when

`vp run screencast all` produces the video, the instructions and the contact sheet from a clean checkout's dev store. The user has picked the voice and reviewed the copy, and §7 is filled in.

## 7. Deviations and issues

### Plan review

### Deviations

- **Step 1, 2026-10-21.** Legacy's three files became `scripts/lib/tts.ts` (`synthesize`, `SpeechText`, `speechAccount`, `speechToken`, naming and playback helpers) and `scripts/tts.ts`. The changes:
  - Text and account validation are Schemas.
  - Legacy-only timestamp folders are no longer read by `play`.
  - The tests are 12 Vitest cases in `test/unit/scripts/lib/tts.test.ts`, with `fetch` stubbed. They cover validation, no overwrite, no request before validation, and no token in error text.
  - Legacy's CLI-help process tests were not ported.
  - `/tmp/` is in `.gitignore` for `tmp/tts/`.
- **Step 2, 2026-10-21.**
  - `applyStoreFixture(store, table)` and `applyFixture({ fixture, waitForInstall })` take the fixture. `vp run fixture`, `db:reset` and `help-screenshots` pass the dev `fixture`.
  - `placeOrder` is the order half of `applyStoreFixture`, and `createStoreOrder(store, order)` exposes it for the dev store. It tags the order with its own tag only, so the next fixture run cancels it.
  - `screencast-fixture.ts` holds `screencastFixture`, `SCREENCAST_WORKFLOW` ("Cutting board"), `SCREENCAST_TAG` (`suggestedTag` of that name, "cutting board") and `SCREENCAST_ORDER` (one Maple board).
  - The plan said to drop the product's other tags. It has only the one tag, the screencast's.
  - **Kept the cancel rule.** The screencast fixture leaves the three `seed` orders open in Shopify and only empties Baton. Cancelling them would send cancel webhooks into the emptied Baton, since the halves run in parallel. Baton never sees those orders, because the take does not press Sync.
  - A3 held: empty members, teams, workflows and orders decode.
  - **Live run on the dev store:**
    - `vp run fixture` printed nothing new.
    - The screencast fixture archived 7 products, retagged the board, and left Baton at 0 of everything.
    - `createStoreOrder` placed #1012. `ordersWebhook` stored it, and `reconcileOrder` created no run, since there's no workflow.
    - `vp run fixture` restored all 8 products and cancelled #1012.
  - **Tests:** `test/unit/screencast-fixture.test.ts` (5 cases). `vp test --project unit` gives 888 passed, and `vp check` is clean.
- **Renders moved, 2026-10-21.** Everything the screencast writes is in `tmp/screencast/`, ignored with the rest of `/tmp/`. The `.screencast/` ignore line is gone.
- **Step 3, 2026-10-21.**
  - **`scripts/lib/screencast.ts`:**
    - `Scene`, the `Take` interface that acts call, and `VOICE` (aura-2, luna).
    - `voiceKey`, `voicePlan` and `renderVoices`. `renderVoices` renders only missing clips, writes `voice.json` with ffprobe durations, and prunes unused clips.
    - `readVoiceIndex`, which fails when a scene's clip is stale.
    - `instructionsText`, with the 2,800 cap.
  - **`Take` is new.** Acts call named helpers (`nav`, `press`, `fill`, `choose`, `tick`, `see`, `placeOrder`, `openOrder`) instead of raw locators, so the scene table reads like the steps. Step 4 implements them, with the top-document-then-app-frame lookup from S3.
  - **`scripts/screencast-scenes.ts`:** a 16-scene draft in 5 chapters, with one team (Woodshop), one member (ana@example.com), the workflow "Cutting board" with steps "Cut and sand" and "Oil and pack", and one order moved to Made.
  - **`vp run screencast voice [--dry-run]` and `instructions`.** The dry run gives 16 lines, 1,714 characters, about $0.05. The instructions are 13 steps and 1,229 characters.
  - **Not rendered yet.** The copy is unreviewed, and Step 4's rehearsal may change scene wording to match the real labels. Render once both settle.
  - **Tests:** `test/unit/scripts/lib/screencast.test.ts` (8 cases). They cover the key, the numbering, the cap, unique ids, lines the voice accepts, and no semicolons.
- **Step 4, 2026-10-21: `record` in `scripts/lib/screencast-take.ts`.**
  - **`closeDevConsole`** clicks `button[aria-label="hide"][class*="_MinimizeButton_"]`, kept self-contained for `scripts/browser.ts`.
  - **`HIDE_OVERLAYS`** moved to `embedded-app.ts`, and the take re-adds it on every load.
  - **`record --rehearse`** is added. It estimates each line at 77 ms per character (luna's rate in the samples), so the take could be driven through the real UI before any narration was paid for. Six rehearsals found:
    - **Modal fields are the app's own `s-modal` in the frame,** found by role (`textbox` "Name"), not by label.
    - **The workflow editor is an `s-app-window` frame** that stays open over the admin after Turn on. `Take.closeWindow` closes it, so the turn-on line and step now say "close the editor".
    - **Active and other title-bar text are in the top document,** so `see` searches the top document, the editor and the app, matching substrings ("Step 1 of 2 · Cut and sand").
    - **An empty Baton's Orders page has no status strip,** just "No open orders". The order is placed first, its arrival brings the strip, and then Not started is pressed.
    - **A strip cell is named "Not started, 0",** so `press` also matches a name followed by a comma.
    - **The order page never says "Made".** It says "Every item is done. Fulfill in Shopify." The second-done line and step now say "every item is done". The outro goes back to Orders, presses Made, and the order is listed as Made, which adds a 14th instruction step.
  - **The copy changes against the approved draft:** turn-on adds "close the editor", second-done reads "every item is done", and the outro gains its Orders and Made sentence and step.
  - **Pressing a title-bar control** tries Playwright's click for 3 s, then a native click. The cursor and highlight still show for the attempt.
- **Narration rendered, 2026-10-21:** 16 lines, 1,789 characters, about $0.054, 130.0 s. A second dry run renders 0.
- **Step 5, 2026-10-21: `build` in `scripts/lib/screencast-build.ts`.**
  - It refuses a rehearsal take, a stale clip and overlapping lines (`OVER`).
  - It runs the narration pass, then the mux.
  - It checks the video's length is within one frame of the take.
  - It writes the contact sheet.
- **Step 6, 2026-10-21:** `all` runs `voice`, `record`, `build` and `instructions` in order.

### Step 7 results, 2026-10-21

- **The take:** `vp run screencast all` in about 4 minutes, no audio spend.
- **Video:** `tmp/screencast/out/baton-review.mp4`, 2:51 (171.3 s), 1920×1080 H.264 with AAC 48 kHz stereo, 9.6 MB.
- **Sync:** silence detection puts each line 40–50 ms after its scene mark, which is the MP3's own lead-in.
- **Instructions:** 14 steps, 1,322 characters.
- **Tests:** `test/unit/scripts/lib/screencast-build.test.ts` (8 cases). `vp test --project unit` gives 903 passed, and `vp check` is clean.
- **Not run:** the e2e suite. `closeDevConsole` changed, and the `embedded` and `billing` projects call it.
- **Voice samples.** Four voices (luna, thalia, athena, cora) speak one 61-character line, written to `tmp/screencast/voices/`. That's 244 characters, about $0.007.

### Issues

- **`closeDevConsole` no longer finds the Dev Console's toggle** (found in S3, 2026-10-21).
  - The Shopify CLI's panel now names its collapse button `hide`, not "Close Dev Console". A second `hide` button exists elsewhere on the page.
  - So the helper times out when the panel is expanded. It returns early only when the panel is collapsed, which is how the e2e sessions have it.
  - The spike clicked `button[aria-label=hide][class*=_MinimizeButton_]`, and the panel stayed collapsed for the whole take.
  - Fix `closeDevConsole` in Step 4, before `record` uses it. `help-screenshots` and the e2e `embedded` project share it.
- **Admin title-bar actions and modals are in the top document, not the app frame.** Examples are Create team and its modal. Scenes find them with `page.getByRole`, falling back to `appFrame`. Playwright refuses `.or()` across a frame locator.

### Command results

**S1, frame-clock offsets: passed.** Five color changes, 1–3 s apart, in a 12.7 s recording.

| Change | `Date.now()` − first `onFrame` | In the file | Off by |
| ------ | ------------------------------ | ----------- | ------ |
| 1      | 987 ms                         | 967 ms      | 20 ms  |
| 2      | 3,503 ms                       | 3,500 ms    | 3 ms   |
| 3      | 4,819 ms                       | 4,800 ms    | 19 ms  |
| 4      | 7,836 ms                       | 7,833 ms    | 3 ms   |
| 5      | 9,553 ms                       | 9,533 ms    | 20 ms  |

All are within one frame (33 ms). `onFrame` delivered only 6 frames, because it fires on repaint. That's why the mark uses the wall clock against the first frame's timestamp, not a frame.

**S2, sharpness: fallback taken.** With `deviceScaleFactor: 1.5` and `size: 1920×1080`, the 1280×720 viewport came out at CSS pixels, padded with gray inside a 1920×1080 frame. A 1600×900 recording scaled up with lanczos reads cleanly (`s2-compare.png`). `VIEWPORT` is 1600×900.

**S3, real admin and an arriving order: passed after two fixes.**

- **Recording:** headless real Chrome recorded the admin and the app frame with no challenge, including the Create team modal.
- **Cursor and highlight:** both land on the admin's nav links and the title-bar button.
- **Order arrival:** `orders/paid` reached the dev Backend 1.4 s after `draftOrderComplete`, and `reconcileOrder` created the run.
  - Order #1011 appeared on Orders, filtered to Not started, 2.0 s after it was created, with no reload and no Sync.
  - The first run's #1010 seemed missing only because Orders defaults to Making.
- **The two fixes:** the Dev Console toggle (Issues), and hiding action titles.
- `vp run fixture` afterwards cancelled #1010 and #1011 and restored the fixture.

**Mini-take: the whole pipeline, passed.**

- **Voice:** two lines, 52 and 68 characters, rendered by legacy's `tts gen` (aura-2, luna) with no changes. They took 1.8 s each and run 3.8 s and 4.1 s. 120 characters is about $0.004.
- **Recording:** Home, then Teams, paced by the narration.
- **Build:** Bang's audio filter chain. The output is 1920×1080 H.264 with AAC, 10.0 s, the same as the raw file. Silence detection puts line 1 at 0.55 s (mark 0.50 s) and line 2 at 5.20 s (mark 4.92 s). The gap is the MP3's own lead-in silence.

### Human steps requested

- Step 1: pick the voice from four samples. **Answered 2026-10-21: luna.**
- Step 7: review the copy and the video. Copy approved 2026-10-21 before Step 4, video review owed.

### Implementation review

## 8. Out of scope

- The final narration copy beyond a reviewed draft, and the listing's feature video.
- Uploading to YouTube and filling the submission form. The user does both.
- Install, plan choice and any filmed Shopify admin step (research Q9, Q11).
- Captions or subtitle files (research Q13).
- Member screens (research Q10).
- Running the instructions by hand on a second store before submitting (research Q17). The user does that once the video is final.
