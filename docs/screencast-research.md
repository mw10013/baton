# Review screencast: research

Status: implemented, 2026-10-21. Research written and settled the same day. This covers how to produce the App Store review screencast automatically, not what it says. Sources:

- Shopify's requirements in `refs/shopify-docs`.
- Bang's two videos and its rejection (`../bang`).
- Baton's fixture, browser tooling and merchant flow.
- Legacy's text-to-speech script (`../baton-legacy/scripts/tts.ts`).
- A spike, run in a scratch folder, that recorded a cross-origin iframe with Playwright's screencast API.

2026-10-21: every question in §6 was answered, then `docs/screencast-plan.md` implemented them. `vp run screencast all` produces the video and the testing instructions. The plan's §7 records the spikes and every deviation, and §7 below sums up what the build changed in this design. Q6, Q9, Q11 and Q13 differ from the first recommendation, and §0 and §5 are written to the answers.

## 0. Verdict

Generate the screencast from one typed scene table:

- Each scene holds a narration phrase, the browser actions that go with it, and one numbered step of the testing instructions.
- A script, written and iterated on by an LLM, renders the narration with legacy's Workers AI text-to-speech script and measures each clip.
- It drives Baton in the embedded admin with Playwright and records the page with `page.screencast`, which draws its own cursor.
- ffmpeg lays each clip onto the recording at the offset where its scene started.
- The same table prints the testing instructions, so the two can't drift.

The take is Baton only. It opens on Home. Install, plan choice, product tagging and placing an order are Shopify steps the tester already knows. The narration names them, and the script does them off camera.

Nothing needs to be installed. Playwright 1.64.1 is already in the repo, and ffmpeg and ImageMagick are already on the Mac. The plan doesn't use `cliclick`, screen capture or a microphone.

## 1. What Shopify asks for

From `refs/shopify-docs/docs/apps/launch/shopify-app-store/app-store-requirements.md`, best-practices.md and pass-app-review.md:

- **Required.** 4.5.3, "Include a demo screencast." A missing or inadequate screencast means a resubmit.
- **Content.** It shows "onboarding and features as described in its listing" with "clear step-by-step instructions showing how to set up your apps core features". Best practices add: show "the expected outcome for each test case".
- **Language.** "in English or have English subtitles". The docs say nothing about narration.
- **Length.** The docs only say "short". The submission form, as Bang recorded it, says "Aim for a 3 to 8 minute video" and "Show the customer flow and the merchant flow". An admin-only app should say in the first 15 s that it has no customer flow. The "2-3 minutes" figure is for the listing's feature video, a separate, promotional deliverable.
- **Hosting.** The docs don't say. Bang submitted YouTube Unlisted links, and review accepted them.
- **Testing instructions.** They sit with the screencast in Part G of the form, are capped at 2,800 characters, and must include working credentials or say none are needed (4.5.4, 4.5.5).
- **App name.** The TOML name must "match, or be similar" to the name in the submission form (4.1.1). The docs say nothing about the name shown in a video.
- **Install, OAuth and billing.** Install starts on a Shopify-owned surface, OAuth runs immediately, and the merchant lands in the app (2.3.1–2.3.4). Charges must be approved and re-requested on reinstall (1.2.x). The reviewer goes through these on their own install, so the screencast doesn't show them.

## 2. What Bang taught us

From `../bang/docs/shopify-app-review-pause-research.md` and resubmission-screencast-and-testing.md:

- **Why review paused the first submission (4.5.3).** The screencast was a broad tour that assumed state the reviewer's store didn't have. The reviewer went down a path the video skipped, and it failed. Shopify asked for "initial setup, full configuration, and triggering actions ... so that we can replicate the exact steps."
- **What passed.** One small flow, built on camera from a clean state, with the result of every action shown. The testing instructions repeat the same steps in the same order, with exact field values and what the tester should see.
- **The review screencast was a hand-recorded take.** It was one live QuickTime take with live narration. Only the feature video was automated, and that rig is the one to avoid:
  - ffmpeg avfoundation display capture, with the real cursor driven by `cliclick`.
  - Screen Recording, Accessibility and Microphone permissions.
  - Hands off the Mac, screensaver off, and a PSNR check to catch windows covering the frame.
  - ffmpeg dropped about 11% of audio buffers, so a custom Swift recorder had to replace it.
  - Per-take denoise thresholds, and a room-tone bed.
