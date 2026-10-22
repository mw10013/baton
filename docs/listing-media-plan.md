# Plan: listing media

Implements `docs/listing-media-research.md`. Every question in its §5 was answered on 2026-10-22, all as recommended. Read the research's §0, §2, §3 and §4 first. This plan does not repeat their reasoning.

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
  - No e2e: nothing under `src/` changes.
- **What does not change.**
  - Nothing under `src/`, no stack or table change, no new Alchemy resource.
  - The review take. `vp run screencast all` with no `--take` still makes `baton-review.mp4`, and its scenes, voice cache and output stay where they are.
  - No new Mac installs. Playwright, ffmpeg, ffprobe and ImageMagick are already there.
- **Stores.** The dev store only. Every script that writes to Baton loads the dev fixture again at the end, also when it fails. Never staging or production.
- **Paid calls.**
  - Text to speech is metered. Render the feature narration once, in Step 6, after the user approves the copy and the rehearsal. Never in a test.
  - Before Step 6, use `voice --dry-run` and `record --rehearse` only.
- **Copy.** Plain words, the screen's own labels, no metaphor, no semicolons, no claims about results. The user approves the narration (Step 1) and the alt text (Step 7).
- Do not rewrite the steps. Record in §7 what you built differently, and what surprised you, as you go.

## 1. Outcome

- `tmp/screencast/feature/out/baton-feature.mp4`: 1:30–1:45, 1920 × 1080, H.264 with AAC, narrated by Aura-2 luna, on the dev fixture.
- `tmp/screencast/feature/out/thumbnail.png`: 1600 × 900, the designed card.
- `tmp/screencast/feature/out/contact-sheet.png`: one frame per scene.
- `tmp/listing/desktop-<n>-<slug>.png`: six 1600 × 900 screenshots of the app pane.
- `tmp/listing/mobile-<n>-<slug>.png`: three 900 × 1600 screenshots of the member site.
- `tmp/listing/alt.txt`: each file's alt text, 64 characters at most.

The user uploads the video to YouTube and fills the listing form (§8).

## 2. What this plan rests on

