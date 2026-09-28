# View rows on `s-press-button`, and how Issues gets the merchant's attention

Written 2026-09-28, after commit 8724449 moved the orders index's view row from `s-press-button` to `s-button` to make Issues red. Checked against the code and the CDN bundle the same day; corrections from that check are marked **Correction**. This doc covers two separate questions: which element a view row should use, and how an order with issues should reach the merchant. The second question is not a property of a button, and should be decided on its own.

Sources: `src/routes/app.orders.index.tsx` (`VIEWS`, `viewButton`), `src/routes/shop.$shop.workflows.index.tsx` (`viewRow`), `Domain.OrderIssue`, `Domain.orderIssues`, `Domain.productionState` in `src/lib/Domain.ts`, `OrderRepository.listOrders`, the App Home docs in `refs/shopify-docs/docs/api/app-home/latest/`, `@shopify/polaris-types` 1.0.7 (`PressButtonProps`, `ButtonProps`), the CDN `polaris.js` as served on 2026-09-28, `e2e/orders.spec.ts`, `e2e/member-runs.member.spec.ts`, `docs/page-banners-research.md`, and the e2e runs from 2026-09-28.

## 1. Where things stand

Two screens have a view row: a row of buttons, exactly one of them selected, each showing a view of a list.

| Screen                  | Element    | Selected shown by                                                  | Red                              |
| ----------------------- | ---------- | ------------------------------------------------------------------ | -------------------------------- |
| Orders index (merchant) | `s-button` | `variant="primary"`, plus `accessibilityLabel` ending ", selected" | Issues, while it counts an order |
| Workflows list (member) | `s-button` | `variant="primary"`, plus `aria-pressed` on the host               | Blocked, while it counts a run   |

Until 8724449 the orders index used `s-press-button` with `pressed`. The move to `s-button` had one purpose: `s-press-button` accepts only `tone="neutral"` (`PressButtonProps` in `@shopify/polaris-types`), so it cannot be red. It also accepts only `variant="secondary" | "tertiary"`, so it cannot be solid black either.

## 2. The element: `s-press-button`

### What is wrong with `s-button` here

- **`variant="primary"` means the page's main action.** In Polaris the primary button is the one thing the page most wants you to do, and a page should have one. A solid black "Open · 74" presents a filter as that action. We are borrowing the variant because it is the only strong visual state `s-button` has. The button-group docs say the same thing sideways: a `primary` button "can't be used when `gap="none"`", so Polaris's own segmented view switcher has no primary in it.
- **It has no pressed state.** `ButtonProps` has no `pressed` property. `aria-pressed` on the host element stays on the host: Polaris renders a native `<button>` inside a shadow root, and the attribute never reaches it. Screen readers were not told which view was selected. The orders e2e tests caught this on 2026-09-28: the `aria-pressed` assertions that passed against `s-press-button` failed against `s-button`. The member e2e suite already works around it and checks the URL instead (`selectView` in `e2e/member-runs.member.spec.ts`, whose JSDoc says `getByRole` "may resolve to either the `s-button` host or the native button").
- **The fix is a workaround.** 8724449 adds ", selected" to the pressed button's accessible name through `accessibilityLabel`. It is announced, but as part of the name ("Open · 74, selected, button"), not as a state. It also changes the button's name every time the selection changes, which is why the e2e locator had to learn the suffix.

### What Polaris App Home offers

