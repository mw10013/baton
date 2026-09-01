# Pre-hydration dead controls & e2e hydration gates — research

Research + decision writeup, arising from `docs/member-access-phase-1-plan.md` step 5 (e2e). Covers: what actually breaks before React hydrates, why it bit the member-area specs and never bit the embedded ones, what machinery exists in Baton and `refs/bang`, and which of three shapes we should settle on.

Status: problem understood and fixed empirically (7/7 e2e green). **One decision open** — marker naming/count, see [Approaches](#approaches). Nothing here is committed.

## TL;DR

- The failure is not a Playwright quirk. SSR'd interactive controls are **painted and dead** until React attaches; a click on one passes every actionability check and the activation is silently swallowed. No error, and the run dies much later at an unrelated assertion.
- Playwright cannot see this. Neither `toBeVisible()` nor "the expected content is present" proves anything — that content is in the SSR'd HTML too.
- The embedded app never hit it because `src/routes/app.tsx:231` makes the pre-hydration window `inert`, and `e2e/app.ts` waits on the marker that mirrors it. The member area had neither.
- `useHydrated()` is a **global constant store**, so every marker derived from it flips in one React commit. Two markers can never disagree today.
- But they answer different questions — *"React attached?"* vs *"the inert barrier lifted?"* — and only one of them is coupled to `inert` by construction.
- **Recommendation: keep two markers, rename the embedded one `data-app-hydrated` → `data-app-interactive`.** Collapsing to one is simpler and correct today, and accepts a latent trap.

## 1. The problem

### 1.1 What actually goes wrong

Between "the browser painted the SSR'd HTML" and "React finished hydrating" there is a window where the page is a photograph of an app. A `<button>` has correct geometry, correct text, correct accessible name, is not `disabled`, is not `aria-disabled` — and has no `onClick`, because React hasn't attached it yet.

Playwright's actionability checks are all satisfied by that photograph. It dispatches the click. Nothing happens. **No error is raised** — the click genuinely occurred, it just had no handler. The test proceeds and fails somewhere else entirely, at an assertion for a result the click never requested.

This is the same class of silent drop that `e2e/app.ts:22-31` already documents for `inert`:

> Playwright's actionability is inert-blind (verified in `refs/playwright`: `injectedScript.ts` never reads `inert`; its `enabled` check only looks at `aria-disabled`; the hit-test is pure geometry). So a click on an inert-wrapped element passes every actionability check, Playwright dispatches it, and the browser swallows the activation — a silent drop, no error.

Pre-hydration is that failure without the `inert`.

### 1.2 It is also a real user-facing bug

Worth separating, because it drives a design decision below. A real user on a slow connection who clicks "Send magic link" before hydration also gets nothing. The test is not exercising a synthetic condition; it is exercising a narrow race that users hit too. `inert` is a genuine fix for it; a marker is only observability.

### 1.3 How it presented

Three of four member-area specs failed at assertions that had nothing to do with the cause:

```
Locator: locator('s-section[heading="Check your email"]')
Expected: visible
Error: element(s) not found
```

The page was still showing the login form 10s later. The submit had never happened.

## 2. Evidence

Three independent confirmations, because the first explanation was wrong.

### 2.1 `useHydrated()` is a global constant store

```ts
// refs/tan-router/packages/react-router/src/ClientOnly.tsx:56
export function useHydrated(): boolean {
  return React.useSyncExternalStore(
    subscribe,     // noop — never fires
    () => true,    // client snapshot: constant
    () => false,   // server snapshot: constant
  )
}
```

Not per-component state. `false` while rendering to match SSR, `true` for the rest of the document's life. Every caller reads the same snapshot, so React re-renders them together. **Consequence: any two markers derived from `useHydrated()` flip in the same commit and can never disagree.**

### 2.2 The failing wait recorded the flip

Playwright's own retry log, from the failure:

```
 2 × locator resolved to <html lang="en" ...>              ← no data-hydrated
22 × locator resolved to <html data-hydrated="true" ...>
```

Two polls before the flip, twenty-two after. The page hydrated *during* the wait — so at the moment of the click it had not.

### 2.3 Two probes killed the first theory

The initial diagnosis blamed client-side `<Link>` navigation. Both probes contradict it:

| Probe | Setup | Result |
|---|---|---|
| A | Sign out with **zero** `Link` navigations | **fails** — so `Link` is not the cause |
| B | Keep both `Link` navigations, await hydration after the magic link | **passes** — so `Link` is fine |

`Link` navigations need no wait at all: React is already live for those.

### 2.4 The double React banner

React logs its DevTools notice once per root. In one manual run it appeared twice:

```
[   604ms] Download the React DevTools ...   ← document 1 (/login)
[ 12358ms] Download the React DevTools ...   ← document 2 (/shop), after the magic-link click
```

Direct proof that the magic-link click boots a **new document**, not an SPA transition.

## 3. Why a full document load happens mid-SPA

The intuition "we're an SPA by then" is right for most of the flow. One click leaves it:

```tsx
// src/routes/login.tsx:127
<s-link href={loginMutation.data.magicLink}>Open your magic link</s-link>
```

`s-link` renders a native `<a href>`. TanStack Router only intercepts clicks on its own `<Link>` component, so this leaves the SPA entirely — and it *must*, because `/api/auth/magic-link/verify` is a server route and setting the session cookie requires a real HTTP request. Chain: verify `302` → `/login-callback` `307` → `/shop`, then a brand-new document.

### 3.1 The SPA boundary, step by step

| Step | Kind | Needs hydration gate? |
|---|---|---|
| `goto("/login")` | document load | **yes** |
| fill + "Send magic link" | server fn over fetch, React state | already hydrated |
| **"Open your magic link"** (`s-link`, `login.tsx:127`) | **native `<a>` → redirect chain → new document** | **yes** ← the one originally missed |
| shop link (`<Link>`, `shop.index.tsx:59`) | SPA nav | no |
| "Back to your shops" (`<Link>`, `shop.$shop.tsx:44`) | SPA nav | no |
| "Sign out" (`s-button onClick`) | needs React attached | — provided by the gate above |

Sign out stays in the SPA: its server fn throws `redirect({ to: "/" })` and the router navigates client-side — which is why no third React banner appears.

**Rule that generalizes:** the gate is needed after *any* document load, including one a click causes. "Did I call `page.goto`?" is the wrong question.

## 4. Impact on testing

### 4.1 What does not work as a gate

- `expect(x).toBeVisible()` — the SSR'd HTML contains `x`. Proves nothing about interactivity.
- `waitForLoadState("load"` / `"networkidle")` — per `e2e/app.ts:47-56`, the client entry is a dynamic import, so its waterfall runs *after* `readyState=complete`. A stall there has no page-level symptom.
- Asserting a URL — the redirect chain completes long before hydration.

### 4.2 What does work

A DOM marker driven by `useHydrated()`, waited on with `waitFor({ state: "attached" })`. It is a retrying poll over the live DOM, so it rides through redirects.

### 4.3 Why the embedded specs never hit this

Because the embedded app already solved it — twice over:

```tsx
// src/routes/app.tsx:231
<div inert={!hydrated} data-app-hydrated={hydrated ? "true" : undefined}>
```

```ts
// e2e/app.ts:77
const hydrated = frame.locator('[data-app-hydrated="true"]');
```

Every embedded spec routes through `gotoApp`, so the wait is baked in and invisible at the call site. That is why it looked as though there were "no hydration waits" on the embedded side.

### 4.4 Why `refs/bang` never hit it either

Bang has the same embedded machinery (verified byte-identical, see §5) and **no** root marker — checked, `refs/bang/src/routes/__root.tsx` has neither `useHydrated` nor `data-hydrated`.

It never needed one. Bang's non-embedded surface is `/`, `/privacy`, `/help/*` — static content — and every interaction in `refs/bang/e2e/help.spec.ts` is a plain anchor click (`s-link[href="/help/actions"]`, `s-clickable[href=...]`). **Anchors are browser-native and work with React absent entirely.** Bang has no non-embedded form or `onClick` button, so it had no pre-hydration click to drop.

Baton's member area is the first interactive non-embedded surface in either project. This is new ground, not a gap in the port.

## 5. Current machinery

### 5.1 Embedded — Baton ≡ Bang, verified

`diff` confirms byte-identical:

- `e2e/app.ts` vs `refs/bang/e2e/app.ts` — identical
- `src/routes/app.tsx` vs `refs/bang/src/routes/app.tsx`, hydration wrapper region — identical

So "should Baton mirror Bang on the embedded side" is already answered: it does, exactly. No work there.

`gotoApp` carries two things the member area deliberately does **not** copy: a 15s timeout and a one-shot reload rescue. Those exist because the embedded app is served through a Cloudflare quick tunnel where individual requests in Vite's unbundled module graph (~186/load) can hang forever (`e2e/app.ts:47-56`). The member area runs against `http://localhost:$PORT` with no tunnel in the path, so the default timeout is honest and a rescue would be cargo-culted.

### 5.2 Non-embedded — added for the member area

```tsx
// src/routes/__root.tsx:73
<html lang="en" suppressHydrationWarning data-hydrated={hydrated ? "true" : undefined}>
```

Helper module `e2e/member.ts`, structured to mirror `e2e/app.ts`:

| | `e2e/app.ts` (embedded) | `e2e/member.ts` (non-embedded) |
|---|---|---|
| navigate + gate | `gotoApp(page)` → `FrameLocator` | `gotoMember(page, path)` |
| raw gate | *(inlined)* | `awaitHydration(page)` |
| surface-specific | `appFrame`, `clickHoisted` | `followMagicLink` |

`awaitHydration` is exposed separately only because one document load is not one we issue (§3). The embedded side needs no equivalent — nothing in the iframe leaves it via an anchor.

## 6. Should the member area also use `inert`?

No — and this asymmetry is deliberate, not an oversight.

`inert` is the stronger tool: it fixes the real user-facing bug (§1.2), not just the test's blindness. But on the member area it would **remove working behavior**. Pre-hydration:

- the magic link (`s-link` → native `<a>`) works — it is a plain hyperlink;
- the shop links (`<Link>` also renders `<a href>`) work — they degrade to full page loads.

Making that subtree `inert` would break links that currently function without JS. The member area's only genuinely-dead pre-hydration controls are two `onClick` buttons ("Send magic link", "Sign out").

**Conclusion: embedded gets `inert` + marker; member area gets marker only.**

(Not investigated: *why* the embedded app needs `inert` at all. `app.tsx:201` says only "content inert until hydration completes"; plausibly App Bridge/Polaris misbehaviour pre-hydration. Worth knowing before anyone changes that gate.)

## 7. Approaches

The two markers are provably redundant **as hydration signals** (§2.1). But they answer different questions:

- `data-hydrated` → *has React attached?*
- `data-app-hydrated` → *has the `inert` barrier lifted?*

Only the second is coupled to `inert` by construction — same variable, same JSX element, cannot drift.

### A. Two markers, rename the embedded one — recommended

```tsx
<div inert={!hydrated} data-app-interactive={hydrated ? "true" : undefined}>
```

- ✓ Names encode the distinction. The current name says "hydrated", which is precisely why it was pattern-matched to the new marker and a **wrong mechanism was written into a code comment** during this work. That ambiguity has already cost something.
- ✓ Embedded gate stays welded to `inert`.
- ✗ `app.tsx` + `e2e/app.ts` stop matching Bang byte-for-byte; future diffs against Bang carry noise.

### B. Two markers, names unchanged — status quo on disk

- ✓ Zero churn, exact Bang parity.
- ✗ Two attributes both named "hydrated"; the distinction lives only in JSDoc.

### C. Collapse to one marker

Drop `data-app-hydrated`; `gotoApp` waits on `frame.locator('html[data-hydrated="true"]')` — which does resolve, since the iframe renders the same root.

- ✓ One concept, one name, both surfaces. Correct **today**, guaranteed by §2.1.
- ✗ The embedded gate becomes an inference across a component boundary ("React attached, *therefore* the wrapper is not inert") rather than a direct observation.
- ✗ Latent trap: the moment `inert` gains a condition — App Bridge ready, session resolved, anything — the root marker is silently wrong and embedded specs resume clicking into an inert wrapper. That is the hardest failure mode in this codebase to diagnose, and it is exactly the one this work just removed.

## 8. Recommendation

**A.** The deciding factor is asymmetry of cost, not elegance:

- Collapsing saves one attribute and risks a silently swallowed click.
- Keeping two costs one attribute and a sentence of JSDoc.

The rename is the part that pays for itself — it removes an ambiguity that has already produced one wrong explanation in this codebase. C is defensible and I would not argue hard against it if one concept is worth more than the guard rail.

## 9. Open / not addressed

- Why the embedded app needs `inert` at all (§6). Unknown; changing that gate without knowing is risky.
- No CI story. All of this was verified locally against a live install; `LOGIN_LIMITER` (5 sends/60s, all local requests share the `unknown` IP key) would need thought before these specs run repeatedly in CI.
- The member specs' hydration gate is untested against a *slow* client entry — the failure mode `gotoApp`'s reload rescue exists for. If the member suite ever runs through a tunnel, revisit §5.1.
