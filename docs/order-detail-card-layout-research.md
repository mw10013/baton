# Order detail: line item card layout research

The line item card on the merchant order page (`/app/orders/$orderId`, `renderLineItem` and `renderRun` in `src/routes/app.orders.$orderId.tsx`) reads badly on a blocked run. The screenshot that prompted this is the e2e stress order in `e2e/fixture.ts` (`LONG_TITLE`, one property `{ "Gift note": null }`, a block reason near `BLOCK_REASON_MAX_LENGTH`). That fixture is the worst case on purpose, and each problem below also shows up on ordinary orders, just less visibly.

Several recommendations here revisit decisions made earlier today in `order-detail-clarity-research.md` and `order-detail-blocked-and-manage-research.md`. Each section says which decision it touches and whether it keeps or reopens it.

## What the card renders today

Top to bottom, for a live blocked run with Manage open:

```
Engraved cutting board, extra large end-grain walnut … (3 lines)
× 1
[ ^ Manage ]                      ← header action, wrapped onto its own line
Properties                        ← our heading, subdued
Gift note                         ← customer's key, subdued, value null
[In progress] [Blocked]           ← run badges
┌ ! Blocked ─────────────────────┐
│ reason (up to 1000 chars)      │  critical tone
│ lead@m.com · 1h ago            │
│ [Edit] [Unblock]               │
└────────────────────────────────┘
Step 2 of 3 · Engrave             ← Now line
Note                     [Edit]   ← blank note placeholder
┌ Engraved cutting board workflow ┐ ← Manage drawer
│ Step 1 …                        │
```

## 1. Properties and "Gift note"

"Properties" is Baton's heading (clarity research §4, decided today). "Gift note" is a line item property key the storefront sent, and its value is `null` (`Domain.OrderAttribute.value` is nullable). The grid renders keys and values both in plain `s-text`, keys subdued, and a null value as an empty string. So the merchant sees two grey words stacked with nothing beside either, and they read as a heading and a subheading.

The heading is not the problem. The value column is. With no visible value, nothing tells the merchant that "Gift note" is a key rather than another label.

Options:

1. **Keep the heading; make values strong and show a null value as "—"** (recommended). The member page's `Personalization` component already renders values `type="strong"`; the order page's copy of the grid does not. Reuse `Personalization` so the two pages cannot drift, and have it draw "—" for a null value. The row then reads `Gift note   —`, which is an answer: the customer left it blank. The heading's original reason still holds: the facts line sits above and the workflow block below, so the rows need a name.
2. **Drop the heading, render `Key: value` lines like the Shopify admin.** Reopens clarity §4. The admin can do it because nothing else sits between its title and the properties; here the facts line and the run do.
3. **Hide null-valued properties.** Tidier, but the maker loses "the customer left the gift note blank", which is information when the product offers one.

## 2. Where the status badges sit

The badges are the first line of `renderRun`, so they land between the properties and the banner. They read as belonging to the properties above them rather than to the item. The clarity research's at-rest mock (§7b) put the badge on the same line as the Now line; the implementation split them because the blocked banner sits between.

The badge is the item's state at a glance, which is what a merchant scanning a multi-item order looks for first. It should sit next to the title.

Options:

1. **Live run's badges on the facts line** (recommended): `× 1 · SKU WB-XL  [In progress] [Blocked]`. `Removed` already sits there. A badge cannot sit inline at the end of a wrapping `s-heading`, so the facts line is the nearest stable spot. Cancelled runs keep their own line in the run area, because each carries its own `Undo cancel`, and an item can hold several. A done run's flag badge keeps its `Dismiss` beside it, so that pair moves up together.
2. **Badge on the Now line**, as in the §7b mock: `[In progress] Step 2 of 3 · Engrave`, with the banner above it. Status stays inside the run block, but it ends up below the banner, farther from the title than today.
3. **Leave them.**

In chat I suggested hiding the Blocked badge while the banner shows. With the badges moved up to the title, the reasoning behind today's Q3a (the badge is the glance, and it matches the orders index) holds more strongly, so I now recommend **keeping it**. Badge and banner are no longer adjacent, so the repetition is less visible.

## 3. Where the blocked banner sits

You asked whether the banner should go above the item title.

Against it: the card would open with a red block that doesn't say which item it's about. On a multi-item order the merchant would see red boxes before seeing which item each one belongs to. The banner is also about the run, not the item: Unblock, the reason and the attribution all refer to the run.

Options:

1. **Keep it in the run block, directly above the Now line** (recommended). With the badges moved up (§2), the order becomes title, facts and badges, properties, banner, Now line. The banner answers why the run stopped and the Now line answers where. The badge on the title line flags the card before the merchant reaches the banner.
2. **Above the title**, as you proposed.
3. **A page-level summary banner** in the existing banner stack ("1 item is blocked") in addition to the card banner. Useful on large orders, but it is another place saying Blocked. I would not add it until an order with many items shows the need.

## 4. How much red

Two things make the banner loud: the critical tone and the length.