- **No view component.** The Shopify admin shows its own views on the orders index (IndexFilters in Polaris React), and App Home has no web component for them.
- **`s-button-group` with `gap="none"`.** The button group docs describe this segmented form "for toggling between views or options" (`web-components/actions/button-group.md`, "Create a segmented button group"). Its example uses plain `s-button`s and shows no selected state, so it doesn't say how to mark one. **Correction:** the CDN bundle's `s-button-group` accepts `s-press-button` children as well as `s-button` (its child filter tests for both tag names), so a segmented group of press buttons is possible, though undocumented. A segmented group still doesn't fit seven views of different widths with one set apart.
- **`s-press-button`.** A toggle button. **Verified in the CDN bundle:** it renders `aria-pressed="true" | "false"` and `aria-label` on the native button inside its shadow root, so a screen reader hears "pressed" as a state, and the pre-8724449 e2e `aria-pressed` assertions passed because `getByRole` resolved to that native button. It is in `@shopify/polaris-types` and in the CDN `polaris.js` this app loads, but not in the App Home component list under `refs/shopify-docs` (the only "toggle button" pages there are the checkout and customer-account migration guides, which are different components). The orders index used it without trouble until 8724449. Its pressed look is a grey fill; whether that matches how the Shopify admin shows its own selected view was not checked against the admin.
- **Others don't fit.** `s-select` hides the views and their counts behind a click. `s-clickable-chip` is for filter tags that can be removed.

### A risk to check before moving back: `s-press-button` toggles itself

**Correction (new).** The CDN bundle's click handler on `s-press-button` runs `pressed = !pressed` on every click. Under React 19 `pressed` is a controlled prop: React sets the property when its value changes between renders, not when the DOM drifts. Clicking the already-pressed view calls `setFilters` with the values it already has, so nothing re-renders, and the element is left unpressed with the view still selected. The old code had this shape and no e2e test clicked a pressed view, so it is unknown whether it showed. If it does, the fix is one line in `onClick`: set `event.currentTarget.pressed = true` before navigating, or navigate only when the view changes. The member screen has the same shape (`selectView` on a pressed view is a no-op navigation).

### Recommendation

Move both view rows to `s-press-button`:

- **Orders index:** `pressed={q === null && view === value}`, drop `variant`, `tone` and the ", selected" `accessibilityLabel`. The e2e tests go back to checking `aria-pressed`, as they did before 8724449; drop `expectSelected` and the ", selected" suffix in `viewButton`. Add one e2e step that clicks the pressed view and asserts it stays pressed (the self-toggle risk above).
- **Workflows list (member):** the same, keeping `inlineSize="fill"` (which `s-press-button` accepts) so the grid still gives each button its cell's width. Remove the host `aria-pressed`. The member e2e suite can check `aria-pressed` instead of the URL, since the attribute is now on the native button, which is the element `getByRole` resolves to. Its JSDoc says `variant="primary"` "is the only selected state any of these components has"; that is wrong and should go.
- **Both screens lose their red.** Issues on the merchant screen and Blocked on the member screen become neutral. Section 3 is where the merchant's attention comes from instead. Section 4, Q3 covers the member screen.

This replaces the pending member-screen fix (port the ", selected" label). That fix is no longer needed.

## 3. How issues get the merchant's attention

### What an issue is

`Domain.OrderIssue`: an open order that will not move until the merchant acts. Four kinds, each with a remedy on the order page:

| Issue             | Badge tone | Who causes it         | Remedy                           | Can it linger for a good reason?                                  |
| ----------------- | ---------- | --------------------- | -------------------------------- | ----------------------------------------------------------------- |
| No workflow       | warning    | the product catalogue | attach a workflow                | **Yes, by design**: a ready-made product nobody makes (see below) |
| Choose a workflow | warning    | two workflows match   | choose one                       | No. It is one decision.                                           |
| Needs a team      | critical   | staffing              | assign a team, or staff the team | Rarely: a team that is empty while someone is hired               |
| Blocked           | critical   | a member              | unblock on the order page        | Yes: waiting on a supplier or the customer, outside Baton         |

Issues show only on the orders index today: the Issues view, its count, and the Issues column. The home page (usage meters, a link to Orders), the Shopify admin navigation and the member screens don't show them.

**Correction: No workflow is a fact about the whole order, not about an item.** `Domain.orderIssues` raises `no_workflow` only when the order is paid, uncancelled, unfulfilled, has no run of any status on any item, and has no ambiguous item. An order with one tagged item and one untagged item raises nothing: the tagged item's run exists, so the order is Not started, then Making, then Made, and the untagged item is never mentioned. Two things follow:

- The forgotten-tag defence in the `OrderIssue` JSDoc ("hiding the badge would hide that product too") already covers only orders made entirely of untagged items. In a shop that sells both kinds, a forgotten tag on a wallet bought with a keychain is already silent until the packer finds it.
- The Way B risk below, "alongside a tagged item, the order moves to Made", is today's behaviour, not something Way B introduces. Way B changes only the pure-untagged case.

### Your goal, and what stands in its way

You want issues dealt with, not left hanging in a production system. For that, **every issue has to be something the merchant can clear in Baton**. Otherwise the count never reaches zero, and any attention device on it becomes permanent and gets ignored.

One kind can't be cleared today. Many shops sell two kinds of product: made-to-order products (an engraved wallet), which match a workflow by tag, and ready-made products off the shelf (a keychain), which nobody makes and so match no workflow. An order for a keychain alone gets No workflow, on purpose: Baton can't tell a product that is never made from a made-to-order product someone forgot to tag, and hiding the badge would hide the forgotten tag too. But the merchant has no way in Baton to say "we don't make keychains", so every keychain-only order stays an issue until it is fulfilled in Shopify. In a shop that sells ready-made products, the Issues count never reaches zero.

So the order of work matters. **Settle No workflow first, then add the attention device.** A banner added first would be up permanently in every shop that sells ready-made products, and merchants would learn to ignore it before it helped them.

There are two ways to settle it (Q5 below). Neither is decided.

#### Way A: keep No workflow as an issue, and give the merchant a way to clear it

- **Per item: "Baton doesn't make this".** A decision on the order page. Cancel workflow already counts as "decided" ("An issue is an undecided item"), but it cancels a run, and an item that matched no workflow has no run to cancel, so this needs a new stored per-item decision. Clears one order's item. For a ready-made product that sells every day, it's a chore on every order.
- **Per product: mark it as not made to order.** Once, on a product. Later orders of that product never raise No workflow. It needs somewhere to store the decision and a screen to make it on, and Baton doesn't read the product catalogue today.
- **By tag: ready-made products carry a tag Baton ignores.** It's the same mechanism as matching workflows by tag, and it's configured in Shopify. It depends on the merchant tagging correctly, and an untagged ready-made product still raises the issue, which is the right result.

All three make Baton the place where the merchant tells ready-made from made-to-order. That is a second classification on top of the workflow tags, which already say what Baton makes.

#### Way B: stop treating No workflow as an issue

The argument: matching products to workflows by tag is the merchant's job. The tags already are the merchant's statement of what Baton makes. An item that matches no workflow is, by that statement, not Baton's work, and Baton shouldn't second-guess it on every order.

- **What "matched no workflow" means:** either a ready-made product nobody makes, which is normal, or a made-to-order product someone forgot to tag, which is a mistake. Baton can't tell the two apart. Today it flags both, but only on orders with nothing else on them. In a shop that sells ready-made products, most of those flags are false, and the merchant learns to ignore the Issues count, including the issues that are real.
- **What changes:** `no_workflow` leaves `OrderIssue`, its SQL restatement in `OrderRepository.listOrders` (the `issues` fragment and the count fact), the `ORDER_ISSUE_LABEL` row, the glossary, and the tests pinned to it. Issues then holds only things Baton owns and the merchant can clear in Baton: Choose a workflow, Needs a team, Blocked. The count can reach zero, which is what a banner needs.
- **Where the order goes:** an order made only of items that match no workflow already sits under Not started, which is defined to include "an order whose items matched no workflow" (`Domain.ProductionState`). The table could show a quiet grey "No workflow" badge in the Status column rather than a warning in Issues, so the fact stays visible without counting as a problem.
- **The risk, a made-to-order product with a forgotten tag:**
  - _Only item on the order:_ the order sits in Not started indefinitely, where the merchant can see it. This is the one case Way B changes.
  - _Alongside a tagged item:_ already today, the order moves to Made and the packer finds the item wasn't made. Way B doesn't change this.
  - In both cases the fix, tagging the product, is on the merchant anyway.