- **A1. The review screencast pipeline works** (screencast research §7): `voice` caches by text, `record` films 1600 × 900 CSS and paces by narration, `record --rehearse` paces by estimate, `build` scales to 1080p.
- **A2. `help:screenshots` can shoot the member site** at a phone viewport, signed in as `ana@example.com`, and the merchant screens in the admin with overlays hidden.
- **A3. The top document can be drawn on.** `page.evaluate` on `admin.shopify.com` can add a full-frame element over the app frame, and the page screencast films it. Not yet checked. Step 2 starts with it.
- **A4. Chrome takes a `deviceScaleFactor` of 3** for the mobile shots, and `page.screenshot` writes real 3x pixels. The page screencast ignores `deviceScaleFactor`, but screenshots don't.
- **A5. The dev fixture has what the script needs:** a workflow with several steps (the help uses "Embroider and fold"), an order with items at different steps (#1235), blocked items under Issues, and an item on its last step. Step 1 checks the last one.

## 3. Names and constants

| Name                  | Value                                                                   |
| --------------------- | ----------------------------------------------------------------------- |
| `--take`              | `review` (default) or `feature`                                         |
| Feature output folder | `tmp/screencast/feature/`                                               |
| Feature video         | `baton-feature.mp4`                                                     |
| Listing output folder | `tmp/listing/`                                                          |
| Desktop shot          | 1600 × 900, app pane at 2x, downscaled                                  |
| Mobile viewport       | 414 × 736 CSS (9:16) at `deviceScaleFactor` 3, downscaled to 900 × 1600 |
| Alt text limit        | 64 characters                                                           |
| Brand line            | "Made-to-order production workflows", on both cards and the thumbnail   |

## 4. Steps

### Step 1: Check the script against the screens

No code. Open the dev store with the dev fixture loaded, through `verify-baton` or Chrome MCP, and walk research §3.2 scene by scene:

- The status strip's labels and the Issues wording.
- "Embroider and fold": its steps, teams and tag on the Workflows list.
- Order #1235, or whichever order shows items at different steps best.
- An item on its last step, for scene 8. Note its order number.
- The member screens: the task list, Start and Done, and the button that marks a task blocked. Use the button's label in scene 6.

Write the checked narration into research §3.2, mark every word that changed, and stop for the user's approval. This is the only blocking human step before Step 6.

### Step 2: `--take` and cards

- `scripts/screencast.ts`: a `--take review|feature` flag on `voice`, `record`, `build` and `all`. The take picks the scene table, the fixture before the take, and the output folder. `instructions` stays review-only.
- `recordTake`: the fixture before the take becomes a parameter. The review take keeps `screencastFixture`. The feature take loads the dev fixture. Both load the dev fixture after.
- `Scene` gains an optional `card`: `{ title, line }` for a title card, or `{ phones: [file, file, file] }` for the member card. While the scene plays, the take draws the card over the whole top document, then removes it. Build the HTML from Baton's icon and Polaris type on a solid background, with no Shopify marks.
- Start by checking A3 with a one-scene take. If the screencast doesn't film the overlay, open the card in a second page and record it separately, then join the two in `build`. Record which in §7.
- The feature take crops to the app pane, title bar included: size the window so the pane is 16:9, and crop in `build` before scaling to 1080p. Cards still cover the whole frame. The review take is unchanged.
- The voice cache is shared by both takes. Keyed by text, a line can't collide.
- Unit tests: the flag picks the right table and folder, and a scene with a card validates.

### Step 3: Retake the member pictures

`vp run help:screenshots --section members`. Look at each, and keep the three the card uses: the task list, a task with Start and Done, a blocked task. Commit the changed help pictures with this step.

### Step 4: The feature scene table

`scripts/feature-video-scenes.ts`: research §3.2's nine scenes with the narration approved in Step 1. Each `act` uses the existing `Take` helpers. Add a helper only when two scenes need it. Opening an order by number and pressing Done on one item's task are the likely ones.

### Step 5: Rehearse

`vp run screencast record --rehearse --take feature`, then `build --take feature` without narration, so the contact sheet exists. Show the user the contact sheet and the silent video. Fix what they flag, rehearse again.

### Step 6: Voice, build, thumbnail

- `voice --take feature --dry-run` and report the character count and cost (expected under $0.04).
- `voice --take feature`, `record --take feature`, `build --take feature`.
- `vp run screencast thumbnail`: renders the thumbnail card to 1600 × 900 with Playwright, the same HTML parts as the cards.
- Check: the length is 1:30–1:45, the narration starts within one frame of each scene, no line runs past its scene.

### Step 7: Listing screenshots

- `help:screenshots --listing`: its own shot list, the same gates, fixture load and reload, `HIDE_OVERLAYS` and overlap check. Without the flag, the script behaves as today.
- **Desktop.** Measure the admin's nav width and top bar height, then size the window so the app pane, title bar included, is 16:9. Clip it at 2x and downscale to 1600 × 900. A page taller than the pane gets a larger 16:9 window. Shots: research §4.2's six.
- **Mobile.** 414 × 736 at 3x, signed in as `ana@example.com`, downscaled to 900 × 1600. The member card's three screens.
- Write `tmp/listing/alt.txt` from the shot list. A unit test holds every alt text at 64 characters or fewer.
- Look at every image: no real-looking person's data, no plan or price, no Shopify marks, no overlay.

### Step 8: Hand over

Show the user the video, thumbnail, screenshots and alt text. Fill §7.

## 5. Verification checklist

- [ ] Step 1's narration approved by the user.
- [ ] `vp run screencast all` with no `--take` still makes the review video, and renders no voice.
- [ ] A3 checked, the card method recorded.
- [ ] The feature take leaves the dev fixture loaded, after a success and after a forced failure.
- [ ] `baton-feature.mp4` is 1920 × 1080, 1:30–1:45, H.264 with AAC, in sync at each scene start.
- [ ] `thumbnail.png` is 1600 × 900.
- [ ] Six desktop shots at 1600 × 900, three mobile shots at 900 × 1600, each alt text 64 characters or fewer.
- [ ] `vp check` and the full `vp test` pass.

## 6. Done when

The video, thumbnail, screenshots and alt text are in `tmp/`, the user has seen them, and §7 is filled in.

## 7. Deviations and issues

- **Step 1, 2026-10-22.** The dev server had run 40 hours and its quick tunnel had expired. Restarted with `vp run dev:stop` and `vp run dev`, then checked every scene live (`.logs/verify/feature-script-2`). Results are in research §3.2.
- **Crop the feature take to the app pane.** Found in Step 1: the full admin shows the Shopify wordmark and the dev app's name, Baton Dev. Step 2 adds it.
- **Step 2, 2026-10-22.** A3 held: a card drawn on the admin's top document is filmed like any paint, so the take stays one recording. The pane measured 1280 × 720 at a 1520 × 776 viewport (nav 240, top bar 56). The admin draws the pane's corners rounded and dark against its top bar, so the crop is inset to 1248 × 702 (`paneCrop`). The cursor is parked in the admin nav while a card shows, outside the crop. Workflow scenes use the workflow's own page, not the editor (Step 1). `build` makes a silent `-rehearsal.mp4` from a rehearsal. The voice cache is shared, so pruning keeps every take's lines.
- **Step 3 skipped, 2026-10-22.** The member pictures (taken 2026-10-19) were checked against the live member screens in Step 1 and match, so they weren't retaken.
- **Step 5, first rehearsal, 2026-10-22.** All nine scenes pass at 92.8 s with estimated lines. #1242 moved to Made (Making 24 → 23, Made 4 → 5) and the fixture reload put it back. Output: `tmp/screencast/feature/out/baton-feature-rehearsal.mp4` and `contact-sheet.png`.
- **Step 6, 2026-10-22.** The user approved the rehearsal. Voice: 9 lines, 965 characters, about $0.03. The Bash tool's shell doesn't load `~/.zshrc`, so the two `CLOUDFLARE_*` exports were loaded from it for the run. The first `all` failed before filming: the app frame didn't hydrate within 15 s on the first load. A plain `record` retry passed. `baton-feature.mp4`: 80.3 s, 1920 × 1080 H.264 with AAC. Every line starts within 0.1 s of its scene (silence detection). `thumbnail.png`: 1600 × 900. The video runs under research Q6's 1:30–1:45, because the real lines are shorter than the estimate.
- **Trimmed ends, 2026-10-22.** The user saw the take's lead-in (the home page before the opening card) and its tail (the page after the closing card). The take now marks where its first scene opens (`openMs`), and `build` keeps only that point to the last scene's end, moving the narration with it. The card is drawn before the cursor parks, and a pane take's cursor waits in the hidden nav, so the video opens on the card. `baton-feature.mp4` is now 76.6 s. A review take recorded from now on is trimmed the same way. Its current `scenes.json` has no `openMs`, so it builds whole, as before.
- **Step 7, 2026-10-22.** `vp run help:screenshots --listing` writes six desktop shots, three mobile shots and `alt.txt` to `tmp/listing/`. The shot list and alt text are in `scripts/lib/listing-screenshots.ts`, so a unit test holds each alt text to 64 characters. Desktop shots use the feature video's pane and inset crop (`measurePane`, `paneCrop`) at 2x, scaled to 1600 × 900. Without the inset the admin's rounded corner showed as a dark speck. Mobile shots are 414 × 736 at 3x (touch, mobile), scaled to 900 × 1600, and reuse the help's member takes. **Changed:** the team page was mostly empty, so shot 5 is order #1242 with Manage open: each step, its team, who did it and when. Shot 3 is the workflow's page (tag and steps), not the editor.
- **Uploaded, 2026-10-22.** The listing form refused the 900 × 1600 mobile shots: "Mobile screenshots must be 1600px by 900px". Each phone screen is now set at 450 × 800, corners rounded, on a 1600 × 900 card in the brand blue (`fitMobile`). The video embed URL, the thumbnail, all nine shots and their alt text are in the form and saved; the listing is not submitted.
- **Full `vp test`, 2026-10-22.** 1192 of 1193 passed. `test/browser/web/components/run.test.tsx` (RunNoteModal) failed once and passed twice on its own. It's a web component this work doesn't touch.

## 8. Out of scope

- Uploading to YouTube (Unlisted, comments off, not made for kids) and filling the listing form. The user does both, with the `/embed/<id>` URL.
- Merchant screens in the Shopify mobile app (research Q9).
- Background music (research Q11) and captions.
- The listing's other open issues: the test account and the review screencast's hosting.