- **Worth porting from `scripts/video-build.sh`:**
  - Per-line narration clips placed at absolute offsets with `adelay`.
  - Narration rendered in its own ffmpeg pass. Mixing it in the video graph hung ffmpeg.
  - `aresample` plus `asetpts=N/SR/TB` around `adelay`. Without it the narration landed 0.5 s early.
  - Finite loops instead of `-stream_loop -1`.
  - An `OVER` check when a line runs past its slot.
  - Title cards as HTML rendered by Chrome (`scripts/video-cards.ts`).

Text to speech removes the whole audio half of Bang's rig. The page screencast removes the capture half.

## 3. Spikes and prior work

### 3.1 Playwright page screencast (Playwright 1.64.1, headless Chromium)

A page with a sidebar and a cross-origin iframe, recorded with `page.screencast.start({ path, size: 1440×900, fps: 30 })`, plus `showActions` and `showChapter`:

- **Held:**
  - The recording includes the cross-origin frame. That's the shape of the embedded admin: admin.shopify.com outside, the app's origin inside.
  - The output was VP9 webm at 1440×900, 30 fps.
  - `showActions` draws a pointer that glides to each action point inside the iframe. Locators went through `frameLocator`. There's no real cursor, no `cliclick`, and no OS permissions.
  - `showChapter` draws a centered card over a blurred page, which works as a section title.
- **Found:** the video ran 8.13 s for 6.88 s of wall time between `start` and `stop`. Wall-clock offsets taken in the script won't line up with the video. Scene offsets have to come from the frames themselves (Q4).
- **Not tested:**
  - The real admin.
  - `deviceScaleFactor` above 1. Does the recording get sharper, or is it capped at CSS pixels?
  - Headed versus headless with Shopify's bot checks.
  - Polaris components inside the app frame. Is `showActions`' highlight drawn in the right place on `s-*` elements' shadow DOM?
- **Settled by the plan's spikes:**
  - `deviceScaleFactor` is ignored, because the recording is CSS pixels, so the take records 1600×900 and scales up.
  - Headless real Chrome films the admin with no challenge.
  - The highlight lands on `s-*` controls.
  - Scene offsets taken against the first `onFrame` timestamp are within one frame of the file.

### 3.2 Text to speech: legacy's `scripts/tts.ts`

`../baton-legacy/scripts/tts.ts` is an Effect CLI with two commands, `gen` and `play`:

- **`gen`:**
  - POSTs to `https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}` with `CLOUDFLARE_API_TOKEN` from the environment.
  - Reads the account from `wrangler.jsonc`, or from `CLOUDFLARE_ACCOUNT_ID`.
  - Models are `aura-1` or `aura-2`, and the default is aura-2 with luna. Voices are limited to the feminine English ones.
  - Writes MP3 plus a metadata JSON under `tmp/tts/<date>-NN-<slug>/`.
- **`play`:** plays the latest recording.
- **Tests:** `scripts/lib/tts.test.ts`, `tts-naming.test.ts` and `tts-playback.test.ts`.

Baton doesn't have `wrangler.jsonc`, so the account ID comes from `CLOUDFLARE_ACCOUNT_ID` or Baton's own config. `cf ai run` can't stand in: it prints `{}` for audio.

| Model                    | Price                    | Notes                                                           |
| ------------------------ | ------------------------ | --------------------------------------------------------------- |
| `@cf/deepgram/aura-2-en` | $0.03 per 1k characters  | 40 English voices. WAV, MP3, Opus, FLAC. Sample rate selectable |
| `@cf/deepgram/aura-1`    | $0.015 per 1k characters | Older Deepgram voices                                           |

A 4-minute script is about 3,600 characters, so a full Aura-2 render costs about $0.11. A run that re-renders only the changed lines costs cents.

## 4. Baton facts that shape the flow

- **Merchant flow**, from `src/web/components/help/getting-started`:
  1. Create a team.
  2. Add a member, then add the member to the team.
  3. Create a workflow (Name, Tag).
  4. In the editor: add a step (Name, Team, Instructions), then turn the workflow on.
  5. Put the tag on a product in Shopify.
  6. A paid order for that product shows on Orders as Not started.
  7. On the order page, under Manage, Done on each task moves the run step by step until the order reads Made.
