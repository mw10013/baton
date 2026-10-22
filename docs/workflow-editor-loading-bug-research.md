# Workflow editor loading bug

## Status

**Closed (2026-10-22): external cause, not a Baton defect. No longer a release blocker.** Codex Browser Use held document responses in the tab it drove (see [Cause](#cause-codex-browser-use-held-the-tabs-document-responses)). The owner closed the blocker. No code, Shopify configuration or deployments were changed. The editor was verified in a tab Browser Use was not attached to: 19 open/close cycles in production. The remaining smoke-test checks (adding and saving a step, the order/webhook run) belong to the production deployment smoke test, not to this bug.

Original status, kept for the record: **Open — production release blocker**, investigated on 2026-10-22 during the production development-store smoke test.

## Environment

- Production app: `https://baton.mw10013.com`.
- Shopify handle: `baton-work`; client ID: `5dbed6b0306c3bc52945dd24bd7b0ff9`.
- Development store: `mw10013-production-shop-00.myshopify.com`.
- Installed app with an approved free Basic test subscription; home displayed 200 included production orders and 3 included members.
- Chrome 155 on macOS, existing signed-in profile. Initial interactions used Chrome through CUA; subsequent comparison used Chrome DevTools MCP in the same profile.
- Production Website version observed during initial investigation: `b4c6cd51-ab7e-474b-973f-7d4b307b3f56`, deployed from commit `b7828d7` through the production branch trigger.
- Test team and draft workflow: `Production smoke test`.
- Workflow ID: `e349821d-0a33-446b-8356-500a321c7cce`; matching tag: `baton-production-smoke`.

## Expected and actual behavior

Clicking **Edit** on a saved workflow should open the fullscreen editor with its steps and **Add step** control.

In the failing tab, Shopify opened a fullscreen window titled Baton, but its body remained blank with a central loading spinner. It persisted across repeated observations over several minutes. The workflow itself had been saved and remained readable on its detail page.

After closing the window and reloading Shopify, the main embedded app also became blank in that tab. This may share a cause with the editor failure, but that relationship is not established.

## Observed reproduction

1. Open Baton in the production development store and verify that the embedded home renders.
2. Open **Workflows → Production smoke test**.
3. Click **Edit**.
4. Observe the fullscreen shell and persistent spinner instead of editor content.
5. Close the window and retry Edit; the failure was observed again.

The original affected tab was Chrome tab `2074574341`, later Chrome DevTools MCP page `6`. These are investigation-session identifiers, not stable reproduction prerequisites.

The symptom was reproduced again when explicitly asked to investigate. However, there is not yet a deterministic procedure for putting a fresh tab into the failing state.

## Evidence

### Failing tab

- The modal iframe pointed to the correct `/app/workflows/<workflowId>/edit` route with `chrome=window` and Shopify's embedded authentication parameters.
- Its DOM attributes included `data-loaded="false"`; the iframe had zero rendered height while Shopify displayed the spinner.
- Chrome Network showed the editor document **pending**, with **0 bytes transferred** and no response headers available.
- The Timing panel showed **Connection start → Stalled**. It did not show a completed request-send or server-response phase. This narrows the observed stall, but does not identify its cause.
- A full reload and a reload bypassing cache did not restore the affected tab during those attempts.
- Opening the editor as a regular embedded route rather than a fullscreen modal also left that tab blank.
- Bringing the tab to the foreground coincided with one successful editor load. A later attempt failed while foregrounded, so background-tab throttling alone does not explain it.
- Initial CUA console capture reported no errors. Later Chrome DevTools MCP captured an `unload is not allowed in this document` permissions-policy error in Shopify-hosted scripts; no causal connection has been established. Other warnings concerned ShopifyQL Direct API Access, deprecated initialization parameters, and Polaris primary-action markup.

### Server observations

- Website telemetry recorded several editor document requests as HTTP 200, outcome `ok`; observed Worker wall times included approximately 119–170 ms.
- Backend reads around the investigation included successful RPC calls. No captured Worker exception explained the spinner.
- These observations are not proof that the browser received a complete document. Individual browser requests and server events still need reliable correlation; earlier HTTP 200 events must not be treated as proof that a currently pending request reached the Worker.
- The public production home rendered successfully in another Chrome tab while the embedded tab was blank.

### Fresh-tab comparison

- Opened a new tab in the same Chrome profile using Chrome DevTools MCP, without changing app code, configuration, credentials, subscription, or workflow data.
- Embedded home loaded successfully.
- Opened the same saved workflow and clicked Edit: the editor displayed **Steps** and **Add step**, and its document request returned HTTP 200.
- Closed and reopened the editor successfully a second time.
- Closed the editor and performed a full reload; the workflow detail page rendered successfully. Opened the editor again afterward.

The comparison demonstrates that the failure can depend on tab/session conditions. It does **not** prove that automation caused the failure or that merchants cannot encounter it.

### Second investigation: production telemetry (2026-10-22)

Times are UTC. Source: `cf o11y telemetry query` events for `baton-website-production` and `baton-backend-production`. Both Workers ran one version throughout (Website `b4c6cd51…`, Backend `001e8c5b…`), so a deploy did not cause the failure. The actor's `ShopActor.fetch: … socket accepted` log marks a page that hydrated, because every page under `/app` opens the shop socket right after hydration.

| UTC                         | Website request                  | Hydrated (socket accepted)        |
| --------------------------- | -------------------------------- | --------------------------------- |
| 05:49:35                    | `/app` 200                       | yes, 05:49:38                     |
| 05:51:02                    | editor (window) 200, 160 ms      | **no**                            |
| 05:56:37                    | editor (window) 200, 170 ms      | **no**                            |
| 05:57:53                    | main socket closed 1001 (reload) | —                                 |
| 05:59:23                    | `/app` 200                       | yes, 05:59:25                     |
| 06:04:24                    | editor (window) 200, 125 ms      | **27 s late**, 06:04:51           |
| 06:07:16, 06:07:48          | editor (window) 200              | **no**                            |
| 06:10:06, 06:10:59          | editor as a plain page 200       | **no**                            |
| 06:14:44 onward (fresh tab) | `/app`, editor (window) 200      | yes, every time, within about 1 s |

- In the affected tab the server finished each editor document within 125–185 ms with 200, but the page never hydrated: no App Bridge "loaded" (spinner) and no socket. This held both in the window and as a plain page. Other routes in the same tab (`/app`, the workflow page) did hydrate.
- Retries the browser showed as pending (Connection start → Stalled) do not appear in Website telemetry. Those requests never left the browser.
- The one late success (06:04:24 document, 06:04:51 socket) matches the earlier note that bringing the tab forward coincided with a load: the document was delivered, but its scripts ran 27 s later.
- In the fresh tab, 19 consecutive scripted open/close cycles (15 foreground, 4 with another tab in front) each loaded in 0.5–0.7 s. Chrome DevTools MCP emulates focus and visibility, so it cannot test a truly hidden tab.

Conclusion so far: the stall is in the browser, in that tab: requests held before sending, or delivered documents and their scripts held. The Baton server and the editor route served correctly throughout, and the same build works in any other tab.

### Cause: Codex Browser Use held the tab's document responses

The smoke test ran through Codex Browser Use (session `rollout-2026-10-21T22-59-02-…` in `~/.codex/sessions`), which drove Chrome tab `2074574341`, the affected tab, with Playwright over the ChatGPT extension's DevTools relay.

- On every tab it attaches to, Browser Use calls `Fetch.enable` with `{requestStage: "Response", resourceType: "Document"}`. Chrome then pauses **every document response in that tab, including iframes**, until the Codex browser service handles `Fetch.requestPaused` and calls `Fetch.continueResponse`. An origin-approval listener can take over a paused response first and release it only after approval. See `~/.codex/plugins/cache/openai-bundled/chrome/26.1007.71326/scripts/browser-service.mjs`: `Ru`, `handleEvent`, and the message "Browser Use reserves Document responses for browser-managed navigation".
- At 05:51:59, 57 s after the first editor window's document was served, the session logged: "Browser use could not acquire authority to act in a frame. The origin approval gate did not grant access for https://admin.shopify.com. Automatic approval review failed: You've hit your usage limit." It had also logged CDP timeouts (`Timed out after 3000ms waiting for CDP command Runtime.evaluate`) at 05:46:54 and 05:49:32.
- From then on, any document response the service did not release stayed paused. Baton's Worker had already sent the response (200 in Website telemetry), Chrome showed the request as pending with 0 bytes, and the frame never ran: spinner, no socket. Subresources, server functions and WebSockets are not intercepted, which is why other traffic in the tab kept working. A document went through only when the service happened to answer, as with the 27 s late release at 06:04.
- The DevTools attachment and its `Fetch` interception belong to the tab, so reloads kept them. A new tab without Browser Use attached loaded every time.

Every observation in this document matches this mechanism. Baton's code, Worker and Shopify configuration played no part. The failure would occur the same way on staging, in dev, or on any site in a tab Browser Use stays attached to after its approval review stops working.

Mitigation for smoke tests: drive the embedded admin from a tab Browser Use is not attached to (Chrome DevTools MCP, Playwright, or by hand), or end the Browser Use session and close its tab before testing manually. If an editor window spins forever, first check for Chrome's "is debugging this browser" bar.

## Hypotheses, not conclusions

- Browser request scheduling, connection state, cache state, or an extension/automation interaction prevents the document navigation from progressing.
- Shopify's embedded frame or App Bridge window lifecycle leaves the tab in a bad state.
- Baton's document/authentication or editor-window lifecycle contributes to the condition.

None is confirmed. Do not disable security controls or change production Shopify identity/configuration to test a guess.

## Investigation plan

1. Preserve and inspect the failing tab if it still exists; capture a sanitized request/timing trace and compare it with a successful load. Never commit session tokens, cookies, authorization headers, or full authenticated URLs.
2. Correlate a specific failed browser navigation with Website and Backend telemetry. Determine whether it is held before transmission, at an intermediary, or during document delivery.
3. Compare fresh and affected tab behavior using the same browser tool, then test ordinary manual interaction to separate app behavior from instrumentation effects. Change one condition at a time.
4. Inspect editor-window creation, show/hide, source updates, document authentication, and App Bridge initialization against the observed request lifecycle.
5. Build a minimal repeatable sequence that creates the failure; implement a targeted fix once the responsible layer is established.
6. Run the relevant automated checks and repeat the production development-store verification below.

## Resolution criteria

- Explain the cause with evidence and record the fix, or establish an external cause with a reliable mitigation suitable for users.
- Verify editor open, close, reopen, and full-page reload repeatedly, including the sequence that previously failed.
- Verify navigation away and back, and foreground/background transitions.
- Confirm the saved workflow remains intact and the editor supports adding and saving a step/task.
- Resume and complete the order/webhook smoke test. It remains incomplete; installation and subscription success are not an end-to-end production pass.

## Relevant implementation and references

- `src/web/components/workflow-editor-window.ts`: `useWorkflowEditorWindow`, fullscreen `s-app-window` lifecycle and BroadcastChannel outcomes.
- `src/web/routes/app.workflows.$workflowId_.edit.tsx`: editor route and loader.
- `src/web/routes/-app-guard.ts`: embedded document authentication and redirects.
- `src/web/routes/app.tsx`: App Bridge script, frame policy, app layout.
- `src/web/routes/__root.tsx`: document scripts and hydration behavior.
- `src/web/server/workflows.ts`: workflow detail read.
- [Production deployment research](production-deployment-research.md): deployment and smoke-test execution record.
- [Chrome Network reference](https://developer.chrome.com/docs/devtools/network/reference/#timing-explanation): request timing phases.
- [Shopify App window](https://shopify.dev/docs/api/app-home/latest/app-bridge-web-components/app-window): supported fullscreen window component.

## Reporting correction

Earlier investigation updates prematurely described the fresh-tab success as evidence against an app defect and the issue as no longer a production blocker. That conclusion was unsupported. The observed failure is real, its cause remains unknown, and the owner has designated it a showstopping release blocker.
