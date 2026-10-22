# Listing media: research

Status: research, 2026-10-22. Not implemented. Every question answered as recommended on 2026-10-22. Q5 and Q9 settle on simulated phone screens (§5). Covers the App Store listing's **Feature media** (a feature video with its thumbnail) and **Screenshots** (at least three desktop screenshots with alt text). Both are among the four issues still blocking the listing. This doc doesn't cover the review screencast (that's [Screencast research](screencast-research.md)), and it doesn't write final listing copy.

Sources:

- The listing form, as shown on 2026-10-22: the Feature media and Screenshots sections and their error messages.
- `refs/shopify-docs/docs/apps/launch/shopify-app-store/best-practices.md` (B.1 Feature media, B.3 Screenshots) and app-store-requirements.md (4.4.3–4.4.5).
- Bang's feature video and screenshot research (`../bang/docs/app-store-feature-video-research.md`, `app-store-screenshots-capture-research.md`).
- Baton's review screencast tooling (`scripts/screencast.ts`, `scripts/lib/screencast-*.ts`), the help screenshot script (`scripts/help-screenshots.ts`) and the TTS CLI (`vp run tts`).
- The help pictures under `public/assets/help/`, which are shot on the dev fixture.

## 0. Verdict

**Feature video.** Build it with the same pipeline as the review screencast: one scene table, Aura-2 luna narration through `scripts/lib/tts.ts`, `page.screencast` in the dev store, and ffmpeg to lay the voice on the picture. Two things change:

- **What it shows.** The review take starts from an empty Baton and teaches setup. The feature video starts on the **dev fixture** (7 members, 8 teams, 8 workflows, 42 orders), so every screen looks like a busy shop. It shows what Baton does for a merchant, not how to set it up.
- **What frames it.** It opens and closes on a title card, and it has a member beat shown on a phone. Both are full-frame overlays the take draws on the admin's top page, so the take stays one recording.

Target 1:30–1:45, about 190 words of narration, about $0.04 of speech. The 1600 × 900 thumbnail is an HTML card that Chrome renders, not a video frame. Host on YouTube Unlisted, comments off, and paste the `/embed/<id>` URL.

**Screenshots.** Add a `listing` mode to `vp run help:screenshots`. It reuses the script's gates, fixture load, `HIDE_OVERLAYS` and overlap check, and writes six 1600 × 900 PNGs of the app pane at 2x, downscaled. The alt text (64 characters at most) lives next to each shot's spec, the same way the help pictures' alt text does. Add two or three optional mobile screenshots of the member screens, because the listing says members work on a phone or tablet.

## 1. What Shopify asks for

### 1.1 Feature media (the form, best-practices B.1)

| Spec                 | Value                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Choice               | Video **or** image. The form checks Video by default.                                                                         |
| Video URL            | Required with a video. The placeholder is `https://www.youtube.com/embed/abcxyz`, the **embed** form.                         |
| Video thumbnail      | Required with a video, uploaded in the form. 1600 × 900, `.jpg` or `.png`.                                                    |
| Length               | No more than 3 minutes (form). Best practices say 2–3 minutes.                                                                |
| Tone                 | "Promotional rather than instructional", and "limit screencasts to 25% of the video". This is guidance, not a requirement.    |
| Feature image (alt.) | 1600 × 900, one focal point, solid background, contrast 4.5:1, alt text. No Shopify logo, don't repeat the app card subtitle. |
| YouTube              | The form links "turn off comments" and "set your video to unlisted".                                                          |

Media shows in the listing's header. The form's DO list says "Consider using a video rather than image" and "Visually highlight your app's benefits". DON'T says no Shopify logo, no heavy patterns, no screenshots with a lot of text.

### 1.2 Screenshots (the form, best-practices B.3, requirements 4.4)

| Spec     | Value                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| Size     | 1600 × 900 (16:9), PNG or JPG.                                                                                         |
| Count    | At least 3 valid desktop screenshots, 3–6 recommended. At least one shows the app's UI.                                |
| Alt text | Required for each, 64 characters at most (the form's `0/64` counter).                                                  |
| Content  | The app's real UI (4.4.4). No browser window or desktop (4.4.4). Each one different (4.4.5). No Shopify marks (4.4.3). |
| Data     | Fictional. The form's footer has you confirm that account data shown is fictional, not a real person's.                |
| Don't    | Personally identifiable information, pricing, reviews or outcome guarantees.                                           |
| Optional | Mobile screenshots, and Point of Sale screenshots. "Most Shopify App Store visitors browse on mobile."                 |

Mobile screenshots: the form names no size (checked 2026-10-22, it shows only an image box and 64-character alt text). Shopify's partner blog gives **900 × 1600 (9:16)**, not duplicates of the desktop shots, showing how the UI responds on a phone. The docs in `refs/shopify-docs` don't mention a mobile size.

@see https://www.shopify.com/partners/blog/faster-app-review

## 2. What already exists

### 2.1 The review screencast pipeline

`vp run screencast voice|record|build|instructions|all` (Screencast research §7):

- `voice` renders each scene's `say` once, cached by a hash of model, speaker and text, so an edit costs only the changed lines. Aura-2 luna, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the shell.
- `record` films the take headless in real Chrome in the dev store at 1600 × 900 CSS, with Playwright's synthetic cursor and `showChapter` cards. Narration paces each scene. `--rehearse` paces by estimated length, so a take can be checked before any voice is paid for.
- `build` places each clip at its scene's offset, normalizes loudness, scales to 1920 × 1080 H.264/AAC, and writes a contact sheet.
- The scene table is `scripts/screencast-scenes.ts`, written against a small `Take` helper set (`nav`, `press`, `fill`, `choose`, `see`, …).

What's tied to the review take today: `recordTake` loads `screencastFixture` (empty Baton plus one tagged product) and loads the dev fixture again afterwards. Paths are fixed under `tmp/screencast/`. Both need a parameter for a second take (Q3).

### 2.2 The help screenshot script

`vp run help:screenshots` shoots every help picture against the dev fixture: real Chrome, headless, light theme, 1280 × 800 at 2x for the admin and 390 × 844 at 2x for the member's phone. It checks the admin session, loads the fixture, refuses a shot that an admin overlay would land in, and loads the fixture again at the end. The shots are cropped to the app (`page`, `modal`, `window` shapes), so they're already free of browser chrome and the Shopify top bar, but they aren't 16:9: the Orders list is 2080 × 2342, the order page 2080 × 1766, the editor 2528 × 1370.

The fixture data is fictional and reads well on camera: "Engraved cutting board — Walnut", "Embroider and fold", teams Textiles and Finishing, members `@example.com`, a status strip with No workflow 2, Not started 9, Making 24, Made 4, Issues 3.

### 2.3 What Bang learned

From Bang's feature video and screenshots, the parts that carry over:

- **Lead with the merchant's problem, then show.** One sentence of what the app is. Everything else is the screen doing it.
- **Title cards as HTML rendered by Chrome.** No Keynote. They also bring the screencast share down.
- **The thumbnail is its own 1600 × 900 card**, uploaded to the listing form and used as YouTube's poster frame. Same file both times.
- **No reliability or outcome claims.** Say what the screen shows.
- **YouTube Unlisted, comments off, not made for kids, `/embed/<id>` URL.**
- **Screenshots: crop to the app pane, keep the app's title bar,** one fixed recipe for every shot. Pick a window size where the pane is exactly 16:9 so nothing needs padding. A page taller than the pane needs a bigger 16:9 window, at the cost of smaller UI.
- **What to avoid:** Bang's capture rig (avfoundation, `cliclick`, macOS permissions, hand-recorded audio) and its per-shot hand edits (`zoompan`, `xfade`, speed ramps). Baton's page screencast and text to speech already replace both.

## 3. Feature video design

### 3.1 Shape

```
scripts/feature-video-scenes.ts   the scene table: say, act, and an optional card
scripts/screencast.ts             gains --take review|feature (Q3)
tmp/screencast/feature/           voice/, raw.webm, scenes.json, out/baton-feature.mp4
tmp/screencast/feature/out/thumbnail.png
```

- **State.** The dev fixture, loaded before the take and again after, as `help:screenshots` does. The take presses Done on a real item, so the fixture reload takes that back.
- **Cards.** A scene with `card` draws a full-frame HTML panel on the admin's top document (`page.evaluate`, not the cross-origin app frame) and removes it when the scene ends. The page screencast films it like any other paint, so there's no concat and no second recording. Cards use Baton's icon and Polaris type on a solid background, with no Shopify marks.
- **The member beat.** A card that shows two or three phone screens side by side: the help's member pictures (`members/finding-your-work-1.png`, `recording-your-work-*.png`, `blocking-*.png`), retaken first so they match today's UI (Q5).
- **Motion.** The cursor and highlight from `showActions`, the same as the review take. No zoom or pan in post.
- **Thumbnail.** `vp run screencast thumbnail --take feature` renders an HTML card to a 1600 × 900 PNG with Playwright. Icon, "Baton", one line that isn't the subtitle (Q7).

### 3.2 Script draft

**Brand line: "Baton - Made-to-order production workflows"** (the user, 2026-10-22). The opening card, the closing card and the thumbnail carry it word for word, and the last narration line says it. The rest of the narration describes, so it doesn't repeat it.

Copy rules: plain words, glossary terms and the screen's own labels, no semicolons, no metaphor, no claims about results. About 190 words. At luna's pace (the review take ran about 150 words a minute) and with pauses, the video runs about 1:30–1:45.

| #   | Screen (the `act`)                                                                                         | Narration (`say`)                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Card**: Baton icon, "Baton", "Made-to-order production workflows".                                       | Made-to-order shops make each item by hand. Baton keeps track of who is making what, and what comes next.                                                                 |
| 2   | Orders, the status strip. The cursor moves across Not started, Making and Made, then presses Making.       | Every paid order shows up in Baton with its production status. Not started, Making, Made, and the ones with issues.                                                       |
| 3   | Workflows, then open "Embroider and fold". The editor shows three steps with their teams and instructions. | You describe how a product is made once, as a workflow. Each step has tasks for your teams, with the instructions they need.                                              |
| 4   | Close the editor. The cursor rests on the workflow's tag in the Workflows list.                            | Give the workflow a tag, and put the same tag on your products. A paid order for those products starts the workflow.                                                      |
| 5   | Orders, open #1235. Three items at different steps, the engraving text, the order note.                    | Open an order to see where each item is. The step it is on, the details the customer chose, and the notes for your team.                                                  |
| 6   | **Card**: three phone screens, the member's task list, a task with Start and Done, a blocked task.         | Members sign in from a phone or tablet with a link sent to their email. They see their team's tasks, press Start and Done, and mark a task blocked when work can't go on. |
| 7   | Orders, press Issues. Blocked items are listed.                                                            | A blocked task shows up under Issues, so you see the problem right away.                                                                                                  |
| 8   | Open an item on its last step, press Manage, then Done. Back on Orders, press Made and see the order.      | When the last step is done, the order moves to Made.                                                                                                                      |
| 9   | **Card**: the same brand stack as scene 1, held to the end.                                                | Baton. Made-to-order production workflows, in your Shopify admin.                                                                                                         |

Before rendering any voice, check each line against the screens: the member's block button label, the Issues wording, and which fixture order sits on its last step for scene 8. The words in the narration must be the words on screen.

Screencast share: scenes 2–5, 7 and 8 film the admin, about 70% of the run. Bang chose to mitigate rather than obey the 25% guidance, because the product's UI is what it sells. Baton is in the same position (Q2).

### 3.3 Cost

About 1,150 characters at $0.03 per 1,000 is under $0.04 for a full render. Re-renders only touch the changed lines. Rehearse with `record --rehearse` until the picture is right, and render the voice once the copy is approved.

## 4. Screenshots design

### 4.1 Capture

Add `--listing` to `vp run help:screenshots` (Q8). It keeps the script's gates, fixture load and reload, `HIDE_OVERLAYS` and `overlapCheck`, and shoots a separate list of shots:

- **Geometry.** The admin window is sized so the app's pane, from the app title bar down and right of the admin nav, is exactly 16:9 in CSS pixels. The script measures the nav and top bar each run, like Bang's probe, instead of hard-coding them. At 2x, the clip is then downscaled to 1600 × 900 with ImageMagick. A page taller than the pane gets a larger 16:9 window, at the cost of smaller UI.
- **The title bar stays.** It's Baton's (icon and breadcrumb), not Shopify's. The admin's own top bar, with the Shopify wordmark, is cropped out.
- **Output.** `tmp/listing/desktop-<n>-<slug>.png` and `alt.txt`, not `public/`: these images are uploaded by hand and never served by Baton.

### 4.2 Shot list

Six shots, each a different screen or state (4.4.5). Alt text is the screen's words, 64 characters at most.

| #   | Screen                                                       | Alt text draft                                           | Chars |
| --- | ------------------------------------------------------------ | -------------------------------------------------------- | ----- |
| 1   | Orders, Making, with the status strip and two Blocked badges | Orders list with counts for Not started, Making and Made | 56    |
| 2   | Order page #1235, three items at different steps             | Order page showing each item's step, details and notes   | 54    |
| 3   | Workflow editor, "Embroider and fold", three steps           | Workflow editor with ordered steps assigned to teams     | 52    |
| 4   | Workflows list with each workflow's tag and status           | Workflows list with the product tag each one matches     | 52    |
| 5   | A team's page with its members                               | Team page listing the members who get the team's tasks   | 54    |
| 6   | Orders, Issues                                               | Orders with blocked tasks listed under Issues            | 45    |

Optional mobile: the member's task list, a task with Start and Done, and Block. These are the help's `member` pictures retaken at 900 × 1600 (Q9).

The fixture's names are fictional ("Sam and Priya" in an engraving, `ana@example.com`). Before uploading, check each shot for anything that looks like a real person's email or address, and for the shop's plan or price on screen.

## 5. Questions

**Q1. Video or image for Feature media?**
Answer: as recommended (2026-10-22). video. The form and best practices both prefer it, the pipeline already exists, and it costs cents. The thumbnail is needed either way, so a feature image is the fallback if the video slips.

**Q2. Promotional tone vs the 25% screencast guidance: obey or mitigate?**
Answer: as recommended (2026-10-22). mitigate, as Bang did. Three cards (open, members, close) and short, purposeful screen beats. Filling 75% of the video with non-UI material would mean stock footage or motion graphics, which is more work and says less about Baton.

**Q3. One CLI with `--take review|feature`, or a second script?**
Answer: as recommended (2026-10-22). one CLI with `--take`. `voice`, `record` and `build` are the same steps. The take picks the scene table, the fixture and the output folder. A second script would copy most of `screencast.ts`.

**Q4. Starting state: dev fixture or a new feature fixture?**
Answer: as recommended (2026-10-22). the dev fixture. It already has realistic, fictional data, and the help pictures use it, so the video, screenshots and help all show the same shop. Reload it after the take, as `help:screenshots` does.

**Q5. The member beat: phone stills on a card, or a second live recording at phone size?**
Answer: stills on a card, as recommended (2026-10-22). What a "phone screen" means here: **a simulated phone, not a real device.** Playwright opens Baton's member site in Chrome with a phone-sized viewport (390 × 844 CSS at 2x, touch on, a mobile user agent), signed in as the fixture's member `ana@example.com`. The page lays itself out exactly as it would in a phone's browser, because it is the same responsive page. `help:screenshots` already makes the help's member pictures this way, at 780 × 1688 px. What a simulated shot doesn't have: the phone's status bar (time, battery), the browser's address bar and any notch. That's fine: Shopify asks for no browser chrome anyway (4.4.4).

A real phone would mean signing in on an iPhone by hand, taking screenshots, cropping the status bar off and repeating that every time the UI changes. It gives the same pixels with more work, so I don't recommend it.

For the video, the card shows three of those simulated screens side by side on a solid background, each in a plain rounded frame. No drawn device: an iPhone mock-up is Apple's trade dress and adds nothing.

- **Stills on a card (recommended).** Three phone screens: the member's task list, a task with Start and Done, a blocked task. The card holds for the length of the narration line, about 15 s. No new recording code.
- **A live phone recording.** A second `page.screencast` at phone size, the cursor pressing Start and Done, laid into the 1920 × 1080 frame with an ffmpeg overlay. It moves, but it needs a second take, a second sign-in and an overlay step in `build`, for one 15-second beat.

Recommendation: stills on a card. Retake the member pictures first so they match today's UI.

**Q6. Length?**
Answer: as recommended (2026-10-22). 1:30–1:45. Under the 3-minute limit, short enough to be watched, and it leaves room to add one beat if the first cut feels thin.

**Q7. Thumbnail: a designed card or a frame from the video?**
Answer: as recommended (2026-10-22), a designed card. Best practices ask for one focal point and a solid background. A UI frame shrunk to a card is a screenshot with a lot of text. Use the icon, "Baton" and one line that is not the app card subtitle ("Manage production workflows for made-to-order products"). The line is the brand line, "Made-to-order production workflows" (2026-10-22). It shares words with the subtitle but isn't a repeat of it.

**Q8. Screenshots: a `--listing` mode in `help:screenshots`, or a separate script?**
Answer: as recommended (2026-10-22). a mode in `help:screenshots`. The gates, fixture handling, overlay check and screen-opening helpers are what make the shots repeatable, and they're already there. Only the window size, crop and output folder differ.

**Q9. Mobile screenshots: include them?**
Answer: as recommended (2026-10-22), the member site only. The same simulated phone as Q5, shot at 900 × 1600. Two readings of "mobile" matter:

- **Baton's member site on a phone.** This is Baton's own UI, and it's what the listing claims ("Members use email sign-in on a phone or tablet"). The help's member pictures already exist this way.
- **Baton's merchant screens inside the Shopify mobile app.** Shopify's "If your app is mobile-responsive" most likely means this: the embedded app opened from the Shopify app on a phone. Capturing it means a real phone or the Shopify app in a simulator, signed in to the store. It can't be scripted the way the admin is.

Size: 900 × 1600 (§1.2). The help's phone is 390 × 844 CSS, a taller shape (0.46) than 9:16 (0.56). The listing shots use a 414 × 736 CSS viewport, which is exactly 9:16 and a real phone's size (iPhone 8 Plus), shot at 3x (1242 × 2208) and downscaled to 900 × 1600. No crop, no padding.

Recommendation: two or three shots of the member site (task list, a task with Start and Done, a blocked task), simulated, at 900 × 1600. Skip the merchant screens on mobile: they're optional, and they'd need a real device by hand.

**Q10. Voice: luna again?**
Answer: as recommended (2026-10-22). luna, the same as the review take, so both of Baton's videos sound the same. Pick another Aura-2 voice only if the promotional read sounds flat after one sample of line 1.

**Q11. Background music?**
Answer: as recommended (2026-10-22). none. It needs licensing and a mix level, and Shopify doesn't ask for it. Narration over a quiet picture is fine for a listing header.

**Q12. Hosting?**
Answer: as recommended (2026-10-22). YouTube Unlisted, comments off, not made for kids, in the same channel as the review screencast. Paste `https://www.youtube.com/embed/<id>`. Upload the thumbnail to YouTube as well.

**Q13. Script copy (§3.2): approve as drafted, or edit first?**
Answer: as recommended (2026-10-22). edit here before any voice is rendered. Rehearse with `record --rehearse --take feature`, then render the voice once.