- **The merchant can finish a run alone.** The order page's Done means the tester never has to sign in as a member. Members sign in by magic link, and on deployed stages that link is mailed to an address the tester doesn't own.
- **The fixture is dev only** (`vp run fixture`, `requireFixtureStore`):
  - It fills D1 with 7 members, 8 teams, 8 workflows and 42 orders that exist only in Baton.
  - It puts 8 tagged products and 3 real orders in the store.
  - Staging has no `/api/dev`, no fixture and no inline magic links.
- **Orders.** `vp run test-order` is limited to e2e stores and creates a custom line item, so it matches no workflow. The fixture's store half already creates product orders with `draftOrderCreate` plus `draftOrderComplete`.
- **Browser tooling to reuse:**
  - `scripts/help-screenshots.ts`: real Chrome, headless, storage state, fixed viewport, and `HIDE_OVERLAYS` CSS for Sidekick, toasts and the mini console.
  - `scripts/lib/embedded-app.ts`: `appFrame`, `awaitHydration`, `closeDevConsole`, `gotoApp`.
  - Admin sign-in is never automated. The storage state comes from Chrome's cookies (`vp run e2e:auth`).
- **App name.** The dev app's `shopify.app.toml` already says `name = "Baton"`, so the admin sidebar shows "Baton". The handle never changes.
- **Billing.** Dev stores were subscribed once by hand, at $0, so the take never meets the plan page.

## 5. Design, as answered

```
scripts/tts.ts               ported from legacy: gen, play
scripts/screencast.ts        vp run screencast <voice|record|build|instructions|all>
scripts/lib/screencast.ts    the scene table: id, chapter?, say, act(page, app), step?
tmp/screencast/                 gitignored: voice/<hash>.<ext>, raw.webm, scenes.json, out/
```

1. **`voice`.** Render each scene's `say` through the ported TTS code.
   - Cache files by a hash of (model, speaker, text), so an edit re-renders only the lines that changed.
   - `ffprobe` each clip and write its duration.
2. **`record`.** The dev store, with the dev app.
   - Empty Baton and give the store one product (Q8).
   - Open the admin in real Chrome with the storage state and `HIDE_OVERLAYS`.
   - Start on Baton's Home.
   - `page.screencast.start` with `onFrame`, then `showActions({ cursor: "pointer" })`, highlight only.
   - For each scene:
     - Mark its start on the frame clock.
     - Run `act`.
     - Wait out the rest of the narration plus a short pause.
   - The order scene tags the product and creates the paid order through the Admin API while Orders is on screen, and the order's arrival is the visible result (Q9).
   - Write `scenes.json` with each scene's start offset in the video.
3. **`build`.** Using Bang's fixes from §2:
   - One audio pass: each clip `adelay`ed to its offset, then `loudnorm`.
   - Then mux: VP9 to H.264 1080p, AAC.
   - Fail on `OVER`.
4. **`instructions`.** Print the testing instructions from the scenes' `step` text and check the 2,800-character cap.
5. **Review loop.** Pull one frame from the middle of each scene into a contact sheet (`magick montage`). The LLM and you look at it before anyone watches the video.

## 6. Questions, answered 2026-10-21

**Q1. Who drives the browser: an LLM live, or a script the LLM writes?**
Answer: a script, as recommended. A take has to be repeatable after every copy edit or UI change, with pauses timed to the narration. MCP driving is for writing a scene's `act`, not for the take.

**Q2. Capture: Playwright `page.screencast`, or display capture with `cliclick`?**
Answer: `page.screencast`, as recommended. It records the frames Chrome paints, iframes included (§3.1). It draws an eased cursor, needs no macOS permissions, and nothing on the desktop gets into the frame.

**Q3. Who sets the pace, the narration or the actions?**
Answer: the narration, as recommended. Render the voice first. Each scene's picture runs at least as long as its line, and the line describes what happens while it plays.

**Q4. How are scene offsets taken, given the recording runs ahead of the wall clock?**
Answer: `onFrame` timestamps, as recommended. Offsets are taken on the browser's frame clock. The first spike checks they match the file's timeline to within one frame. If they don't, the fallback is a painted marker that ffmpeg finds.

**Q5. Which voice model and speaker?**
Answer: Aura-2, as recommended, with the speaker picked by ear from a few samples of the same line. Legacy's default is luna.