- **Catching forgotten tags per product, not per order:** later, and only if merchants actually get bitten, a list on the Workflows screen of products that match no workflow. The merchant reviews it when adding products, once per product, instead of on every order. This reads the Shopify catalogue, which Baton doesn't do today. It would also cover the mixed-order case that no per-order issue can.
- **What it gives up:** the reason the badge exists (`Domain.OrderIssue`: hiding it would hide a made-to-order product nobody tagged, "and that customer never gets their order"). Way B accepts that risk for pure-untagged orders and relies on Not started to surface it. How often forgotten tags happen in real shops is unknown.

### Ways to draw attention

1. **Nothing on the row. The table's badges carry the tone.** It's quiet, and it's what you get from `s-press-button` alone. The merchant has to open Orders and look.
2. **A banner on Orders while any open order has an issue.** Polaris gives a banner the job of "needs the merchant's action". Copy along the lines of "13 open orders have issues", with a Show issues button that selects the Issues view. It sits above the orders card, where the quota banners already sit (`docs/page-banners-research.md`).
3. **The same banner on the home page.** Home is where the merchant lands when opening the app. Orders is one click further on.
4. **Tell the merchant without them opening Baton:** a Shopify Flow trigger when an order gets an issue, or an email. It reaches a merchant who doesn't open the app every day. It's the only option here that works when nobody is looking, and the largest piece of work.
5. **Escalate by age.** An issue raised five minutes ago is normal. One from three days ago is what you mean by "hanging around". The copy could name the oldest ("the oldest has waited 3 days"), or the tone could go from warning to critical after a day. **Correction:** Blocked already has a timestamp: a blocked run stores `blockedAt`. The other three are derived on every read and have no start time, so age for them needs a stored timestamp or a proxy (the order's `processedAt`, which says how old the order is, not how long the issue has stood).

On "not proceeding too far": Baton can't stop the merchant fulfilling in Shopify, or stop new orders arriving. What it can control is how visible issues are and how early they appear. The practical form is options 2 and 3 now, with 4 or 5 later if issues still linger.

## 4. Questions

**Q1. Move both view rows to `s-press-button`?**
Recommendation: yes, as in section 2. It's what Polaris means by a toggle, and screen readers announce the pressed state. It removes the ", selected" workaround. Check the self-toggle risk first: it is a five-minute check on the running app, and a one-line fix if it shows.

**Q2. The Issues button's position.**
Recommendation: keep it at the end of the row, set apart (8724449). It divides the row into a lifecycle run and a cross-cutting view no matter how attention is handled. If the banner lands, the button doesn't need to stand out on its own.

**Q3. The member screen's Blocked loses its red. Accept?**
Recommendation: accept. For a member, Blocked lists runs someone has stopped; the member isn't usually the one who clears them, the merchant is. It was the member screen's only red, and consistent elements across both screens are worth more than it. If members need Blocked to stand out, that is its own question for the member screen.

**Q4. Banner: where, what tone, dismissible?**
Recommendation:

- **Where:** Orders only, above the card, below the quota banners, which say the app itself is stopped and so come first. Not home: decided 2026-09-28.
- **Tone:** follow the worst issue present. Critical if any order is Blocked or Needs a team, warning if there are only Choose a workflow issues (and No workflow, if it stays). This matches the table's badge tones, so critical stays rare enough to mean something.
- **Dismissible:** no. Dismissing it hides a state that is still true, and the banner would come back on the next load anyway, so dismissing only teaches the merchant to click it away.
- **Copy:** the count and a Show issues button. Leave the breakdown by kind to the Issues column, which already shows it.
- **On the Issues view:** hide it there. The merchant is already looking at those orders, and the banner would be telling them what the table below already shows.

**Q5. How is No workflow settled: cleared by the merchant (Way A) or no longer an issue (Way B)?** This has to be decided before the banner.
Recommendation: Way B. Three reasons, in order of weight:

1. The safety net is smaller than the JSDoc says. It only ever catches a forgotten tag on an order with nothing else on it; a forgotten tag on a mixed order is already silent. A net with that hole isn't worth a permanent false alarm in every shop that sells ready-made products.
2. The tags are already the merchant's statement of what Baton makes. Way A asks for the same information twice, and every Way A form needs new stored data (a per-item decision, a per-product flag, or a second tag convention) plus a screen or a convention to maintain it.
3. Way B needs no new data and no new screen, and leaves the fact visible as a Not started order with a grey No workflow badge.

If Way A is chosen, per product is the better form: the decision is about the product, not about each order, and a tag Baton ignores brings back the permanent issue whenever the tag is missing. The per-product form and the "products that match no workflow" list under Way B are the same catalogue read, so that work isn't wasted either way.

**Q6. Should the orders index open on Issues when there are any?**
Recommendation: no. A default view that changes with the data makes the page's starting point unpredictable, and the URL would have to say which view it landed on. The banner does this job without moving the merchant.

**Q7. Push (Flow or email) and escalation by age: now or later?**
Recommendation: later. Do Q5 and the banner first, and watch whether issues still linger in real shops. If they do, age escalation (option 5) is the smaller next step, and Blocked can have it at once from `blockedAt`. Push (option 4) is for merchants who don't open Baton daily, which needs evidence of how merchants actually use it. Decided 2026-09-28: push is probably never.

**Q8 (new). Should No workflow become per item?** The alternative to Way B: keep the issue and make it fire for any unfulfilled item with no run and no workflow choice pending, so mixed orders are caught too.
Recommendation: no. It closes the hole in the safety net, but it makes the false alarm worse: every mixed order in a ready-made shop, not just the keychain-only ones, would carry the badge. It only makes sense together with Way A, and then Way A per product is doing the real work.

**Q9 (new). Under Way B, will ready-made-only orders sitting in Not started confuse the merchant?**
What happens, confirmed in `OrderRepository.listOrders` and the order page: an order whose items all matched no workflow is open with no run, so it is in the Not started view (and in Open) from import until it is fulfilled in Shopify, then it leaves on its own. Opening it shows every item with a Workflow picker (`workflowPicker` on the order page), so a forgotten tag is remedied there by attaching a workflow, and the product tag is fixed in Shopify so the next order matches.

In a shop that sells ready-made products, Not started will hold mostly orders Baton will never touch, and its count will say so. That is the honest number: Baton lists every open order, and these are open.

Recommendation: no badge in the first cut. Not started already holds four kinds of order (unpaid, matched nothing, run cancelled, item removed) and does not say which is which; the Payment column covers unpaid, and the order page covers the rest in one click. A "No workflow" badge would mark the most common kind in a ready-made shop, so it would be on most rows of the view, which is noise, and it cannot tell a keychain from a forgotten tag any more than the issue could. Add a grey badge later only if a merchant asks why orders sit in Not started; the cheaper answer then is one sentence in the Not started view's empty state and help text. Decided 2026-09-28: no badge.

## 5. Order of work

1. View rows to `s-press-button` on both screens (Q1, Q3), with the self-toggle check. Small, and independent of the rest.
2. Settle No workflow (Q5): drop it from Issues (Way B), or research and build a way to clear it (Way A).
3. Issues banner on Orders and home (Q4).
4. Revisit age escalation and push once real shops have used it (Q7).

## 6. Decisions (2026-09-28, Plannotator review)

| Question | Decision                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| Q1       | Both view rows to `s-press-button`; check the self-toggle risk first.                                      |
| Q2       | Issues stays at the end of the row, set apart.                                                             |
| Q3       | Member Blocked loses its red.                                                                              |
| Q4       | Banner on Orders only, not home. Tone follows the worst issue; not dismissible; hidden on the Issues view. |
| Q5       | Way B: No workflow leaves Issues.                                                                          |
| Q6       | The index does not open on Issues.                                                                         |
| Q7       | Age escalation later if issues linger; push probably never.                                                |
| Q8       | No workflow does not become per item.                                                                      |
| Q9       | No badge for No workflow in the first cut; Not started and the order page carry it.                        |