**Tone.** Critical red was decided today (blocked-and-manage Q1, Q2), and it matches the worker's page and the Blocked tab through `flagTone`. In chat I suggested warning (amber), since a block is a hold someone chose rather than an error. On reflection I would keep red. The block exists because something is wrong and the run can't move. Changing it on one page breaks the "merchant sees what the worker sees" reason for sharing `FlagBanner`, and changing it on both reopens a decision made hours ago. The size of the banner is what makes it overwhelming, not the colour.

**Length.** `BLOCK_REASON_MAX_LENGTH` is 1000 characters. At full length the banner is taller than the rest of the card, as the screenshot shows. `s-paragraph` has a `lineClamp` prop in the Polaris types.

Options:

1. **Clamp the reason to 3 lines with a "Show more" tertiary toggle** (recommended), in `FlagBanner`, so both pages get it. Typical reasons are one or two lines and never see the toggle.
2. **Clamp without a toggle**; Edit shows the full text in the modal. Cheaper, but reading the full reason should not require opening an editor.
3. **Lower the cap.** 1000 characters is generous, but a long reason is sometimes the whole story ("tried three passes, waiting on vector artwork"), and the stress case is not common.

## 5. The Manage button

It is coded as a header action: an inline stack with `justifyContent="space-between"`, title left, button right. The long title fills the row, so the button wraps onto its own line under the facts. That puts it four blocks above the drawer it opens (`manageRows`, rendered last in `renderRun`). Even when it fits in the header, it is the full height of the card away from its drawer.

The JSDoc on `manageButton` compares it to the Shopify admin's card headers. Those header buttons act on the card, but Manage is a disclosure, and a disclosure belongs directly above what it reveals.

Options:

1. **Move Manage to the end of the run block, after the note, directly above the drawer** (recommended, and what you proposed). Keep the label and chevron. The header then holds only the title and facts, so the wrap goes away.
2. **Keep it in the header and stop the wrap** (fixed-width column for the button). Fixes the wrap, not the distance.

## 6. Two Edit buttons and the blank note

The banner has Edit (the block reason) and the note row has Edit (the note), a few lines apart. Blocked-and-manage Q5 decided the blank note renders as the subdued word "Note" with a right-aligned Edit. In the screenshot that placeholder reads as another heading with no content, the same problem as "Gift note", and the Edit button floats far to the right, detached from it.

Options:

1. **Name the objects: "Edit reason" and "Edit note"; for a blank note, render only the "Edit note" button, left-aligned, no placeholder word** (recommended). One verb is kept, per Q5's "Add implies Remove" reasoning, and the button says what it edits, so it no longer needs the placeholder. A written note keeps its prose with "Edit note" under it. `RunNote` and the banner are shared with the member page, so both pages change, and e2e selectors that address "Edit" need updating.
2. **Rename only**, keeping the "Note" placeholder.
3. **Leave as is.**

## Proposed card

All recommendations applied, blocked run, Manage open:

```
Engraved cutting board, extra large end-grain walnut …
× 1 · SKU WB-XL   [In progress] [Blocked]

Properties
Gift note   —

┌ ! Blocked ──────────────────────────────┐
│ The crest is a scan of a wax seal and   │
│ the fine lines fill in at this depth;   │
│ we have tried three passes and it …     │
│ Show more                               │
│ lead@m.com · 1h ago                     │
│ [Edit reason] [Unblock]                 │
└─────────────────────────────────────────┘
Step 2 of 3 · Engrave
[Edit note]
[ ^ Manage ]
┌ Engraved cutting board workflow ────────┐
│ …                                       │
```

## Decisions (2026-09-24)

Every recommendation was accepted as written. No open questions remain.

| #   | Decision                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Keep the "Properties" heading. The order page reuses `Personalization`, so values render strong.                               |
| Q2  | A null-valued property renders as "—", not hidden.                                                                             |
| Q3  | The live run's badges move onto the facts line under the title. Cancelled runs keep their own line with Undo cancel.           |
| Q4  | Keep the Blocked badge while the banner shows (blocked-and-manage Q3a stands).                                                 |
| Q5  | The banner stays in the run block, directly above the Now line. No page-level summary banner.                                  |
| Q6  | The banner stays critical red (blocked-and-manage Q1 and Q2 stand).                                                            |
| Q7  | `FlagBanner` clamps the reason to 3 lines with a "Show more" toggle, on both pages.                                            |
| Q8  | Manage moves to the end of the run block, after the note, directly above the drawer.                                           |
| Q9  | Buttons read "Edit reason" and "Edit note". A blank note renders only the "Edit note" button, no placeholder word. Both pages. |
| Q10 | The item title is not clamped.                                                                                                 |

The card at rest then matches "Proposed card" above.

Implemented 2026-09-24. Show more is an `s-link` rather than a tertiary button, because the button's inline padding set it off from the reason's left edge. The toggle shows only when the clamp actually hides text; `ClampedProse` in `src/components/MemberRun.tsx` measures it.