**Q6. How does the script authenticate to Workers AI?**
Answer: port legacy's `scripts/tts.ts` (§3.2), which already works: a REST call with `CLOUDFLARE_API_TOKEN`. No Alchemy, because voice tooling is separate from the stacks. This replaces the first recommendation, an Alchemy-made token, which was written before the legacy script was found.

**Q7. Which environment: dev, staging or production?**
Answer: a dev store with the dev app, as recommended. Its TOML name is already "Baton". The Shopify CLI dev preview stays closed (`closeDevConsole`, `HIDE_OVERLAYS`).

**Q8. What state does the take start from?**
Answer: an empty Baton plus one product, as recommended. That means no members, teams, workflows or orders, so everything Baton holds is built on camera, as in the reviewer's store. It needs a `screencast` variant of the fixture. The product's tag is set off camera (Q9).

**Q9. How does an order come in?**
Answer: off camera. This replaces the first recommendation, which filmed Create order in the Shopify admin, and follows Q11: the take doesn't show Shopify admin steps. The narration tells the tester to tag a product and place a paid order for it. The script does both through the Admin API while Baton's Orders page is on screen, using the fixture's `draftOrderCreate` plus `draftOrderComplete` with a product variant. The order appearing is the visible result. The first spike checks that it arrives through the dev app's webhooks without Sync open orders. If it doesn't, the scene and the instructions press Sync.

**Q10. Does the take show the member's side?**
Answer: no, as recommended. The merchant moves the run with Done on the order page. One sentence of narration says members sign in by email and see their tasks.

**Q11. Install and plan approval?**
Answer: not shown. This replaces the first recommendation. The tester installs and picks a plan without help, and the take can't show a reviewer's install anyway. The video opens on Baton's Home and goes straight into the flow. The same goes for any other Shopify admin step (Q9).

**Q12. Length and structure?**
Answer: about 4 minutes in chapters (`showChapter` cards), as recommended:

- Intro. Admin-only, no customer flow, said in the first 15 s.
- Team and member.
- Workflow and tag.
- Order arrives.
- Moving the run to Made.

Every chapter ends on its visible result.

**Q13. Captions?**
Answer: none. English narration is enough for 4.5.3. This replaces the first recommendation, a generated subtitle file.

**Q14. Resolution?**
Answer: 1920×1080, as recommended. First spike `deviceScaleFactor: 1.5` on a 1280×720 viewport. If the screencast is capped at CSS pixels, record a 1600×900 viewport and scale up.

**Q15. Hosting?**
Answer: YouTube Unlisted, as recommended, as Bang did.

**Q16. Anything to download for the Mac?**
Answer: nothing, as recommended. Playwright, ffmpeg and ImageMagick cover it.

**Q17. Do the testing instructions come from the same table?**
Answer: yes, as recommended. Each scene carries its `step` text: exact names and values, plus what the tester should see. `instructions` prints them in order under the 2,800-character cap. Before submitting, run the instructions by hand once, on a store that isn't the recording store.

## 7. As built, 2026-10-21

Where the build moved from §5. Details are in the plan's §7.

- **Paths:** renders live in `tmp/screencast/` (git ignores `/tmp/`), not `.screencast/`.
- **Text to speech:** legacy's script is ported to `scripts/lib/tts.ts` (`synthesize`) and `scripts/tts.ts` (`vp run tts gen|play`). It uses the shell's `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and the voice is luna.
- **The parts:**
  - `screencast-fixture.ts`: the empty Baton plus one board tagged "cutting board".
  - `scripts/screencast-scenes.ts`: 16 scenes, with acts written against a small `Take` helper set.
  - `scripts/lib/screencast-take.ts`: `record`.
  - `scripts/lib/screencast-build.ts`: `build`.
- **`record --rehearse`** paces each scene by an estimated line length, so a take can be checked in the real admin before any narration is paid for.
- **Facts about the screens that shaped the copy:**
  - The workflow editor covers the admin until it's closed.
  - An empty Baton's Orders page has no status strip until the first order arrives.
  - The order page says "Every item is done" and never "Made". Made shows on the Orders list.
- **Output:** the take is 2:51, with 14 instruction steps in 1,322 characters. The full narration cost about $0.05, and a run with no copy change costs nothing.
